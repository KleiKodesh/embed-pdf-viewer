// PDF.js document-level getters over the engine: getOutline(), getAttachments(),
// getPageLabels(), getPageMode(), getDestination(id) and getMetadata()'s info, in the shapes
// PDF.js's API returns (src/display/api.js, src/core/catalog.js, src/core/document.js).
import type { DocumentFileInfo } from '@embedpdf/engine-core';
import type {
  DocumentHandle,
  OutlineItem as EngineOutlineItem,
  PageDestination,
  PageLayout,
  PdfDestination,
} from '@embedpdf/engine-core/public';
import { pdfDestinationOf } from '@embedpdf/engine-core/public';

import { md5 } from './md5';

export interface PdfRef {
  num: number;
  gen: number;
}
export type ExplicitDest = [PdfRef, { name: string }, ...(number | null)[]];

/** One item of PDF.js `getOutline()`. */
export interface OutlineItem {
  action: string | null;
  dest: ExplicitDest | string | null;
  url: string | null;
  unsafeUrl?: string;
  newWindow?: boolean;
  title: string;
  color: Uint8ClampedArray;
  count: number | undefined;
  bold: boolean;
  italic: boolean;
  items: OutlineItem[];
}

/** One value of PDF.js `getAttachments()`. */
export interface Attachment {
  rawFilename: string;
  filename: string;
  content: Uint8Array;
  description: string;
}

export interface DocInfo {
  outline: OutlineItem[] | null;
  attachments: Record<string, Attachment> | null;
  pageLabels: string[] | null;
  pageMode: string;
  /** Each page's object number, in page order (PDF.js page refs). */
  pageObjNums: number[];
}

/** PDF.js getPageMode() names. */
const PAGE_MODES: Record<DocumentFileInfo['pageMode'], string> = {
  none: 'UseNone',
  outlines: 'UseOutlines',
  thumbnails: 'UseThumbs',
  fullScreen: 'FullScreen',
  optionalContent: 'UseOC',
  attachments: 'UseAttachments',
};

const VIEW_NAMES: Record<PdfDestination['kind'], string> = {
  xyz: 'XYZ',
  fit: 'Fit',
  fitH: 'FitH',
  fitV: 'FitV',
  fitR: 'FitR',
  fitB: 'FitB',
  fitBH: 'FitBH',
  fitBV: 'FitBV',
};

/** The engine reads destinations as float32 (805.92 -> 805.9199829); PDF.js keeps the file's decimal. */
function decimal(x: number | null): number | null {
  return x === null ? null : parseFloat(Math.fround(x).toPrecision(7));
}

type Pages = readonly Pick<PageLayout, 'ref' | 'pdfCropBox'>[];

/** A page-space destination as PDF.js's explicit destination array: page ref, view, file coordinates. */
export function explicitDestOf(destination: PageDestination, pages: Pages): ExplicitDest | null {
  const page = pages.find((p) => p.ref.objectNumber === destination.page.objectNumber);
  if (!page) return null;
  const d = pdfDestinationOf(destination, page.pdfCropBox);
  const ref: PdfRef = { num: destination.page.objectNumber, gen: 0 };
  const view = { name: VIEW_NAMES[d.kind] };
  switch (d.kind) {
    case 'xyz':
      return [ref, view, decimal(d.left), decimal(d.top), decimal(d.zoom)];
    case 'fitH':
    case 'fitBH':
      return [ref, view, decimal(d.top)];
    case 'fitV':
    case 'fitBV':
      return [ref, view, decimal(d.left)];
    case 'fitR':
      return [ref, view, decimal(d.left), decimal(d.bottom), decimal(d.right), decimal(d.top)];
    default:
      return [ref, view];
  }
}

function colorOf(hex: string | null): Uint8ClampedArray {
  if (!hex) return new Uint8ClampedArray(3);
  const n = parseInt(hex.slice(1), 16);
  return new Uint8ClampedArray([(n >> 16) & 255, (n >> 8) & 255, n & 255]);
}

/**
 * PDF.js Catalog.documentOutline from the engine's outline. `/Count` is rebuilt from the tree
 * the way PDF writers set it (ISO 32000 12.3.3): an open item counts its visible descendants, a
 * closed one the negative of those that would show when opened; a leaf has none.
 */
export function outlineOf(items: readonly EngineOutlineItem[], pages: Pages): OutlineItem[] | null {
  if (!items.length) return null;
  const byParent = new Map<number, EngineOutlineItem[]>();
  for (const it of items) {
    const key = it.parent?.objectNumber ?? 0;
    let list = byParent.get(key);
    if (!list) byParent.set(key, (list = []));
    list.push(it);
  }
  const build = (parent: number): { out: OutlineItem[]; visible: number } => {
    const out: OutlineItem[] = [];
    let visible = 0;
    for (const it of byParent.get(parent) ?? []) {
      const kids = build(it.ref.objectNumber);
      const shown = kids.out.length + kids.visible;
      const t = it.target;
      const url = t?.kind === 'uri' ? t.uri : null;
      let dest: OutlineItem['dest'] = null;
      if (t?.kind === 'goto') dest = it.destinationName ?? explicitDestOf(t.destination, pages);
      out.push({
        action: t?.kind === 'named' ? t.name : null,
        dest,
        url,
        unsafeUrl: url ?? undefined,
        newWindow: undefined,
        title: it.title,
        color: colorOf(it.color),
        count: kids.out.length ? (it.open ? shown : -shown) : undefined,
        bold: it.bold,
        italic: it.italic,
        items: kids.out,
      });
      visible += it.open ? shown : 0;
    }
    return { out, visible };
  };
  return build(0).out;
}

/** PDF.js getDocument().getOutline/getAttachments/getPageLabels/getPageMode, read in one go. */
export async function readDocInfo(doc: DocumentHandle): Promise<DocInfo> {
  const [list, outline, file, attachmentList] = await Promise.all([
    doc.pages.list(),
    doc.outline.get(),
    doc.metadata.file(),
    doc.attachments.list(),
  ]);
  const pages = list.pages;
  let attachments: Record<string, Attachment> | null = null;
  for (const a of attachmentList.attachments) {
    attachments ??= Object.create(null) as Record<string, Attachment>;
    const content = await doc.attachments.download(a.ref);
    attachments[a.name] = {
      rawFilename: a.name,
      filename: a.name,
      content,
      description: a.description ?? '',
    };
  }
  return {
    outline: outlineOf(outline.items, pages),
    attachments,
    pageLabels: list.labels.length ? pages.map((p) => p.label ?? '') : null,
    pageMode: PAGE_MODES[file.pageMode] ?? 'UseNone',
    pageObjNums: pages.map((p) => p.ref.objectNumber),
  };
}

/** PDF.js pdfDocument.getDestination(id): the explicit destination a name stands for, or null. */
export async function getDestination(
  doc: DocumentHandle,
  id: string,
): Promise<ExplicitDest | null> {
  const destination = await doc.actions.resolveNamedDestination(id);
  if (!destination) return null;
  return explicitDestOf(destination, (await doc.pages.list()).pages);
}

export interface DocMeta {
  info: Record<string, unknown>;
  /** The XMP packet, or null. */
  xmp: string | null;
  contentLength: number;
  /** pdfDocument.fingerprints. */
  fingerprints: [string, string | null];
}

// PDF.js DocumentInfoValidators: the /Info entries it keeps, all strings but /Trapped.
const INFO_KEYS = [
  'Title',
  'Author',
  'Subject',
  'Keywords',
  'Creator',
  'Producer',
  'CreationDate',
  'ModDate',
];

/**
 * pdfDocument.getMetadata()'s info (PDFDocument.documentInfo), the XMP packet and
 * pdfDocument.fingerprints. `bytes` are the file as loaded: its length, the linearization check
 * and the fingerprint of a file without /ID come from them.
 */
export async function readDocMeta(doc: DocumentHandle, bytes: Uint8Array): Promise<DocMeta> {
  const [file, forms] = await Promise.all([
    doc.metadata.file(),
    doc.forms.list().catch(() => null),
  ]);
  const info: Record<string, unknown> = {
    PDFFormatVersion: file.version,
    Language: file.language,
    EncryptFilterName: doc.security.state.encryption.state === 'encrypted' ? 'Standard' : null,
    IsLinearized: isLinearized(bytes),
    IsAcroFormPresent: !!forms && forms.formKind !== 'none',
    IsXFAPresent: false,
    IsCollectionPresent: false,
    IsSignaturesPresent: false,
  };
  for (const key of INFO_KEYS) if (typeof file.info[key] === 'string') info[key] = file.info[key];
  if (typeof file.info.Trapped === 'string') info.Trapped = { name: file.info.Trapped };
  return {
    info,
    xmp: file.xmp === null ? null : file.xmp.replace(/^﻿/, ''),
    contentLength: bytes.length,
    fingerprints: fingerprintsOf(file.identifiers, bytes),
  };
}

// PDFDocument.fingerprints: the /ID strings (16 bytes, not all zero), else the MD5 of the
// first 1024 bytes.
function fingerprintsOf(
  ids: DocumentFileInfo['identifiers'],
  bytes: Uint8Array,
): [string, string | null] {
  const valid = (hex: string) => hex.length === 32 && !/^0+$/.test(hex);
  if (ids && valid(ids.permanent)) {
    const b = ids.changing;
    return [ids.permanent, b !== ids.permanent && valid(b) ? b : null];
  }
  return [
    Array.from(md5(bytes.subarray(0, 1024)), (x) => x.toString(16).padStart(2, '0')).join(''),
    null,
  ];
}

// Linearization.create: the first object is a /Linearized dict whose /L is the file length.
export function isLinearized(bytes: Uint8Array): boolean {
  const head = new TextDecoder('latin1').decode(bytes.subarray(0, 2048));
  const m = /(\d+)\s+(\d+)\s+obj\s*<<([\s\S]*?)>>/.exec(head);
  if (!m || !/\/Linearized/.test(m[3]!)) return false;
  const l = /\/L\s+(\d+)/.exec(m[3]!);
  return !!l && parseInt(l[1]!, 10) === bytes.length;
}
