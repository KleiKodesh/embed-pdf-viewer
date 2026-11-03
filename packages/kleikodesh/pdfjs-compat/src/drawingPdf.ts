/**
 * PDF.js's signature drawing (`StampAnnotation`'s drawing appearance) as a
 * one-page PDF whose page is the annotation's rect, for a stamp's
 * `appearance` resource. Each line is PDF.js's Bézier list: a start point
 * `[NaN, NaN, NaN, NaN, x, y]`, then six numbers per segment, a curve
 * `c1x c1y c2x c2y x y` or a line `NaN NaN NaN NaN x y`. Contours are filled,
 * strokes are stroked with round caps and joins, as PDF.js draws them.
 */
export interface Drawing {
  rect: number[];
  lines: ArrayLike<number>[];
  /** 0–255 RGB. */
  color: ArrayLike<number>;
  thickness: number;
  areContours: boolean;
}

const num = (n: number) => {
  const r = Math.round(n * 100) / 100;
  return Object.is(r, -0) ? '0' : String(r);
};

export function drawingContent({ lines, color, thickness, areContours }: Drawing): string {
  const rgb = [0, 1, 2].map((i) => num((Number(color[i]) || 0) / 255)).join(' ');
  const out = [`${num(thickness)} w 1 J 1 j`, `${rgb} ${areContours ? 'rg' : 'RG'}`];
  for (const line of lines) {
    if (line.length < 6) continue;
    out.push(`${num(line[4])} ${num(line[5])} m`);
    for (let i = 6; i + 6 <= line.length; i += 6) {
      if (Number.isNaN(line[i])) out.push(`${num(line[i + 4])} ${num(line[i + 5])} l`);
      else
        out.push(
          `${num(line[i])} ${num(line[i + 1])} ${num(line[i + 2])} ${num(line[i + 3])} ${num(line[i + 4])} ${num(line[i + 5])} c`,
        );
    }
    if (line.length === 6) out.push(`${num(line[4])} ${num(line[5])} l`);
  }
  out.push(areContours ? 'f' : 'S');
  return out.join('\n');
}

export function drawingPdf(drawing: Drawing): Uint8Array {
  const [x1, y1, x2, y2] = drawing.rect;
  const box = [Math.min(x1, x2), Math.min(y1, y2), Math.max(x1, x2), Math.max(y1, y2)]
    .map(num)
    .join(' ');
  const content = drawingContent(drawing);
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [${box}] /Resources << >> /Contents 4 0 R >>`,
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
  ];
  let pdf = '%PDF-1.7\n';
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(pdf.length);
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(pdf);
}
