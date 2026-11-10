import type {
  DocumentHandle,
  Engine,
  OutlineItem,
  OutlineItemRef,
  OutlinePosition,
  PageRef,
} from '@embedpdf/engine-core/public';

/**
 * One row of an edited table of contents, as the viewer's outline editor
 * serializes it.
 */
export interface EditedOutlineItem {
  title: string;
  /** 1-based page an item without a target of its own goes to. */
  page: number;
  /**
   * The item it was, by its index in the loaded outline read breadth first.
   * Absent for a row the user added.
   */
  src?: number;
  items: EditedOutlineItem[];
}

export interface SaveOutlineOptions {
  /** The password the document was opened with. */
  password?: string;
  /** Other edits for the same save, such as form field values. */
  alsoApply?: (doc: DocumentHandle) => Promise<void>;
}

/** The loaded outline's items, breadth first: the order `src` indexes. */
export function outlineBreadthFirst(items: readonly OutlineItem[]): OutlineItem[] {
  const children = new Map<number | null, OutlineItem[]>();
  for (const item of items) {
    const key = item.parent?.objectNumber ?? null;
    const list = children.get(key);
    if (list) list.push(item);
    else children.set(key, [item]);
  }
  const out: OutlineItem[] = [];
  for (const queue: (number | null)[] = [null]; queue.length; ) {
    for (const item of children.get(queue.shift()!) ?? []) {
      out.push(item);
      queue.push(item.ref.objectNumber);
    }
  }
  return out;
}

/**
 * `file` with its outline replaced by `edited` (left alone when `null`).
 *
 * The save merges into the file's last update section
 * (`download({ mode: 'incremental', mergeLastUpdate: true })`): repeated
 * saves keep one section and the bytes before it unchanged. A file without
 * an update yet, or whose last section is signed, gets one appended section
 * that later saves merge into. Items that keep their `src` keep their
 * object, target and style (bold, italic, colour, open state); new items go
 * to their `page`.
 */
export async function saveOutlineEdits(
  engine: Engine,
  file: Uint8Array,
  edited: readonly EditedOutlineItem[] | null,
  options: SaveOutlineOptions = {},
): Promise<Uint8Array> {
  const doc = await engine.open(
    { kind: 'bytes', bytes: file.slice() } as never,
    options.password ? ({ password: options.password } as never) : undefined,
  );
  try {
    if (edited) await applyOutline(doc, edited, undefined, []);
    if (options.alsoApply) await options.alsoApply(doc);
    return await doc.download({ mode: 'incremental', mergeLastUpdate: true });
  } finally {
    await doc.close();
  }
}

async function applyOutline(
  doc: DocumentHandle,
  edited: readonly EditedOutlineItem[],
  sameFile: null | undefined,
  loaded: readonly OutlineItem[],
) {
  const current = (await doc.outline.get()).items;
  const bfs = outlineBreadthFirst(current);
  const pages = (await doc.pages.list()).pages.map((p: { ref: PageRef }) => p.ref);
  const pageRef = (page: number) =>
    pages[Math.max(0, Math.min(pages.length - 1, (page | 0) - 1))] ?? null;
  const reuse = sameFile !== null;
  // A leaf has no open state of its own: given children, it opens.
  const parents = new Set<number>();
  for (const item of [...current, ...loaded]) if (item.parent) parents.add(item.parent.objectNumber);
  const wasOpen = (item: OutlineItem) => !parents.has(item.ref.objectNumber) || item.open;
  const kept = new Set<number>();

  type Placed = {
    ref: OutlineItemRef;
    from: OutlineItem | null;
    /** Its open state now, for an item that was already there. */
    open: boolean | null;
    children: Placed[];
  };

  const place = async (
    items: readonly EditedOutlineItem[],
    parent: OutlineItemRef | null,
  ): Promise<Placed[]> => {
    const placed: Placed[] = [];
    let previous: OutlineItemRef | null = null;
    for (const item of items) {
      const position: OutlinePosition = previous ? { after: previous } : 'start';
      const index = Number.isInteger(item.src) && item.src! >= 0 ? item.src! : -1;
      const own = reuse ? bfs[index] : undefined;
      const from = (reuse ? own : loaded[index]) ?? null;
      let ref: OutlineItemRef;
      if (own && !kept.has(own.ref.objectNumber)) {
        kept.add(own.ref.objectNumber);
        ref = own.ref;
        await doc.outline.move([ref], parent, position);
        if (own.title !== item.title) await doc.outline.update(ref, { title: item.title });
        if (!own.target && !own.action) await setPageTarget(ref, item.page);
      } else {
        const hasTarget = !!from && (!!from.target || !!from.action);
        const writable = hasTarget && from!.target && isWritable(from!.target) ? from!.target : null;
        const created = await doc.outline.create(
          {
            title: item.title,
            target: writable ?? (hasTarget ? null : pageTarget(item.page)),
            color: from?.color ?? null,
            bold: from?.bold ?? false,
            italic: from?.italic ?? false,
          } as never,
          { parent, position },
        );
        ref = created.item.ref;
      }
      const reused = own && own.ref === ref ? own : null;
      placed.push({ ref, from, open: reused ? reused.open : null, children: await place(item.items ?? [], ref) });
      previous = ref;
    }
    return placed;
  };

  const pageTarget = (page: number) => {
    const p = pageRef(page);
    return p
      ? ({ kind: 'goto', destination: { kind: 'xyz', page: p, x: null, y: null, zoom: null } } as const)
      : null;
  };
  const setPageTarget = async (ref: OutlineItemRef, page: number) => {
    const target = pageTarget(page);
    if (target) await doc.outline.update(ref, { target } as never);
  };

  const roots = await place(edited, null);

  // Items the edit dropped: every kept one was moved out of them first.
  for (const item of bfs) {
    if (kept.has(item.ref.objectNumber)) continue;
    const parent = item.parent?.objectNumber;
    if (parent !== undefined && !kept.has(parent) && bfs.some((b) => b.ref.objectNumber === parent)) {
      continue; // goes with its dropped ancestor
    }
    await doc.outline.delete(item.ref);
  }

  // Open state: an item keeps its own; a new item with children opens.
  const setOpen = async (nodes: Placed[]) => {
    for (const node of nodes) {
      if (!node.children.length) continue;
      const open = node.from ? wasOpen(node.from) : true;
      if (open !== node.open) await doc.outline.update(node.ref, { open });
      await setOpen(node.children);
    }
  };
  await setOpen(roots);
}

function isWritable(target: NonNullable<OutlineItem['target']>) {
  return target.kind === 'goto' || target.kind === 'uri';
}
