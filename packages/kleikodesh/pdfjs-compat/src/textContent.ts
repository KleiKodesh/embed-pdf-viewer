/* Copyright 2012 Mozilla Foundation
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
// PDF.js 5.7.284 `page.getTextContent()` built from the engine's `page.text.objects()`:
// objects in content order with their marked-content stacks, glyphs in pen order.
// The grouping is PDF.js's evaluator code (compareWithLastPosition & co.).
import type { PageTextObjectsSnapshot } from '@embedpdf/engine-core';
import { bidi } from './bidi';
import { normalizeUnicode } from './textUtils';

export interface TextItem {
  str: string;
  dir: string;
  width: number;
  height: number;
  transform: number[];
  fontName: string;
  hasEOL: boolean;
}
export interface TextStyle {
  fontFamily: string;
  ascent: number;
  descent: number;
  vertical: boolean;
}
export type MarkedItem =
  | { type: 'beginMarkedContentProps'; id: string | null; tag: string | null }
  | { type: 'endMarkedContent' };
export type ContentItem = TextItem | MarkedItem;

export interface PdfjsTextContent {
  items: ContentItem[];
  styles: Record<string, TextStyle>;
  lang: string | null;
}

export interface BuildTextContentOptions {
  /** The page's view box [x1, y1, x2, y2] (crop box): glyphs outside it are dropped. */
  viewBox: number[];
  /** The page's object number, for marked-content ids (`p<n>R_mc<MCID>`). */
  pageObjNum: number | null;
  /**
   * `getTextContent()` defaults (copy-all): normalized text, no marked content. Otherwise
   * `{ includeMarkedContent: true, disableNormalization: true }` (the text layer).
   */
  plain?: boolean;
}

const TRACKING_SPACE_FACTOR = 0.102;
const NOT_A_SPACE_FACTOR = 0.03;
const NEGATIVE_SPACE_FACTOR = -0.2;
const SPACE_IN_FLOW_MIN_FACTOR = 0.102;
const SPACE_IN_FLOW_MAX_FACTOR = 0.6;
const VERTICAL_SHIFT_RATIO = 0.25;
// getSerifFonts() keys that can match a normalized (whitespace-free) name.
const SERIF_FONTS = new Set(['Bembo', 'Bodoni', 'Bordeaux', 'Cholla', 'Concrete', 'Plantin', 'Rotis', 'Trinité', 'Trump', 'Wingdings']);

interface Glyph {
  ch: string;
  x: number;
  y: number;
  w: number;
  matrix: number[];
  fs: number;
  advScale: number;
  fontName: string;
  isSpace: boolean;
  piled: boolean;
}

function fontFamily(font: PageTextObjectsSnapshot['fonts'][number]) {
  // fonts.js: fallbackName = isMonospace ? "monospace" : isSerifFont ? "serif" : "sans-serif"
  let isSerif = font.serif;
  if (!isSerif) {
    for (const part of font.baseName.split('+')) {
      const n = part.replaceAll(/[,_]/g, '-').replaceAll(/\s/g, '').split('-', 1)[0];
      if (SERIF_FONTS.has(n)) {
        isSerif = true;
        break;
      }
    }
  }
  return font.monospace ? 'monospace' : isSerif ? 'serif' : 'sans-serif';
}

/** PDF.js `page.getTextContent()` items and styles from `page.text.objects()`. */
export function buildTextContent(snapshot: PageTextObjectsSnapshot, opts: BuildTextContentOptions): PdfjsTextContent {
  const { viewBox } = opts;
  const plain = !!opts.plain;
  const styles: Record<string, TextStyle> = Object.create(null);
  const fontNames = new Map<number, string>();
  const glyphs: Glyph[][] = snapshot.objects.map((o) => {
    if (o.kind !== 'text' || !o.glyphs.length) return [];
    let fontName = fontNames.get(o.font);
    if (!fontName) {
      fontName = `g_d0_f${fontNames.size + 1}`;
      fontNames.set(o.font, fontName);
      styles[fontName] = { fontFamily: fontFamily(snapshot.fonts[o.font]), ascent: 0, descent: 0, vertical: false };
    }
    const m = o.matrix;
    const matrix = [m[0], m[1], m[2], m[3]].map((v) => v * o.fontSize);
    const advScale = Math.hypot(m[0], m[1]) || 1;
    return o.glyphs.map((g) => ({
      ch: g.unicode,
      x: g.origin.x,
      y: g.origin.y,
      w: g.advance,
      matrix,
      fs: o.fontSize,
      advScale,
      fontName: fontName!,
      isSpace: /^\s$/.test(g.unicode),
      piled: !!g.stacked,
    }));
  });

  const textContent: PdfjsTextContent = { items: [], styles, lang: null };
  const pageObjId = opts.pageObjNum !== null ? `p${opts.pageObjNum}R` : 'p';
  const keepWhiteSpace = false;
  const twoLastChars = [' ', ' '];
  let twoLastCharsPos = 0;
  let curMatrix = [1, 0, 0, 1];
  let curAdvScale = 1;
  let posX = 0;
  let posY = 0;
  let loadedName = '';
  let fontSize = 0;
  const item = {
    initialized: false,
    str: [] as string[],
    totalWidth: 0,
    totalHeight: 0,
    width: 0,
    height: 0,
    vertical: false,
    prevTransform: null as number[] | null,
    textAdvanceScale: 1,
    spaceInFlowMin: 0,
    spaceInFlowMax: 0,
    trackingSpaceMin: Infinity,
    negativeSpaceMax: -Infinity,
    notASpace: -Infinity,
    transform: null as number[] | null,
    fontName: null as string | null,
    hasEOL: false,
  };
  const getCurrentTextTransform = () => [...curMatrix, posX, posY];
  function saveLastChar(char: string) {
    const nextPos = (twoLastCharsPos + 1) % 2;
    const ret = twoLastChars[twoLastCharsPos] !== ' ' && twoLastChars[nextPos] === ' ';
    twoLastChars[twoLastCharsPos] = char;
    twoLastCharsPos = nextPos;
    return !keepWhiteSpace && ret;
  }
  function shouldAddWhitepsace() {
    return !keepWhiteSpace && twoLastChars[twoLastCharsPos] !== ' ' && twoLastChars[(twoLastCharsPos + 1) % 2] === ' ';
  }
  function resetLastChars() {
    twoLastChars[0] = twoLastChars[1] = ' ';
    twoLastCharsPos = 0;
  }
  function pushWhitespace({
    width = 0,
    height = 0,
    transform = item.prevTransform,
    fontName = item.fontName,
  }: {
    width?: number;
    height?: number;
    transform?: number[] | null;
    fontName?: string | null;
  }) {
    textContent.items.push({ str: ' ', dir: 'ltr', width, height, transform: transform!, fontName: fontName!, hasEOL: false });
  }
  function ensureTextContentItem() {
    if (item.initialized) return item;
    item.fontName = loadedName;
    const trm = (item.transform = getCurrentTextTransform());
    item.width = item.totalWidth = 0;
    item.height = item.totalHeight = Math.hypot(trm[2], trm[3]);
    item.vertical = false;
    item.textAdvanceScale = curAdvScale;
    item.trackingSpaceMin = fontSize * TRACKING_SPACE_FACTOR;
    item.notASpace = fontSize * NOT_A_SPACE_FACTOR;
    item.negativeSpaceMax = fontSize * NEGATIVE_SPACE_FACTOR;
    item.spaceInFlowMin = fontSize * SPACE_IN_FLOW_MIN_FACTOR;
    item.spaceInFlowMax = fontSize * SPACE_IN_FLOW_MAX_FACTOR;
    item.hasEOL = false;
    item.initialized = true;
    return item;
  }
  function flushTextContentItem() {
    if (!item.initialized || !item.str) return;
    item.totalWidth += item.width * item.textAdvanceScale;
    let text = item.str.join('');
    if (plain) text = normalizeUnicode(text); // !disableNormalization
    const bidiResult = bidi(text, -1, item.vertical);
    textContent.items.push({
      str: bidiResult.str,
      dir: bidiResult.dir,
      width: Math.abs(item.totalWidth),
      height: Math.abs(item.totalHeight),
      transform: item.transform!,
      fontName: item.fontName!,
      hasEOL: item.hasEOL,
    });
    item.initialized = false;
    item.str.length = 0;
  }
  function appendEOL() {
    resetLastChars();
    if (item.initialized) {
      item.hasEOL = true;
      flushTextContentItem();
    } else {
      textContent.items.push({ str: '', dir: 'ltr', width: 0, height: 0, transform: getCurrentTextTransform(), fontName: loadedName, hasEOL: true });
    }
  }
  function addFakeSpaces(width: number, transf: number[] | null, textOrientation: number) {
    if (textOrientation * item.spaceInFlowMin <= width && width <= textOrientation * item.spaceInFlowMax) {
      if (item.initialized) {
        resetLastChars();
        item.str.push(' ');
      }
      return false;
    }
    const fontName = item.fontName;
    flushTextContentItem();
    resetLastChars();
    pushWhitespace({ width: Math.abs(width), height: 0, transform: transf || getCurrentTextTransform(), fontName });
    return true;
  }
  function applyInverseRotation(x: number, y: number, matrix: number[]) {
    const scale = Math.hypot(matrix[0], matrix[1]);
    return [(matrix[0] * x + matrix[1] * y) / scale, (matrix[2] * x + matrix[3] * y) / scale];
  }
  function compareWithLastPosition(glyphWidth: number) {
    const currentTransform = getCurrentTextTransform();
    let x = currentTransform[4];
    let y = currentTransform[5];
    if (x + glyphWidth < viewBox[0] || x > viewBox[2] || y < viewBox[1] || y > viewBox[3]) return false;
    if (!item.prevTransform) return true;
    let lastPosX = item.prevTransform[4];
    let lastPosY = item.prevTransform[5];
    if (lastPosX === x && lastPosY === y) return true;
    let rotate = -1;
    if (currentTransform[0] && currentTransform[1] === 0 && currentTransform[2] === 0) rotate = currentTransform[0] > 0 ? 0 : 180;
    else if (currentTransform[1] && currentTransform[0] === 0 && currentTransform[3] === 0) rotate = currentTransform[1] > 0 ? 90 : 270;
    switch (rotate) {
      case 0:
        break;
      case 90:
        [x, y] = [y, x];
        [lastPosX, lastPosY] = [lastPosY, lastPosX];
        break;
      case 180:
        [x, y, lastPosX, lastPosY] = [-x, -y, -lastPosX, -lastPosY];
        break;
      case 270:
        [x, y] = [-y, -x];
        [lastPosX, lastPosY] = [-lastPosY, -lastPosX];
        break;
      default:
        [x, y] = applyInverseRotation(x, y, currentTransform);
        [lastPosX, lastPosY] = applyInverseRotation(lastPosX, lastPosY, item.prevTransform);
    }
    const advanceX = (x - lastPosX) / item.textAdvanceScale;
    const advanceY = y - lastPosY;
    const textOrientation = Math.sign(item.width || item.totalWidth);
    if (advanceX < textOrientation * item.negativeSpaceMax) {
      if (Math.abs(advanceY) > 0.5 * item.height) {
        appendEOL();
        return true;
      }
      resetLastChars();
      flushTextContentItem();
      return true;
    }
    if (Math.abs(advanceY) > item.height) {
      appendEOL();
      return true;
    }
    if (advanceX <= textOrientation * item.notASpace) resetLastChars();
    if (advanceX <= textOrientation * item.trackingSpaceMin) {
      if (shouldAddWhitepsace()) {
        resetLastChars();
        flushTextContentItem();
        pushWhitespace({ width: Math.abs(advanceX) });
      } else {
        item.width += advanceX;
      }
    } else if (!addFakeSpaces(advanceX, item.prevTransform, textOrientation)) {
      if (item.str.length === 0) {
        resetLastChars();
        pushWhitespace({ width: Math.abs(advanceX) });
      } else {
        item.width += advanceX;
      }
    }
    if (Math.abs(advanceY) > item.height * VERTICAL_SHIFT_RATIO) flushTextContentItem();
    return true;
  }

  // Marked content: transitions between consecutive objects' mark stacks.
  let open: number[] = [];
  const syncMarks = (marks: number[]) => {
    let common = 0;
    while (common < open.length && common < marks.length && open[common] === marks[common]) common++;
    for (let i = open.length; i > common; i--) {
      flushTextContentItem();
      if (!plain) textContent.items.push({ type: 'endMarkedContent' });
    }
    for (let i = common; i < marks.length; i++) {
      flushTextContentItem();
      if (plain) continue;
      const m = snapshot.marks[marks[i]];
      textContent.items.push({
        type: 'beginMarkedContentProps',
        id: m.mcid !== undefined && Number.isInteger(m.mcid) ? `${pageObjId}_mc${m.mcid}` : null,
        tag: m.tag || null,
      });
    }
    open = marks;
  };

  snapshot.objects.forEach((o, oi) => {
    syncMarks(o.marks);
    for (const g of glyphs[oi]) {
      // setFont: a different font or size flushes (buildTextContentItem's check).
      if (g.fontName !== loadedName || g.fs !== fontSize) {
        if (loadedName) flushTextContentItem();
        loadedName = g.fontName;
        fontSize = g.fs;
      }
      curMatrix = g.matrix;
      curAdvScale = g.advScale;
      posX = g.x;
      posY = g.y;
      if (g.isSpace) {
        saveLastChar(' ');
        continue;
      }
      // Each piled (zero-advance) glyph is its own item, as PDF.js gives them.
      if (g.piled) {
        flushTextContentItem();
        resetLastChars();
      }
      if (!compareWithLastPosition(g.w)) continue;
      const chunk = ensureTextContentItem();
      chunk.width += g.w / g.advScale;
      if (g.w) {
        const h = Math.hypot(g.matrix[0], g.matrix[1]) || 1;
        chunk.prevTransform = [...g.matrix, g.x + (g.matrix[0] / h) * g.w, g.y + (g.matrix[1] / h) * g.w];
      }
      if (saveLastChar(g.ch)) chunk.str.push(' ');
      chunk.str.push(g.ch);
    }
  });
  syncMarks([]);
  flushTextContentItem();
  return textContent;
}

/** The find controller's items: `{ str, hasEOL }` of the text items only. */
export function liteTextItems(content: PdfjsTextContent): { str: string; hasEOL: boolean }[] {
  const out: { str: string; hasEOL: boolean }[] = [];
  for (const it of content.items) if ('str' in it) out.push({ str: it.str, hasEOL: it.hasEOL });
  return out;
}
