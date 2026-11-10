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
// Verbatim from PDF.js 5.7.284: normalizeUnicode (src/shared/util.js) and
// removeNullCharacters (web/ui_utils.js).

let NormalizeRegex: RegExp | null = null
let NormalizationMap: Map<string, string> | null = null
export function normalizeUnicode(str: string) {
  if (!NormalizeRegex) {
    NormalizeRegex =
      /([ µ;ຳ -  Ωﬀ-ﬄﬆﬠ-זּטּ-לּמּנּ-סּףּ-פּצּ-ﮡﮤ-ﮩﮮ-ﮱﯓ-ﯜﯞ-ﯧﯪ-ﯸﯼ-ﯽﰀ-ﱝﱤ-ﳱﳵ-ﴽﶈﷴﷺ-ﷻﹱﹷﹹﹻﹽ]+)|(ﬅ+)/gu
    NormalizationMap = new Map([['ﬅ', 'ſt']])
  }
  return str.replaceAll(NormalizeRegex, (_, p1, p2) => (p1 ? p1.normalize('NFKC') : NormalizationMap!.get(p2)!))
}

const InvisibleCharsRegExp = /[\x00-\x1F]/g
export function removeNullCharacters(str: string, replaceInvisible = false) {
  if (!InvisibleCharsRegExp.test(str)) return str
  if (replaceInvisible) return str.replaceAll(InvisibleCharsRegExp, (m) => (m === '\x00' ? '' : ' '))
  return str.replaceAll('\x00', '')
}
