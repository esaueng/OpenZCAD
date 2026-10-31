import {
  SHEET_STROKE_DASH_MM,
  SHEET_STROKE_ORDER,
  SHEET_STROKE_WIDTH_MM,
  sheetSafeText,
  textWidthMm,
  type SheetPage,
  type SheetText
} from './sheetPage';
import { exportFileStem } from '../model';

/** The longest file name the desktop save dialog accepts, in bytes. */
export const MAX_EXPORT_FILE_NAME_BYTES = 160;
/** The sheet's share of an export name, so the project keeps a readable part. */
const SHEET_STEM_LIMIT = 60;

/**
 * `project-sheet.ext`, bounded to what the desktop save dialog accepts:
 * each name is valid on its own, but two long ones together are not.
 * Stems are ASCII, so characters are bytes.
 */
export function drawingExportFileName(
  projectName: string,
  sheetName: string,
  format: 'pdf' | 'svg'
): string {
  const extension = `.${format}`;
  const room = MAX_EXPORT_FILE_NAME_BYTES - extension.length - 1;
  const trim = (stem: string) => stem.replace(/[-. ]+$/, '');
  const sheet =
    trim(exportFileStem(sheetName).slice(0, SHEET_STEM_LIMIT)) || 'sheet';
  const project = trim(
    exportFileStem(projectName).slice(0, room - sheet.length)
  );
  return `${project || 'openzcad-part'}-${sheet}${extension}`;
}

/**
 * Sheet export: the composed page as SVG text or PDF bytes. Both are pure,
 * dependency-free serializers of the same `SheetPage` the preview draws, and
 * both are deterministic — no timestamps, ids or locale-dependent numbers —
 * so the same document and kernel pin export identical bytes after a reload.
 */

/** Fixed-point with trailing zeros trimmed; never exponent notation. */
function num(value: number, digits = 3): string {
  const fixed = (Math.abs(value) < 10 ** -digits / 2 ? 0 : value).toFixed(
    digits
  );
  return fixed.includes('.') ? fixed.replace(/\.?0+$/, '') : fixed;
}

function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Where a text's start lies: `align` measures back along its baseline by
 * the same Helvetica metrics layout used, so SVG and PDF agree.
 */
export function sheetTextStart(text: SheetText): { x: number; y: number } {
  if (!text.align) return { x: text.x, y: text.y };
  const width = textWidthMm(text.text, text.sizeMm, text.bold);
  const shift = text.align === 'middle' ? width / 2 : width;
  const radians = ((text.angleDeg ?? 0) * Math.PI) / 180;
  return {
    x: text.x - Math.cos(radians) * shift,
    y: text.y - Math.sin(radians) * shift
  };
}

/** One SVG user unit is one paper millimetre; y is flipped to SVG's down. */
export function sheetPageToSvg(page: SheetPage, title: string): string {
  const h = page.heightMm;
  const lines: string[] = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<svg xmlns="http://www.w3.org/2000/svg" width="${num(page.widthMm)}mm" height="${num(h)}mm" viewBox="0 0 ${num(page.widthMm)} ${num(h)}">`,
    // Sheet names come from saved documents; only text an XML parser
    // accepts goes into the file (the same rule as the page's own text).
    `<title>${escapeXml(sheetSafeText(title))}</title>`,
    `<rect width="${num(page.widthMm)}" height="${num(h)}" fill="#ffffff"/>`
  ];
  for (const kind of SHEET_STROKE_ORDER) {
    const strokes = page.strokes.filter((stroke) => stroke.kind === kind);
    if (strokes.length === 0) continue;
    const pattern = SHEET_STROKE_DASH_MM[kind];
    const dash = pattern
      ? ` stroke-dasharray="${pattern.map((value) => num(value)).join(' ')}"`
      : '';
    lines.push(
      `<g class="${kind}" fill="none" stroke="#000000" stroke-width="${num(SHEET_STROKE_WIDTH_MM[kind])}" stroke-linecap="round" stroke-linejoin="round"${dash}>`
    );
    for (const stroke of strokes) {
      const coords: string[] = [];
      for (let i = 0; i + 1 < stroke.points.length; i += 2)
        coords.push(
          `${num(stroke.points[i]!)},${num(h - stroke.points[i + 1]!)}`
        );
      lines.push(
        stroke.filled
          ? `<polygon points="${coords.join(' ')}" fill="#000000" stroke="none"/>`
          : `<${stroke.closed ? 'polygon' : 'polyline'} points="${coords.join(' ')}"/>`
      );
    }
    lines.push('</g>');
  }
  if (page.texts.length > 0) {
    lines.push('<g font-family="Helvetica, Arial, sans-serif" fill="#000000">');
    for (const text of page.texts) {
      if (!text.text) continue;
      // `sizeMm` is cap height-ish; Helvetica's cap height is 0.718 em.
      // Aligned text is placed from its measured start, as in the PDF, so
      // a viewer's own font metrics cannot move it.
      const start = sheetTextStart(text);
      const turn = text.angleDeg
        ? ` transform="rotate(${num(-text.angleDeg)} ${num(start.x)} ${num(h - start.y)})"`
        : '';
      lines.push(
        `<text x="${num(start.x)}" y="${num(h - start.y)}" font-size="${num(text.sizeMm / 0.718)}"${text.bold ? ' font-weight="bold"' : ''}${turn}>${escapeXml(text.text)}</text>`
      );
    }
    lines.push('</g>');
  }
  lines.push('</svg>', '');
  return lines.join('\n');
}

const PT_PER_MM = 72 / 25.4;

/** A PDF literal string for WinAnsi text: Latin-1 bytes, escaped. */
function pdfString(text: string): string {
  let out = '(';
  for (const char of text) {
    const code = char.codePointAt(0)!;
    if (char === '(' || char === ')' || char === '\\') out += `\\${char}`;
    else if (code >= 0x20 && code <= 0x7e) out += char;
    else if (code >= 0xa0 && code <= 0xff)
      out += `\\${code.toString(8).padStart(3, '0')}`;
    else out += '?';
  }
  return `${out})`;
}

/**
 * A single-page vector PDF 1.4: the page's strokes as paths and its text in
 * the base-14 Helvetica faces with WinAnsi encoding (not embedded — every
 * reader supplies them). Coordinates convert from paper millimetres to points.
 */
export function sheetPageToPdf(page: SheetPage, title: string): Uint8Array {
  const pt = (mm: number) => num(mm * PT_PER_MM);
  // Clipped to the page: the composed page already drops what lies past the
  // paper, and this keeps any glyph that runs over its edge on it too.
  const content: string[] = [
    `0 0 ${pt(page.widthMm)} ${pt(page.heightMm)} re W n`,
    '1 J 1 j 0 0 0 RG 0 0 0 rg'
  ];
  for (const kind of SHEET_STROKE_ORDER) {
    const strokes = page.strokes.filter((stroke) => stroke.kind === kind);
    if (strokes.length === 0) continue;
    content.push(`${pt(SHEET_STROKE_WIDTH_MM[kind])} w`);
    const pattern = SHEET_STROKE_DASH_MM[kind];
    content.push(pattern ? `[${pattern.map(pt).join(' ')}] 0 d` : '[] 0 d');
    for (const stroke of strokes) {
      const path: string[] = [];
      for (let i = 0; i + 1 < stroke.points.length; i += 2)
        path.push(
          `${pt(stroke.points[i]!)} ${pt(stroke.points[i + 1]!)} ${i === 0 ? 'm' : 'l'}`
        );
      if (path.length < 2) continue;
      content.push(
        `${path.join(' ')} ${stroke.filled ? 'h f' : stroke.closed ? 's' : 'S'}`
      );
    }
  }
  for (const text of page.texts) {
    if (!text.text) continue;
    const start = sheetTextStart(text);
    const radians = ((text.angleDeg ?? 0) * Math.PI) / 180;
    const place = text.angleDeg
      ? `${num(Math.cos(radians), 6)} ${num(Math.sin(radians), 6)} ${num(-Math.sin(radians), 6)} ${num(Math.cos(radians), 6)} ${pt(start.x)} ${pt(start.y)} Tm`
      : `${pt(start.x)} ${pt(start.y)} Td`;
    content.push(
      `BT /${text.bold ? 'F2' : 'F1'} ${pt(text.sizeMm / 0.718)} Tf ${place} ${pdfString(text.text)} Tj ET`
    );
  }
  const stream = content.join('\n');
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pt(page.widthMm)} ${pt(page.heightMm)}] /Resources << /Font << /F1 5 0 R /F2 6 0 R >> >> /Contents 4 0 R >>`,
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>',
    `<< /Title ${pdfString(sheetSafeText(title))} /Producer (OpenZCAD) >>`
  ];
  // Every character is one Latin-1 byte (strings escape the rest), so byte
  // offsets are string lengths.
  let body = '%PDF-1.4\n%âãÏÓ\n';
  const offsets: number[] = [];
  objects.forEach((object, index) => {
    offsets.push(body.length);
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets)
    body += `${String(offset).padStart(10, '0')} 00000 n \n`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info ${objects.length} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  const bytes = new Uint8Array(body.length);
  for (let i = 0; i < body.length; i += 1) bytes[i] = body.charCodeAt(i) & 0xff;
  return bytes;
}
