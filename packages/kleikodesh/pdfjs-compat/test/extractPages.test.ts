import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createLocalEngine } from '@embedpdf/engine';
import type { Engine } from '@embedpdf/engine-core/public';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { extractPages, layoutPages } from '../src';

const here = dirname(fileURLToPath(import.meta.url));
const samplePath = resolve(here, '../../../../examples/engine-runtime-demo/public/sample.pdf');
let engine: Engine;
let withOutline: Uint8Array;

beforeAll(async () => {
  engine = (await createLocalEngine({ runtime: { prefer: 'wasm' } })) as unknown as Engine;
  const doc = await engine.open({
    kind: 'bytes',
    bytes: new Uint8Array(await readFile(samplePath)),
  });
  try {
    const pages = (await doc.pages.list()).pages;
    for (const [i, page] of pages.slice(0, 2).entries()) {
      await doc.outline.create(
        {
          title: `item ${i}`,
          target: { kind: 'goto', destination: { kind: 'fit', page: page.ref } },
        } as never,
        { parent: null, position: 'end' } as never,
      );
    }
    withOutline = await doc.download({ mode: 'rewrite' } as never);
  } finally {
    await doc.close();
  }
}, 120_000);
afterAll(async () => {
  await engine.destroy();
});

async function read(bytes: Uint8Array) {
  const doc = await engine.open({ kind: 'bytes', bytes: bytes.slice() });
  try {
    const pages = (await doc.pages.list()).pages.map((p) => p.ref.objectNumber);
    const items = (await doc.outline.get()).items.map((it) => {
      const target = it.target as {
        kind: string;
        destination?: { page: { objectNumber: number } };
      } | null;
      return {
        title: it.title,
        page: target?.destination ? pages.indexOf(target.destination.page.objectNumber) : null,
      };
    });
    return { numPages: pages.length, items };
  } finally {
    await doc.close();
  }
}

describe('extractPages', () => {
  it('lays pages out like PDFEditor', () => {
    expect(layoutPages([{ document: null, pageIndices: [2, 0, 1] }], [3])).toEqual([
      [0, 1],
      [0, 2],
      [0, 0],
    ]);
    expect(layoutPages([{ document: null, excludePages: [1] }], [3])).toEqual([
      [0, 0],
      [0, 2],
    ]);
  });

  it('writes the outline once when a page is used twice, and drops items of removed pages', async () => {
    const before = await read(withOutline);
    expect(before.items).toEqual([
      { title: 'item 0', page: 0 },
      { title: 'item 1', page: 1 },
    ]);
    const copied = await read(
      await extractPages(engine, withOutline, [
        { document: null },
        { document: null, includePages: [0] },
      ]),
    );
    expect(copied.items).toEqual(before.items);
    expect(copied.numPages).toBe(before.numPages + 1);

    const dropped = await read(
      await extractPages(engine, withOutline, [{ document: null, excludePages: [1] }]),
    );
    expect(dropped.items).toEqual([{ title: 'item 0', page: 0 }]);
  }, 120_000);
});
