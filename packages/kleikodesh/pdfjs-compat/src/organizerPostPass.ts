/**
 * The page organizer's output, finished like PDF.js's PDFEditor writes it.
 *
 * The engine's rewrite keeps whatever still points at a page that was removed: the structure
 * tree (every element of that page, and through /Pg the page itself with its content and fonts),
 * links and named destinations to it, form fields whose widgets were on it. And a page used twice
 * shares its structure elements and /StructParents with its copy. PDFEditor instead builds the
 * new file from the kept pages only. This pass does the same on the engine's output:
 *
 * - Structure tree: a port of PDFEditor #mergeStructTrees / #cloneStructTreeNode /
 *   #makeStructTree, read from the ORIGINAL file (the engine cannot read every structure tree,
 *   e.g. Word's hybrid files keep it in object streams only the /XRefStm lists). Each page-info
 *   entry gets its own copy of the elements on its pages; /StructParent(s) renumbered in page
 *   order; ParentTree, IDTree (ids deduplicated), ClassMap, RoleMap, Namespaces, AF and
 *   PronunciationLexicon rebuilt. One deliberate difference: an /OBJR kid whose annotation is
 *   kept stays (PDFEditor drops it, leaving the annotation's ParentTree entry pointing at an
 *   element that no longer owns it).
 * - Link annotations whose destination page is gone are removed (#postCollectPageData), named
 *   destinations to removed pages are dropped, the /OpenAction too when its page is gone, and form
 *   fields keep only widgets of kept pages.
 * - The file is written with only the objects still reachable.
 *
 * Unchanged on purpose (PDFEditor drops them): the catalog's /Lang, /MarkInfo, /Metadata,
 * /ViewerPreferences, and named destinations nothing uses. Encrypted files are returned as the
 * engine wrote them.
 */
import {
  PdfFile,
  PdfStream,
  headerOf,
  isDict,
  isName,
  isRef,
  writePdf,
  type PdfValue,
  type Ref,
} from './pdfFile';

type Dict = Map<string, PdfValue>;

const MAX_IN_NAME_TREE_NODE = 64;
const ref = (n: number): Ref => ({ ref: [n, 0] });

/** Leaves of a number or name tree: [key, raw value]. */
function treeEntries(file: PdfFile, root: PdfValue, key: 'Nums' | 'Names'): [PdfValue, PdfValue][] {
  const out: [PdfValue, PdfValue][] = [];
  const seen = new Set<number>();
  const visit = (node: PdfValue, depth: number) => {
    if (isRef(node)) {
      if (seen.has(node.ref[0])) return;
      seen.add(node.ref[0]);
    }
    const d = file.deref(node);
    if (!isDict(d) || depth > 32) return;
    const leaves = file.deref(d.get(key));
    if (Array.isArray(leaves))
      for (let i = 0; i + 1 < leaves.length; i += 2) out.push([leaves[i], leaves[i + 1]]);
    const kids = file.deref(d.get('Kids'));
    if (Array.isArray(kids)) for (const k of kids) visit(k, depth + 1);
  };
  visit(root, 0);
  return out;
}

/** A PDF string's text (literal or hex source), for comparing ids and names. */
function stringText(s: string): string {
  if (s.startsWith('<')) {
    const hex = s.slice(1, -1).replace(/[^0-9a-fA-F]/g, '');
    let out = '';
    for (let i = 0; i < hex.length; i += 2)
      out += String.fromCharCode(parseInt(hex.slice(i, i + 2).padEnd(2, '0'), 16));
    return out;
  }
  let out = '';
  const body = s.slice(1, -1);
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c !== '\\') {
      out += c;
      continue;
    }
    const n = body[++i];
    if (n === undefined) break;
    const esc: Record<string, string> = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f' };
    if (n in esc) out += esc[n];
    else if (/[0-7]/.test(n)) {
      let oct = n;
      while (oct.length < 3 && /[0-7]/.test(body[i + 1] ?? '')) oct += body[++i];
      out += String.fromCharCode(parseInt(oct, 8) & 0xff);
    } else if (n === '\r') {
      if (body[i + 1] === '\n') i++;
    } else if (n !== '\n') out += n;
  }
  return out;
}

/** A PDF literal string for `text` (bytes as latin1). */
function literal(text: string): string {
  return `(${text
    .replace(/[\\()]/g, (c) => `\\${c}`)
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n')})`;
}

/** The pages of a file in order: object numbers. */
function pageList(file: PdfFile, root: Dict): number[] {
  const out: number[] = [];
  const seen = new Set<number>();
  const visit = (node: PdfValue, depth: number) => {
    if (!isRef(node) || seen.has(node.ref[0]) || depth > 64) return;
    seen.add(node.ref[0]);
    const d = file.read(node.ref[0]);
    if (!isDict(d)) return;
    const kids = file.deref(d.get('Kids'));
    if (Array.isArray(kids) && !isName(d.get('Type'), 'Page'))
      kids.forEach((k) => visit(k, depth + 1));
    else out.push(node.ref[0]);
  };
  visit(root.get('Pages')!, 0);
  return out;
}

interface Group {
  /** Original page → its page in the output. */
  pagesMap: Map<number, number>;
  /** Original annotation → its annotation in the output. */
  annotsMap: Map<number, number>;
  /** Original object → its copy in the output (PDFEditor's oldRefMapping). */
  oldRefMapping: Map<number, number>;
  /** Output objects reachable from this entry's pages: originals there are reused as they are. */
  pageObjects: Set<number>;
  usedStructParents: Set<number>;
  oldStructParentMapping: Map<number, number>;
}

/**
 * `out` = the engine's rewrite of `base` with its pages laid out as `layout` ([page-info index,
 * page index in `base`] per output page; every entry's source is `base`).
 */
export function finishOrganizedPdf(
  base: Uint8Array,
  out: Uint8Array,
  layout: [number, number][],
): Uint8Array {
  const src = new PdfFile(base);
  const dst = new PdfFile(out);
  if (src.encrypted || dst.encrypted) return out;

  // The output's objects, editable.
  const objects = new Map<number, PdfValue>();
  for (const n of dst.numbers()) objects.set(n, dst.read(n));
  let nextNum = Math.max(0, ...objects.keys()) + 1;
  const add = (v: PdfValue): Ref => {
    const n = nextNum++;
    objects.set(n, v);
    return ref(n);
  };
  const get = (v: PdfValue | undefined): PdfValue =>
    isRef(v) ? (objects.get(v.ref[0]) ?? null) : (v ?? null);
  const dictOf = (v: PdfValue | undefined): Dict | null => {
    const x = get(v);
    return x instanceof PdfStream ? x.dict : isDict(x) ? x : null;
  };

  const rootRef = dst.trailer.get('Root');
  const root = dictOf(rootRef);
  const srcRoot = src.deref(src.trailer.get('Root'));
  if (!root || !isRef(rootRef) || !isDict(srcRoot)) return out;
  const outPages = pageList(dst, root);
  const srcPages = pageList(src, srcRoot);
  if (outPages.length !== layout.length) return out;
  const outPageSet = new Set(outPages);

  // Objects reachable from a page without walking to other pages (or up the page tree).
  const fromPages = (pages: number[]) => {
    const seen = new Set<number>();
    const stack = [...pages];
    while (stack.length) {
      const n = stack.pop()!;
      if (seen.has(n)) continue;
      seen.add(n);
      const visit = (v: PdfValue, key?: string) => {
        if (isRef(v)) {
          if (key !== 'Parent' && !outPageSet.has(v.ref[0])) stack.push(v.ref[0]);
        } else if (Array.isArray(v)) v.forEach((x) => visit(x));
        else if (isDict(v)) v.forEach((x, k) => visit(x, k));
        else if (v instanceof PdfStream) v.dict.forEach((x, k) => visit(x, k));
      };
      visit(objects.get(n) ?? null);
    }
    return seen;
  };

  const annotsOf = (file: PdfFile | null, page: number): PdfValue[] => {
    const d = file ? file.read(page) : objects.get(page);
    if (!isDict(d)) return [];
    const a = file ? file.deref(d.get('Annots')) : get(d.get('Annots'));
    return Array.isArray(a) ? a : [];
  };

  // One group per page-info entry (PDFEditor's DocumentData), in entry order.
  const groups = new Map<number, Group>();
  layout.forEach(([s, i], k) => {
    let g = groups.get(s);
    if (!g) {
      g = {
        pagesMap: new Map(),
        annotsMap: new Map(),
        oldRefMapping: new Map(),
        pageObjects: new Set(),
        usedStructParents: new Set(),
        oldStructParentMapping: new Map(),
      };
      groups.set(s, g);
    }
    const from = srcPages[i];
    const to = outPages[k];
    if (from === undefined) return;
    g.pagesMap.set(from, to);
    const a = annotsOf(src, from);
    const b = annotsOf(null, to);
    if (a.length === b.length)
      a.forEach(
        (x, j) => isRef(x) && isRef(b[j]) && g!.annotsMap.set(x.ref[0], (b[j] as Ref).ref[0]),
      );
  });
  const groupOrder = [...groups.keys()].sort((a, b) => a - b);
  for (const s of groupOrder) {
    const g = groups.get(s)!;
    g.pageObjects = fromPages([...g.pagesMap.values()]);
  }
  const srcPageSet = new Set(srcPages);

  // --- links, named destinations, open action, form fields ------------------------------------

  const destPage = (d: PdfValue): number | undefined | null => {
    // An explicit destination's page in the output (null: a page that is gone).
    const arr = get(d);
    if (!Array.isArray(arr)) return undefined;
    const p = arr[0];
    if (isRef(p)) return outPageSet.has(p.ref[0]) ? p.ref[0] : null;
    return undefined;
  };
  // Named destinations: /Dests (dict) and /Names /Dests (name tree), entries to removed pages go.
  const destNames = new Set<string>();
  const keepDest = (v: PdfValue) => {
    let d = get(v);
    if (isDict(d)) d = get(d.get('D'));
    return destPage(d) !== null;
  };
  const dests = dictOf(root.get('Dests'));
  if (dests) {
    for (const [k, v] of [...dests]) {
      if (keepDest(v)) destNames.add(k);
      else dests.delete(k);
    }
  }
  const names = dictOf(root.get('Names'));
  if (names?.has('Dests')) {
    const entries = treeEntries(
      { deref: (v: PdfValue | undefined) => get(v) } as unknown as PdfFile,
      names.get('Dests')!,
      'Names',
    ).filter(([k, v]) => typeof k === 'string' && keepDest(v));
    entries.forEach(([k]) => destNames.add(stringText(k as string)));
    if (entries.length) names.set('Dests', add(new Map([['Names', entries.flat()]])));
    else names.delete('Dests');
  }
  // An output annotation's original (the engine's page copy can drop a link's destination).
  const original = new Map<number, [Group, number]>();
  for (const s of groupOrder) {
    const g = groups.get(s)!;
    g.annotsMap.forEach((to, from) => original.has(to) || original.set(to, [g, from]));
  }
  outPages.forEach((page, k) => {
    const d = dictOf(ref(page));
    const annots = annotsOf(null, page);
    if (!d || !annots.length) return;
    const kept = annots.filter((a) => {
      const orig = isRef(a) ? original.get(a.ref[0]) : undefined;
      const g = orig?.[0] ?? groups.get(layout[k][0])!;
      const ad = orig ? (src.deref(ref(orig[1])) as Dict | null) : dictOf(a);
      const read = orig ? (v: PdfValue | undefined) => src.deref(v) : get;
      if (!isDict(ad) || !isName(ad.get('Subtype'), 'Link')) return true;
      const action = read(ad.get('A'));
      const dest = isDict(action) ? read(action.get('D')) : read(ad.get('Dest'));
      if (dest === null) return true;
      if (Array.isArray(dest))
        return (
          !isRef(dest[0]) ||
          (orig ? g.pagesMap.has(dest[0].ref[0]) : outPageSet.has(dest[0].ref[0]))
        );
      if (typeof dest === 'string') return destNames.has(stringText(dest));
      if (isName(dest)) return destNames.has(dest.name);
      return false;
    });
    if (kept.length !== annots.length) {
      if (kept.length) d.set('Annots', kept);
      else d.delete('Annots');
    }
  });
  const openAction = get(root.get('OpenAction'));
  if (Array.isArray(openAction) && destPage(openAction) === null) root.delete('OpenAction');
  else if (
    isDict(openAction) &&
    isName(openAction.get('S'), 'GoTo') &&
    destPage(openAction.get('D')!) === null
  )
    root.delete('OpenAction');

  const keptAnnots = new Set<number>();
  for (const page of outPages)
    for (const a of annotsOf(null, page)) if (isRef(a)) keptAnnots.add(a.ref[0]);
  const acroForm = dictOf(root.get('AcroForm'));
  if (acroForm) {
    const keepField = (f: PdfValue, depth: number): boolean => {
      const d = dictOf(f);
      if (!d || depth > 32) return false;
      const kids = get(d.get('Kids'));
      if (Array.isArray(kids) && kids.length) {
        const k = kids.filter((x) => keepField(x, depth + 1));
        if (k.length !== kids.length) d.set('Kids', k);
        return k.length > 0;
      }
      return isRef(f) && keptAnnots.has(f.ref[0]);
    };
    const fields = get(acroForm.get('Fields'));
    const kept = Array.isArray(fields) ? fields.filter((f) => keepField(f, 0)) : [];
    if (kept.length) acroForm.set('Fields', kept);
    else root.delete('AcroForm');
  }

  // --- structure tree (PDFEditor) -------------------------------------------------------------

  const st = src.deref(srcRoot.get('StructTreeRoot'));
  const structTreeKids: Ref[] = [];
  const newParentTree = new Map<number, [Group, PdfValue]>();
  const newIdTree = new Map<string, { id: string; ref: Ref | null }>();
  const newClassMap = new Map<string, PdfValue>();
  const newRoleMap = new Map<string, PdfValue>();
  const newNamespaces = new Map<string, PdfValue>();
  const newStructTreeAF: PdfValue[] = [];
  const newLexicon: PdfValue[] = [];
  const srcDict = (v: PdfValue | undefined): Dict | null => {
    const x = src.deref(v);
    return x instanceof PdfStream ? x.dict : isDict(x) ? x : null;
  };
  const isStructElemRef = (n: number) => {
    const d = srcDict(ref(n));
    return (
      !!d &&
      (isName(d.get('Type'), 'StructElem') ||
        (!d.has('Type') && d.has('S') && (d.has('P') || d.has('K'))))
    );
  };

  /** PDFEditor #collectDependencies for this group: `v` from the original, as an output value. */
  const collect = (g: Group, v: PdfValue): PdfValue => {
    if (isRef(v)) {
      const n = v.ref[0];
      const page = g.pagesMap.get(n);
      if (page !== undefined) return ref(page);
      if (srcPageSet.has(n)) return null;
      const annot = g.annotsMap.get(n);
      if (annot !== undefined) return ref(annot);
      const mapped = g.oldRefMapping.get(n);
      if (mapped !== undefined) return ref(mapped);
      if (isStructElemRef(n)) return null;
      if (g.pageObjects.has(n)) return ref(n);
      const obj = src.read(n);
      if (typeof obj === 'number') return obj;
      if (obj === null) return null;
      const r = add(null);
      g.oldRefMapping.set(n, r.ref[0]);
      objects.set(r.ref[0], collect(g, obj));
      return r;
    }
    if (Array.isArray(v)) return v.map((x) => collect(g, x));
    if (v instanceof PdfStream) return new PdfStream(collect(g, v.dict) as Dict, v.data);
    if (isDict(v)) {
      const d: Dict = new Map();
      v.forEach((x, k) => d.set(k, collect(g, x)));
      return d;
    }
    return v;
  };

  const cloneNode = (
    g: Group,
    node: Dict,
    removed: Set<number>,
    dedupIDs: Map<string, string>,
    dedupClasses: Map<string, string>,
    dedupRoles: Map<string, string>,
    visited: Set<number>,
  ): Ref | null => {
    const pg = node.get('Pg');
    if (isRef(pg) && !g.pagesMap.has(pg.ref[0])) return null;
    let kids: PdfValue = node.get('K') ?? null;
    if (isRef(kids)) {
      if (visited.has(kids.ref[0])) return null;
      const k = src.read(kids.ref[0]);
      kids = Array.isArray(k) ? k : [kids];
    }
    const kidList: PdfValue[] = Array.isArray(kids) ? kids : kids === null ? [] : [kids];
    const newKids: PdfValue[] = [];
    const structElemIndices: number[] = [];
    for (let kid of kidList) {
      const kidRef = isRef(kid) ? kid.ref[0] : null;
      if (kidRef !== null) {
        if (visited.has(kidRef)) continue;
        visited.add(kidRef);
        kid = src.read(kidRef);
      }
      if (typeof kid === 'number') {
        newKids.push(kid);
        continue;
      }
      const kd = kid instanceof PdfStream ? null : isDict(kid) ? kid : null;
      if (!kd) continue;
      const pgRef = kd.get('Pg');
      if (isRef(pgRef) && !g.pagesMap.has(pgRef.ref[0])) continue;
      const type = kd.get('Type');
      if (!type || isName(type, 'StructElem')) {
        let setAsSpan = false;
        if (kidRef !== null && removed.has(kidRef)) {
          if (!isName(kd.get('S'), 'Link')) continue;
          setAsSpan = true;
        }
        const newKid = cloneNode(g, kd, removed, dedupIDs, dedupClasses, dedupRoles, visited);
        if (newKid) {
          structElemIndices.push(newKids.length);
          newKids.push(newKid);
          if (kidRef !== null) g.oldRefMapping.set(kidRef, newKid.ref[0]);
          if (setAsSpan) (objects.get(newKid.ref[0]) as Dict).set('S', { name: 'Span' });
        }
        continue;
      }
      if (isName(type, 'OBJR')) {
        // Kept while its annotation is (see the header).
        const obj = kd.get('Obj');
        if (!isRef(obj) || !g.annotsMap.has(obj.ref[0])) continue;
        const copy = collect(g, kd);
        newKids.push(kidRef !== null ? add(copy) : copy);
        continue;
      }
      if (isName(type, 'MCR')) {
        newKids.push(collect(g, kidRef !== null ? ref(kidRef) : kd));
        continue;
      }
      if (kidRef !== null) newKids.push(collect(g, ref(kidRef)));
    }
    if (kidList.length !== 0 && newKids.length === 0) return null;
    const newNodeRef = add(null);
    const rest: Dict = new Map(node);
    for (const k of ['ID', 'C', 'K', 'P', 'S']) rest.delete(k);
    const newNode = collect(g, rest) as Dict;
    objects.set(newNodeRef.ref[0], newNode);
    const classNames = node.get('C');
    const cls = (n: PdfValue) => (isName(n) ? { name: dedupClasses.get(n.name) ?? n.name } : n);
    if (isName(classNames)) newNode.set('C', cls(classNames));
    else if (Array.isArray(classNames))
      newNode.set('C', classNames.filter((c) => isName(c)).map(cls));
    const role = node.get('S');
    if (isName(role)) newNode.set('S', { name: dedupRoles.get(role.name) ?? role.name });
    const id = node.get('ID');
    if (typeof id === 'string') {
      const newId = dedupIDs.get(stringText(id));
      newNode.set('ID', newId !== undefined ? literal(newId) : id);
    }
    for (const i of structElemIndices)
      (objects.get((newKids[i] as Ref).ref[0]) as Dict).set('P', newNodeRef);
    if (newKids.length === 1) newNode.set('K', newKids[0]);
    else if (newKids.length > 1) newNode.set('K', newKids);
    return newNodeRef;
  };

  const stDict = isDict(st) ? st : null;
  const parentTree = new Map<number, PdfValue>();
  const idTree: [string, PdfValue][] = [];
  if (stDict) {
    if (stDict.has('ParentTree'))
      for (const [k, v] of treeEntries(src, stDict.get('ParentTree')!, 'Nums'))
        if (typeof k === 'number') parentTree.set(k, v);
    if (stDict.has('IDTree'))
      for (const [k, v] of treeEntries(src, stDict.get('IDTree')!, 'Names'))
        if (typeof k === 'string') idTree.push([stringText(k), v]);

    // #mergeStructTrees, first loop: /StructParent(s) of the new pages, in page order.
    let newStructParentId = 0;
    const done = new Set<Dict>();
    outPages.forEach((page, k) => {
      const g = groups.get(layout[k][0])!;
      if (!parentTree.size && !stDict.has('ParentTree')) return;
      const seen = new Set<number>([page]);
      const visit = (v: PdfValue, key?: string) => {
        if (isRef(v)) {
          const n = v.ref[0];
          if (seen.has(n) || outPageSet.has(n) || key === 'Parent') return;
          seen.add(n);
          visit(objects.get(n) ?? null);
          return;
        }
        if (Array.isArray(v)) return v.forEach((x) => visit(x));
        const d = v instanceof PdfStream ? v.dict : isDict(v) ? v : null;
        if (!d) return;
        if (!done.has(d)) {
          done.add(d);
          const key2 = d.has('StructParent')
            ? 'StructParent'
            : d.has('StructParents')
              ? 'StructParents'
              : null;
          const sp = key2 ? d.get(key2) : undefined;
          if (key2 && typeof sp === 'number') {
            g.usedStructParents.add(sp);
            let parent: PdfValue = parentTree.get(sp) ?? null;
            if (isRef(parent)) {
              const arr = src.read(parent.ref[0]);
              if (Array.isArray(arr)) parent = arr;
            }
            if (Array.isArray(parent) && parent.every((x) => x === null)) parent = null;
            if (!parent) d.delete(key2);
            else {
              let n = g.oldStructParentMapping.get(sp);
              if (n === undefined) {
                n = newStructParentId++;
                g.oldStructParentMapping.set(sp, n);
                newParentTree.set(n, [g, parent]);
              }
              d.set(key2, n);
            }
          }
        }
        d.forEach((x, kk) => visit(x, kk));
      };
      visit(objects.get(page) ?? null);
    });

    const kidsOf = (v: PdfValue | undefined) => {
      const x = src.deref(v);
      return x === null ? [] : Array.isArray(x) ? x : [x];
    };
    for (const s of groupOrder) {
      const g = groups.get(s)!;
      const removed = new Set<number>();
      for (const [key, value] of parentTree)
        if (!g.usedStructParents.has(key) && isRef(value)) removed.add(value.ref[0]);
      const dedupIDs = new Map<string, string>();
      for (const [id] of idTree) {
        let _id = id;
        if (newIdTree.has(id)) {
          for (let i = 1; ; i++) {
            const newId = `${id}_${i}`;
            if (!newIdTree.has(newId)) {
              dedupIDs.set(id, newId);
              _id = newId;
              break;
            }
          }
        }
        newIdTree.set(_id, { id: _id, ref: null });
      }
      const dedupClasses = new Map<string, string>();
      const classMap = srcDict(stDict.get('ClassMap'));
      if (classMap)
        for (let [className, classDict] of classMap) {
          classDict = collect(g, classDict);
          if (newClassMap.has(className)) {
            for (let i = 1; ; i++) {
              const n = `${className}_${i}`;
              if (!newClassMap.has(n)) {
                dedupClasses.set(className, n);
                className = n;
                break;
              }
            }
          }
          newClassMap.set(className, classDict);
        }
      const dedupRoles = new Map<string, string>();
      const roleMap = srcDict(stDict.get('RoleMap'));
      if (roleMap)
        for (const [roleName, mapped] of roleMap) {
          const cur = newRoleMap.get(roleName);
          if (!cur) {
            newRoleMap.set(roleName, mapped);
            continue;
          }
          if (isName(cur) && isName(mapped) && cur.name === mapped.name) continue;
          for (let i = 1; ; i++) {
            const n = `${roleName}_${i}`;
            if (!newRoleMap.has(n)) {
              dedupRoles.set(roleName, n);
              newRoleMap.set(n, mapped);
              break;
            }
          }
        }
      for (const nsRef of kidsOf(stDict.get('Namespaces'))) {
        const ns = srcDict(nsRef);
        const name = ns?.get('NS');
        if (typeof name !== 'string' || newNamespaces.has(stringText(name))) continue;
        newNamespaces.set(stringText(name), collect(g, nsRef));
      }
      const af = src.deref(stDict.get('AF'));
      if (Array.isArray(af)) for (const a of af) newStructTreeAF.push(collect(g, a));
      const lex = src.deref(stDict.get('PronunciationLexicon'));
      if (Array.isArray(lex)) for (const l of lex) newLexicon.push(collect(g, l));

      for (const kid of kidsOf(stDict.get('K'))) {
        const kidRef = isRef(kid) ? kid.ref[0] : null;
        if (kidRef !== null && removed.has(kidRef)) continue;
        const kd = srcDict(kid);
        if (!kd) continue;
        const r = cloneNode(g, kd, removed, dedupIDs, dedupClasses, dedupRoles, new Set());
        if (r) {
          structTreeKids.push(r);
          if (kidRef !== null) g.oldRefMapping.set(kidRef, r.ref[0]);
        }
      }
      for (const [id, nodeRef] of idTree) {
        const mapped = isRef(nodeRef) ? g.oldRefMapping.get(nodeRef.ref[0]) : undefined;
        const newId = dedupIDs.get(id) ?? id;
        if (mapped !== undefined) newIdTree.set(newId, { id: newId, ref: ref(mapped) });
        else newIdTree.delete(newId);
      }
    }
  }

  // #makeStructTree
  root.delete('StructTreeRoot');
  if (structTreeKids.length) {
    const stRef = add(null);
    const tree: Dict = new Map<string, PdfValue>([
      ['Type', { name: 'StructTreeRoot' }],
      ['K', structTreeKids],
    ]);
    objects.set(stRef.ref[0], tree);
    for (const k of structTreeKids) {
      const d = objects.get(k.ref[0]) as Dict;
      if (!d.has('Type') || isName(d.get('Type'), 'StructElem')) d.set('P', stRef);
    }
    const finalParentTree: [number, PdfValue][] = [];
    for (const [key, [g, parent]] of newParentTree) {
      if (!Array.isArray(parent)) {
        const m = isRef(parent) ? g.oldRefMapping.get(parent.ref[0]) : undefined;
        if (m !== undefined) finalParentTree.push([key, ref(m)]);
        continue;
      }
      const mapped = parent.map((r) => {
        const m = isRef(r) ? g.oldRefMapping.get(r.ref[0]) : undefined;
        return m !== undefined ? ref(m) : null;
      });
      if (mapped.length && mapped.some((x) => x !== null)) finalParentTree.push([key, mapped]);
    }
    const makeTree = (entries: [PdfValue, PdfValue][], areNames: boolean): Ref => {
      const sorted = entries.sort(
        areNames
          ? ([a], [b]) => stringText(a as string).localeCompare(stringText(b as string))
          : ([a], [b]) => (a as number) - (b as number),
      );
      const treeRef = add(null);
      const stack: { dict: Dict; entries: [PdfValue, PdfValue][]; isRoot?: boolean }[] = [
        { dict: new Map(), entries: sorted, isRoot: true },
      ];
      objects.set(treeRef.ref[0], stack[0].dict);
      const valueType = areNames ? 'Names' : 'Nums';
      while (stack.length) {
        const { dict, entries: e, isRoot } = stack.pop()!;
        if (e.length <= MAX_IN_NAME_TREE_NODE) {
          if (!isRoot) dict.set('Limits', [e[0][0], e[e.length - 1][0]]);
          dict.set(valueType, e.flat());
          continue;
        }
        const chunkSize = Math.max(
          MAX_IN_NAME_TREE_NODE,
          Math.ceil(e.length / MAX_IN_NAME_TREE_NODE),
        );
        const kids: Ref[] = [];
        dict.set('Kids', kids);
        for (let i = 0; i < e.length; i += chunkSize) {
          const chunk = e.slice(i, i + chunkSize);
          const d: Dict = new Map([['Limits', [chunk[0][0], chunk[chunk.length - 1][0]]]]);
          kids.push(add(d));
          stack.push({ dict: d, entries: chunk });
        }
      }
      return treeRef;
    };
    if (finalParentTree.length) {
      const pt = makeTree(finalParentTree, false);
      (objects.get(pt.ref[0]) as Dict).set('Type', { name: 'ParentTree' });
      tree.set('ParentTree', pt);
      tree.set('ParentTreeNextKey', finalParentTree.length);
    }
    const ids = [...newIdTree.values()]
      .filter((x) => x.ref)
      .map((x) => [literal(x.id), x.ref!] as [PdfValue, PdfValue]);
    if (ids.length) {
      const it = makeTree(ids, true);
      (objects.get(it.ref[0]) as Dict).set('Type', { name: 'IDTree' });
      tree.set('IDTree', it);
    }
    if (newClassMap.size) tree.set('ClassMap', add(new Map(newClassMap)));
    if (newRoleMap.size) tree.set('RoleMap', add(new Map(newRoleMap)));
    if (newNamespaces.size) tree.set('Namespaces', add([...newNamespaces.values()]));
    if (newStructTreeAF.length) tree.set('AF', add(newStructTreeAF));
    if (newLexicon.length) tree.set('PronunciationLexicon', add(newLexicon));
    root.set('StructTreeRoot', stRef);
  }

  return writePdf(headerOf(out), objects, dst.trailer);
}
