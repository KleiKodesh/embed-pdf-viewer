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
  /** Absent on a comment set on an annotation without an editor: `page` says it then. */
  pageIndex?: number;
  /** The page view's page (`AnnotationElement.commentText` stores it instead of `pageIndex`). */
  page?: { _pageIndex?: number; pageNumber?: number } | null;
  /** `[x1, y1, x2, y2]` where the annotation stands on the page. */
  rect?: number[];
  /** The view's rotation the editor was made in, in degrees counterclockwise. */
  rotation?: number;
  /**
   * The annotation this edits or deletes, as {@link annotationIdOf} names it
   * (`"<objectNumber>R"`); absent for a new one.
   */
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

const BASE_PREFIX = 'annot_base';

/**
 * The PDF.js id of an engine annotation: `"<objectNumber>R"` like PDF.js, or
 * `"annot_base<i>"` for one inline in the page's `/Annots` (PDF.js gives those
 * an `annot_` id too), so every annotation can be named back.
 */
export function annotationIdOf(ref: AnnotationRef | null | undefined): string | null {
  if (!ref) return null;
  return ref.kind === 'objectNumber' ? `${ref.objectNumber}R` : `${BASE_PREFIX}${ref.baseIndex}`;
}

/** The engine ref an {@link annotationIdOf} id names on `page`; null for any other id. */
export function annotationRefOf(
  page: PageRef,
  id: string | null | undefined,
): AnnotationRef | null {
  if (!id) return null;
  const objectNumber = /^(\d+)R$/.exec(id);
  if (objectNumber) return { kind: 'objectNumber', page, objectNumber: Number(objectNumber[1]) };
  if (id.startsWith(BASE_PREFIX)) {
    const rest = id.slice(BASE_PREFIX.length);
    if (/^\d+$/.test(rest)) return { kind: 'baseIndex', page, baseIndex: Number(rest) };
  }
  return null;
}

function pageIndexOf(value: PdfjsEditorValue): number | undefined {
  if (Number.isInteger(value.pageIndex)) return value.pageIndex;
  const page = value.page;
  if (Number.isInteger(page?._pageIndex)) return page!._pageIndex;
  if (Number.isInteger(page?.pageNumber)) return page!.pageNumber! - 1;
  return undefined;
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

  /** Each page's annotations by id, read once, before any write. */
  const listed = new Map<
    number,
    Promise<Map<string, { popup: AnnotationRef | null; top: number | null }>>
  >();
  const existing = async (index: number, ref: AnnotationRef) => {
    let byId = listed.get(index);
    if (!byId) {
      byId = doc
        .page(pages[index].ref)
        .annotations.list()
        .then(
          (read) =>
            new Map(
              read.annotations.map((a) => {
                const at = a as { popup?: AnnotationRef | null; rect?: { y: number } };
                return [
                  annotationIdOf(a.ref) ?? '',
                  { popup: at.popup ?? null, top: at.rect?.y ?? null },
                ];
              }),
            ),
        );
      listed.set(index, byId);
    }
    return (await byId).get(annotationIdOf(ref) ?? '') ?? { popup: null, top: null };
  };

  for (const value of list) {
    const pageIndex = pageIndexOf(value);
    const page = pageIndex === undefined ? undefined : pages[pageIndex];
    if (!page) {
      out.skipped.push({ value, reason: `no page ${String(pageIndex)}` });
      continue;
    }
    const ref = annotationRefOf(page.ref, value.id == null ? null : String(value.id));
    if (value.id && !ref) {
      out.skipped.push({ value, reason: `unknown annotation id ${String(value.id)}` });
      continue;
    }
    const annotations = doc.page(page.ref).annotations;
    try {
      if (value.deleted) {
        if (!ref) continue;
        // The annotation goes with its comment window (PDF.js deletes `popupRef` too).
        const { popup } = await existing(pageIndex!, ref);
        await annotations.delete(ref);
        out.deleted.push(ref);
        if (popup) {
          await annotations.delete(popup).catch(() => undefined);
          out.deleted.push(popup);
        }
      } else if (ref) {
        const patch = patchOf(value, page);
        const comment = commentOf(value);
        const { popup, top } =
          comment === undefined ? { popup: null, top: null } : await existing(pageIndex!, ref);
        if (Object.keys(patch).length > 0) {
          const updated = await annotations.update(ref, patch as AnnotationPatch);
          await drawInk(annotations, value, updated.annotation, page.crop);
          out.updated.push(ref);
        }
        if (comment === null && popup) {
          // A deleted comment: PDF.js drops `/Popup`, `/Contents`, `/RC` and the window.
          await annotations.delete(popup);
          out.deleted.push(popup);
        } else if (comment != null && !popup) {
          // A first comment gets its window, like a new annotation's (PopupAnnotation.createNewDict).
          const made = await annotations.create({
            subtype: 'popup',
            rect: popupBoxOf(value, page.crop, top),
            parent: ref,
            open: false,
          } as AnnotationDraft);
          out.created.push(made.annotation.ref);
        }
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
        await drawInk(annotations, value, result.annotation, page.crop);
        out.created.push(result.annotation.ref);
        // PopupAnnotation.createNewDict: a comment gets its window, linked both ways.
        if (commentOf(value)) {
          const popup = await annotations.create({
            subtype: 'popup',
            rect: popupBoxOf(value, page.crop, null),
            parent: result.annotation.ref,
            open: false,
          } as AnnotationDraft);
          out.created.push(popup.annotation.ref);
        }
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
          // PDF.js's `/DA` color is the text's; the engine writes `/DA` from `color`.
          ...(value.color ? { color: hexOf(value.color), fontColor: hexOf(value.color) } : {}),
          ...alignOf(value.value),
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
      // PDF.js keeps the alt text in the structure tree (a /Figure with /Alt), which the
      // engine can't write; as /Contents it would reopen as a comment, so it stays out.
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

/**
 * PDF.js draws ink as smoothed Bézier curves (`paths.lines`); the engine joins
 * `/InkList` points with straight segments. Once the engine has placed the
 * ink (its `/Rect`), PDF.js's curves become its appearance, drawn into that
 * rect in page space.
 */
async function drawInk(
  annotations: ReturnType<DocumentHandle['page']>['annotations'],
  value: PdfjsEditorValue,
  annotation: { ref: AnnotationRef; subtype: string; rect?: unknown },
  crop: PdfRect,
): Promise<void> {
  const lines = value.paths?.lines;
  if (value.annotationType !== AnnotationEditorType.INK || annotation.subtype !== 'ink') return;
  if (!lines?.length) return;
  const box = annotation.rect as
    | { x: number; y: number; width: number; height: number }
    | undefined;
  if (!box) return;
  const left = crop.left + box.x;
  const top = crop.top - box.y;
  const appearance = drawingPdf({
    rect: [left, top - box.height, left + box.width, top],
    lines,
    color: value.color ?? [0, 0, 0],
    thickness: positive(value.thickness),
    areContours: false,
    opacity: value.opacity,
  });
  await annotations.update(
    annotation.ref,
    {} as AnnotationPatch,
    {
      resources: { appearance },
    } as never,
  );
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
      if (value.color) patch.color = patch.fontColor = hexOf(value.color);
      if (value.value != null)
        Object.assign(patch, alignOf(value.value), { richText: richTextOf(value.value) });
      break;
    case AnnotationEditorType.STAMP:
    case AnnotationEditorType.SIGNATURE:
      if (value.rect) Object.assign(patch, turnedBox(value.rect, value.rotation, page.crop));
      break;
  }
  return patch;
}

/**
 * Where a comment's window goes: the rect PDF.js gives it, else where
 * `AnnotationEditor.addComment` puts one: 180×100 just right of the page, its
 * top level with the annotation's (`existingTop`, page space, for one without
 * a rect in the value).
 */
function popupBoxOf(value: PdfjsEditorValue, crop: PdfRect, existingTop: number | null) {
  const r = value.popup?.rect;
  if (r && r.length === 4) {
    const topLeft = pointOf(Math.min(r[0], r[2]), Math.max(r[1], r[3]), crop);
    return { ...topLeft, width: Math.abs(r[2] - r[0]), height: Math.abs(r[3] - r[1]) };
  }
  const at = value.rect ?? boundsOf(value.quadPoints);
  const top = at ? pointOf(0, Math.max(at[1], at[3]), crop).y : (existingTop ?? 0);
  return { x: crop.right - crop.left + 1, y: top, width: 180, height: 100 };
}

function boundsOf(quads: ArrayLike<number> | null | undefined): number[] | null {
  if (!quads || quads.length < 8) return null;
  let [x1, y1, x2, y2] = [Infinity, Infinity, -Infinity, -Infinity];
  for (let i = 0; i + 1 < quads.length; i += 2) {
    x1 = Math.min(x1, quads[i]);
    x2 = Math.max(x2, quads[i]);
    y1 = Math.min(y1, quads[i + 1]);
    y2 = Math.max(y2, quads[i + 1]);
  }
  return [x1, y1, x2, y2];
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
  const body = isRtl(text) ? { body: { align: 'right', dir: 'rtl' } } : {};
  return { ...body, paragraphs: text.split('\n').map((line) => ({ runs: [{ text: line }] })) };
}

/**
 * Right-to-left text (its first strong character is Hebrew or Arabic, as `dir="auto"` decides):
 * the free text editor shows it right-aligned, so it is saved right-aligned (`/Q 2`).
 */
function isRtl(text: string): boolean {
  const strong = /[A-Za-zÀ-ɏͰ-ϿЀ-ӿ]|([֐-ࣿיִ-﷿ﹰ-﻿])/u.exec(text);
  return !!strong?.[1];
}

function alignOf(text: string): Record<string, unknown> {
  return isRtl(text) ? { textAlign: 'right' } : {};
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
