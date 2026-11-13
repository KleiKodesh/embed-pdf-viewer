/**
 * A page's content as the content stream draws it, returned by
 * `PageHandle.text.objects()`: every page object in content order (form
 * XObjects flattened in place), each with its marked-content stack, and for
 * text objects their font, matrix and glyphs in drawing order.
 *
 * This is the object-level twin of `text.get()` / `text.layout()`, which
 * describe the page's characters in reading order. It is what a consumer
 * needs to rebuild text the way the content stream lays it out (tagged-PDF
 * marked content, per-object fonts, glyph runs in pen order), e.g. to emulate
 * another viewer's text extraction.
 *
 * Values are in PDF user space (y up, no page rotation or crop applied),
 * exactly as the content stream states them: a matrix cannot be expressed in
 * page space without losing what the file says.
 */
export interface PageTextObjectsSnapshot {
  /** Every page object in content order; form XObjects are flattened in place. */
  objects: PageContentObject[];
  /**
   * Each distinct marked-content sequence (`BDC`/`BMC` … `EMC`) the objects
   * sit in. Objects refer to them by index, so two objects inside the same
   * sequence share an entry, while two separate sequences with the same tag
   * and properties do not.
   */
  marks: PageContentMark[];
  /** Fonts the text objects use, referred to by `PageTextObject.font`. */
  fonts: PageTextFont[];
}

/** One marked-content sequence. */
export interface PageContentMark {
  /** The tag (`/Span`, `/P`, `/Artifact` …), without the slash. */
  tag: string;
  /** The `/MCID` property, when the sequence has one. */
  mcid?: number;
}

/** The kind of a page object, as the content stream draws it. */
export type PageContentObjectKind = 'text' | 'path' | 'image' | 'shading' | 'unknown';

/** A page object that is not text: only its place in the marked content. */
export interface PageOtherObject {
  kind: Exclude<PageContentObjectKind, 'text'>;
  /** Indexes into `PageTextObjectsSnapshot.marks`, outermost first. */
  marks: number[];
}

/** A text object (one `Tj`/`TJ` run in one text state). */
export interface PageTextObject {
  kind: 'text';
  /** Indexes into `PageTextObjectsSnapshot.marks`, outermost first. */
  marks: number[];
  /** Index into `PageTextObjectsSnapshot.fonts`. */
  font: number;
  /** The text state font size (`Tf`). */
  fontSize: number;
  /**
   * The object's matrix `[a, b, c, d, e, f]` (text matrix times CTM), without
   * the font size.
   */
  matrix: [number, number, number, number, number, number];
  /**
   * True when the page's text stores this object's characters in reverse
   * (right-to-left text kept in logical order). `glyphs` are in drawing order
   * either way; `index` keeps the text-page order.
   */
  reversed?: true;
  /** The object's glyphs in drawing (pen) order. */
  glyphs: PageTextGlyph[];
}

export type PageContentObject = PageTextObject | PageOtherObject;

/** One glyph of a text object. */
export interface PageTextGlyph {
  /** The character's index in the page's character space (`text.layout()`). */
  index: number;
  /**
   * The glyph's text as drawn: for a reversed object, brackets the text page
   * mirrored for display are mirrored back.
   */
  unicode: string;
  /** The pen position (glyph origin), in PDF user space. */
  origin: { x: number; y: number };
  /**
   * How far the pen moves for this glyph along the baseline, in user space:
   * the distance to the next glyph's origin when that moves forward, else the
   * glyph's cell width (shear removed).
   */
  advance: number;
  /** Present, and true, for whitespace. */
  space?: true;
  /**
   * Present, and true, when the object draws every glyph at one pen position
   * (zero advance, e.g. `Tz` near 0): the order is the text page's order,
   * reversed for right-to-left lines.
   */
  stacked?: true;
}

/** A font as text extraction sees it. */
export interface PageTextFont {
  /** `/BaseFont`, subset tag included (`ABCDEF+Name`); empty when absent. */
  baseName: string;
  /** The font descriptor `/Flags`. */
  flags: number;
  /** Ascent and descent per unit of font size (descent is negative). */
  ascent: number;
  descent: number;
  /**
   * True when the font is fixed pitch: the descriptor says so, or every
   * non-zero glyph width is the same.
   */
  monospace: boolean;
  /** True when the descriptor's Serif flag is set. */
  serif: boolean;
}

/**
 * `PageTextObjectsSnapshot` in typed-array columns, returned by
 * `PageHandle.text.objectsPacked()`. Same content, but a worker hands the
 * arrays over without copying and nothing is allocated per glyph: the shape
 * for reads that walk every page (find, copy-all), where per-glyph objects
 * cost more than the read itself. `unpackPageTextObjects` gives the snapshot.
 */
export interface PageTextObjectsPacked {
  /**
   * `PACKED_TEXT_OBJECT_STRIDE` integers per object: its kind
   * (`PACKED_TEXT_OBJECT_KINDS` index), font index (-1 when not text), first
   * glyph, glyph count, first entry in `objectMarks`, mark count, and 1 when
   * `reversed`.
   */
  objects: Int32Array;
  /** Every object's mark stack (indexes into `marks`), back to back. */
  objectMarks: Int32Array;
  /** Per object, `fontSize` then `matrix` (7 numbers; zeros when not text). */
  objectNumbers: Float64Array;
  /** Per glyph, the code point of `unicode`. */
  glyphCodes: Uint32Array;
  /** Per glyph, `index`. */
  glyphIndexes: Int32Array;
  /** Per glyph, `origin.x`, `origin.y` and `advance`. */
  glyphNumbers: Float64Array;
  /** Per glyph, `PACKED_GLYPH_SPACE` and `PACKED_GLYPH_STACKED` bits. */
  glyphFlags: Uint8Array;
  marks: PageContentMark[];
  fonts: PageTextFont[];
}

/** Integers per object in `PageTextObjectsPacked.objects`. */
export const PACKED_TEXT_OBJECT_STRIDE = 7;
/** Numbers per object in `PageTextObjectsPacked.objectNumbers`. */
export const PACKED_TEXT_OBJECT_NUMBERS = 7;
/** `PageTextObjectsPacked.objects` kind codes. */
export const PACKED_TEXT_OBJECT_KINDS: readonly PageContentObjectKind[] = [
  'text',
  'path',
  'image',
  'shading',
  'unknown',
];
export const PACKED_GLYPH_SPACE = 1;
export const PACKED_GLYPH_STACKED = 2;

/** The buffers of a packed snapshot, for a transfer list. */
export function packedTextObjectsBuffers(packed: PageTextObjectsPacked): ArrayBuffer[] {
  return [
    packed.objects,
    packed.objectMarks,
    packed.objectNumbers,
    packed.glyphCodes,
    packed.glyphIndexes,
    packed.glyphNumbers,
    packed.glyphFlags,
  ].map((a) => a.buffer as ArrayBuffer);
}

/** `PageTextObjectsPacked` back to the snapshot it encodes. */
export function unpackPageTextObjects(packed: PageTextObjectsPacked): PageTextObjectsSnapshot {
  const { objects: o, objectMarks, objectNumbers: n } = packed;
  const objects: PageContentObject[] = [];
  for (let i = 0; i * PACKED_TEXT_OBJECT_STRIDE < o.length; i++) {
    const at = i * PACKED_TEXT_OBJECT_STRIDE;
    const kind = PACKED_TEXT_OBJECT_KINDS[o[at]] ?? 'unknown';
    const marks = Array.from(objectMarks.subarray(o[at + 4], o[at + 4] + o[at + 5]));
    if (kind !== 'text') {
      objects.push({ kind, marks });
      continue;
    }
    const num = i * PACKED_TEXT_OBJECT_NUMBERS;
    const glyphs: PageTextGlyph[] = [];
    for (let g = o[at + 2], end = g + o[at + 3]; g < end; g++) {
      const flags = packed.glyphFlags[g];
      glyphs.push({
        index: packed.glyphIndexes[g],
        unicode: String.fromCodePoint(packed.glyphCodes[g]),
        origin: { x: packed.glyphNumbers[g * 3], y: packed.glyphNumbers[g * 3 + 1] },
        advance: packed.glyphNumbers[g * 3 + 2],
        ...(flags & PACKED_GLYPH_SPACE ? { space: true as const } : {}),
        ...(flags & PACKED_GLYPH_STACKED ? { stacked: true as const } : {}),
      });
    }
    objects.push({
      kind,
      marks,
      font: o[at + 1],
      fontSize: n[num],
      matrix: [n[num + 1], n[num + 2], n[num + 3], n[num + 4], n[num + 5], n[num + 6]],
      ...(o[at + 6] ? { reversed: true as const } : {}),
      glyphs,
    });
  }
  return { objects, marks: packed.marks, fonts: packed.fonts };
}
