import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createLocalEngine } from '@embedpdf/engine';
import type { Engine } from '@embedpdf/engine-core/public';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildTextContent } from '../src';

const here = dirname(fileURLToPath(import.meta.url));
const samplePath = resolve(here, '../../../../examples/engine-runtime-demo/public/sample.pdf');
let engine: Engine;

beforeAll(async () => {
  engine = (await createLocalEngine({ runtime: { prefer: 'wasm' } })) as unknown as Engine;
});
afterAll(async () => {
  await engine?.destroy();
});

describe('buildTextContent', () => {
  it('gives the same content from objects() and objectsPacked()', async () => {
    const doc = await engine.open({ kind: 'bytes', bytes: new Uint8Array(await readFile(samplePath)) });
    try {
      const pages = (await doc.pages.list()).pages;
      expect(pages.length > 0).toBe(true);
      for (const page of pages.slice(0, 3)) {
        const text = doc.page(page.ref).text;
        const [snapshot, packed] = await Promise.all([text.objects(), text.objectsPacked()]);
        for (const plain of [false, true]) {
          const opts = { viewBox: [0, 0, 10000, 10000], pageObjNum: 1, plain };
          const content = buildTextContent(snapshot, opts);
          expect(content.items.length > 0).toBe(true);
          expect(buildTextContent(packed, opts)).toEqual(content);
        }
      }
    } finally {
      await doc.close();
    }
  });
});
