/**
 * The KitveiHakodesh table-of-contents marker. An update section that only
 * rewrites the outline ends, right after its `%%EOF`, with
 *
 *   %KH-TOC start=<S> prev=<P> sha=<H>
 *
 * where `S` is the byte offset the section starts at, `P` the previous
 * cross-reference offset (the section's `/Prev`) and `H` the SHA-256 (hex) of
 * the bytes from `S` up to the marker. The next outline save starts again
 * from the bytes before `S`, so outline edits never stack up sections.
 *
 * A marker is trusted only when it provably describes the file's last
 * section; anything else (another tool's update after ours, a rewrite, a
 * forged or stale marker) is left alone and the next save appends.
 */

const MARKER_RE =
  /(?:^|[\r\n])%KH-TOC start=(\d+) prev=(\d+)(?: sha=([0-9a-f]{64}))?[ \t]*[\r\n]?[\0\t\n\f\r ]*$/;

export interface TocMarker {
  /** Where the outline section starts: the bytes before it are the file it updates. */
  start: number;
  /** The previous cross-reference offset, the section's `/Prev`. */
  prev: number;
}

const latin1 = (bytes: Uint8Array, from = 0, to = bytes.length) => {
  let s = '';
  for (let i = from; i < to; i += 0x8000) {
    s += String.fromCharCode(...bytes.subarray(i, Math.min(to, i + 0x8000)));
  }
  return s;
};

/** SHA-256 of `bytes`, lower-case hex. */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>));
  return Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('');
}

function markerLine(bytes: Uint8Array) {
  const from = Math.max(0, bytes.length - 256);
  const m = MARKER_RE.exec(latin1(bytes, from));
  if (!m) return null;
  return {
    start: Number(m[1]),
    prev: Number(m[2]),
    sha: m[3] || null,
    at: from + m.index + (m[0][0] === '%' ? 0 : 1),
  };
}

/**
 * The file's trailing marker, or `null` unless it provably describes the last
 * section: the section follows an `%%EOF` and a cross-reference at `prev`, has
 * exactly one `startxref` and `%%EOF`, its cross-reference lies inside it with
 * `/Prev prev`, and its hash matches.
 */
export async function readTocMarker(bytes: Uint8Array): Promise<TocMarker | null> {
  const ml = markerLine(bytes);
  if (!ml) return null;
  const { start, prev, sha, at } = ml;
  if (
    !(
      Number.isSafeInteger(start) &&
      Number.isSafeInteger(prev) &&
      start > 0 &&
      start < at &&
      prev >= 0 &&
      prev < start
    )
  ) {
    return null;
  }
  const atPrev = latin1(bytes, prev, Math.min(start, prev + 512));
  if (!/^xref\s/.test(atPrev) && !/^\d+\s+\d+\s+obj\s*<<[\s\S]*\/Type\s*\/XRef\b/.test(atPrev)) {
    return null;
  }
  if (!/%%EOF[\0\t\n\f\r ]*$/.test(latin1(bytes, Math.max(0, start - 64), start))) return null;
  const section = latin1(bytes, start, at);
  if (!/^\s*(?:\d+\s+\d+\s+obj\b|xref\s)/.test(section)) return null;
  if (section.split('%%EOF').length !== 2 || section.split('startxref').length !== 2) return null;
  const end = /startxref\s+(\d+)\s+%%EOF\s*$/.exec(section);
  if (!end) return null;
  const xrefAt = Number(end[1]);
  if (!(xrefAt >= start && xrefAt < start + end.index)) return null;
  const xrefPart = section.slice(xrefAt - start, end.index);
  let dict: string;
  if (/^xref\s/.test(xrefPart)) {
    const t = xrefPart.indexOf('trailer');
    if (t < 0) return null;
    dict = xrefPart.slice(t);
  } else if (/^\d+\s+\d+\s+obj\s*<</.test(xrefPart) && /\/Type\s*\/XRef\b/.test(xrefPart)) {
    dict = xrefPart.slice(0, Math.max(0, xrefPart.indexOf('stream')) || xrefPart.length);
  } else {
    return null;
  }
  const prevs = dict.match(/\/Prev\s+(\d+)/g);
  if (!prevs || prevs.length !== 1 || Number(/\d+/.exec(prevs[0])![0]) !== prev) return null;
  if (sha && (await sha256Hex(bytes.subarray(start, at))) !== sha) return null;
  return { start, prev };
}

/**
 * `saved` with the marker appended for its last section, which starts at
 * `start` (the length of the file it updates). Returns `saved` unchanged when
 * the marker would not prove that section, so the result never carries a
 * marker that `readTocMarker` rejects.
 */
export async function appendTocMarker(saved: Uint8Array, start: number): Promise<Uint8Array> {
  const section = latin1(saved, start);
  // The trailer (or cross-reference stream dictionary) comes after the
  // section's objects, whose outline items have /Prev keys of their own.
  const prevs = section.match(/\/Prev\s+(\d+)(?!\d)(?!\s+\d+\s+R)/g);
  if (!prevs) return saved;
  const prev = Number(/\d+/.exec(prevs[prevs.length - 1])![0]);
  const body = /[\r\n]$/.test(section) ? saved : concat(saved, new Uint8Array([10]));
  const line = `%KH-TOC start=${start} prev=${prev} sha=${await sha256Hex(body.subarray(start))}\n`;
  const out = concat(body, Uint8Array.from(line, (c) => c.charCodeAt(0)));
  return (await readTocMarker(out)) ? out : saved;
}

function concat(a: Uint8Array, b: Uint8Array) {
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}
