import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync, inflateSync } from 'node:zlib';

import { createLocalEngine } from '@embedpdf/engine';
import type { DocumentHandle, Engine } from '@embedpdf/engine-core/public';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AnnotationEditorType as T, applyAnnotationEdits, type PdfjsEditorValue } from '../src';

const here = dirname(fileURLToPath(import.meta.url));
const samplePath = resolve(here, '../../../../examples/engine-runtime-demo/public/sample.pdf');
let engine: Engine;
let sample: Uint8Array;

beforeAll(async () => {
  engine = (await createLocalEngine({ runtime: { prefer: 'wasm' } })) as unknown as Engine;
  sample = new Uint8Array(await readFile(samplePath));
});
afterAll(async () => {
  await engine.destroy();
});

/** Every stream in the file that inflates, as text. */
function inflatedStreams(pdf: Uint8Array): string[] {
  const bytes = Buffer.from(pdf);
  const out: string[] = [];
  for (let at = bytes.indexOf('stream'); at >= 0; at = bytes.indexOf('stream', at + 6)) {
    let start = at + 6;
    if (bytes[start] === 13) start++;
    if (bytes[start] === 10) start++;
    const end = bytes.indexOf('endstream', start);
    if (end < 0) break;
    try {
      out.push(inflateSync(bytes.subarray(start, end)).toString('latin1'));
    } catch {
      // Not Flate, or not a stream.
    }
  }
  return out;
}

/** A 2×2 red PNG. */
function png(): Uint8Array {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (bytes: Uint8Array) => {
    let c = 0xffffffff;
    for (const b of bytes) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Uint8Array) => {
    const out = new Uint8Array(12 + data.length);
    const view = new DataView(out.buffer);
    view.setUint32(0, data.length);
    out.set(new TextEncoder().encode(type), 4);
    out.set(data, 8);
    view.setUint32(8 + data.length, crc(out.subarray(4, 8 + data.length)));
    return out;
  };
  const ihdr = new Uint8Array(13);
  new DataView(ihdr.buffer).setUint32(0, 2);
  new DataView(ihdr.buffer).setUint32(4, 2);
  ihdr.set([8, 2, 0, 0, 0], 8);
  const raw = new Uint8Array([0, 255, 0, 0, 255, 0, 0, 0, 255, 0, 0, 255, 0, 0]);
  const parts = [
    new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', new Uint8Array(deflateSync(raw))),
    chunk('IEND', new Uint8Array()),
  ];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

async function open(bytes: Uint8Array) {
  return engine.open({ kind: 'bytes', bytes: bytes.slice() } as never);
}

async function annotationsOf(doc: DocumentHandle) {
  const page = (await doc.pages.list()).pages[0];
  return (await doc.page(page.ref).annotations.list()).annotations.filter(
    (a) => a.subtype !== 'popup',
  );
}

const created: PdfjsEditorValue[] = [
  {
    annotationType: T.HIGHLIGHT,
    pageIndex: 0,
    rect: [100, 700, 200, 712],
    color: [255, 255, 0],
    opacity: 1,
    thickness: 12,
    quadPoints: new Float32Array([100, 712, 200, 712, 100, 700, 200, 700]),
    popup: { contents: 'הערה', deleted: false },
  },
  {
    annotationType: T.HIGHLIGHT,
    pageIndex: 0,
    rect: [100, 600, 200, 620],
    color: [128, 235, 255],
    opacity: 1,
    thickness: 12,
    quadPoints: null,
    outlines: { outline: [], points: [[110, 610, 150, 612, 190, 610]] },
  },
  {
    annotationType: T.INK,
    pageIndex: 0,
    rect: [300, 500, 400, 560],
    color: [0, 0, 255],
    opacity: 0.5,
    thickness: 2,
    paths: {
      lines: [[NaN, NaN, NaN, NaN, 310, 510, 330, 540, 370, 540, 390, 510]],
      points: [[310, 510, 350, 550, 390, 510]],
    },
  },
  {
    annotationType: T.FREETEXT,
    pageIndex: 0,
    rect: [100, 400, 260, 430],
    rotation: 0,
    color: [255, 0, 0],
    fontSize: 14,
    value: 'שלום\nworld',
  },
  {
    annotationType: T.STAMP,
    pageIndex: 0,
    rect: [400, 300, 460, 360],
    rotation: 0,
    bitmapId: 'img1',
  },
  {
    annotationType: T.SIGNATURE,
    pageIndex: 0,
    rect: [100, 200, 220, 260],
    rotation: 0,
    isSignature: true,
    areContours: false,
    color: [0, 0, 0],
    thickness: 1,
    lines: [
      [NaN, NaN, NaN, NaN, 110, 210, 130, 250, 150, 250, 170, 210, NaN, NaN, NaN, NaN, 210, 250],
    ],
  },
];

describe('applyAnnotationEdits', () => {
  it('creates, then updates and deletes, and the incremental saves keep the original', async () => {
    const doc = await open(sample);
    let first: Uint8Array;
    try {
      const result = await applyAnnotationEdits(doc, created, { stampImage: () => png() });
      expect(result.skipped).toEqual([]);
      // Six annotations and the highlight's comment window.
      expect(result.created).toHaveLength(7);
      first = await doc.download({ mode: 'incremental' } as never);
    } finally {
      await doc.close();
    }
    expect(Buffer.from(first.subarray(0, sample.length)).equals(Buffer.from(sample))).toBe(true);
    // The ink's appearance is PDF.js's curve, not straight segments.
    expect(inflatedStreams(first).some((s) => s.includes('330 540 370 540 390 510 c'))).toBe(true);

    const again = await open(first);
    let second: Uint8Array;
    try {
      const read = await annotationsOf(again);
      const subtypes = read.map((a) => a.subtype);
      expect(subtypes).toEqual(['highlight', 'ink', 'ink', 'free-text', 'stamp', 'stamp']);
      const [highlight, freeHighlight, ink, text] = read as never as Record<string, unknown>[];
      expect(highlight.contents).toBe('הערה');
      expect(highlight.color).toBe('#ffff00');
      expect(highlight.popup).toBeTruthy();
      expect(text.textAlign).toBe('right');
      expect(freeHighlight.intent).toBe('ink-highlight');
      expect(ink.opacity).toBeCloseTo(0.5);
      expect(text.contents).toContain('שלום');
      expect(read.every((a) => a.hasAppearance)).toBe(true);

      const id = (i: number) => `${(read[i].ref as { objectNumber: number }).objectNumber}R`;
      const edits: PdfjsEditorValue[] = [
        {
          annotationType: T.HIGHLIGHT,
          pageIndex: 0,
          id: id(0),
          color: [0, 255, 0],
          popup: { deleted: true },
        },
        {
          annotationType: T.INK,
          pageIndex: 0,
          id: id(2),
          color: [255, 0, 0],
          thickness: 4,
          opacity: 1,
          // A first comment on an existing annotation gets its window.
          popup: { contents: 'new comment', deleted: false },
        },
        {
          annotationType: T.FREETEXT,
          pageIndex: 0,
          id: id(3),
          rect: [120, 380, 280, 410],
          rotation: 0,
          color: [0, 0, 0],
          fontSize: 10,
          value: 'changed',
        },
        { id: id(4), pageIndex: 0, deleted: true },
      ];
      const result = await applyAnnotationEdits(again, edits);
      expect(result.skipped).toEqual([]);
      expect(result.updated).toHaveLength(3);
      // The deleted stamp, and the highlight's comment window.
      expect(result.deleted).toHaveLength(2);
      expect(result.created).toHaveLength(1);
      second = await again.download({ mode: 'incremental' } as never);
    } finally {
      await again.close();
    }
    expect(Buffer.from(second.subarray(0, first.length)).equals(Buffer.from(first))).toBe(true);

    const last = await open(second);
    try {
      const read = (await annotationsOf(last)) as never as Record<string, unknown>[];
      expect(read.map((a) => a.subtype)).toEqual(['highlight', 'ink', 'ink', 'free-text', 'stamp']);
      expect(read[0].color).toBe('#00ff00');
      expect(read[0].contents ?? null).toBeNull();
      expect(read[0].popup ?? null).toBeNull();
      expect(read[2].contents).toBe('new comment');
      expect(read[2].popup).toBeTruthy();
      expect(read[2].color).toBe('#ff0000');
      expect(read[2].strokeWidth).toBe(4);
      expect(read[3].contents).toBe('changed');
    } finally {
      await last.close();
    }
  });
});
