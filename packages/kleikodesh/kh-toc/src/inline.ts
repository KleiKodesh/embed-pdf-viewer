/**
 * Makes an outline section self-contained: every outline item's target is
 * written inside the item's own dictionary.
 *
 * The engine writes a new item's target as objects of their own
 * (`/A 315 0 R`, the action's `/D 314 0 R`). A KH-TOC section is replaced
 * wholesale by the next outline save, and a writer that rebuilds from the
 * bytes before the section while copying item dictionaries from the loaded
 * outline would keep references to objects that no longer exist. With the
 * targets inline, the item dictionaries carry everything they need.
 *
 * The section is rewritten object by object with a fresh cross-reference
 * table; objects nothing references any more are dropped, and /Size is
 * brought back to one past the highest object number. Sections it can't
 * rewrite safely (a cross-reference stream, a stream object, or an encrypted
 * file whose inlined objects hold strings, which are encrypted for the object
 * they live in) are returned unchanged.
 */

interface PdfObject {
  num: number;
  gen: number;
  body: string;
}

const REF = /(\d+)\s+(\d+)\s+R\b/g;

export function inlineOutlineTargets(saved: Uint8Array, start: number): Uint8Array {
  const section = latin1(saved, start);
  if (/\bstream\b/.test(section) || !/(?:^|[\r\n])xref\s/.test(section)) return saved;

  const objects: PdfObject[] = [];
  const objRe = /(\d+)\s+(\d+)\s+obj\b([\s\S]*?)endobj/g;
  let xrefAt = -1;
  for (let m: RegExpExecArray | null; (m = objRe.exec(section)); ) {
    objects.push({ num: Number(m[1]), gen: Number(m[2]), body: m[3].trim() });
  }
  const xrefMatch = /(?:^|[\r\n])xref\s/.exec(section);
  if (!xrefMatch) return saved;
  xrefAt = xrefMatch.index;
  const trailerMatch = /trailer\s*(<<[\s\S]*>>)\s*startxref/.exec(section.slice(xrefAt));
  if (!trailerMatch || objects.length === 0) return saved;
  let trailer = trailerMatch[1];
  const encrypted = /\/Encrypt\b/.test(trailer);

  const byNum = new Map(objects.map((o) => [o.num, o]));
  const isItem = (o: PdfObject) => /\/Title\b/.test(o.body) && /\/Parent\b/.test(o.body);
  const isPlainValue = (o: PdfObject) => !/^<<[\s\S]*\/(Type\s*\/(Outlines|Catalog|Pages?)|Title)\b/.test(o.body);

  // The body of a section-local object with its own section-local references
  // inlined, or null when it can't be inlined.
  const expand = (num: number, seen: Set<number>): string | null => {
    const o = byNum.get(num);
    if (!o || seen.has(num) || !isPlainValue(o)) return null;
    if (encrypted && /[()]|<[0-9A-Fa-f\s]*>/.test(o.body.replace(/<<|>>/g, ''))) return null;
    seen.add(num);
    let failed = false;
    const body = o.body.replace(REF, (all, n: string) => {
      if (!byNum.has(Number(n))) return all;
      const inner = expand(Number(n), seen);
      if (inner === null) failed = true;
      return inner ?? all;
    });
    seen.delete(num);
    return failed ? null : body;
  };

  let changed = false;
  for (const o of objects) {
    if (!isItem(o)) continue;
    o.body = o.body.replace(/\/(A|Dest)\s+(\d+)\s+(\d+)\s+R\b/g, (all, key: string, n: string) => {
      const inner = byNum.has(Number(n)) ? expand(Number(n), new Set()) : null;
      if (inner === null) return all;
      changed = true;
      return `/${key} ${inner}`;
    });
  }
  // Keep what is still referenced from the kept objects or the trailer.
  const used = new Set<number>();
  const mark = (text: string) => {
    for (const m of text.matchAll(REF)) {
      const n = Number(m[1]);
      if (byNum.has(n) && !used.has(n)) {
        used.add(n);
        mark(byNum.get(n)!.body);
      }
    }
  };
  for (const o of objects) {
    if (!isPlainValue(o)) {
      used.add(o.num);
      mark(o.body);
    }
  }
  mark(trailer);
  const kept = objects.filter((o) => used.has(o.num));

  if (!changed) return saved;
  // Dropped objects may have been the highest numbers the engine's /Size
  // counted: one past the highest kept object, never below the base file's.
  const baseSize = baseSizeOf(saved, start);
  if (baseSize > 0) {
    const size = Math.max(baseSize, ...kept.map((o) => o.num + 1));
    trailer = trailer.replace(/\/Size\s+\d+/, `/Size ${size}`);
  }

  let out = '';
  const offsets = new Map<number, { off: number; gen: number }>();
  for (const o of kept) {
    offsets.set(o.num, { off: start + out.length, gen: o.gen });
    out += `${o.num} ${o.gen} obj\n${o.body}\nendobj\n`;
  }
  const xrefOffset = start + out.length;
  out += 'xref\n';
  const nums = [...offsets.keys()].sort((a, b) => a - b);
  for (let i = 0; i < nums.length; ) {
    let j = i;
    while (j + 1 < nums.length && nums[j + 1] === nums[j] + 1) j++;
    out += `${nums[i]} ${j - i + 1}\n`;
    for (let k = i; k <= j; k++) {
      const { off, gen } = offsets.get(nums[k])!;
      out += `${String(off).padStart(10, '0')} ${String(gen).padStart(5, '0')} n\r\n`;
    }
    i = j + 1;
  }
  out += `trailer\n${trailer}\nstartxref\n${xrefOffset}\n%%EOF\n`;

  const tail = Uint8Array.from(out, (c) => c.charCodeAt(0));
  const result = new Uint8Array(start + tail.length);
  result.set(saved.subarray(0, start));
  result.set(tail, start);
  return result;
}

/** The /Size of the file the section updates: its last trailer, or 0. */
function baseSizeOf(bytes: Uint8Array, start: number) {
  const tail = latin1(bytes, Math.max(0, start - 1024), start);
  const at = [...tail.matchAll(/startxref\s+(\d+)/g)].pop();
  if (!at) return 0;
  const offset = Number(at[1]);
  if (!(offset >= 0 && offset < start)) return 0;
  // A cross-reference table's trailer follows the table; a stream's
  // dictionary comes first.
  const text = latin1(bytes, offset, start);
  const dict = /^xref\s/.test(text) ? text.slice(text.indexOf('trailer')) : text.slice(0, 4096);
  const size = /\/Size\s+(\d+)/.exec(dict);
  return size ? Number(size[1]) : 0;
}

function latin1(bytes: Uint8Array, from = 0, to = bytes.length) {
  let s = '';
  for (let i = from; i < to; i += 0x8000) {
    s += String.fromCharCode(...bytes.subarray(i, Math.min(to, i + 0x8000)));
  }
  return s;
}
