import { createLocalEngine } from '@embedpdf/engine';
import type { Engine } from '@embedpdf/engine-core/public';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { extractPages } from '../src';
import { PdfFile, isDict, isName, isRef, type PdfValue } from '../src/pdfFile';

let engine: Engine;

beforeAll(async () => {
  engine = (await createLocalEngine({ runtime: { prefer: 'wasm' } })) as unknown as Engine;
}, 120_000);
afterAll(async () => {
  await engine.destroy();
});

/** A tagged 3-page PDF: one /P element per page (MCID 0), a link on page 1 to page 2. */
function taggedPdf(): Uint8Array {
  const objs: string[] = [];
  objs[1] = '<< /Type /Catalog /Pages 2 0 R /StructTreeRoot 20 0 R /MarkInfo << /Marked true >> >>';
  objs[2] = '<< /Type /Pages /Kids [3 0 R 4 0 R 5 0 R] /Count 3 >>';
  for (let i = 0; i < 3; i++) {
    const annots = i === 0 ? ' /Annots [30 0 R]' : '';
    objs[3 + i] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents ${10 + i} 0 R /StructParents ${i}${annots} >>`;
    const content = `/P <</MCID 0>> BDC 0 0 m 10 ${10 + i} l S EMC`;
    objs[10 + i] = `<< /Length ${content.length} >>\nstream\n${content}\nendstream`;
    objs[21 + i] = `<< /Type /StructElem /S /P /P 24 0 R /Pg ${3 + i} 0 R /K 0 /ID (p${i}) >>`;
  }
  objs[24] = '<< /Type /StructElem /S /Document /P 20 0 R /K [21 0 R 22 0 R 23 0 R] >>';
  objs[25] = '<< /Nums [0 [21 0 R] 1 [22 0 R] 2 [23 0 R]] >>';
  objs[26] = '<< /Names [(p0) 21 0 R (p1) 22 0 R (p2) 23 0 R] >>';
  objs[20] =
    '<< /Type /StructTreeRoot /K 24 0 R /ParentTree 25 0 R /ParentTreeNextKey 3 /IDTree 26 0 R >>';
  objs[30] = '<< /Type /Annot /Subtype /Link /Rect [0 0 50 50] /Dest [4 0 R /Fit] >>';
  let out = '%PDF-1.7\n';
  const offsets: number[] = [];
  for (let n = 1; n < objs.length; n++) {
    if (!objs[n]) continue;
    offsets[n] = out.length;
    out += `${n} 0 obj\n${objs[n]}\nendobj\n`;
  }
  const xref = out.length;
  out += `xref\n0 ${objs.length}\n0000000000 65535 f\r\n`;
  for (let n = 1; n < objs.length; n++)
    out +=
      offsets[n] === undefined
        ? '0000000000 65535 f\r\n'
        : `${String(offsets[n]).padStart(10, '0')} 00000 n\r\n`;
  out += `trailer\n<< /Size ${objs.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(out);
}

function structure(bytes: Uint8Array) {
  const f = new PdfFile(bytes);
  const root = f.deref(f.trailer.get('Root')) as Map<string, PdfValue>;
  const pages = (
    f.deref((f.deref(root.get('Pages')) as Map<string, PdfValue>).get('Kids')) as PdfValue[]
  ).map((p) => (isRef(p) ? p.ref[0] : -1));
  const pageDicts = pages.map((n) => f.read(n) as Map<string, PdfValue>);
  const elems = f
    .numbers()
    .map((n) => f.read(n))
    .filter((v): v is Map<string, PdfValue> => isDict(v) && isName(v.get('Type'), 'StructElem'));
  const st = f.deref(root.get('StructTreeRoot')) as Map<string, PdfValue>;
  const nums = (f.deref(st.get('ParentTree')) as Map<string, PdfValue>).get('Nums') as PdfValue[];
  return {
    numObjects: f.numbers().length,
    structParents: pageDicts.map((d) => d.get('StructParents')),
    elemPages: elems
      .filter((e) => e.has('Pg'))
      .map((e) => pages.indexOf((e.get('Pg') as { ref: [number, number] }).ref[0]))
      .sort(),
    parentTreeKeys: nums.filter((_, i) => i % 2 === 0),
    links: pageDicts.map((d) =>
      Array.isArray(d.get('Annots')) ? (d.get('Annots') as PdfValue[]).length : 0,
    ),
  };
}

describe('organizer post-pass (PDFEditor structure tree)', () => {
  it('drops the structure of removed pages and gives a copied page its own', async () => {
    // New order: page 3, page 1, page 1 again (copy); page 2 removed.
    const out = await extractPages(engine, taggedPdf(), [
      { document: null, includePages: [0, 2], pageIndices: [1, 0] },
      { document: null, includePages: [0], pageIndices: [2] },
    ]);
    const s = structure(out);
    expect(s.structParents).toEqual([0, 1, 2]);
    expect(s.elemPages).toEqual([0, 1, 2]);
    expect(s.parentTreeKeys).toEqual([0, 1, 2]);
    // The link to the removed page is gone, and nothing keeps that page alive.
    expect(s.links).toEqual([0, 0, 0]);
    expect(s.numObjects).toBe(
      // catalog, pages, 3 pages + 3 contents, root, 2 Document elems, 3 P elems, parent tree, id tree
      1 + 1 + 6 + 1 + 2 + 3 + 1 + 1,
    );
  });
});
