import {
  SHEET_STROKE_DASH_MM,
  SHEET_STROKE_ORDER,
  sheetStrokeWidthMm,
  sheetSafeText,
  textWidthMm,
  type SheetPage,
  type SheetStrokeKind,
  type SheetText
} from './sheetPage';
import {
  dxfTextLength,
  MAX_DXF_TEXT_LENGTH,
  writeDxf,
  type DxfEntity,
  type DxfLayer
} from '@openzcad/io-dxf';
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
  format: 'pdf' | 'svg' | 'dxf'
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
/** Why a page's picture cannot be written: its bytes are not at hand. */
export class SheetPictureUnavailableError extends Error {
  override name = 'SheetPictureUnavailableError';
  constructor() {
    super(
      'A picture on this sheet is not available on this device yet; open it in Build once it has downloaded, then export.'
    );
  }
}

/**
 * D02 (v92): `pictures` holds each page picture's bytes as a data URL, by
 * checksum; a page with pictures and none at hand refuses rather than
 * leaving a hole in the print.
 */
export function sheetPageToSvg(
  page: SheetPage,
  title: string,
  pictures?: ReadonlyMap<string, string>
): string {
  const h = page.heightMm;
  const lines: string[] = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<svg xmlns="http://www.w3.org/2000/svg" width="${num(page.widthMm)}mm" height="${num(h)}mm" viewBox="0 0 ${num(page.widthMm)} ${num(h)}">`,
    // Sheet names come from saved documents; only text an XML parser
    // accepts goes into the file (the same rule as the page's own text).
    `<title>${escapeXml(sheetSafeText(title))}</title>`,
    `<rect width="${num(page.widthMm)}" height="${num(h)}" fill="#ffffff"/>`
  ];
  for (const image of page.images ?? []) {
    const href = pictures?.get(image.checksumSha256);
    if (!href) throw new SheetPictureUnavailableError();
    lines.push(
      `<image x="${num(image.x)}" y="${num(h - image.y - image.height)}" width="${num(image.width)}" height="${num(image.height)}" preserveAspectRatio="none" href="${escapeXml(href)}"/>`
    );
  }
  for (const kind of SHEET_STROKE_ORDER) {
    const strokes = page.strokes.filter((stroke) => stroke.kind === kind);
    if (strokes.length === 0) continue;
    const pattern = SHEET_STROKE_DASH_MM[kind];
    const dash = pattern
      ? ` stroke-dasharray="${pattern.map((value) => num(value)).join(' ')}"`
      : '';
    lines.push(
      `<g class="${kind}" fill="none" stroke="#000000" stroke-width="${num(sheetStrokeWidthMm(page, kind))}" stroke-linecap="round" stroke-linejoin="round"${dash}>`
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

/**
 * D02 (v92): a JPEG's size and colour components, read from its first
 * start-of-frame marker, so a PDF can carry the bytes as they are
 * (DCTDecode). Refuses anything that is not a JPEG with a frame header.
 */
export function jpegInfo(bytes: Uint8Array): {
  width: number;
  height: number;
  components: 1 | 3 | 4;
} {
  const refuse = () =>
    new Error('A picture on this sheet is not a readable JPEG.');
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) throw refuse();
  let at = 2;
  while (at + 4 <= bytes.length) {
    if (bytes[at] !== 0xff) throw refuse();
    const marker = bytes[at + 1]!;
    // Fill bytes before a marker.
    if (marker === 0xff) {
      at += 1;
      continue;
    }
    const length = (bytes[at + 2]! << 8) | bytes[at + 3]!;
    // Start of frame: any SOFn but DHT (C4), JPG (C8) and DAC (CC).
    if (
      marker >= 0xc0 &&
      marker <= 0xcf &&
      marker !== 0xc4 &&
      marker !== 0xc8 &&
      marker !== 0xcc
    ) {
      if (at + 9 >= bytes.length) throw refuse();
      const height = (bytes[at + 5]! << 8) | bytes[at + 6]!;
      const width = (bytes[at + 7]! << 8) | bytes[at + 8]!;
      const components = bytes[at + 9]!;
      if (
        width === 0 ||
        height === 0 ||
        (components !== 1 && components !== 3 && components !== 4)
      )
        throw refuse();
      return { width, height, components };
    }
    if (marker === 0xd9 || marker === 0xda) break;
    at += 2 + length;
  }
  throw refuse();
}

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
export function sheetPageToPdf(
  page: SheetPage,
  title: string,
  /** D02 (v92): each page picture as baseline JPEG bytes, by checksum. */
  pictures?: ReadonlyMap<string, Uint8Array>
): Uint8Array {
  const pt = (mm: number) => num(mm * PT_PER_MM);
  // Clipped to the page: the composed page already drops what lies past the
  // paper, and this keeps any glyph that runs over its edge on it too.
  const content: string[] = [
    `0 0 ${pt(page.widthMm)} ${pt(page.heightMm)} re W n`,
    '1 J 1 j 0 0 0 RG 0 0 0 rg'
  ];
  // D02 (v92): pictures first, beneath the lines, each an image XObject
  // drawn into its box (one object per distinct picture).
  const xobjects: { name: string; object: string }[] = [];
  const named = new Map<string, string>();
  for (const image of page.images ?? []) {
    const bytes = pictures?.get(image.checksumSha256);
    if (!bytes) throw new SheetPictureUnavailableError();
    let name = named.get(image.checksumSha256);
    if (!name) {
      const info = jpegInfo(bytes);
      name = `Im${named.size + 1}`;
      named.set(image.checksumSha256, name);
      let binary = '';
      for (let i = 0; i < bytes.length; i += 0x8000)
        binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      xobjects.push({
        name,
        object: `<< /Type /XObject /Subtype /Image /Width ${info.width} /Height ${info.height} /ColorSpace /${info.components === 1 ? 'DeviceGray' : info.components === 4 ? 'DeviceCMYK' : 'DeviceRGB'} /BitsPerComponent 8 /Filter /DCTDecode${info.components === 4 ? ' /Decode [1 0 1 0 1 0 1 0]' : ''} /Length ${bytes.length} >>\nstream\n${binary}\nendstream`
      });
    }
    content.push(
      `q ${pt(image.width)} 0 0 ${pt(image.height)} ${pt(image.x)} ${pt(image.y)} cm /${name} Do Q`
    );
  }
  for (const kind of SHEET_STROKE_ORDER) {
    const strokes = page.strokes.filter((stroke) => stroke.kind === kind);
    if (strokes.length === 0) continue;
    content.push(`${pt(sheetStrokeWidthMm(page, kind))} w`);
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
  // Pictures follow the fonts (objects 7…); the info dictionary stays last.
  const pictureRefs = xobjects
    .map((entry, index) => `/${entry.name} ${7 + index} 0 R`)
    .join(' ');
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pt(page.widthMm)} ${pt(page.heightMm)}] /Resources << /Font << /F1 5 0 R /F2 6 0 R >>${pictureRefs ? ` /XObject << ${pictureRefs} >>` : ''} >> /Contents 4 0 R >>`,
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>',
    ...xobjects.map((entry) => entry.object),
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

/**
 * D04: each stroke kind's DXF layer. R12 has no line weights, so a kind is
 * told apart by its layer's colour (a plotter pen) and line type: hidden
 * edges dashed, the cutting-plane line long-dash-dot, as on the PDF.
 */
const DXF_LAYERS: Readonly<Record<SheetStrokeKind, DxfLayer>> = {
  visible: { name: 'VISIBLE', color: 7 },
  hidden: { name: 'HIDDEN', color: 8, lineType: 'HIDDEN' },
  border: { name: 'BORDER', color: 7 },
  thin: { name: 'THIN', color: 9 },
  dimension: { name: 'DIMENSION', color: 3 },
  hatch: { name: 'HATCH', color: 8 },
  chain: { name: 'CENTER', color: 4, lineType: 'CENTER' },
  cutting: { name: 'CUTTING', color: 1 }
};
const DXF_TEXT_LAYER: DxfLayer = { name: 'TEXT', color: 7 };

/**
 * `text` cut, between characters, into the fewest pieces that each fit one
 * DXF TEXT once encoded (non-ASCII characters take seven characters each).
 */
export function dxfTextPieces(text: string): string[] {
  const pieces: string[] = [];
  let piece = '';
  for (const char of text) {
    if (dxfTextLength(piece + char) > MAX_DXF_TEXT_LENGTH) {
      pieces.push(piece);
      piece = '';
    }
    piece += char;
  }
  if (piece) pieces.push(piece);
  return pieces;
}

/**
 * D04: the composed page as a DXF R12 drawing, one-to-one in paper
 * millimetres, so it lands on the sheet as printed (views at the sheet's
 * scale, the title block, every dimension). Each stroke is a LINE or a
 * POLYLINE on its kind's layer, each filled arrowhead a SOLID, and each text
 * a TEXT on `TEXT` at its cap height, aligned and turned as drawn. Curves
 * are the page's polylines: the exact edges sampled to the display
 * tolerance, as the PDF draws them. Deterministic, like the other writers.
 */
export function sheetPageToDxf(page: SheetPage): string {
  const entities: DxfEntity[] = [];
  const used = new Set<SheetStrokeKind>();
  for (const kind of SHEET_STROKE_ORDER) {
    const layer = DXF_LAYERS[kind].name;
    for (const stroke of page.strokes) {
      if (stroke.kind !== kind) continue;
      const points: [number, number][] = [];
      for (let i = 0; i + 1 < stroke.points.length; i += 2)
        points.push([stroke.points[i]!, stroke.points[i + 1]!]);
      if (points.length < 2) continue;
      used.add(kind);
      if (stroke.filled && (points.length === 3 || points.length === 4))
        entities.push({
          kind: 'solid',
          layer,
          points: points as [
            [number, number],
            [number, number],
            [number, number]
          ]
        });
      else if (points.length === 2 && !stroke.closed && !stroke.filled)
        entities.push({
          kind: 'line',
          layer,
          start: points[0]!,
          end: points[1]!
        });
      else
        entities.push({
          kind: 'polyline',
          layer,
          points,
          closed: stroke.closed === true || stroke.filled === true,
          // A sampled curve's segments are shorter than a dash: the pattern
          // runs on along it, or a hidden circle would draw solid.
          ...(DXF_LAYERS[kind].lineType
            ? { continuousLinetype: true as const }
            : {})
        });
    }
  }
  for (const text of page.texts) {
    if (!text.text) continue;
    const pieces = dxfTextPieces(text.text);
    const align =
      text.align === 'middle'
        ? ('center' as const)
        : text.align === 'end'
          ? ('right' as const)
          : undefined;
    if (pieces.length === 1) {
      entities.push({
        kind: 'text',
        layer: DXF_TEXT_LAYER.name,
        position: [text.x, text.y],
        height: text.sizeMm,
        text: text.text,
        ...(text.angleDeg ? { rotationDeg: text.angleDeg } : {}),
        ...(align ? { align } : {})
      });
      continue;
    }
    // Longer than one TEXT holds once encoded: consecutive left-aligned
    // pieces along the same baseline, starting where the whole would.
    const total = textWidthMm(text.text, text.sizeMm, text.bold);
    const radians = ((text.angleDeg ?? 0) * Math.PI) / 180;
    const along: [number, number] = [Math.cos(radians), Math.sin(radians)];
    let at =
      text.align === 'middle' ? -total / 2 : text.align === 'end' ? -total : 0;
    for (const piece of pieces) {
      entities.push({
        kind: 'text',
        layer: DXF_TEXT_LAYER.name,
        position: [text.x + along[0] * at, text.y + along[1] * at],
        height: text.sizeMm,
        text: piece,
        ...(text.angleDeg ? { rotationDeg: text.angleDeg } : {})
      });
      at += textWidthMm(piece, text.sizeMm, text.bold);
    }
  }
  const layers = [
    ...SHEET_STROKE_ORDER.filter((kind) => used.has(kind)).map(
      (kind) => DXF_LAYERS[kind]
    ),
    ...(page.texts.length > 0 ? [DXF_TEXT_LAYER] : [])
  ];
  return writeDxf(entities, { units: 'mm', layers });
}
