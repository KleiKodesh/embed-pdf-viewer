import type {
  PageContentMark,
  PageObjectNumber,
  PageTextFont,
  PageTextGlyph,
  PageTextObjectsPacked,
  PageTextObjectsSnapshot,
} from '@embedpdf/engine-core/runtime';
import {
  EngineError,
  EngineErrorCode,
  PACKED_GLYPH_SPACE,
  PACKED_GLYPH_STACKED,
  PACKED_TEXT_OBJECT_NUMBERS,
  PACKED_TEXT_OBJECT_STRIDE,
  unpackPageTextObjects,
} from '@embedpdf/engine-core/runtime';
import type { PdfRuntimeModule, Ptr } from '@embedpdf/engine-runtime';

import type { DocumentSession } from '../../document-session/DocumentSession';
import { readF32, readI32 } from '../../runtime/memory/structs';
import { withScratch } from '../../runtime/memory/scratch';
import { readUtf16String } from '../../runtime/memory/strings';
import { throwIfAborted } from '../../shared/abort';
import { SliceTimer, type Slices } from '../../shared/slices';

/** `FPDF_PAGEOBJ_*` → `PACKED_TEXT_OBJECT_KINDS` index. */
const OBJECT_KIND_CODES: Record<number, number> = {
  1: 0, // text
  2: 1, // path
  3: 2, // image
  4: 3, // shading
};
const UNKNOWN_KIND_CODE = 4;
const TEXT_KIND_CODE = 0;
const FPDF_PAGEOBJ_FORM = 5;

/** Font descriptor `/Flags` bits. */
const FLAG_FIXED_PITCH = 1;
const FLAG_SERIF = 2;

/** Char codes probed to tell whether every glyph width of a font is the same. */
const WIDTH_PROBE_CODES = 1024;

/** Brackets a right-to-left text page shows mirrored. */
const MIRRORED: Record<string, string> = {
  '(': ')',
  ')': '(',
  '[': ']',
  ']': '[',
  '{': '}',
  '}': '{',
  '<': '>',
  '>': '<',
  '«': '»',
  '»': '«',
  '‹': '›',
  '›': '‹',
};

const isSpace = (text: string) => /^\s$/.test(text);

/** Strong right-to-left characters (Hebrew, Arabic and their presentation forms). */
const isRtlCodePoint = (u: number) =>
  (u >= 0x590 && u <= 0x8ff) || (u >= 0xfb1d && u <= 0xfdff) || (u >= 0xfe70 && u <= 0xfeff);

/** What `probeFont` learns about a font. */
interface FontProbe {
  flags: number;
  /** Distinct non-zero glyph widths: 0, 1, or 2 for more (not probed when fixed pitch). */
  widthCount: number;
  /** Not fixed pitch and no width to probe: the page's cells decide. */
  needsCells: boolean;
}

interface RawObject {
  handle: Ptr;
  type: number;
  marks: number[];
}

/** A text page character, as `drawingOrder` takes it. */
export interface TextObjectChar {
  index: number;
  unicode: string;
  x: number;
  y: number;
  /** Loose cell width, shear removed. */
  width: number;
}

/** The text page's characters in columns (see `readChars`). */
interface CharColumns {
  /** Text-page index, code point, origin and shear-free loose width per character read. */
  index: Int32Array;
  code: Uint32Array;
  x: Float64Array;
  y: Float64Array;
  width: Float64Array;
  /** Per text-page index: 1 on a right-to-left line. */
  lineRtl: Uint8Array;
  /** Characters grouped by object; `slotStart`/`slotCount` give each group's range. */
  order: Int32Array;
  slotOf: Map<number | bigint, number>;
  slotStart: Int32Array;
  slotCount: Int32Array;
  uniformWidths: Map<number | bigint, boolean>;
  count: number;
}

/** `isSpace` for one code point. */
function isSpaceCode(u: number): boolean {
  return (
    (u >= 9 && u <= 13) ||
    u === 32 ||
    u === 0xa0 ||
    u === 0x1680 ||
    (u >= 0x2000 && u <= 0x200a) ||
    u === 0x2028 ||
    u === 0x2029 ||
    u === 0x202f ||
    u === 0x205f ||
    u === 0x3000 ||
    u === 0xfeff
  );
}

/** `MIRRORED` by code point. */
const MIRRORED_CODES = new Map<number, number>(
  Object.entries(MIRRORED).map(([a, b]) => [a.codePointAt(0)!, b.codePointAt(0)!]),
);

/**
 * Object-level page text: every page object in content order with its
 * marked-content stack, and each text object's font, matrix and glyphs in
 * drawing order.
 *
 * Objects come from the page's object list (form XObjects flattened in
 * place); glyphs come from the text page, matched to their object through
 * `FPDFText_GetTextObject`. The text page keeps right-to-left lines in
 * logical order with brackets mirrored, so each object's glyphs are put back
 * in pen order along the object's baseline and mirrored brackets restored.
 */
export class PageTextObjectsReader {
  constructor(
    private readonly runtime: PdfRuntimeModule,
    private readonly session: DocumentSession,
  ) {}

  async read(
    pageObjectNumber: PageObjectNumber,
    signal: AbortSignal,
    slices: Slices,
  ): Promise<PageTextObjectsSnapshot> {
    return unpackPageTextObjects(await this.readPacked(pageObjectNumber, signal, slices));
  }

  /** `read()` in typed-array columns (see `PageTextObjectsPacked`). */
  async readPacked(
    pageObjectNumber: PageObjectNumber,
    signal: AbortSignal,
    slices: Slices,
  ): Promise<PageTextObjectsPacked> {
    throwIfAborted(signal);
    const { fn, mem } = this.runtime;
    const pool = this.session.pagePool();
    const pagePtr = await pool.acquireInSlices(pageObjectNumber, signal, slices);
    try {
      throwIfAborted(signal);
      const textPagePtr = fn.FPDFText_LoadPage(pagePtr);
      if (!textPagePtr) {
        throw new EngineError(
          EngineErrorCode.RuntimeUnavailable,
          `FPDFText_LoadPage returned null for page object ${pageObjectNumber}`,
        );
      }
      try {
        const timer = new SliceTimer(slices, signal);
        const marks: PageContentMark[] = [];
        const raw: RawObject[] = [];
        this.collect(
          fn.FPDFPage_CountObjects(pagePtr),
          (i) => fn.FPDFPage_GetObject(pagePtr, i),
          [],
          new Map(),
          marks,
          raw,
        );
        const fontProbes = new Map<number | bigint, FontProbe>();
        const charsByObject = await this.readChars(textPagePtr, timer, fontProbes);
        const fonts: PageTextFont[] = [];
        const fontIndex = new Map<number | bigint, number>();
        const objects = new Int32Array(raw.length * PACKED_TEXT_OBJECT_STRIDE);
        const objectNumbers = new Float64Array(raw.length * PACKED_TEXT_OBJECT_NUMBERS);
        const objectMarks = new Int32Array(raw.reduce((n, o) => n + o.marks.length, 0));
        const glyphCount = charsByObject.count;
        const glyphCodes = new Uint32Array(glyphCount);
        const glyphIndexes = new Int32Array(glyphCount);
        const glyphNumbers = new Float64Array(glyphCount * 3);
        const glyphFlags = new Uint8Array(glyphCount);
        let markAt = 0;
        let glyphAt = 0;
        const scratch = mem.alloc(24);
        try {
          for (let i = 0; i < raw.length; i++) {
            if (timer.due) await timer.pause();
            const object = raw[i];
            const at = i * PACKED_TEXT_OBJECT_STRIDE;
            const kind = OBJECT_KIND_CODES[object.type] ?? UNKNOWN_KIND_CODE;
            objects[at] = kind;
            objects[at + 1] = -1;
            objects[at + 4] = markAt;
            objects[at + 5] = object.marks.length;
            for (const m of object.marks) objectMarks[markAt++] = m;
            objects[at + 2] = glyphAt;
            if (kind !== TEXT_KIND_CODE) continue;
            const fontPtr = fn.FPDFTextObj_GetFont(object.handle);
            let font = fontIndex.get(fontPtr);
            if (font === undefined) {
              font = fonts.length;
              fontIndex.set(fontPtr, font);
              fonts.push(this.readFont(fontPtr, fontProbes, charsByObject.uniformWidths));
            }
            objects[at + 1] = font;
            const num = i * PACKED_TEXT_OBJECT_NUMBERS;
            objectNumbers[num] = fn.FPDFTextObj_GetFontSize(object.handle, scratch)
              ? readF32(mem, scratch)
              : 1;
            const matrix = [1, 0, 0, 1, 0, 0];
            if (fn.FPDFPageObj_GetMatrix(object.handle, scratch)) {
              for (let k = 0; k < 6; k++) matrix[k] = readF32(mem, scratch, k * 4);
            }
            for (let k = 0; k < 6; k++) objectNumbers[num + 1 + k] = matrix[k];
            const slot = charsByObject.slotOf.get(object.handle);
            let reversed = false;
            if (slot !== undefined) {
              const cols = charsByObject;
              const from = cols.slotStart[slot];
              const list = cols.order.subarray(from, from + cols.slotCount[slot]);
              reversed = orderPackedGlyphs(cols, list, matrix, (c, code, advance, stacked) => {
                glyphCodes[glyphAt] = code;
                glyphIndexes[glyphAt] = cols.index[c];
                glyphNumbers[glyphAt * 3] = cols.x[c];
                glyphNumbers[glyphAt * 3 + 1] = cols.y[c];
                glyphNumbers[glyphAt * 3 + 2] = advance;
                glyphFlags[glyphAt] =
                  (isSpaceCode(code) ? PACKED_GLYPH_SPACE : 0) | (stacked ? PACKED_GLYPH_STACKED : 0);
                glyphAt++;
              });
            }
            objects[at + 3] = glyphAt - objects[at + 2];
            objects[at + 6] = reversed ? 1 : 0;
          }
        } finally {
          mem.free(scratch);
        }
        // Characters of objects the page list doesn't reach are not glyphs.
        const used = glyphAt;
        return {
          objects,
          objectMarks,
          objectNumbers,
          glyphCodes: used === glyphCount ? glyphCodes : glyphCodes.slice(0, used),
          glyphIndexes: used === glyphCount ? glyphIndexes : glyphIndexes.slice(0, used),
          glyphNumbers: used === glyphCount ? glyphNumbers : glyphNumbers.slice(0, used * 3),
          glyphFlags: used === glyphCount ? glyphFlags : glyphFlags.slice(0, used),
          marks,
          fonts,
        };
      } finally {
        fn.FPDFText_ClosePage(textPagePtr);
      }
    } finally {
      pool.release(pageObjectNumber);
    }
  }

  /** Flatten the object tree in content order, resolving each object's mark stack. */
  private collect(
    count: number,
    objectAt: (i: number) => Ptr,
    inherited: number[],
    markIds: Map<number | bigint, number>,
    marks: PageContentMark[],
    out: RawObject[],
  ): void {
    const { fn } = this.runtime;
    for (let i = 0; i < count; i++) {
      const handle = objectAt(i);
      const type = fn.FPDFPageObj_GetType(handle);
      const stack = [...inherited];
      const markCount = fn.FPDFPageObj_CountMarks(handle);
      for (let m = 0; m < markCount; m++) {
        const markPtr = fn.FPDFPageObj_GetMark(handle, m);
        let id = markIds.get(markPtr);
        if (id === undefined) {
          id = marks.length;
          markIds.set(markPtr, id);
          marks.push(this.readMark(markPtr));
        }
        stack.push(id);
      }
      if (type === FPDF_PAGEOBJ_FORM) {
        this.collect(
          fn.FPDFFormObj_CountObjects(handle),
          (j) => fn.FPDFFormObj_GetObject(handle, j),
          stack,
          markIds,
          marks,
          out,
        );
      } else {
        out.push({ handle, type, marks: stack });
      }
    }
  }

  private readMark(markPtr: Ptr): PageContentMark {
    const { fn, mem } = this.runtime;
    const tag =
      withScratch(mem, 8, (lenPtr) =>
        readUtf16String(mem, (buf, capacity) =>
          fn.FPDFPageObjMark_GetName(markPtr, buf, capacity, lenPtr) ? readI32(mem, lenPtr) : 0,
        ),
      ) ?? '';
    const mcid = withScratch(mem, 4, (ptr) =>
      fn.FPDFPageObjMark_GetParamIntValue(markPtr, 'MCID', ptr) ? readI32(mem, ptr) : undefined,
    );
    return mcid === undefined ? { tag } : { tag, mcid };
  }

  /**
   * The text page's characters in columns, grouped by text object (`order`
   * holds each object's characters in text-page order, `slotOf` maps an
   * object handle to its group), each character's line direction, and, for
   * fonts whose glyph widths can't be probed, whether the cells they draw on
   * this page are all one width (the fixed-pitch fallback).
   */
  private async readChars(
    textPagePtr: Ptr,
    timer: SliceTimer,
    fontProbes: Map<number | bigint, FontProbe>,
  ): Promise<CharColumns> {
    const { fn, mem } = this.runtime;
    const count = Math.max(fn.FPDFText_CountChars(textPagePtr), 0);
    const lineRtl = new Uint8Array(count);
    const codePoints = new Uint32Array(count);
    let lineStart = 0;
    let rtl = false;
    for (let i = 0; i <= count; i++) {
      const u = i < count ? (codePoints[i] = fn.FPDFText_GetUnicode(textPagePtr, i)) : 10;
      if (u === 10 || u === 13) {
        if (rtl) lineRtl.fill(1, lineStart, Math.min(i + 1, count));
        lineStart = i + 1;
        rtl = false;
      } else if (isRtlCodePoint(u)) {
        rtl = true;
      }
    }
    const index = new Int32Array(count);
    const code = new Uint32Array(count);
    const x = new Float64Array(count);
    const y = new Float64Array(count);
    const width = new Float64Array(count);
    const slotOfChar = new Int32Array(count);
    const slotOf = new Map<number | bigint, number>();
    const slotSizes: number[] = [];
    const widthsByFont = new Map<number | bigint, Set<number>>();
    let read = 0;
    // x and y (f64) then the loose box (FS_RECTF), in one block.
    const block = mem.alloc(32);
    const [xPtr, yPtr, rectPtr] = [0, 8, 16].map((offset) => (block + BigInt(offset)) as Ptr);
    const matrixPtr = mem.alloc(24);
    // Consecutive characters mostly share a text object: its font and slant are read once.
    let lastObject: Ptr | undefined;
    let slot = -1;
    let cellWidths: Set<number> | undefined;
    let slant = 0;
    try {
      for (let i = 0; i < count; i++) {
        // Checking the clock per character costs more than the character's own reads.
        if ((i & 63) === 0 && timer.due) await timer.pause();
        if (fn.FPDFText_IsGenerated(textPagePtr, i) === 1) continue;
        const object = fn.FPDFText_GetTextObject(textPagePtr, i);
        if (!object) continue;
        if (object !== lastObject) {
          lastObject = object;
          let found = slotOf.get(object);
          if (found === undefined) {
            found = slotSizes.length;
            slotOf.set(object, found);
            slotSizes.push(0);
          }
          slot = found;
          const fontPtr = fn.FPDFTextObj_GetFont(object);
          // Cell widths only matter for a font whose glyph widths say nothing.
          cellWidths = undefined;
          if (this.probeFont(fontPtr, fontProbes).needsCells) {
            cellWidths = widthsByFont.get(fontPtr);
            if (!cellWidths) widthsByFont.set(fontPtr, (cellWidths = new Set<number>()));
          }
          slant = 0;
          if (fn.FPDFPageObj_GetMatrix(object, matrixPtr)) {
            const c = readF32(mem, matrixPtr, 8);
            const d = readF32(mem, matrixPtr, 12);
            if (c && d) slant = Math.abs(c / d);
          }
        }
        const u = codePoints[i];
        fn.FPDFText_GetCharOrigin(textPagePtr, i, xPtr, yPtr);
        fn.FPDFText_GetLooseCharBox(textPagePtr, i, rectPtr);
        // FS_RECTF { left, top, right, bottom }
        const left = readF32(mem, rectPtr, 0);
        const top = readF32(mem, rectPtr, 4);
        const right = readF32(mem, rectPtr, 8);
        const bottom = readF32(mem, rectPtr, 12);
        let w = right - left;
        if (cellWidths && w > 0 && !isSpaceCode(u)) {
          const fontSize = fn.FPDFText_GetFontSize(textPagePtr, i) || 1;
          cellWidths.add(Math.round((w / fontSize) * 1000));
        }
        // Sheared text: the loose box bounds the slanted cell; remove the slant.
        if (slant) w = Math.max(0, w - slant * Math.abs(top - bottom));
        index[read] = i;
        code[read] = u;
        x[read] = Number(mem.peek(xPtr, 'f64'));
        y[read] = Number(mem.peek(yPtr, 'f64'));
        width[read] = w;
        slotOfChar[read] = slot;
        slotSizes[slot]++;
        read++;
      }
    } finally {
      mem.free(matrixPtr);
      mem.free(block);
    }
    // Group by object, keeping text-page order within each group.
    const slotStart = new Int32Array(slotSizes.length);
    const slotCount = Int32Array.from(slotSizes);
    for (let k = 1; k < slotSizes.length; k++) slotStart[k] = slotStart[k - 1] + slotSizes[k - 1];
    const fill = slotStart.slice();
    const order = new Int32Array(read);
    for (let c = 0; c < read; c++) order[fill[slotOfChar[c]]++] = c;
    const uniformWidths = new Map<number | bigint, boolean>();
    for (const [font, set] of widthsByFont) uniformWidths.set(font, set.size === 1);
    return {
      index,
      code,
      x,
      y,
      width,
      lineRtl,
      order,
      slotOf,
      slotStart,
      slotCount,
      uniformWidths,
      count: read,
    };
  }

  /**
   * A font's flags and how many distinct non-zero glyph widths it has (0, 1,
   * or 2 for "more than one"), read once per page.
   */
  private probeFont(fontPtr: Ptr, probes: Map<number | bigint, FontProbe>): FontProbe {
    let probe = probes.get(fontPtr);
    if (probe) return probe;
    const { fn, mem } = this.runtime;
    const flags = fn.FPDFFont_GetFlags(fontPtr);
    let widthCount = 0;
    if ((flags & FLAG_FIXED_PITCH) === 0) {
      // Every non-zero glyph width equal makes a font fixed pitch, as viewers
      // derive it from /Widths.
      const widths = new Set<number>();
      withScratch(mem, 4, (ptr) => {
        for (let code = 0; code < WIDTH_PROBE_CODES && widths.size < 2; code++) {
          if (!fn.FPDFFont_GetGlyphWidth(fontPtr, code, 1, ptr)) continue;
          const width = Math.round(readF32(mem, ptr) * 1000);
          if (width) widths.add(width);
        }
      });
      widthCount = widths.size;
    }
    probe = { flags, widthCount, needsCells: (flags & FLAG_FIXED_PITCH) === 0 && widthCount === 0 };
    probes.set(fontPtr, probe);
    return probe;
  }

  private readFont(
    fontPtr: Ptr,
    probes: Map<number | bigint, FontProbe>,
    uniformWidths: Map<number | bigint, boolean>,
  ): PageTextFont {
    const { fn, mem } = this.runtime;
    const { flags, widthCount } = this.probeFont(fontPtr, probes);
    const baseName =
      withScratch(mem, 512, (buf) =>
        fn.FPDFFont_GetBaseFontName(fontPtr, buf, 512) > 0 ? mem.readU8String(buf) : '',
      ) ?? '';
    const [ascent, descent] = withScratch(mem, 4, (ptr) => [
      fn.FPDFFont_GetAscent(fontPtr, 1, ptr) ? readF32(mem, ptr) : 0,
      fn.FPDFFont_GetDescent(fontPtr, 1, ptr) ? readF32(mem, ptr) : 0,
    ]);
    // With no glyph width to probe, judge by the cells.
    const monospace =
      (flags & FLAG_FIXED_PITCH) !== 0 ||
      widthCount === 1 ||
      (widthCount === 0 && (uniformWidths.get(fontPtr) ?? false));
    return { baseName, flags, ascent, descent, monospace, serif: (flags & FLAG_SERIF) !== 0 };
  }
}

/**
 * Put an object's characters in drawing order. Pure — exported for tests.
 *
 * Order is along the object's baseline. A right-to-left object (the text page
 * stored it reversed, or it sits on a right-to-left line with no advance to
 * tell) breaks ties in reverse, draws its logically trailing spaces first and
 * leading ones last, and has its mirrored brackets restored. An object whose
 * glyphs all share one pen position keeps the text page's order (reversed
 * for right-to-left) and marks them `stacked`.
 */
export function drawingOrder(
  chars: readonly TextObjectChar[],
  matrix: readonly number[],
  lineRtl: readonly boolean[],
): { glyphs: PageTextGlyph[]; reversed: boolean } {
  const glyphs: PageTextGlyph[] = [];
  const reversed = orderGlyphs(chars, matrix, lineRtl, (c, unicode, advance, stacked) => {
    glyphs.push({
      index: c.index,
      unicode,
      origin: { x: c.x, y: c.y },
      advance,
      ...(isSpace(unicode) ? { space: true as const } : {}),
      ...(stacked ? { stacked: true as const } : {}),
    });
  });
  return { glyphs, reversed };
}

/**
 * `drawingOrder` handing each glyph to `emit` (its char, text as drawn,
 * advance, stacked) instead of building objects; returns `reversed`.
 */
function orderGlyphs(
  chars: readonly TextObjectChar[],
  matrix: readonly number[],
  lineRtl: readonly boolean[],
  emit: (c: TextObjectChar, unicode: string, advance: number, stacked: boolean) => void,
): boolean {
  if (chars.length === 0) return false;
  const [ax, ay] = matrix;
  const along = (c: TextObjectChar) => c.x * ax + c.y * ay;
  const solid = chars.filter((c) => !isSpace(c.unicode));
  let direction = 0;
  for (let k = 1; k < solid.length && !direction; k++) {
    const delta = along(solid[k]) - along(solid[k - 1]);
    if (Math.abs(delta) > 1e-3) direction = Math.sign(delta);
  }
  const rtl = direction ? direction < 0 : (lineRtl[chars[0].index] ?? false);
  const stacked = direction === 0 && solid.length > 1;
  let sorted: TextObjectChar[];
  if (stacked) {
    sorted = rtl ? [...chars].reverse() : [...chars];
  } else {
    sorted = [...chars].sort(
      (a, b) => along(a) - along(b) || (rtl ? b.index - a.index : a.index - b.index),
    );
    if (rtl) {
      const firstSolid = chars.findIndex((c) => !isSpace(c.unicode));
      let lastSolid = chars.length - 1;
      while (lastSolid >= 0 && isSpace(chars[lastSolid].unicode)) lastSolid--;
      const trailing = new Set(chars.filter((_, k) => k > lastSolid).map((c) => c.index));
      const leading = new Set(chars.filter((_, k) => k < firstSolid).map((c) => c.index));
      if (trailing.size || leading.size) {
        const byIndexDesc = (a: TextObjectChar, b: TextObjectChar) => b.index - a.index;
        sorted = [
          ...sorted.filter((c) => trailing.has(c.index)).sort(byIndexDesc),
          ...sorted.filter((c) => !trailing.has(c.index) && !leading.has(c.index)),
          ...sorted.filter((c) => leading.has(c.index)).sort(byIndexDesc),
        ];
      }
    }
  }
  const scale = Math.hypot(ax, ay) || 1;
  for (let k = 0; k < sorted.length; k++) {
    const c = sorted[k];
    const next = sorted[k + 1];
    let advance = c.width;
    if (next) {
      const step = along(next) - along(c);
      if (step > 0) advance = step / scale;
    }
    emit(c, rtl && MIRRORED[c.unicode] ? MIRRORED[c.unicode] : c.unicode, advance, stacked);
  }
  return rtl;
}

/**
 * `orderGlyphs` over character columns, with no per-glyph objects: `list`
 * holds the object's characters (column positions) in text-page order.
 * Same order, advances and mirroring.
 */
function orderPackedGlyphs(
  cols: CharColumns,
  list: Int32Array,
  matrix: readonly number[],
  emit: (c: number, code: number, advance: number, stacked: boolean) => void,
): boolean {
  const n = list.length;
  if (n === 0) return false;
  const { x, y, code, index } = cols;
  const [ax, ay] = matrix;
  const along = new Float64Array(n);
  for (let k = 0; k < n; k++) along[k] = x[list[k]] * ax + y[list[k]] * ay;
  let direction = 0;
  let previous = -1;
  let solidCount = 0;
  for (let k = 0; k < n; k++) {
    if (isSpaceCode(code[list[k]])) continue;
    solidCount++;
    if (previous >= 0 && !direction) {
      const delta = along[k] - along[previous];
      if (Math.abs(delta) > 1e-3) direction = Math.sign(delta);
    }
    previous = k;
  }
  const rtl = direction ? direction < 0 : cols.lineRtl[index[list[0]]] === 1;
  const stacked = direction === 0 && solidCount > 1;
  // Positions within `list`; text-page order is position order.
  let sorted: number[] = new Array(n);
  for (let k = 0; k < n; k++) sorted[k] = k;
  if (stacked) {
    if (rtl) sorted.reverse();
  } else {
    // Mostly already in order, or in reverse (right-to-left): no ties then, so
    // the sort would give the same.
    let rising = true;
    let falling = true;
    for (let k = 1; k < n && (rising || falling); k++) {
      if (!(along[k] > along[k - 1])) rising = false;
      if (!(along[k] < along[k - 1])) falling = false;
    }
    if (falling && n > 1) sorted.reverse();
    else if (!rising) sorted.sort((a, b) => along[a] - along[b] || (rtl ? b - a : a - b));
    if (rtl) {
      let firstSolid = 0;
      while (firstSolid < n && isSpaceCode(code[list[firstSolid]])) firstSolid++;
      if (firstSolid === n) firstSolid = -1;
      let lastSolid = n - 1;
      while (lastSolid >= 0 && isSpaceCode(code[list[lastSolid]])) lastSolid--;
      if (lastSolid < n - 1 || firstSolid > 0) {
        const trailing = (k: number) => k > lastSolid;
        const leading = (k: number) => k < firstSolid;
        const descending = (a: number, b: number) => b - a;
        sorted = [
          ...sorted.filter(trailing).sort(descending),
          ...sorted.filter((k) => !trailing(k) && !leading(k)),
          ...sorted.filter(leading).sort(descending),
        ];
      }
    }
  }
  const scale = Math.hypot(ax, ay) || 1;
  for (let j = 0; j < n; j++) {
    const k = sorted[j];
    const c = list[k];
    let advance = cols.width[c];
    if (j + 1 < n) {
      const step = along[sorted[j + 1]] - along[k];
      if (step > 0) advance = step / scale;
    }
    const u = code[c];
    emit(c, rtl ? (MIRRORED_CODES.get(u) ?? u) : u, advance, stacked);
  }
  return rtl;
}
