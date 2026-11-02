import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createLocalEngine } from '@embedpdf/engine';
import type { Engine, OutlineItem } from '@embedpdf/engine-core/public';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  appendTocMarker,
  outlineBreadthFirst,
  readTocMarker,
  saveOutlineEdits,
  type EditedOutlineItem,
} from '../src';

const here = dirname(fileURLToPath(import.meta.url));
let engine: Engine;
let original: Uint8Array;

beforeAll(async () => {
  engine = (await createLocalEngine({ runtime: { prefer: 'wasm' } })) as unknown as Engine;
  original = new Uint8Array(await readFile(resolve(here, 'outline-rich.pdf')));
});
afterAll(async () => {
  await engine.destroy();
});

async function outlineOf(bytes: Uint8Array) {
  const doc = await engine.open({ kind: 'bytes', bytes: bytes.slice() } as never);
  try {
    return outlineBreadthFirst((await doc.outline.get()).items);
  } finally {
    await doc.close();
  }
}

/** The loaded outline as the editor serializes it, unchanged. */
function asEdited(items: OutlineItem[]): EditedOutlineItem[] {
  const index = new Map(items.map((item, i) => [item.ref.objectNumber, i]));
  const build = (parent: number | null): EditedOutlineItem[] =>
    items
      .filter((item) => (item.parent?.objectNumber ?? null) === parent)
      .map((item) => ({
        title: item.title,
        page: 1,
        src: index.get(item.ref.objectNumber)!,
        items: build(item.ref.objectNumber),
      }));
  return build(null);
}

const prefixOf = (bytes: Uint8Array, prefix: Uint8Array) =>
  bytes.length >= prefix.length && prefix.every((b, i) => bytes[i] === b);
const count = (bytes: Uint8Array, text: string) =>
  new TextDecoder('latin1').decode(bytes).split(text).length - 1;

describe('saveOutlineEdits', () => {
  it('appends one marked section and keeps the original as a prefix', async () => {
    const items = await outlineOf(original);
    const edited = asEdited(items);
    edited[0].title = 'renamed';
    const saved = await saveOutlineEdits(engine, original, edited);

    expect(prefixOf(saved, original)).toBe(true);
    expect(await readTocMarker(saved)).toMatchObject({ start: original.length });
    const back = await outlineOf(saved);
    expect(back.map((i) => i.title)).toEqual(['renamed', ...items.slice(1).map((i) => i.title)]);
  });

  it('keeps each kept item’s object, target and style', async () => {
    const items = await outlineOf(original);
    const saved = await saveOutlineEdits(engine, original, asEdited(items));
    const back = await outlineOf(saved);
    const pick = (i: OutlineItem) => ({
      ref: i.ref,
      title: i.title,
      target: i.target,
      bold: i.bold,
      italic: i.italic,
      color: i.color,
      open: i.open,
    });
    expect(back.map(pick)).toEqual(items.map(pick));
  });

  it('replaces its own section on the next save instead of stacking', async () => {
    const first = await saveOutlineEdits(engine, original, [
      ...asEdited(await outlineOf(original)),
      { title: 'added', page: 2, items: [] },
    ]);
    const second = await saveOutlineEdits(engine, first, [
      ...asEdited(await outlineOf(first)),
      { title: 'added again', page: 3, items: [] },
    ]);

    expect(prefixOf(second, original)).toBe(true);
    expect(count(second, '%KH-TOC')).toBe(1);
    expect(count(second, '%%EOF')).toBe(count(original, '%%EOF') + 1);
    const titles = (await outlineOf(second)).map((i) => i.title);
    expect(titles).toContain('added');
    expect(titles).toContain('added again');
  });

  it('moves, nests and drops items', async () => {
    const items = await outlineOf(original);
    const edited = asEdited(items);
    const [head, ...rest] = edited;
    const moved = { ...head, items: [] };
    const tree: EditedOutlineItem[] = [{ title: 'group', page: 1, items: [...rest, moved] }];
    const back = await outlineOf(await saveOutlineEdits(engine, original, tree));

    expect(back[0].title).toBe('group');
    expect(back.filter((i) => i.parent === null)).toHaveLength(1);
    const kept = new Set(back.map((i) => i.ref.objectNumber));
    for (const child of head.items) expect(kept.has(items[child.src!].ref.objectNumber)).toBe(false);
  });
});

describe('readTocMarker', () => {
  it('rejects a marker whose section was changed after it was written', async () => {
    const saved = await saveOutlineEdits(engine, original, asEdited(await outlineOf(original)));
    const tampered = saved.slice();
    const at = original.length + 2;
    tampered[at] = tampered[at] === 0x30 ? 0x31 : 0x30;
    expect(await readTocMarker(saved)).not.toBeNull();
    expect(await readTocMarker(tampered)).toBeNull();
  });

  it('rejects a marker followed by another update', async () => {
    const saved = await saveOutlineEdits(engine, original, asEdited(await outlineOf(original)));
    const later = new Uint8Array([...saved, ...new TextEncoder().encode('% another tool\n')]);
    expect(await readTocMarker(later)).toBeNull();
  });

  it('is not written for a section it could not prove', async () => {
    expect(await appendTocMarker(original, original.length - 10)).toBe(original);
  });
});
