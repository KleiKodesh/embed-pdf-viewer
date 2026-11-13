/**
 * A small reader/writer for whole PDF files, for the page organizer's post-pass (structTree.ts).
 *
 * Reads every object of an unencrypted file (xref tables, xref streams, hybrid /XRefStm, object
 * streams; FlateDecode with PNG predictors) into plain values. Strings keep their source text
 * (literal or hex, as written), so writing them back is byte-exact. Writes a new file holding
 * only the objects reachable from the trailer, renumbered 1..n, with a classic xref table.
 *
 * The lexer/parser and xref readers are the engine's (engine-services save/internal/
 * mergeLastUpdate.ts), kept in step by hand.
 */
import { inflate } from './inflate';

export interface Ref {
  ref: [number, number];
}
export interface Name {
  name: string;
}
export type PdfValue =
  | number
  | boolean
  | null
  | string
  | Name
  | Ref
  | PdfValue[]
  | Map<string, PdfValue>
  | PdfStream
  | { keyword: string };

/** A stream object: its dictionary and its raw (still encoded) data. */
export class PdfStream {
  constructor(
    public dict: Map<string, PdfValue>,
    public data: Uint8Array,
  ) {}
}

type Entry =
  | { type: 0; gen: number }
  | { type: 1; offset: number; gen: number }
  | { type: 2; stm: number; idx: number };

const isWS = (c: number) => c === 0 || c === 9 || c === 10 || c === 12 || c === 13 || c === 32;
const isDelim = (c: number) =>
  c === 0x28 ||
  c === 0x29 ||
  c === 0x3c ||
  c === 0x3e ||
  c === 0x5b ||
  c === 0x5d ||
  c === 0x7b ||
  c === 0x7d ||
  c === 0x2f ||
  c === 0x25;
const isDigit = (c: number) => c >= 0x30 && c <= 0x39;

function latin1(bytes: Uint8Array, from: number, to: number): string {
  let s = '';
  for (let i = from; i < to; i += 8192) {
    s += String.fromCharCode(...bytes.subarray(i, Math.min(to, i + 8192)));
  }
  return s;
}

function ascii(s: string): Uint8Array {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
  return out;
}

function fail(why: string): never {
  throw new Error(`pdfFile: ${why}`);
}

class Parser {
  constructor(
    readonly b: Uint8Array,
    public pos: number,
  ) {}

  skipWS(): void {
    const b = this.b;
    while (this.pos < b.length) {
      const c = b[this.pos];
      if (isWS(c)) this.pos++;
      else if (c === 0x25) {
        while (this.pos < b.length && b[this.pos] !== 10 && b[this.pos] !== 13) this.pos++;
      } else break;
    }
  }

  private regular(): string {
    const start = this.pos;
    while (this.pos < this.b.length && !isWS(this.b[this.pos]) && !isDelim(this.b[this.pos]))
      this.pos++;
    return latin1(this.b, start, this.pos);
  }

  private peekIntIntKeyword(kw: string): boolean {
    const save = this.pos;
    try {
      this.skipWS();
      const a = this.regular();
      this.skipWS();
      const g = this.regular();
      this.skipWS();
      const k = this.regular();
      return /^\d+$/.test(a) && /^\d+$/.test(g) && k === kw;
    } finally {
      this.pos = save;
    }
  }

  value(depth = 0): PdfValue {
    if (depth > 200) fail('nesting too deep');
    this.skipWS();
    const b = this.b;
    if (this.pos >= b.length) fail('unexpected end');
    const c = b[this.pos];
    if (c === 0x2f) {
      this.pos++;
      return { name: this.regular() };
    }
    if (c === 0x28) return this.literalString();
    if (c === 0x3c) {
      if (b[this.pos + 1] === 0x3c) {
        this.pos += 2;
        const dict = new Map<string, PdfValue>();
        for (;;) {
          this.skipWS();
          if (b[this.pos] === 0x3e && b[this.pos + 1] === 0x3e) {
            this.pos += 2;
            return dict;
          }
          const key = this.value(depth + 1);
          if (typeof key !== 'object' || key === null || !('name' in key))
            fail('bad dictionary key');
          dict.set((key as Name).name, this.value(depth + 1));
        }
      }
      const end = b.indexOf(0x3e, this.pos);
      if (end < 0) fail('unterminated hex string');
      const s = latin1(b, this.pos, end + 1);
      this.pos = end + 1;
      return s;
    }
    if (c === 0x5b) {
      this.pos++;
      const arr: PdfValue[] = [];
      for (;;) {
        this.skipWS();
        if (b[this.pos] === 0x5d) {
          this.pos++;
          return arr;
        }
        arr.push(this.value(depth + 1));
      }
    }
    if (isDelim(c)) fail('unexpected delimiter');
    if (isDigit(c) && this.peekIntIntKeyword('R')) {
      const num = Number(this.regular());
      this.skipWS();
      const gen = Number(this.regular());
      this.skipWS();
      this.regular();
      return { ref: [num, gen] };
    }
    const tok = this.regular();
    if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(tok)) return Number(tok);
    if (tok === 'true') return true;
    if (tok === 'false') return false;
    if (tok === 'null') return null;
    if (tok === '') fail('empty token');
    return { keyword: tok };
  }

  private literalString(): string {
    const b = this.b;
    const start = this.pos;
    let depth = 0;
    for (; this.pos < b.length; this.pos++) {
      const c = b[this.pos];
      if (c === 0x5c) this.pos++;
      else if (c === 0x28) depth++;
      else if (c === 0x29 && --depth === 0) {
        this.pos++;
        return latin1(b, start, this.pos);
      }
    }
    return fail('unterminated string');
  }

  keyword(): string {
    this.skipWS();
    return this.regular();
  }

  objHeader(): [number, number] {
    const num = this.keyword();
    const gen = this.keyword();
    const kw = this.keyword();
    if (!/^\d+$/.test(num) || !/^\d+$/.test(gen) || kw !== 'obj') fail('not an object');
    return [Number(num), Number(gen)];
  }
}

export const isRef = (v: unknown): v is Ref =>
  typeof v === 'object' && v !== null && 'ref' in (v as object);
export const isName = (v: PdfValue | undefined, name?: string): v is Name =>
  typeof v === 'object' &&
  v !== null &&
  'name' in (v as object) &&
  (name === undefined || (v as Name).name === name);
export const isDict = (v: unknown): v is Map<string, PdfValue> => v instanceof Map;

const getInt = (d: Map<string, PdfValue>, key: string): number | undefined => {
  const v = d.get(key);
  return typeof v === 'number' && Number.isInteger(v) ? v : undefined;
};

function decodeStream(dict: Map<string, PdfValue>, raw: Uint8Array): Uint8Array {
  let filter = dict.get('Filter');
  let parms = dict.get('DecodeParms');
  if (Array.isArray(filter)) {
    if (filter.length > 1) fail('unsupported filter chain');
    filter = filter[0];
    parms = Array.isArray(parms) ? parms[0] : parms;
  }
  if (filter === undefined) return raw;
  if (!isName(filter, 'FlateDecode')) fail('unsupported filter');
  let data = inflate(raw);
  if (parms instanceof Map) {
    const predictor = getInt(parms, 'Predictor') ?? 1;
    if (predictor >= 10) {
      const colors = getInt(parms, 'Colors') ?? 1;
      const bpc = getInt(parms, 'BitsPerComponent') ?? 8;
      const columns = getInt(parms, 'Columns') ?? 1;
      const bpp = Math.max(1, Math.ceil((colors * bpc) / 8));
      const rowLen = Math.ceil((colors * bpc * columns) / 8);
      const rows = Math.floor(data.length / (rowLen + 1));
      const out = new Uint8Array(rows * rowLen);
      for (let r = 0; r < rows; r++) {
        const type = data[r * (rowLen + 1)];
        const src = r * (rowLen + 1) + 1;
        const dst = r * rowLen;
        for (let i = 0; i < rowLen; i++) {
          const x = data[src + i];
          const a = i >= bpp ? out[dst + i - bpp] : 0;
          const up = r > 0 ? out[dst - rowLen + i] : 0;
          const ul = r > 0 && i >= bpp ? out[dst - rowLen + i - bpp] : 0;
          let v: number;
          switch (type) {
            case 0:
              v = x;
              break;
            case 1:
              v = x + a;
              break;
            case 2:
              v = x + up;
              break;
            case 3:
              v = x + ((a + up) >> 1);
              break;
            case 4: {
              const p = a + up - ul;
              const pa = Math.abs(p - a);
              const pb = Math.abs(p - up);
              const pc = Math.abs(p - ul);
              v = x + (pa <= pb && pa <= pc ? a : pb <= pc ? up : ul);
              break;
            }
            default:
              return fail('bad predictor');
          }
          out[dst + i] = v & 0xff;
        }
      }
      data = out;
    } else if (predictor !== 1) {
      fail('unsupported predictor');
    }
  }
  return data;
}

function streamData(
  p: Parser,
  dict: Map<string, PdfValue>,
  length: (v: PdfValue | undefined) => number,
): Uint8Array {
  if (p.keyword() !== 'stream') fail('no stream');
  if (p.b[p.pos] === 13) p.pos++;
  if (p.b[p.pos] === 10) p.pos++;
  const len = length(dict.get('Length'));
  if (!(len >= 0) || p.pos + len > p.b.length) fail('bad stream length');
  return p.b.subarray(p.pos, p.pos + len);
}

interface XrefSection {
  entries: Map<number, Entry>;
  trailer: Map<string, PdfValue>;
}

function readXref(bytes: Uint8Array, offset: number): XrefSection {
  if (!(offset >= 0 && offset < bytes.length)) fail('xref offset out of range');
  const p = new Parser(bytes, offset);
  p.skipWS();
  const entries = new Map<number, Entry>();
  if (latin1(bytes, p.pos, p.pos + 4) === 'xref') {
    p.pos += 4;
    for (;;) {
      const tok = p.keyword();
      if (tok === 'trailer') break;
      const count = p.keyword();
      if (!/^\d+$/.test(tok) || !/^\d+$/.test(count)) fail('bad xref table');
      const first = Number(tok);
      for (let i = 0; i < Number(count); i++) {
        const off = p.keyword();
        const gen = p.keyword();
        const kind = p.keyword();
        if (!/^\d+$/.test(off) || !/^\d+$/.test(gen) || (kind !== 'n' && kind !== 'f'))
          fail('bad xref entry');
        const num = first + i;
        if (num === 0 || entries.has(num)) continue;
        entries.set(
          num,
          kind === 'n'
            ? { type: 1, offset: Number(off), gen: Number(gen) }
            : { type: 0, gen: Number(gen) },
        );
      }
    }
    p.skipWS();
    const trailer = p.value();
    if (!(trailer instanceof Map)) fail('bad trailer');
    return { entries, trailer: trailer as Map<string, PdfValue> };
  }
  p.objHeader();
  const dict = p.value();
  if (!(dict instanceof Map) || !isName(dict.get('Type'), 'XRef')) fail('not an xref stream');
  const d = dict as Map<string, PdfValue>;
  const data = decodeStream(
    d,
    streamData(p, d, (v) => (typeof v === 'number' ? v : fail('indirect xref stream length'))),
  );
  const w = d.get('W');
  if (
    !Array.isArray(w) ||
    w.length !== 3 ||
    !w.every((x) => typeof x === 'number' && x >= 0 && x <= 8)
  )
    fail('bad /W');
  const [w0, w1, w2] = w as number[];
  const size = getInt(d, 'Size') ?? fail('no /Size');
  const index = (d.get('Index') as PdfValue[] | undefined) ?? [0, size];
  if (!Array.isArray(index) || index.length % 2 !== 0) fail('bad /Index');
  const rowLen = w0 + w1 + w2;
  const field = (pos: number, n: number) => {
    let v = 0;
    for (let i = 0; i < n; i++) v = v * 256 + data[pos + i];
    return v;
  };
  let pos = 0;
  for (let k = 0; k < index.length; k += 2) {
    const first = index[k] as number;
    const count = index[k + 1] as number;
    for (let i = 0; i < count; i++) {
      if (pos + rowLen > data.length) fail('xref stream too short');
      const type = w0 === 0 ? 1 : field(pos, w0);
      const f2 = field(pos + w0, w1);
      const f3 = field(pos + w0 + w1, w2);
      pos += rowLen;
      const num = first + i;
      if (num === 0 || entries.has(num)) continue;
      if (type === 0) entries.set(num, { type: 0, gen: f3 });
      else if (type === 1) entries.set(num, { type: 1, offset: f2, gen: f3 });
      else if (type === 2) entries.set(num, { type: 2, stm: f2, idx: f3 });
    }
  }
  return { entries, trailer: d };
}

function finalStartxref(bytes: Uint8Array): number {
  const from = Math.max(0, bytes.length - 2048);
  const tail = latin1(bytes, from, bytes.length);
  const at = tail.lastIndexOf('startxref');
  if (at < 0) fail('no startxref');
  const m = /^startxref[\0\t\n\f\r ]+(\d+)/.exec(tail.slice(at));
  if (!m) fail('bad startxref');
  return Number(m![1]);
}

/** Every object of a file, read on demand (newest revision wins). */
export class PdfFile {
  readonly trailer: Map<string, PdfValue>;
  private readonly entries = new Map<number, Entry>();
  private readonly cache = new Map<number, PdfValue>();
  private readonly stmCache = new Map<number, Map<number, PdfValue>>();

  constructor(readonly bytes: Uint8Array) {
    let at: number | undefined = finalStartxref(bytes);
    const visited = new Set<number>();
    let trailer: Map<string, PdfValue> | undefined;
    while (at !== undefined) {
      if (visited.has(at) || visited.size > 10000) fail('xref chain loop');
      visited.add(at);
      const section = readXref(bytes, at);
      trailer ??= section.trailer;
      const add = (m: Map<number, Entry>) =>
        m.forEach((e, n) => this.entries.has(n) || this.entries.set(n, e));
      add(section.entries);
      const stm = getInt(section.trailer, 'XRefStm');
      if (stm !== undefined && !section.trailer.has('Type')) add(readXref(bytes, stm).entries);
      at = getInt(section.trailer, 'Prev');
    }
    this.trailer = trailer!;
  }

  get encrypted(): boolean {
    return this.trailer.has('Encrypt');
  }

  /** Object numbers in use. */
  numbers(): number[] {
    return [...this.entries].filter(([, e]) => e.type !== 0).map(([n]) => n);
  }

  private lengthOf = (v: PdfValue | undefined): number => {
    if (typeof v === 'number') return v;
    if (isRef(v)) {
      const n = this.read(v.ref[0]);
      if (typeof n === 'number') return n;
    }
    return fail('bad stream length');
  };

  /** The object's value; a stream object reads as a PdfStream. */
  read(num: number): PdfValue {
    if (this.cache.has(num)) return this.cache.get(num)!;
    const v = this.load(num);
    this.cache.set(num, v);
    return v;
  }

  /** `v`, or the object it refers to. */
  deref(v: PdfValue | undefined): PdfValue {
    return isRef(v) ? this.read(v.ref[0]) : (v ?? null);
  }

  private load(num: number): PdfValue {
    const entry = this.entries.get(num);
    if (!entry || entry.type === 0) return null;
    if (entry.type === 1) {
      const p = new Parser(this.bytes, entry.offset);
      p.objHeader();
      const v = p.value();
      if (v instanceof Map) {
        const save = p.pos;
        if (p.keyword() === 'stream') {
          p.pos = save;
          return new PdfStream(v, streamData(p, v, this.lengthOf));
        }
      }
      return v;
    }
    let objs = this.stmCache.get(entry.stm);
    if (!objs) {
      const stm = this.read(entry.stm);
      if (!(stm instanceof PdfStream)) fail('object stream not found');
      const data = decodeStream(stm.dict, stm.data);
      const n = getInt(stm.dict, 'N') ?? fail('bad object stream');
      const first = getInt(stm.dict, 'First') ?? fail('bad object stream');
      const hp = new Parser(data, 0);
      const header: [number, number][] = [];
      for (let i = 0; i < n; i++) header.push([Number(hp.keyword()), Number(hp.keyword())]);
      objs = new Map();
      for (const [objNum, off] of header) objs.set(objNum, new Parser(data, first + off).value());
      this.stmCache.set(entry.stm, objs);
    }
    return objs.get(num) ?? null;
  }
}

function num(v: number): string {
  if (Number.isInteger(v)) return String(v);
  let s = v.toFixed(6);
  s = s.replace(/0+$/, '').replace(/\.$/, '');
  return s === '-0' ? '0' : s;
}

function serialize(v: PdfValue, refs: (n: number) => number): string {
  if (v === null) return 'null';
  if (typeof v === 'number') return num(v);
  if (typeof v === 'boolean') return String(v);
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) return `[${v.map((x) => serialize(x, refs)).join(' ')}]`;
  if (v instanceof Map)
    return `<<${[...v].map(([k, x]) => `/${k} ${serialize(x, refs)}`).join(' ')}>>`;
  if (v instanceof PdfStream) fail('stream inside an object');
  if ('name' in v) return `/${v.name}`;
  if ('ref' in v) {
    const n = refs(v.ref[0]);
    return n ? `${n} 0 R` : 'null';
  }
  return v.keyword;
}

/** Objects reachable from `roots` (object numbers) in `objects`. */
export function reachable(objects: Map<number, PdfValue>, roots: number[]): number[] {
  const seen = new Set<number>();
  const order: number[] = [];
  const stack = [...roots].reverse();
  while (stack.length > 0) {
    const n = stack.pop()!;
    if (seen.has(n) || !objects.has(n)) continue;
    seen.add(n);
    order.push(n);
    const found: number[] = [];
    const visit = (v: PdfValue) => {
      if (Array.isArray(v)) v.forEach(visit);
      else if (v instanceof Map) v.forEach(visit);
      else if (v instanceof PdfStream) v.dict.forEach(visit);
      else if (isRef(v)) found.push(v.ref[0]);
    };
    visit(objects.get(n)!);
    for (let i = found.length - 1; i >= 0; i--) stack.push(found[i]);
  }
  return order;
}

/**
 * A new file: `header`, the objects reachable from the trailer's /Root and /Info renumbered
 * 1..n in visiting order, a classic xref table and a trailer (/Size /Root /Info /ID).
 */
export function writePdf(
  header: Uint8Array,
  objects: Map<number, PdfValue>,
  trailer: Map<string, PdfValue>,
): Uint8Array {
  const roots = ['Root', 'Info']
    .map((k) => trailer.get(k))
    .filter(isRef)
    .map((r) => r.ref[0]);
  const order = reachable(objects, roots);
  const renum = new Map(order.map((n, i) => [n, i + 1]));
  const refs = (n: number) => renum.get(n) ?? 0;
  const parts: Uint8Array[] = [header];
  let size = header.length;
  const push = (b: Uint8Array) => {
    parts.push(b);
    size += b.length;
  };
  const offsets: number[] = [];
  for (const n of order) {
    offsets.push(size);
    const v = objects.get(n)!;
    if (v instanceof PdfStream) {
      const dict = new Map(v.dict);
      dict.set('Length', v.data.length);
      push(ascii(`${renum.get(n)} 0 obj\n${serialize(dict, refs)}\nstream\n`));
      push(v.data);
      push(ascii('\nendstream\nendobj\n'));
    } else {
      push(ascii(`${renum.get(n)} 0 obj\n${serialize(v, refs)}\nendobj\n`));
    }
  }
  const xrefAt = size;
  let xref = `xref\n0 ${order.length + 1}\n0000000000 65535 f\r\n`;
  for (const off of offsets) xref += `${String(off).padStart(10, '0')} 00000 n\r\n`;
  const t = new Map<string, PdfValue>([['Size', order.length + 1]]);
  for (const k of ['Root', 'Info', 'ID']) if (trailer.has(k)) t.set(k, trailer.get(k)!);
  xref += `trailer\n${serialize(t, refs)}\nstartxref\n${xrefAt}\n%%EOF\n`;
  push(ascii(xref));
  const out = new Uint8Array(size);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** The file's header: everything before its first object (`%PDF-x.y` and the binary comment). */
export function headerOf(bytes: Uint8Array): Uint8Array {
  const text = latin1(bytes, 0, Math.min(bytes.length, 1024));
  const m = /\d+[\0\t\n\f\r ]+\d+[\0\t\n\f\r ]+obj\b/.exec(text);
  return bytes.slice(0, m ? m.index : 0);
}
