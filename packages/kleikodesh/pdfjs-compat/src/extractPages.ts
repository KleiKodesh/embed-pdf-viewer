// pdfDocument.extractPages(pageInfos): PDF.js's page organizer output (save the reorganised
// document, export the selected pages, merge another PDF in), built on the engine's page
// verbs instead of PDF.js's PDFEditor.
//
// The page layout (which page lands where) is a port of PDFEditor.extractPages:
// #resolveInsertAfterIndices, #getFilteredPageIndices and its slot loop. The result is written
// as a new file ('rewrite'), like PDFEditor's.
//
// Outline, like PDFEditor #buildOutline: an item keeps its target when its page survives (it
// follows the page wherever it moved), an item whose page is gone loses its target and stays
// only while an item under it survives; links, URLs and other actions always stay. A page used
// twice keeps its items on its first use only, so the outline is written once. The outline of a
// merged-in PDF is appended after the document's own (PDFEditor merges every source's).
/* eslint-disable @typescript-eslint/no-explicit-any */
import type { Engine } from '@embedpdf/engine-core/public';

type Any = any;

/** One entry of PDF.js's `extractPages(pageInfos)`. */
export interface ExtractPageInfo {
  /** `null`: the open document (`base`). */
  document: Uint8Array | null;
  includePages?: (number | [number, number])[];
  excludePages?: (number | [number, number])[];
  pageIndices?: number[];
  insertAfter?: number;
  password?: string;
}
type PageInfo = ExtractPageInfo;

// --- layout: PDFEditor's, on page counts instead of loaded documents -----------------------

function filteredPageIndices(info: PageInfo, numPages: number) {
  if (!info.document && info.document !== null) return [];
  let keptIndices: Set<number> | undefined, keptRanges: [number, number][] | undefined;
  let deletedIndices: Set<number> | undefined, deletedRanges: [number, number][] | undefined;
  for (const page of info.includePages || []) {
    if (Array.isArray(page)) (keptRanges ||= []).push(page);
    else (keptIndices ||= new Set()).add(page);
  }
  for (const page of info.excludePages || []) {
    if (Array.isArray(page)) (deletedRanges ||= []).push(page);
    else (deletedIndices ||= new Set()).add(page);
  }
  const indices: number[] = [];
  for (let i = 0; i < numPages; i++) {
    if (deletedIndices?.has(i)) continue;
    if (deletedRanges?.some(([s, e]) => i >= s && i <= e)) continue;
    let takePage = false;
    if (keptIndices) takePage = keptIndices.has(i);
    if (!takePage && keptRanges) takePage = keptRanges.some(([s, e]) => i >= s && i <= e);
    if (!takePage && !keptIndices && !keptRanges) takePage = true;
    if (takePage) indices.push(i);
  }
  return indices;
}

function resolveInsertAfterIndices(pageInfos: PageInfo[], counts: number[]) {
  const sequence: number[] = [];
  const insertAfterList: { i: number; insertAfter: number; count: number }[] = [];
  for (let i = 0; i < pageInfos.length; i++) {
    const info = pageInfos[i];
    if (counts[i] < 0 || info.pageIndices) continue;
    const count = counts[i];
    if (info.insertAfter === undefined) for (let j = 0; j < count; j++) sequence.push(i);
    else insertAfterList.push({ i, insertAfter: info.insertAfter, count });
  }
  insertAfterList.sort((a, b) => a.insertAfter - b.insertAfter);
  if (insertAfterList.length > 0) {
    for (let i = 0; i < pageInfos.length; i++) {
      const info = pageInfos[i];
      if (counts[i] < 0 || !info.pageIndices) continue;
      if (info.pageIndices.length < counts[i])
        throw new Error(
          'extractPages: partial pageIndices cannot be combined with insertAfter entries.',
        );
    }
  }
  const hasExplicitLayout =
    insertAfterList.length > 0 && pageInfos.some((info, i) => counts[i] >= 0 && info.pageIndices);
  if (sequence.length === 0 && hasExplicitLayout) {
    const updated = pageInfos.slice();
    let maxExistingPos = -1;
    for (let i = 0; i < pageInfos.length; i++) {
      if (counts[i] >= 0 && pageInfos[i].pageIndices)
        for (const idx of pageInfos[i].pageIndices!) if (idx > maxExistingPos) maxExistingPos = idx;
    }
    let offset = 0;
    for (const { i, insertAfter, count } of insertAfterList) {
      const threshold = Math.min(Math.max(insertAfter, -1) + offset, maxExistingPos);
      for (let j = 0; j < updated.length; j++) {
        const e = updated[j];
        if (counts[j] < 0 || !e.pageIndices || e.pageIndices.every((idx) => idx <= threshold))
          continue;
        updated[j] = {
          ...e,
          pageIndices: e.pageIndices.map((idx) => (idx > threshold ? idx + count : idx)),
        };
      }
      const inserted: number[] = [];
      for (let k = 0; k < count; k++) inserted.push(threshold + 1 + k);
      const n = { ...updated[i], pageIndices: inserted };
      delete n.insertAfter;
      updated[i] = n;
      offset += count;
      maxExistingPos += count;
    }
    return updated;
  }
  let offset = 0;
  for (const { i, insertAfter, count } of insertAfterList) {
    sequence.splice(insertAfter + 1 + offset, 0, ...new Array(count).fill(i));
    offset += count;
  }
  const arr: number[][] = new Array(pageInfos.length);
  for (let pos = 0; pos < sequence.length; pos++) (arr[sequence[pos]] ||= []).push(pos);
  return pageInfos.map((info, i) => {
    if (counts[i] < 0 || info.pageIndices) return info;
    const n = { ...info, pageIndices: arr[i] || [] };
    delete n.insertAfter;
    return n;
  });
}

/** The new document's pages in order: [source index in pageInfos, page index in that source]. */
export function layoutPages(pageInfos: PageInfo[], numPages: number[]): [number, number][] {
  // counts[i] < 0: an entry without a document (PDF.js skips those).
  const counts = pageInfos.map((info, i) =>
    info.document === undefined ? -1 : filteredPageIndices(info, numPages[i]).length,
  );
  if (pageInfos.some((info) => info.insertAfter !== undefined))
    pageInfos = resolveInsertAfterIndices(pageInfos, counts);
  const oldPages: ([number, number] | null | undefined)[] = [];
  let newIndex = 0;
  for (let s = 0; s < pageInfos.length; s++) {
    const info = pageInfos[s];
    if (counts[s] < 0) continue;
    const { pageIndices } = info;
    if (pageIndices) newIndex = -1;
    let k = 0;
    for (const i of filteredPageIndices(info, numPages[s])) {
      let newPageIndex: number | undefined;
      if (pageIndices) newPageIndex = pageIndices[k++];
      if (newPageIndex === undefined) {
        if (newIndex !== -1) newPageIndex = newIndex++;
        else for (newPageIndex = 0; oldPages[newPageIndex] !== undefined; newPageIndex++);
      }
      oldPages[newPageIndex] = [s, i];
    }
  }
  return oldPages.filter((p): p is [number, number] => !!p);
}

// --- the engine side ---------------------------------------------------------------------------

type Doc = Any;
const openWith = (engine: Engine, bytes: Uint8Array, password?: string) =>
  engine.open(
    { kind: 'bytes', bytes: bytes.slice() },
    password ? { password } : undefined,
  ) as Promise<Doc>;
const refKey = (r: Any) => `${r?.objectNumber}:${r?.generation ?? 0}`;

/**
 * The new PDF, written by `engine`. `base` = the open document's bytes (with its pending outline and form edits
 * already written in); `null` entries of `pageInfos` stand for it.
 */
export async function extractPages(
  engine: Engine,
  base: Uint8Array,
  pageInfos: PageInfo[],
  password = '',
): Promise<Uint8Array> {
  const open = (bytes: Uint8Array, pw?: string) => openWith(engine, bytes, pw);
  const sources = pageInfos.map((info) =>
    info.document === null ? base : (info.document ?? null),
  );
  // Page counts first (layout), then the open document gets every other source inserted.
  const numPages: number[] = [];
  const others: { doc: Doc; outline: Any[] }[] = [];
  for (let s = 0; s < sources.length; s++) {
    const src = sources[s];
    if (!src) {
      numPages.push(0);
      continue;
    }
    if (src === base) {
      numPages.push(-1); // filled below
      continue;
    }
    const d = await open(src, pageInfos[s].password);
    others[s] = { doc: d, outline: (await d.outline.get()).items };
    numPages.push((await d.pages.list()).pages.length);
  }
  const doc = await open(base, password);
  try {
    const basePages: Any[] = (await doc.pages.list()).pages.map((p: Any) => p.ref);
    for (let s = 0; s < numPages.length; s++)
      if (numPages[s] === -1) numPages[s] = basePages.length;
    const layout = layoutPages(pageInfos, numPages);
    if (!layout.length) throw new Error('extractPages: no pages.');

    // Pages of every source as refs in `doc`: the open document's own; merged files go in at the end.
    const pagesOf: Any[][] = [];
    const insertedFrom = new Map<number, Any[]>();
    for (let s = 0; s < sources.length; s++) {
      if (sources[s] === base) pagesOf[s] = basePages;
      else if (others[s]) {
        const r = await doc.pages.insert(sources[s]!, 'end');
        pagesOf[s] = r.insertedPages;
        insertedFrom.set(s, r.insertedPages);
      }
    }
    // First use of a page takes the page itself, every other use a copy of it.
    const used = new Set<string>();
    const finalRefs: Any[] = [];
    for (const [s, i] of layout) {
      const ref = pagesOf[s][i];
      if (!used.has(refKey(ref))) {
        used.add(refKey(ref));
        finalRefs.push(ref);
      } else {
        finalRefs.push((await doc.pages.copy([ref], 'end')).insertedPages[0]);
      }
    }
    const keep = new Set(finalRefs.map(refKey));
    const all: Any[] = (await doc.pages.list()).pages.map((p: Any) => p.ref);
    const drop = all.filter((r) => !keep.has(refKey(r)));
    if (drop.length) await doc.pages.delete(drop);
    await doc.pages.reorder(finalRefs, 'start');

    // Merged files' outlines, after the document's own (targets on their inserted pages).
    for (const [s, o] of others.entries())
      if (o?.outline.length) await copyOutline(doc, o.doc, o.outline, insertedFrom.get(s)!);
    await pruneOutline(doc, new Set((await doc.pages.list()).pages.map((p: Any) => refKey(p.ref))));
    return await doc.download({ mode: 'rewrite' });
  } finally {
    await doc.close();
    for (const o of others) await o?.doc.close();
  }
}

/** PDFEditor #filterOutlineItems: an item whose page is gone loses its target, and goes when
 *  nothing under it survives either. */
async function pruneOutline(doc: Doc, pages: Set<string>) {
  const items: Any[] = (await doc.outline.get()).items;
  const kids = new Map<string, Any[]>();
  for (const it of items) {
    const k = it.parent ? refKey(it.parent) : '';
    const l = kids.get(k);
    if (l) l.push(it);
    else kids.set(k, [it]);
  }
  const hasValidOwnDest = (it: Any) => {
    const t = it.target;
    if (!t) return false;
    if (t.kind === 'goto') return !!t.destination && pages.has(refKey(t.destination.page));
    // Other targets (URL, named action, launch...) stay, like PDF.js's action items. A target the
    // engine reads as 'unsupported' (a page that is gone among them) counts as none.
    return t.kind !== 'unsupported';
  };
  // Depth first, children before the parent: returns whether the item stays.
  const visit = async (it: Any): Promise<boolean> => {
    let anyKid = false;
    for (const c of kids.get(refKey(it.ref)) ?? []) if (await visit(c)) anyKid = true;
    const own = hasValidOwnDest(it);
    if (own || anyKid) {
      if (!own && it.target) await doc.outline.update(it.ref, { target: null });
      return true;
    }
    await doc.outline.delete(it.ref);
    return false;
  };
  for (const it of kids.get('') ?? []) await visit(it);
}

/** Appends `items` (another document's outline) to `doc`'s, targets moved onto the copies of
 *  that document's pages (`inserted`, in its page order). */
async function copyOutline(doc: Doc, srcDoc: Doc, items: Any[], inserted: Any[]) {
  const srcPages: Any[] = (await srcDoc.pages.list()).pages.map((p: Any) => p.ref);
  const index = new Map(srcPages.map((r, i) => [refKey(r), i]));
  const created = new Map<string, Any>();
  for (const it of items) {
    const t = it.target;
    let target: Any = null;
    if (t?.kind === 'goto' && t.destination) {
      const i = index.get(refKey(t.destination.page));
      if (i !== undefined && inserted[i])
        target = { ...t, destination: { ...t.destination, page: inserted[i] } };
    } else if (t?.kind === 'uri') target = t;
    const parent = it.parent ? (created.get(refKey(it.parent)) ?? null) : null;
    const r = await doc.outline.create(
      { title: it.title, target, color: it.color ?? null, bold: !!it.bold, italic: !!it.italic },
      { parent, position: 'end' },
    );
    created.set(refKey(it.ref), r.item.ref);
  }
}
