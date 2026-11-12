import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createLocalEngine } from '@embedpdf/engine';
import type { Engine } from '@embedpdf/engine-core/public';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { getDestination, isLinearized, readDocInfo, readDocMeta } from '../src';

const here = dirname(fileURLToPath(import.meta.url));
const samplePath = resolve(here, '../../../../examples/engine-runtime-demo/public/sample.pdf');
let engine: Engine;
let sample: Uint8Array;
let withOutline: Uint8Array;

beforeAll(async () => {
  engine = (await createLocalEngine({ runtime: { prefer: 'wasm' } })) as unknown as Engine;
  sample = new Uint8Array(await readFile(samplePath));
  const doc = await engine.open({ kind: 'bytes', bytes: sample.slice() });
  try {
    const pages = (await doc.pages.list()).pages;
    const parent = await doc.outline.create(
      {
        title: 'parent',
        bold: true,
        open: false,
        target: { kind: 'goto', destination: { kind: 'fit', page: pages[0]!.ref } },
      } as never,
      { parent: null, position: 'end' } as never,
    );
    const parentRef = (parent as unknown as { item: { ref: unknown } }).item.ref;
    await doc.outline.create(
      {
        title: 'child',
        target: { kind: 'goto', destination: { kind: 'fit', page: pages[1]!.ref } },
      } as never,
      { parent: parentRef, position: 'end' } as never,
    );
    withOutline = await doc.download({ mode: 'rewrite' } as never);
  } finally {
    await doc.close();
  }
}, 120_000);
afterAll(async () => {
  await engine.destroy();
});

describe('document info', () => {
  it('reads the outline in PDF.js shape with /Count rebuilt from the open state', async () => {
    const doc = await engine.open({ kind: 'bytes', bytes: withOutline.slice() });
    try {
      const info = await readDocInfo(doc);
      expect(info.outline).toHaveLength(1);
      const [parent] = info.outline!;
      expect(parent!.title).toBe('parent');
      expect(parent!.bold).toBe(true);
      expect(parent!.count).toBe(-1);
      expect(parent!.items[0]!.title).toBe('child');
      expect(parent!.items[0]!.count).toBeUndefined();
      const dest = parent!.dest as [{ num: number; gen: number }, { name: string }];
      expect(dest[0].num).toBe(info.pageObjNums[0]);
      expect(dest[1]).toEqual({ name: 'Fit' });
      expect(info.pageMode).toBe('UseNone');
      expect(info.attachments).toBeNull();
      expect(await getDestination(doc, 'no-such-name')).toBeNull();
    } finally {
      await doc.close();
    }
  });

  it('reads metadata and fingerprints', async () => {
    const doc = await engine.open({ kind: 'bytes', bytes: sample.slice() });
    try {
      const meta = await readDocMeta(doc, sample);
      expect(meta.contentLength).toBe(sample.length);
      expect(meta.info.IsLinearized).toBe(false);
      expect(typeof meta.info.PDFFormatVersion).toBe('string');
      expect(meta.fingerprints[0]).toMatch(/^[0-9a-f]{32}$/);
    } finally {
      await doc.close();
    }
  });

  it('detects linearization only when /L matches the length', () => {
    const head = new TextEncoder().encode('%PDF-1.7\n1 0 obj\n<< /Linearized 1 /L 60 >>\nendobj\n');
    const bytes = new Uint8Array(60);
    bytes.set(head);
    expect(isLinearized(bytes)).toBe(true);
    expect(isLinearized(bytes.subarray(0, 59))).toBe(false);
  });
});
