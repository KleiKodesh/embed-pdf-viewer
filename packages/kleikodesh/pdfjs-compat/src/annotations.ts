import type {
  AnnotationDraft,
  AnnotationPatch,
  AnnotationRef,
  DocumentHandle,
  PageRef,
  PdfRect,
} from '@embedpdf/engine-core/public';

import { drawingPdf } from './drawingPdf';

/** PDF.js `AnnotationEditorType`. */
export const AnnotationEditorType = {
  FREETEXT: 3,
  HIGHLIGHT: 9,
  STAMP: 13,
  INK: 15,
  SIGNATURE: 101,
} as const;

/**
 * One value of PDF.js's `annotationStorage.serializable`, as an editor's
 * `serialize()` returns it: in the file's coordinates, colors as 0–255 RGB.
 * Fields PDF.js doesn't set for a type are absent.
 */
export interface PdfjsEditorValue {
  annotationType?: number;
  pageIndex: number;
  /** `[x1, y1, x2, y2]` where the annotation stands on the page. */
  rect?: number[];
  /** The view's rotation the editor was made in, in degrees counterclockwise. */
  rotation?: number;
  /** `"<objectNumber>R"` of the annotation this edits or deletes; absent for a new one. */
  id?: string | null;
  deleted?: boolean;
  color?: number[] | null;
  opacity?: number;
  thickness?: number;
  /** Highlight: 8 numbers per quad (upper left, upper right, lower left, lower right). */
  quadPoints?: ArrayLike<number> | null;
  /** Free highlight: the outline and the points it was drawn through. */
  outlines?:
    | { outline?: ArrayLike<number>; points?: ArrayLike<number>[] }
    | ArrayLike<number>[]
    | null;
  /** Ink: the strokes, as Bézier `lines` and plain `points`. */
  paths?: { lines?: ArrayLike<number>[]; points?: ArrayLike<number>[] } | null;
  /** Free text. */
  value?: string;
  fontSize?: number;
  /** Stamp: the image's id in PDF.js's image manager. */
  bitmapId?: string;
  /** Stamp: the image, on the first value that uses `bitmapId`. */
  bitmap?: unknown;
  isSvg?: boolean;
  /** Signature. */
  isSignature?: boolean;
  areContours?: boolean;
  lines?: ArrayLike<number>[];
  accessibilityData?: { type?: string; alt?: string; structParent?: number } | null;
  /** The comment: its text, or `deleted` to remove it. */
  popup?: { contents?: string; deleted?: boolean; rect?: number[] } | null;
  [key: string]: unknown;
}

export interface ApplyAnnotationOptions {
  /**
   * A stamp's image bytes (PNG, JPEG or a one-page PDF) by its `bitmapId`.
   * By default the `bitmap` PDF.js puts on the values is encoded as PNG
   * (needs `OffscreenCanvas`); a stamp with neither is skipped and reported.
   */
  stampImage?: (bitmapId: string) => Promise<Uint8Array | null> | Uint8Array | null;
}

export interface AppliedAnnotationEdits {
  created: AnnotationRef[];
  updated: AnnotationRef[];
  deleted: AnnotationRef[];
  /** Values that were not written, with why. */
  skipped: { value: PdfjsEditorValue; reason: string }[];
}

interface PageInfo {
  ref: PageRef;
  crop: PdfRect;
}

/**
 * Writes PDF.js editor values into `doc`: a value with an `id` updates or
 * deletes that annotation, one without creates a new one. The engine draws
 * every appearance. Run it inside `saveOutlineEdits`'s `alsoApply` to save
 * the edits with the outline and form values in one incremental update.
 */
export async function applyAnnotationEdits(
  doc: DocumentHandle,
  values: Iterable<PdfjsEditorValue>,
  options: ApplyAnnotationOptions = {},
): Promise<AppliedAnnotationEdits> {
  const layout = await doc.pages.list();
  const pages: PageInfo[] = layout.pages.map((page) => ({ ref: page.ref, crop: page.pdfCropBox }));
  const out: AppliedAnnotationEdits = { created: [], updated: [], deleted: [], skipped: [] };
  const list = [...values];
  const bitmaps = new Map<string, unknown>();
  for (const value of list) {
    if (value.bitmapId && value.bitmap && !bitmaps.has(value.bitmapId)) {
      bitmaps.set(value.bitmapId, value.bitmap);
    }
  }
  const stampImage =
    options.stampImage ??
    ((bitmapId: string) => (bitmaps.has(bitmapId) ? pngOfBitmap(bitmaps.get(bitmapId)) : null));

  for (const value of list) {
    const page = pages[value.pageIndex];
    if (!page) {
      out.skipped.push({ value, reason: `no page ${value.pageIndex}` });
      continue;
    }
    const objectNumber = value.id ? Number.parseInt(String(value.id), 10) : NaN;
    const ref: AnnotationRef | null = Number.isInteger(objectNumber)
      ? { kind: 'objectNumber', page: page.ref, objectNumber }
      : null;
    const annotations = doc.page(page.ref).annotations;
    try {
      if (value.deleted) {
        if (!ref) continue;
        await annotations.delete(ref);
        out.deleted.push(ref);
      } else if (ref) {
        const patch = patchOf(value, page);
        if (Object.keys(patch).length === 0) continue;
        await annotations.update(ref, patch as AnnotationPatch);
        out.updated.push(ref);
      } else {
        const made = await draftOf(value, page, stampImage);
        if ('reason' in made) {
          out.skipped.push({ value, reason: made.reason });
          continue;
        }
        const result = await annotations.create(
          made.draft as AnnotationDraft,
          {
            resources: made.resources,
          } as never,
        );
        out.created.push(result.annotation.ref);
      }
    } catch (error) {
      out.skipped.push({ value, reason: error instanceof Error ? error.message : String(error) });
    }
  }
  return out;
}

type Made =
  | { draft: Record<string, unknown>; resources?: Record<string, Uint8Array> }
  | { reason: string };

async function draftOf(
  value: PdfjsEditorValue,
  page: PageInfo,
  stampImage: NonNullable<ApplyAnnotationOptions['stampImage']>,
): Promise<Made> {
  const comment = commentOf(value);
  const base = comment == null ? {} : { contents: comment };
  switch (value.annotationType) {
    case AnnotationEditorType.HIGHLIGHT: {
      if (value.quadPoints && value.quadPoints.length >= 8) {
        return {
          draft: {
            subtype: 'highlight',
            ...base,
            ...colorFields(value),
            quadPoints: quadsOf(value.quadPoints, page.crop),
          },
        };
      }
      // A free highlight is an ink annotation that marks it as a highlight.
      const strokes = strokesOf(freeHighlightPoints(value), page.crop);
      if (strokes.length === 0) return { reason: 'free highlight without points' };
      return {
        draft: {
          subtype: 'ink',
          ...base,
          ...colorFields(value),
          intent: 'ink-highlight',
          strokeWidth: positive(value.thickness),
          inkList: strokes,
        },
      };
    }
    case AnnotationEditorType.INK: {
      const strokes = strokesOf(value.paths?.points ?? [], page.crop);
      if (strokes.length === 0) return { reason: 'ink without points' };
      return {
        draft: {
          subtype: 'ink',
          ...base,
          ...colorFields(value),
          strokeWidth: positive(value.thickness),
          inkList: strokes,
        },
      };
    }
    case AnnotationEditorType.FREETEXT: {
      if (!value.rect || value.value == null) return { reason: 'free text without rect or value' };
      return {
        draft: {
          subtype: 'free-text',
          ...turnedBox(value.rect, value.rotation, page.crop),
          fontSize: positive(value.fontSize, 10),
          // PDF.js writes no border (`/Border [0 0 0]`).
          strokeWidth: 0,
          ...(value.color ? { fontColor: hexOf(value.color) } : {}),
          richText: richTextOf(value.value),
        },
      };
    }
    case AnnotationEditorType.STAMP:
    case AnnotationEditorType.SIGNATURE: {
      if (!value.rect) return { reason: 'stamp without rect' };
      let appearance: Uint8Array | null = null;
      if (value.isSignature || value.annotationType === AnnotationEditorType.SIGNATURE) {
        appearance = drawingPdf({
          rect: value.rect,
          lines: value.lines ?? value.paths?.lines ?? [],
          color: value.color ?? [0, 0, 0],
          thickness: value.thickness ?? 0,
          areContours: !!value.areContours,
        });
      } else if (value.bitmapId) {
        appearance = await stampImage(value.bitmapId);
      }
      if (!appearance) return { reason: `no image for stamp ${value.bitmapId ?? ''}`.trim() };
      return {
        draft: {
          subtype: 'stamp',
          ...base,
          ...turnedBox(value.rect, value.rotation, page.crop),
          fit: 'fill',
        },
        resources: { appearance },
      };
    }
    default:
      return { reason: `unsupported annotationType ${String(value.annotationType)}` };
  }
}

/** The fields an edit of an existing annotation changes, as PDF.js serializes them. */
function patchOf(value: PdfjsEditorValue, page: PageInfo): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  const comment = commentOf(value);
  if (comment !== undefined) patch.contents = comment;
  switch (value.annotationType) {
    case AnnotationEditorType.HIGHLIGHT:
      Object.assign(patch, colorFields(value));
      break;
    case AnnotationEditorType.INK:
      Object.assign(patch, colorFields(value));
      if (value.thickness && value.thickness > 0) patch.strokeWidth = value.thickness;
      if (value.paths?.points?.length) patch.inkList = strokesOf(value.paths.points, page.crop);
      break;
    case AnnotationEditorType.FREETEXT:
      if (value.rect) Object.assign(patch, turnedBox(value.rect, value.rotation, page.crop));
      if (value.fontSize) patch.fontSize = value.fontSize;
      if (value.color) patch.fontColor = hexOf(value.color);
      if (value.value != null) patch.richText = richTextOf(value.value);
      break;
    case AnnotationEditorType.STAMP:
    case AnnotationEditorType.SIGNATURE:
      if (value.rect) Object.assign(patch, turnedBox(value.rect, value.rotation, page.crop));
      break;
  }
  return patch;
}

/** The comment a value sets: its text, `null` to remove it, `undefined` when it says nothing. */
function commentOf(value: PdfjsEditorValue): string | null | undefined {
  const popup = value.popup;
  if (!popup) return undefined;
  if (popup.deleted) return null;
  return popup.contents ?? undefined;
}

function colorFields(value: PdfjsEditorValue): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (value.color) out.color = hexOf(value.color);
  if (typeof value.opacity === 'number') out.opacity = Math.min(1, Math.max(0, value.opacity));
  return out;
}

export function hexOf(rgb: ArrayLike<number>): string {
  const part = (i: number) =>
    Math.round(Math.min(255, Math.max(0, Number(rgb[i]) || 0)))
      .toString(16)
      .padStart(2, '0');
  return `#${part(0)}${part(1)}${part(2)}`;
}

const positive = (n: number | undefined, fallback = 1) => (n && n > 0 ? n : fallback);

const pointOf = (x: number, y: number, crop: PdfRect) => ({ x: x - crop.left, y: crop.top - y });

function quadsOf(flat: ArrayLike<number>, crop: PdfRect) {
  const quads = [];
  for (let i = 0; i + 8 <= flat.length; i += 8) {
    quads.push({
      upperLeft: pointOf(flat[i], flat[i + 1], crop),
      upperRight: pointOf(flat[i + 2], flat[i + 3], crop),
      lowerLeft: pointOf(flat[i + 4], flat[i + 5], crop),
      lowerRight: pointOf(flat[i + 6], flat[i + 7], crop),
    });
  }
  return quads;
}

function strokesOf(strokes: ArrayLike<number>[], crop: PdfRect) {
  const out = [];
  for (const flat of strokes) {
    const points = [];
    for (let i = 0; i + 1 < flat.length; i += 2) {
      if (Number.isFinite(flat[i]) && Number.isFinite(flat[i + 1])) {
        points.push(pointOf(flat[i], flat[i + 1], crop));
      }
    }
    if (points.length) out.push(points);
  }
  return out;
}

function freeHighlightPoints(value: PdfjsEditorValue): ArrayLike<number>[] {
  const outlines = value.outlines;
  if (!outlines || Array.isArray(outlines) || !('points' in outlines)) return [];
  return outlines.points ?? [];
}

/**
 * A box kind's `box` and clockwise `rotation` from PDF.js's on-page rect and
 * its counterclockwise view rotation: at a quarter turn the box stands across
 * the rect, about the same middle.
 */
function turnedBox(rect: number[], rotation: number | undefined, crop: PdfRect) {
  const [x1, y1, x2, y2] = rect;
  const turn = (((rotation ?? 0) % 360) + 360) % 360;
  let width = Math.abs(x2 - x1);
  let height = Math.abs(y2 - y1);
  if (turn % 180 !== 0) [width, height] = [height, width];
  const cx = (x1 + x2) / 2;
  const cy = (y1 + y2) / 2;
  const topLeft = pointOf(cx - width / 2, cy + height / 2, crop);
  return {
    box: { x: topLeft.x, y: topLeft.y, width, height },
    rotation: turn === 0 ? null : 360 - turn,
  };
}

function richTextOf(text: string) {
  return { paragraphs: text.split('\n').map((line) => ({ runs: [{ text: line }] })) };
}

/** An `ImageBitmap` (or any canvas image source) as PNG bytes; null without `OffscreenCanvas`. */
async function pngOfBitmap(bitmap: unknown): Promise<Uint8Array | null> {
  const image = bitmap as { width?: number; height?: number } | null;
  if (!image?.width || !image.height || typeof OffscreenCanvas === 'undefined') return null;
  const canvas = new OffscreenCanvas(image.width, image.height);
  const context = canvas.getContext('2d');
  if (!context) return null;
  context.drawImage(bitmap as CanvasImageSource, 0, 0);
  const blob = await canvas.convertToBlob({ type: 'image/png' });
  return new Uint8Array(await blob.arrayBuffer());
}
