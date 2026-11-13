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
            const chars = charsByObject.chars.get(object.handle) ?? [];
            const reversed = orderGlyphs(chars, matrix, charsByObject.lineRtl, (c, unicode, advance, stacked) => {
              glyphCodes[glyphAt] = unicode.codePointAt(0) ?? 0;
              glyphIndexes[glyphAt] = c.index;
              glyphNumbers[glyphAt * 3] = c.x;
              glyphNumbers[glyphAt * 3 + 1] = c.y;
              glyphNumbers[glyphAt * 3 + 2] = advance;
              glyphFlags[glyphAt] =
                (isSpace(unicode) ? PACKED_GLYPH_SPACE : 0) | (stacked ? PACKED_GLYPH_STACKED : 0);
              glyphAt++;
            });
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
   * The text page's characters grouped by text object, each line's base
   * direction, and, for fonts whose glyph widths can't be probed, whether the
   * cells they draw on this page are all one width (the fixed-pitch fallback).
   */
  private async readChars(
    textPagePtr: Ptr,
    timer: SliceTimer,
    fontProbes: Map<number | bigint, FontProbe>,
  ) {
    const { fn, mem } = this.runtime;
    const count = Math.max(fn.FPDFText_CountChars(textPagePtr), 0);
    const lineRtl: boolean[] = new Array(count);
    const codePoints = new Array<number>(count);
    let lineStart = 0;
    let rtl = false;
    for (let i = 0; i <= count; i++) {
      const u = i < count ? (codePoints[i] = fn.FPDFText_GetUnicode(textPagePtr, i)) : 10;
      if (u === 10 || u === 13) {
        for (let j = lineStart; j <= i && j < count; j++) lineRtl[j] = rtl;
        lineStart = i + 1;
        rtl = false;
      } else if (isRtlCodePoint(u)) {
        rtl = true;
      }
    }
    const chars = new Map<number | bigint, TextObjectChar[]>();
    const widthsByFont = new Map<number | bigint, Set<number>>();
    let read = 0;
    // x and y (f64) then the loose box (FS_RECTF), in one block.
    const block = mem.alloc(32);
    const [xPtr, yPtr, rectPtr] = [0, 8, 16].map((offset) => (block + BigInt(offset)) as Ptr);
    const matrixPtr = mem.alloc(24);
    // Consecutive characters mostly share a text object: its font and slant are read once.
    let lastObject: Ptr | undefined;
    let list: TextObjectChar[] | undefined;
    let fontPtr: Ptr = 0n as Ptr;
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
          list = chars.get(object);
          if (!list) chars.set(object, (list = []));
          fontPtr = fn.FPDFTextObj_GetFont(object);
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
        const unicode = String.fromCodePoint(codePoints[i]);
        fn.FPDFText_GetCharOrigin(textPagePtr, i, xPtr, yPtr);
        fn.FPDFText_GetLooseCharBox(textPagePtr, i, rectPtr);
        // FS_RECTF { left, top, right, bottom }
        const left = readF32(mem, rectPtr, 0);
        const top = readF32(mem, rectPtr, 4);
        const right = readF32(mem, rectPtr, 8);
        const bottom = readF32(mem, rectPtr, 12);
        let width = right - left;
        if (cellWidths && width > 0 && !isSpace(unicode)) {
          const fontSize = fn.FPDFText_GetFontSize(textPagePtr, i) || 1;
          cellWidths.add(Math.round((width / fontSize) * 1000));
        }
        // Sheared text: the loose box bounds the slanted cell; remove the slant.
        if (slant) width = Math.max(0, width - slant * Math.abs(top - bottom));
        list!.push({
          index: i,
          unicode,
          x: Number(mem.peek(xPtr, 'f64')),
          y: Number(mem.peek(yPtr, 'f64')),
          width,
        });
        read++;
      }
    } finally {
      mem.free(matrixPtr);
      mem.free(block);
    }
    const uniformWidths = new Map<number | bigint, boolean>();
    for (const [font, set] of widthsByFont) uniformWidths.set(font, set.size === 1);
    return { chars, lineRtl, uniformWidths, count: read };
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
