import {
  type DrawingViewFrame,
  DRAWING_SCALE_PRESETS,
  DRAWING_VIEW_FRAMES,
  DRAWING_VIEW_ORIENTATIONS,
  drawingPaperMm,
  drawingPaperPerModelUnit,
  drawingFreeSectionLine,
  drawingSectionLine,
  drawingViewAlignment,
  formatDrawingScale,
  projectToView,
  type DrawingSheet,
  type DrawingView,
  type DrawingViewOrientation,
  type UnitSystem
} from '@openzcad/shared';
import type { ViewProjection } from './projectView';

/**
 * One sheet laid out on paper: the single page model the on-screen preview,
 * the SVG writer and the PDF writer all draw, so the three cannot disagree.
 *
 * Paper coordinates are millimetres with the origin at the bottom-left corner
 * and y up, the way PDF measures a page. A view's projected (u, v) model
 * coordinates land at `centerMm + (u − cu, v − cv) · scale · mm-per-unit`,
 * where (cu, cv) is the centre of the view's projected extent: `centerMm` is
 * where the middle of the view sits, so a view does not jump when the part is
 * far from the world origin.
 */

export type SheetStrokeKind =
  | 'visible'
  | 'hidden'
  | 'border'
  | 'thin'
  | 'dimension'
  /** D03 section hatching. */
  | 'hatch'
  /** D03 cutting-plane line: thin long-dash-dot across the view. */
  | 'chain'
  /** D03 the cutting-plane line's thick ends. */
  | 'cutting';

export interface SheetStroke {
  kind: SheetStrokeKind;
  /** Flat `[x0, y0, x1, y1, …]` paper millimetres. */
  points: number[];
  closed?: boolean;
  /** Filled rather than outlined (dimension arrowheads); implies closed. */
  filled?: boolean;
}

export interface SheetText {
  x: number;
  y: number;
  /** Cap-to-baseline size in millimetres. */
  sizeMm: number;
  text: string;
  bold?: boolean;
  /** Which part of the text sits at (x, y); absent is its start. */
  align?: 'middle' | 'end';
  /** Counter-clockwise turn of the baseline about (x, y), in degrees. */
  angleDeg?: number;
}

/**
 * D02 (v92): a picture on the page, its lower-left corner at (x, y) in paper
 * millimetres (y up), stretched to `width` × `height` (the picture's own
 * aspect). The pixels are the reference image's bytes, by checksum: a writer
 * is handed them, the page model never holds them.
 */
export interface SheetImage {
  x: number;
  y: number;
  width: number;
  height: number;
  checksumSha256: string;
  contentType: 'image/png' | 'image/jpeg';
}

export interface SheetPage {
  widthMm: number;
  heightMm: number;
  strokes: SheetStroke[];
  texts: SheetText[];
  /** D02 (v92): pictures, drawn beneath every stroke and text. */
  images?: SheetImage[];
  /**
   * D02 (schema v70): the sheet's own print weights, by stroke kind; absent
   * kinds (and a page without any) use {@link SHEET_STROKE_WIDTH_MM}.
   */
  strokeWidthsMm?: Partial<Record<SheetStrokeKind, number>>;
}

/** A page's print weight for `kind`. */
export function sheetStrokeWidthMm(
  page: Pick<SheetPage, 'strokeWidthsMm'>,
  kind: SheetStrokeKind
): number {
  return page.strokeWidthsMm?.[kind] ?? SHEET_STROKE_WIDTH_MM[kind];
}

/** Stroke weights in paper millimetres (ISO 128 0.35/0.25 pair). */
export const SHEET_STROKE_WIDTH_MM: Readonly<Record<SheetStrokeKind, number>> =
  {
    visible: 0.35,
    hidden: 0.25,
    border: 0.5,
    thin: 0.25,
    dimension: 0.25,
    hatch: 0.18,
    chain: 0.25,
    cutting: 0.7
  };
/** Hidden-line dash and gap, in paper millimetres. */
export const SHEET_HIDDEN_DASH_MM: readonly [number, number] = [3, 1.5];
/** ISO 128 long-dash-dot (type 04) for the cutting-plane line, in paper mm. */
export const SHEET_CHAIN_DASH_MM: readonly number[] = [12, 1.5, 0.5, 1.5];

/** Each stroke kind's dash pattern, in paper millimetres; absent is solid. */
export const SHEET_STROKE_DASH_MM: Readonly<
  Partial<Record<SheetStrokeKind, readonly number[]>>
> = { hidden: SHEET_HIDDEN_DASH_MM, chain: SHEET_CHAIN_DASH_MM };

/**
 * The order the preview and both writers draw stroke kinds in, back to
 * front. A page with no strokes of a kind writes nothing for it, so a sheet
 * without sections exports the same bytes as before D03.
 */
export const SHEET_STROKE_ORDER: readonly SheetStrokeKind[] = [
  'border',
  'thin',
  'hatch',
  'hidden',
  'visible',
  'chain',
  'cutting',
  'dimension'
];

export const SHEET_MARGIN_MM = 10;
export const TITLE_BLOCK_HEIGHT_MM = 32;
/** D02 (v94): the shop layout's height: the title and four rows. */
export const SHOP_TITLE_BLOCK_HEIGHT_MM = 52;

/** A sheet's title-block height, by its layout. */
function titleBlockHeight(sheet: Pick<DrawingSheet, 'titleBlockLayout'>) {
  return sheet.titleBlockLayout === 'shop'
    ? SHOP_TITLE_BLOCK_HEIGHT_MM
    : TITLE_BLOCK_HEIGHT_MM;
}
const TITLE_BLOCK_MAX_WIDTH_MM = 170;

/**
 * Advance widths per 1000 em of the base-14 Helvetica and Helvetica-Bold, from
 * the core fonts' metrics, for every character `sheetSafeText` keeps: U+0020–
 * U+007E, then U+00A0–U+00FF (WinAnsi matches Latin-1 there).
 */
const HELVETICA_WIDTHS = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278,
  278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584,
  584, 556, 1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556,
  833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278,
  278, 278, 469, 556, 333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222,
  500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500,
  500, 334, 260, 334, 584, 278, 333, 556, 556, 556, 556, 260, 556, 333, 737,
  370, 556, 584, 333, 737, 333, 400, 584, 333, 333, 333, 556, 537, 278, 333,
  333, 365, 556, 834, 834, 834, 611, 667, 667, 667, 667, 667, 667, 1000, 722,
  667, 667, 667, 667, 278, 278, 278, 278, 722, 722, 778, 778, 778, 778, 778,
  584, 778, 722, 722, 722, 722, 667, 667, 611, 556, 556, 556, 556, 556, 556,
  889, 500, 556, 556, 556, 556, 278, 278, 278, 278, 556, 556, 556, 556, 556,
  556, 556, 584, 611, 556, 556, 556, 556, 500, 556, 500
];
const HELVETICA_BOLD_WIDTHS = [
  278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278,
  278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 333, 333, 584, 584,
  584, 611, 975, 722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611,
  833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 333,
  278, 333, 584, 556, 333, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278,
  556, 278, 889, 611, 611, 611, 611, 389, 556, 333, 611, 556, 778, 556, 556,
  500, 389, 280, 389, 584, 278, 333, 556, 556, 556, 556, 280, 556, 333, 737,
  370, 556, 584, 333, 737, 333, 400, 584, 333, 333, 333, 611, 556, 278, 333,
  333, 365, 556, 834, 834, 834, 611, 722, 722, 722, 722, 722, 722, 1000, 722,
  667, 667, 667, 667, 278, 278, 278, 278, 722, 722, 778, 778, 778, 778, 778,
  584, 778, 722, 722, 722, 722, 667, 667, 611, 556, 556, 556, 556, 556, 556,
  889, 556, 556, 556, 556, 556, 278, 278, 278, 278, 611, 611, 611, 611, 611,
  611, 611, 584, 611, 611, 611, 611, 611, 556, 611, 556
];

function glyphWidth(code: number, bold: boolean): number {
  const table = bold ? HELVETICA_BOLD_WIDTHS : HELVETICA_WIDTHS;
  const index =
    code >= 0x20 && code <= 0x7e
      ? code - 0x20
      : code >= 0xa0 && code <= 0xff
        ? code - 0xa0 + 95
        : -1;
  // Anything else is drawn as "?" (see sheetSafeText).
  return table[index] ?? table[0x3f - 0x20]!;
}

/**
 * Characters outside Latin-1 that engineering text often uses, mapped to the
 * Latin-1 stand-in a reader expects instead of "?": U+2300 DIAMETER SIGN
 * prints as Ø (the symbol diameter dimensions already use), typographic
 * dashes and the minus sign as a hyphen, curly quotes as straight ones.
 */
const SHEET_TEXT_STAND_INS: Readonly<Record<string, string>> = {
  '⌀': 'Ø', // diameter sign
  '∅': 'Ø', // empty set, often typed for a diameter
  '‐': '-', // hyphen
  '‑': '-', // non-breaking hyphen
  '‒': '-', // figure dash
  '–': '-', // en dash
  '—': '-', // em dash
  '−': '-', // minus sign
  '‘': "'",
  '’': "'",
  '“': '"',
  '”': '"',
  '…': '...',
  '≤': '<=',
  '≥': '>=',
  '≈': '~',
  '′': "'", // prime: feet, arc minutes
  '″': '"' // double prime: inches, arc seconds
};

function sheetPrintable(code: number): boolean {
  return (code >= 0x20 && code <= 0x7e) || (code >= 0xa0 && code <= 0xff);
}

/**
 * Sheet text is drawn in the PDF base-14 Helvetica, which every reader
 * supplies, so nothing is embedded. That font covers WinAnsi only: common
 * engineering symbols become their Latin-1 stand-in and anything else
 * becomes "?" here, before layout, so the preview, SVG and PDF show the
 * same characters.
 */
export function sheetSafeText(text: string): string {
  let out = '';
  for (const char of text.replace(/\s+/g, ' ').trim()) {
    const standIn = SHEET_TEXT_STAND_INS[char];
    if (standIn !== undefined) out += standIn;
    else out += sheetPrintable(char.codePointAt(0)!) ? char : '?';
  }
  return out;
}

/**
 * The distinct characters of `text` a sheet prints as "?", in order of first
 * appearance: what a text editor warns about before the text is placed.
 */
export function sheetUnprintableCharacters(text: string): string[] {
  const found = new Set<string>();
  for (const char of text.replace(/\s+/g, ' ')) {
    if (SHEET_TEXT_STAND_INS[char] !== undefined) continue;
    if (!sheetPrintable(char.codePointAt(0)!)) found.add(char);
  }
  return [...found];
}

export function textWidthMm(
  text: string,
  sizeMm: number,
  bold = false
): number {
  let units = 0;
  for (const char of text) units += glyphWidth(char.codePointAt(0)!, bold);
  // `sizeMm` is cap height; renderers convert it to font size by the same
  // 0.718 factor.
  return (units * (sizeMm / 0.718)) / 1000;
}

/** `text` cut with an ellipsis-free "..." so it fits `widthMm`. */
export function fitText(
  text: string,
  sizeMm: number,
  widthMm: number,
  bold = false
): string {
  if (textWidthMm(text, sizeMm, bold) <= widthMm) return text;
  let cut = text;
  while (cut.length > 0 && textWidthMm(`${cut}...`, sizeMm, bold) > widthMm)
    cut = cut.slice(0, -1);
  return cut.length > 0 ? `${cut.trimEnd()}...` : '';
}

export interface ViewExtent {
  minU: number;
  minV: number;
  maxU: number;
  maxV: number;
}

/** Projected extent of world points (xyz triples) in a view; null when empty. */
export function projectedExtent(
  orientation: DrawingViewOrientation,
  points: Iterable<ArrayLike<number>>,
  /** D03 (v81): an auxiliary view's own frame. */
  own?: DrawingViewFrame
): ViewExtent | null {
  const frame = own ?? DRAWING_VIEW_FRAMES[orientation];
  const extent = {
    minU: Infinity,
    minV: Infinity,
    maxU: -Infinity,
    maxV: -Infinity
  };
  for (const array of points)
    for (let i = 0; i + 2 < array.length; i += 3) {
      const { u, v } = projectToView(frame, {
        x: array[i]!,
        y: array[i + 1]!,
        z: array[i + 2]!
      });
      extent.minU = Math.min(extent.minU, u);
      extent.maxU = Math.max(extent.maxU, u);
      extent.minV = Math.min(extent.minV, v);
      extent.maxV = Math.max(extent.maxV, v);
    }
  return Number.isFinite(extent.minU) ? extent : null;
}

/**
 * Maps a view's model (u, v) to paper millimetres. A detail view (D03,
 * v78) is centred on its circle and drawn at its own scale.
 */
export function viewPageTransform(
  view: Pick<DrawingView, 'centerMm' | 'detail'>,
  extent: ViewExtent,
  sheet: Pick<DrawingSheet, 'scale'>,
  units: UnitSystem
): (u: number, v: number) => [number, number] {
  const detail = view.detail;
  const k = drawingPaperPerModelUnit(detail?.scale ?? sheet.scale, units);
  const cu = detail ? detail.center.u : (extent.minU + extent.maxU) / 2;
  const cv = detail ? detail.center.v : (extent.minV + extent.maxV) / 2;
  return (u, v) => [
    view.centerMm.x + (u - cu) * k,
    view.centerMm.y + (v - cv) * k
  ];
}

/** Paper millimetres per model unit in `view`: a detail's own scale (v78), else the sheet's. */
export function viewPaperPerModelUnit(
  view: Pick<DrawingView, 'detail'>,
  sheet: Pick<DrawingSheet, 'scale'>,
  units: UnitSystem
): number {
  return drawingPaperPerModelUnit(view.detail?.scale ?? sheet.scale, units);
}

/** A view's footprint on paper, in millimetres: a detail's is its circle's square. */
export function viewPageBox(
  view: Pick<DrawingView, 'centerMm' | 'detail'>,
  extent: ViewExtent,
  sheet: Pick<DrawingSheet, 'scale'>,
  units: UnitSystem
): { x: number; y: number; width: number; height: number } {
  if (view.detail) {
    const r =
      view.detail.radius * drawingPaperPerModelUnit(view.detail.scale, units);
    return {
      x: view.centerMm.x - r,
      y: view.centerMm.y - r,
      width: 2 * r,
      height: 2 * r
    };
  }
  const k = drawingPaperPerModelUnit(sheet.scale, units);
  const width = (extent.maxU - extent.minU) * k;
  const height = (extent.maxV - extent.minV) * k;
  return {
    x: view.centerMm.x - width / 2,
    y: view.centerMm.y - height / 2,
    width,
    height
  };
}

/** The title block's box on paper: bottom-right, inside the border. */
export function titleBlockBox(
  sheet: Pick<DrawingSheet, 'paper' | 'titleBlockLayout'>
): {
  x: number;
  y: number;
  width: number;
  height: number;
} {
  const paper = drawingPaperMm(sheet.paper);
  const width = Math.min(
    TITLE_BLOCK_MAX_WIDTH_MM,
    paper.width - 2 * SHEET_MARGIN_MM
  );
  return {
    x: paper.width - SHEET_MARGIN_MM - width,
    y: SHEET_MARGIN_MM,
    width,
    height: titleBlockHeight(sheet)
  };
}

/** The drawable area above the title block, for fitting views. */
export function sheetViewArea(
  sheet: Pick<DrawingSheet, 'paper' | 'titleBlockLayout'>
): {
  x: number;
  y: number;
  width: number;
  height: number;
} {
  const paper = drawingPaperMm(sheet.paper);
  const bottom = SHEET_MARGIN_MM + titleBlockHeight(sheet);
  return {
    x: SHEET_MARGIN_MM,
    y: bottom,
    width: paper.width - 2 * SHEET_MARGIN_MM,
    height: paper.height - SHEET_MARGIN_MM - bottom
  };
}

function rect(x: number, y: number, width: number, height: number): number[] {
  return [x, y, x + width, y, x + width, y + height, x, y + height];
}

/** What a page needs beyond its sheet: the project and the sheet's place. */
export interface SheetPageContext {
  projectName: string;
  units: UnitSystem;
  /**
   * Where the sheet sits in the set, 1-based, for the SHEET cell ("2 / 3").
   * Absent reads as a set of one.
   */
  sheetNumber?: { index: number; count: number };
  /**
   * D02: the DATE cell's automatic value, until the title block sets one:
   * the project's latest saved revision (see {@link titleBlockAutoDate}).
   */
  date?: string;
}

/** The ISO date (YYYY-MM-DD) of the project's latest revision, if any. */
export function titleBlockAutoDate(
  revisions: readonly { createdAt: string }[]
): string | undefined {
  let latest: string | undefined;
  for (const { createdAt } of revisions) {
    const day = /^\d{4}-\d{2}-\d{2}/.exec(createdAt)?.[0];
    if (day && (!latest || day > latest)) latest = day;
  }
  return latest;
}

/** The SIZE cell: the paper, short ("A3", "ANSI B"). */
export function titleBlockSizeText(paper: DrawingSheet['paper']): string {
  return paper.size.replace('-', ' ');
}

/**
 * The SHEET cell: "2 / 3 · Details", the sheet's place in the set and its
 * name. It printed the paper size ("A3"), which the border already shows,
 * while neither the name nor the count appeared anywhere (review I63).
 */
export function titleBlockSheetText(
  sheet: Pick<DrawingSheet, 'name'>,
  sheetNumber: SheetPageContext['sheetNumber']
): string {
  const count = Math.max(1, sheetNumber?.count ?? 1);
  const index = Math.min(count, Math.max(1, sheetNumber?.index ?? 1));
  const name = sheet.name.trim();
  return name ? `${index} / ${count} · ${name}` : `${index} / ${count}`;
}

function titleBlock(
  sheet: DrawingSheet,
  context: SheetPageContext
): { strokes: SheetStroke[]; texts: SheetText[] } {
  const box = titleBlockBox(sheet);
  const strokes: SheetStroke[] = [
    {
      kind: 'border',
      points: rect(box.x, box.y, box.width, box.height),
      closed: true
    }
  ];
  const texts: SheetText[] = [];
  const rowHeight = 10;
  const shop = sheet.titleBlockLayout === 'shop';
  const rowCount = shop ? 4 : 2;
  const titleTop = box.y + box.height;
  const titleBottom = titleTop - (box.height - rowCount * rowHeight);
  // A rule under the title and between each row of cells.
  for (let row = 0; row < rowCount; row += 1) {
    const y = titleBottom - row * rowHeight;
    strokes.push({ kind: 'thin', points: [box.x, y, box.x + box.width, y] });
  }
  const block = sheet.titleBlock;
  const title = sheetSafeText(block.title ?? context.projectName);
  texts.push({
    x: box.x + 2,
    y: titleBottom + 3.5,
    sizeMm: 5,
    bold: true,
    text: fitText(title, 5, box.width - 4, true)
  });
  // The units dimensions print in (v70), else the document's.
  const unitLabel = {
    mm: 'Millimetres',
    cm: 'Centimetres',
    m: 'Metres',
    inch: 'Inches'
  }[sheet.format?.units ?? context.units];
  const projection =
    sheet.projectionAngle === 'first' ? 'First angle' : 'Third angle';
  const numbers: [string, string][] = [
    ['DWG NO.', block.drawingNumber ?? ''],
    ['REV', block.revision ?? ''],
    [
      'SCALE · SIZE',
      `${formatDrawingScale(sheet.scale)} · ${titleBlockSizeText(sheet.paper)}`
    ],
    ['SHEET', titleBlockSheetText(sheet, context.sheetNumber)]
  ];
  const date = block.date ?? context.date ?? '';
  // D02 (v94): the shop layout adds the material and finish, who checked
  // and approved it, the company and the general-tolerance note.
  const rows: [string, string][][] =
    sheet.titleBlockLayout === 'shop'
      ? [
          numbers,
          [
            ['MATERIAL', block.material ?? ''],
            ['FINISH', block.finish ?? ''],
            ['UNITS', unitLabel],
            ['PROJECTION', projection]
          ],
          [
            ['DRAWN', block.author ?? ''],
            ['CHECKED', block.checkedBy ?? ''],
            ['APPROVED', block.approvedBy ?? ''],
            ['DATE', date]
          ],
          [
            ['COMPANY', block.company ?? ''],
            ['GENERAL TOLERANCES', block.tolerances ?? '']
          ]
        ]
      : [
          numbers,
          [
            ['DRAWN', block.author ?? ''],
            ['DATE', date],
            ['UNITS', unitLabel],
            ['PROJECTION', projection]
          ]
        ];
  // REV and DATE each hold a full ISO date ("2026-10-28" is about 21.4 mm
  // at 3 mm text). Every paper, A4 portrait included, is wide enough to give
  // the block its full TITLE_BLOCK_MAX_WIDTH_MM, so these widths hold on all.
  const columns = [0.3, 0.18, 0.22, 0.3];
  // The shop layout's last row: the company, and the tolerance note across
  // the rest.
  const twoColumns = [0.3, 0.7];
  rows.forEach((cells, rowIndex) => {
    const top = titleBottom - rowIndex * rowHeight;
    let x = box.x;
    const widths = cells.length === 2 ? twoColumns : columns;
    cells.forEach(([label, value], column) => {
      const width = box.width * widths[column]!;
      if (column > 0)
        strokes.push({ kind: 'thin', points: [x, top, x, top - rowHeight] });
      texts.push({ x: x + 1.5, y: top - 3, sizeMm: 1.8, text: label });
      texts.push({
        x: x + 1.5,
        y: top - 8,
        sizeMm: 3,
        text: fitText(sheetSafeText(value), 3, width - 3)
      });
      x += width;
    });
  });
  return { strokes, texts };
}

export interface ComposedView {
  view: DrawingView;
  projection: ViewProjection;
}

interface PaperRect {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

function insideRect(rect: PaperRect, x: number, y: number): boolean {
  return x >= rect.minX && x <= rect.maxX && y >= rect.minY && y <= rect.maxY;
}

/** Liang–Barsky: the part of a segment inside `rect`, or null. */
function clipSegment(
  rect: PaperRect,
  x0: number,
  y0: number,
  x1: number,
  y1: number
): [number, number, number, number] | null {
  const dx = x1 - x0;
  const dy = y1 - y0;
  let t0 = 0;
  let t1 = 1;
  for (const [p, q] of [
    [-dx, x0 - rect.minX],
    [dx, rect.maxX - x0],
    [-dy, y0 - rect.minY],
    [dy, rect.maxY - y0]
  ] as const) {
    if (p === 0) {
      if (q < 0) return null;
      continue;
    }
    const t = q / p;
    if (p < 0) {
      if (t > t1) return null;
      if (t > t0) t0 = t;
    } else {
      if (t < t0) return null;
      if (t < t1) t1 = t;
    }
  }
  return [x0 + t0 * dx, y0 + t0 * dy, x0 + t1 * dx, y0 + t1 * dy];
}

/**
 * The parts of a stroke on the paper. Nothing drawn may leave the page — a
 * PDF reader would cut it at the MediaBox, other tools keep it — so a line
 * that runs off is split where it crosses the edge; a filled mark (an
 * arrowhead) is drawn whole or not at all.
 */
function clipStroke(stroke: SheetStroke, rect: PaperRect): SheetStroke[] {
  const { points } = stroke;
  let inside = true;
  for (let i = 0; i + 1 < points.length && inside; i += 2)
    inside = insideRect(rect, points[i]!, points[i + 1]!);
  if (inside) return [stroke];
  if (stroke.filled) return [];
  const path =
    stroke.closed && points.length >= 4
      ? [...points, points[0]!, points[1]!]
      : points;
  const runs: SheetStroke[] = [];
  let run: number[] | null = null;
  for (let i = 0; i + 3 < path.length; i += 2) {
    const clipped = clipSegment(
      rect,
      path[i]!,
      path[i + 1]!,
      path[i + 2]!,
      path[i + 3]!
    );
    if (!clipped) {
      run = null;
      continue;
    }
    const [ax, ay, bx, by] = clipped;
    if (run && run[run.length - 2] === ax && run[run.length - 1] === ay)
      run.push(bx, by);
    else {
      run = [ax, ay, bx, by];
      runs.push({ kind: stroke.kind, points: run });
    }
  }
  return runs;
}

/**
 * The page for a sheet whose views are all projected. Views missing from
 * `views` (stale, refused or still projecting) are simply not drawn; the
 * export path refuses before calling this unless every view is ready.
 */
export function composeSheetPage(
  sheet: DrawingSheet,
  views: readonly ComposedView[],
  context: SheetPageContext,
  /** D02 dimensions and notes, already laid out on this page. */
  annotations?: {
    strokes: SheetStroke[];
    texts: SheetText[];
    images?: SheetImage[];
  }
): SheetPage {
  const marks = composeSectionMarks(sheet, views, context.units);
  const details = composeDetailMarks(sheet, views, context.units);
  const auxiliaries = composeAuxiliaryMarks(sheet, views, context.units);
  const paper = drawingPaperMm(sheet.paper);
  const strokes: SheetStroke[] = [
    {
      kind: 'border',
      points: rect(
        SHEET_MARGIN_MM,
        SHEET_MARGIN_MM,
        paper.width - 2 * SHEET_MARGIN_MM,
        paper.height - 2 * SHEET_MARGIN_MM
      ),
      closed: true
    }
  ];
  for (const { view, projection } of views) {
    if (!projection.bounds) continue;
    const toPage = viewPageTransform(
      view,
      projection.bounds,
      sheet,
      context.units
    );
    if (projection.hatch)
      strokes.push(...hatchStrokes(projection.hatch, toPage));
    // A detail draws only what lies inside its circle (D03, v78).
    const clip = viewClipCircle(view, context.units);
    // Hidden first, so a visible line drawn over a coincident hidden one wins.
    for (const [kind, lines] of [
      ['hidden', projection.hidden],
      ['visible', projection.visible]
    ] as const)
      for (const line of lines) {
        const page: [number, number][] = [];
        for (let i = 0; i + 1 < line.length; i += 2)
          page.push(toPage(line[i]!, line[i + 1]!));
        for (const piece of clip ? clipPolylineToCircle(page, clip) : [page])
          strokes.push({ kind, points: piece.flat() });
      }
  }
  const block = titleBlock(sheet, context);
  // Views and annotations can be placed past the paper's edge (a smaller
  // paper, a drag); what lies there is not on the page, so it is not drawn.
  const onPaper: PaperRect = {
    minX: 0,
    minY: 0,
    maxX: paper.width,
    maxY: paper.height
  };
  const weights = sheet.format?.lineWidthsMm;
  // D02 (v92): a picture is kept whole while any of it is on the paper (the
  // writers clip to the page); one wholly off it is not drawn.
  const images = (annotations?.images ?? []).filter(
    (image) =>
      image.x < paper.width &&
      image.y < paper.height &&
      image.x + image.width > 0 &&
      image.y + image.height > 0
  );
  return {
    widthMm: paper.width,
    heightMm: paper.height,
    ...(weights && Object.keys(weights).length > 0
      ? { strokeWidthsMm: { ...weights } }
      : {}),
    ...(images.length > 0 ? { images } : {}),
    strokes: [
      ...strokes,
      ...marks.strokes,
      ...details.strokes,
      ...auxiliaries.strokes,
      ...(annotations?.strokes ?? []),
      ...block.strokes
    ].flatMap((stroke) => clipStroke(stroke, onPaper)),
    texts: [
      ...marks.texts,
      ...details.texts,
      ...auxiliaries.texts,
      ...(annotations?.texts ?? []),
      ...block.texts
    ].filter((text) => insideRect(onPaper, text.x, text.y))
  };
}

// ---------------------------------------------------------------------------
// D03 section views

/** Hatch line spacing on the paper, in millimetres (ISO 128-50). */
export const SECTION_HATCH_SPACING_MM = 2.5;
/** How far the cutting-plane line runs past its view's extent. */
const SECTION_LINE_OVERRUN_MM = 4;
/** Length of the cutting-plane line's thick ends. */
const SECTION_END_MM = 6;
/** The section arrows: shaft, head length and half width. */
const SECTION_ARROW_MM = 8;
const SECTION_ARROW_HEAD_MM = 3;
const SECTION_ARROW_HALF_WIDTH_MM = 0.9;
export const SECTION_LABEL_MM = 5;
/** From a section view's footprint to its caption's far side. */
const SECTION_CAPTION_GAP_MM = 7;

/** The caption printed under a section view: "SECTION A-A". */
export function sectionCaption(label: string): string {
  // WinAnsi's en dash would print as a hyphen anyway (`sheetSafeText`).
  return `SECTION ${label}-${label}`;
}

/**
 * 45° hatching over a section view's cut faces, on the paper. Lines sit at
 * whole multiples of the spacing measured from the paper's corner, so a view
 * moved by a whole step hatches identically, and each is clipped to the
 * union of the cut triangles: the pieces one line crosses are merged where
 * neighbouring triangles meet, so a face hatches as one run per crossing.
 * The cut faces' curved boundaries are chords of the display tolerance.
 */
export function hatchStrokes(
  triangles: ArrayLike<number>,
  toPage: (u: number, v: number) => [number, number],
  spacing = SECTION_HATCH_SPACING_MM
): SheetStroke[] {
  // s runs across the hatch lines, t along them (direction (1, 1)/√2).
  const lines = new Map<number, [number, number][]>();
  for (let i = 0; i + 5 < triangles.length; i += 6) {
    const corners = [0, 2, 4].map((o) => {
      const [x, y] = toPage(triangles[i + o]!, triangles[i + o + 1]!);
      return [(x - y) / Math.SQRT2, (x + y) / Math.SQRT2] as const;
    });
    const sMin = Math.min(...corners.map(([c]) => c));
    const sMax = Math.max(...corners.map(([c]) => c));
    for (let k = Math.ceil(sMin / spacing); k * spacing <= sMax; k += 1) {
      const s = k * spacing;
      const ts: number[] = [];
      for (let e = 0; e < 3; e += 1) {
        const [s0, t0] = corners[e]!;
        const [s1, t1] = corners[(e + 1) % 3]!;
        if ((s0 - s) * (s1 - s) > 0 || s0 === s1) continue;
        ts.push(t0 + ((t1 - t0) * (s - s0)) / (s1 - s0));
      }
      if (ts.length < 2) continue;
      const low = Math.min(...ts);
      const high = Math.max(...ts);
      if (high - low <= 1e-9) continue;
      let pieces = lines.get(k);
      if (!pieces) lines.set(k, (pieces = []));
      pieces.push([low, high]);
    }
  }
  const strokes: SheetStroke[] = [];
  for (const k of [...lines.keys()].sort((a, b) => a - b)) {
    const s = k * spacing;
    const pieces = lines.get(k)!.sort((a, b) => a[0] - b[0]);
    let [from, to] = pieces[0]!;
    const emit = () => {
      const a = [(s + from) / Math.SQRT2, (from - s) / Math.SQRT2];
      const b = [(s + to) / Math.SQRT2, (to - s) / Math.SQRT2];
      strokes.push({ kind: 'hatch', points: [a[0]!, a[1]!, b[0]!, b[1]!] });
    };
    for (const [low, high] of pieces.slice(1)) {
      if (low <= to + 1e-6) to = Math.max(to, high);
      else {
        emit();
        [from, to] = [low, high];
      }
    }
    emit();
  }
  return strokes;
}

function sectionArrow(
  tail: [number, number],
  sight: [number, number]
): SheetStroke[] {
  const tip: [number, number] = [
    tail[0] + sight[0] * SECTION_ARROW_MM,
    tail[1] + sight[1] * SECTION_ARROW_MM
  ];
  const base: [number, number] = [
    tip[0] - sight[0] * SECTION_ARROW_HEAD_MM,
    tip[1] - sight[1] * SECTION_ARROW_HEAD_MM
  ];
  const w = SECTION_ARROW_HALF_WIDTH_MM;
  return [
    { kind: 'thin', points: [tail[0], tail[1], base[0], base[1]] },
    {
      kind: 'dimension',
      filled: true,
      closed: true,
      points: [
        tip[0],
        tip[1],
        base[0] - sight[1] * w,
        base[1] + sight[0] * w,
        base[0] + sight[1] * w,
        base[1] - sight[0] * w
      ]
    }
  ];
}

/**
 * Where a section view's cutting-plane line lies on its source view, on the
 * paper, with its direction of sight there; null when the source is not
 * drawn yet or the two do not fold.
 */
export function sectionLineOnPage(
  sheet: Pick<DrawingSheet, 'scale'>,
  section: DrawingView,
  source: ComposedView,
  units: UnitSystem
): {
  from: [number, number];
  to: [number, number];
  sight: [number, number];
  /** D03 (v93): a stepped line's corners, from `from` to `to`. */
  points?: [number, number][];
} | null {
  const bounds = source.projection.bounds;
  if (!section.section || !bounds) return null;
  if (section.section.frame) {
    // D03 (v91): a free section's line, at an angle, across the source's
    // footprint and a little past it.
    const { sight, depth } = drawingFreeSectionLine(
      source.view.orientation,
      section.section.frame,
      section.section.depth
    );
    const t: [number, number] = [-sight[1], sight[0]];
    const origin: [number, number] = [sight[0] * depth, sight[1] * depth];
    let low = -Infinity;
    let high = Infinity;
    for (const [axis, min, max] of [
      [0, bounds.minU, bounds.maxU],
      [1, bounds.minV, bounds.maxV]
    ] as const) {
      if (Math.abs(t[axis]) < 1e-12) {
        if (origin[axis] < min || origin[axis] > max) return null;
        continue;
      }
      const a = (min - origin[axis]) / t[axis];
      const b = (max - origin[axis]) / t[axis];
      low = Math.max(low, Math.min(a, b));
      high = Math.min(high, Math.max(a, b));
    }
    if (!(high >= low)) return null;
    const toPage = viewPageTransform(source.view, bounds, sheet, units);
    const from = toPage(origin[0] + t[0] * low, origin[1] + t[1] * low);
    const to = toPage(origin[0] + t[0] * high, origin[1] + t[1] * high);
    const overrun = SECTION_LINE_OVERRUN_MM;
    return {
      from: [from[0] - t[0] * overrun, from[1] - t[1] * overrun],
      to: [to[0] + t[0] * overrun, to[1] + t[1] * overrun],
      sight
    };
  }
  const line = drawingSectionLine(
    source.view.orientation,
    section.orientation,
    section.section.depth
  );
  if (!line) return null;
  const toPage = viewPageTransform(source.view, bounds, sheet, units);
  const overrun = SECTION_LINE_OVERRUN_MM;
  const steps = section.section.steps ?? [];
  if (steps.length > 0) {
    // D03 (v93): the line runs at each segment's depth and jogs at each
    // step, on the source at ±depth (one sign for every segment).
    const sign = drawingSectionLine(
      source.view.orientation,
      section.orientation,
      1
    )!.at;
    const across = (depth: number) => (depth === 0 ? 0 : sign * depth);
    const horizontal = line.axis === 'horizontal';
    const [low, high] = horizontal
      ? [bounds.minU, bounds.maxU]
      : [bounds.minV, bounds.maxV];
    const model: [number, number][] = [];
    const point = (along: number, at: number): [number, number] =>
      horizontal ? [along, at] : [at, along];
    let depth = section.section.depth;
    model.push(point(low, across(depth)));
    for (const step of steps) {
      model.push(point(step.at, across(depth)));
      depth = step.depth;
      model.push(point(step.at, across(depth)));
    }
    model.push(point(high, across(depth)));
    const points = model.map(([u, v]) => toPage(u, v));
    const unit = horizontal ? [1, 0] : [0, 1];
    points[0] = [
      points[0]![0] - unit[0]! * overrun,
      points[0]![1] - unit[1]! * overrun
    ];
    const last = points.length - 1;
    points[last] = [
      points[last]![0] + unit[0]! * overrun,
      points[last]![1] + unit[1]! * overrun
    ];
    return {
      from: points[0],
      to: points[last],
      sight: line.sight,
      points
    };
  }
  if (line.axis === 'horizontal') {
    const [x0, y] = toPage(bounds.minU, line.at);
    const [x1] = toPage(bounds.maxU, line.at);
    return {
      from: [x0 - overrun, y],
      to: [x1 + overrun, y],
      sight: line.sight
    };
  }
  const [x, y0] = toPage(line.at, bounds.minV);
  const [, y1] = toPage(line.at, bounds.maxV);
  return { from: [x, y0 - overrun], to: [x, y1 + overrun], sight: line.sight };
}

/**
 * The marks every section view puts on the page: its cutting-plane line
 * across the source view (thin chain, thick ends, arrows in the direction
 * of sight and the section's letter at each), and its caption under the
 * section view itself. A mark is drawn once the view it sits on is.
 */
export function composeSectionMarks(
  sheet: Pick<DrawingSheet, 'scale' | 'views'>,
  views: readonly ComposedView[],
  units: UnitSystem
): { strokes: SheetStroke[]; texts: SheetText[] } {
  const strokes: SheetStroke[] = [];
  const texts: SheetText[] = [];
  const drawn = new Map(views.map((entry) => [entry.view.viewId, entry]));
  for (const view of sheet.views) {
    if (!view.section) continue;
    const label = view.section.label;
    const source = drawn.get(view.section.sourceViewId);
    const line = source && sectionLineOnPage(sheet, view, source, units);
    if (line) {
      const { from, to, sight } = line;
      const path = line.points ?? [from, to];
      strokes.push({ kind: 'chain', points: path.flat() });
      const direction = (a: [number, number], b: [number, number]) => {
        const length = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
        return [(b[0] - a[0]) / length, (b[1] - a[1]) / length] as [
          number,
          number
        ];
      };
      const length = Math.hypot(to[0] - from[0], to[1] - from[1]);
      const end = Math.min(SECTION_END_MM, length / 3);
      // D03 (v93): a stepped line is thick where it changes direction too.
      for (let i = 1; i + 1 < path.length; i += 1) {
        const corner = path[i]!;
        for (const neighbour of [path[i - 1]!, path[i + 1]!]) {
          const span = Math.hypot(
            neighbour[0] - corner[0],
            neighbour[1] - corner[1]
          );
          if (span === 0) continue;
          const toward = direction(corner, neighbour);
          const reach = Math.min(end / 2, span / 2);
          strokes.push({
            kind: 'cutting',
            points: [
              corner[0],
              corner[1],
              corner[0] + toward[0] * reach,
              corner[1] + toward[1] * reach
            ]
          });
        }
      }
      for (const [point, inward] of [
        [from, direction(path[0]!, path[1]!)],
        [to, direction(path[path.length - 1]!, path[path.length - 2]!)]
      ] as const) {
        strokes.push({
          kind: 'cutting',
          points: [
            point[0],
            point[1],
            point[0] + inward[0] * end,
            point[1] + inward[1] * end
          ]
        });
        strokes.push(...sectionArrow([point[0], point[1]], sight));
        // The letter beside the arrow, on the side away from the view.
        texts.push({
          x: point[0] - inward[0] * 2 + sight[0] * (SECTION_ARROW_MM * 0.6),
          y:
            point[1] -
            inward[1] * 2 +
            sight[1] * (SECTION_ARROW_MM * 0.6) -
            SECTION_LABEL_MM / 2,
          sizeMm: SECTION_LABEL_MM,
          text: label,
          bold: true,
          align: 'middle'
        });
      }
    }
    const own = drawn.get(view.viewId);
    if (own?.projection.bounds) {
      const box = viewPageBox(view, own.projection.bounds, sheet, units);
      // Above the view (ISO 128-44), unless that is toward its source, below
      // it: the caption never sits between the view and its cutting line.
      const sourceView = sheet.views.find(
        (entry) => entry.viewId === view.section!.sourceViewId
      );
      const below =
        sourceView !== undefined &&
        drawingViewAlignment(sourceView.orientation, view.orientation) ===
          'column' &&
        view.centerMm.y < sourceView.centerMm.y;
      texts.push({
        x: view.centerMm.x,
        y: below
          ? box.y - SECTION_CAPTION_GAP_MM
          : box.y +
            box.height +
            SECTION_CAPTION_GAP_MM -
            SECTION_LABEL_MM * 0.7,
        sizeMm: SECTION_LABEL_MM * 0.7,
        text: sectionCaption(label),
        bold: true,
        align: 'middle'
      });
    }
  }
  return { strokes, texts };
}

/**
 * D03 (v78): a detail view's crop circle on the paper, or null for any other
 * view. What the view draws, picks and points leaders at is cut to it.
 */
export function viewClipCircle(
  view: Pick<DrawingView, 'centerMm' | 'detail'>,
  units: UnitSystem
): { center: [number, number]; radius: number } | null {
  if (!view.detail) return null;
  return {
    center: [view.centerMm.x, view.centerMm.y],
    radius:
      view.detail.radius * drawingPaperPerModelUnit(view.detail.scale, units)
  };
}

/**
 * The parts of a paper polyline inside a circle: each segment cut where it
 * crosses the rim, consecutive inside pieces joined.
 */
export function clipPolylineToCircle(
  points: readonly [number, number][],
  circle: { center: [number, number]; radius: number }
): [number, number][][] {
  const [cx, cy] = circle.center;
  const r2 = circle.radius * circle.radius;
  const inside = (p: readonly [number, number]) =>
    (p[0] - cx) ** 2 + (p[1] - cy) ** 2 <= r2;
  const pieces: [number, number][][] = [];
  let current: [number, number][] = [];
  const close = () => {
    if (current.length >= 2) pieces.push(current);
    current = [];
  };
  for (let i = 0; i + 1 < points.length; i += 1) {
    const a = points[i]!;
    const b = points[i + 1]!;
    // Where the segment a + t(b - a) meets the circle.
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const fx = a[0] - cx;
    const fy = a[1] - cy;
    const qa = dx * dx + dy * dy;
    const qb = 2 * (fx * dx + fy * dy);
    const qc = fx * fx + fy * fy - r2;
    if (qa < 1e-18) {
      if (!inside(a)) close();
      continue;
    }
    const disc = qb * qb - 4 * qa * qc;
    if (disc < 0) {
      close();
      continue;
    }
    const root = Math.sqrt(disc);
    const t0 = Math.max(0, (-qb - root) / (2 * qa));
    const t1 = Math.min(1, (-qb + root) / (2 * qa));
    if (t1 - t0 <= 1e-12) {
      close();
      continue;
    }
    const at = (t: number): [number, number] => [a[0] + dx * t, a[1] + dy * t];
    const start = at(t0);
    const last = current[current.length - 1];
    if (
      t0 > 1e-12 ||
      !last ||
      Math.hypot(last[0] - start[0], last[1] - start[1]) > 1e-9
    ) {
      close();
      current.push(start);
    }
    current.push(at(t1));
    if (t1 < 1 - 1e-12) close();
  }
  close();
  return pieces;
}

/** "DETAIL A (2:1)": the detail's caption, under it. */
export function detailCaption(
  label: string,
  scale: DrawingSheet['scale']
): string {
  return `DETAIL ${label} (${formatDrawingScale(scale)})`;
}

/** A circle as a closed paper polyline. */
function circlePoints(center: [number, number], radius: number): number[] {
  const steps = Math.max(36, Math.min(180, Math.ceil(radius * 2)));
  const points: number[] = [];
  for (let i = 0; i < steps; i += 1) {
    const angle = (2 * Math.PI * i) / steps;
    points.push(
      center[0] + radius * Math.cos(angle),
      center[1] + radius * Math.sin(angle)
    );
  }
  return points;
}

/**
 * D03 (v78): each detail's circle on its source view with its letter, the
 * detail's own boundary circle, and its caption beneath it.
 */
export function composeDetailMarks(
  sheet: Pick<DrawingSheet, 'scale' | 'views'>,
  views: readonly ComposedView[],
  units: UnitSystem
): { strokes: SheetStroke[]; texts: SheetText[] } {
  const strokes: SheetStroke[] = [];
  const texts: SheetText[] = [];
  const drawn = new Map(views.map((entry) => [entry.view.viewId, entry]));
  for (const view of sheet.views) {
    const detail = view.detail;
    if (!detail) continue;
    const source = drawn.get(detail.sourceViewId);
    if (source?.projection.bounds) {
      const toPage = viewPageTransform(
        source.view,
        source.projection.bounds,
        sheet,
        units
      );
      const center = toPage(detail.center.u, detail.center.v);
      const radius =
        detail.radius *
        drawingPaperPerModelUnit(
          source.view.detail?.scale ?? sheet.scale,
          units
        );
      strokes.push({
        kind: 'thin',
        closed: true,
        points: circlePoints(center, radius)
      });
      // The letter just outside the circle, up and to the right (45°).
      texts.push({
        x: center[0] + radius * Math.SQRT1_2 + 1.5,
        y: center[1] + radius * Math.SQRT1_2 + 1.5,
        sizeMm: SECTION_LABEL_MM,
        text: detail.label,
        bold: true
      });
    }
    const circle = viewClipCircle(view, units)!;
    strokes.push({
      kind: 'thin',
      closed: true,
      points: circlePoints(circle.center, circle.radius)
    });
    texts.push({
      x: circle.center[0],
      y: circle.center[1] - circle.radius - SECTION_CAPTION_GAP_MM,
      sizeMm: SECTION_LABEL_MM * 0.7,
      text: detailCaption(detail.label, detail.scale),
      bold: true,
      align: 'middle'
    });
  }
  return { strokes, texts };
}

/**
 * D03 (v81): an auxiliary view's direction of sight on its source's paper:
 * a unit (x, y), the way the arrow beside the source points.
 */
export function auxiliarySightOnSource(
  view: Pick<DrawingView, 'auxiliary'> & {
    auxiliary: NonNullable<DrawingView['auxiliary']>;
  },
  source: Pick<DrawingView, 'orientation'>
): [number, number] {
  const frame = DRAWING_VIEW_FRAMES[source.orientation];
  const d = view.auxiliary.direction;
  const u = d.x * frame.x.x + d.y * frame.x.y + d.z * frame.x.z;
  const v = d.x * frame.up.x + d.y * frame.up.y + d.z * frame.up.z;
  const length = Math.hypot(u, v) || 1;
  return [u / length, v / length];
}

/** "VIEW A": an auxiliary view's caption, under it. */
export function auxiliaryCaption(label: string): string {
  return `VIEW ${label}`;
}

/** How far outside its source's footprint the auxiliary arrow starts. */
const AUXILIARY_ARROW_GAP_MM = 6;

/**
 * D03 (v81): each auxiliary view's arrow beside its source, pointing along
 * its direction of sight at the source's middle, with its letter at the
 * tail, and its caption under the view.
 */
export function composeAuxiliaryMarks(
  sheet: Pick<DrawingSheet, 'scale' | 'views'>,
  views: readonly ComposedView[],
  units: UnitSystem
): { strokes: SheetStroke[]; texts: SheetText[] } {
  const strokes: SheetStroke[] = [];
  const texts: SheetText[] = [];
  const drawn = new Map(views.map((entry) => [entry.view.viewId, entry]));
  for (const view of sheet.views) {
    const auxiliary = view.auxiliary;
    if (!auxiliary) continue;
    const source = drawn.get(auxiliary.sourceViewId);
    if (source?.projection.bounds) {
      const box = viewPageBox(
        source.view,
        source.projection.bounds,
        sheet,
        units
      );
      const sight = auxiliarySightOnSource({ auxiliary }, source.view);
      const centre: [number, number] = [
        box.x + box.width / 2,
        box.y + box.height / 2
      ];
      // From outside the footprint, on the side the view is seen from.
      const reach =
        Math.abs(sight[0]) * (box.width / 2) +
        Math.abs(sight[1]) * (box.height / 2) +
        AUXILIARY_ARROW_GAP_MM +
        SECTION_ARROW_MM;
      const tail: [number, number] = [
        centre[0] - sight[0] * reach,
        centre[1] - sight[1] * reach
      ];
      strokes.push(...sectionArrow(tail, sight));
      texts.push({
        x: tail[0] - sight[0] * 3,
        y: tail[1] - sight[1] * 3 - SECTION_LABEL_MM / 2,
        sizeMm: SECTION_LABEL_MM,
        text: auxiliary.label,
        bold: true,
        align: 'middle'
      });
    }
    const own = drawn.get(view.viewId);
    if (own?.projection.bounds) {
      const box = viewPageBox(view, own.projection.bounds, sheet, units);
      texts.push({
        x: view.centerMm.x,
        y: box.y - SECTION_CAPTION_GAP_MM,
        sizeMm: SECTION_LABEL_MM * 0.7,
        text: auxiliaryCaption(auxiliary.label),
        bold: true,
        align: 'middle'
      });
    }
  }
  return { strokes, texts };
}

/** How a view's footprint sits on its sheet; null when it is clear. */
export type ViewPlacementIssue =
  /** Nothing of it is on the paper. */
  | 'off-page'
  /** Part of it runs off the paper: that part would not print. */
  | 'partly-off-page'
  /** On the paper, but across the drawing border into the margin. */
  | 'past-border'
  /** Inside the border, but over the title block. */
  | 'over-title-block';

const PLACEMENT_TOLERANCE_MM = 0.01;

export function viewPlacementIssue(
  box: { x: number; y: number; width: number; height: number },
  sheet: Pick<DrawingSheet, 'paper'>
): ViewPlacementIssue | null {
  const paper = drawingPaperMm(sheet.paper);
  const e = PLACEMENT_TOLERANCE_MM;
  const right = box.x + box.width;
  const top = box.y + box.height;
  const within = (minX: number, minY: number, maxX: number, maxY: number) =>
    box.x >= minX - e &&
    box.y >= minY - e &&
    right <= maxX + e &&
    top <= maxY + e;
  if (
    right < -e ||
    top < -e ||
    box.x > paper.width + e ||
    box.y > paper.height + e
  )
    return 'off-page';
  if (!within(0, 0, paper.width, paper.height)) return 'partly-off-page';
  if (
    !within(
      SHEET_MARGIN_MM,
      SHEET_MARGIN_MM,
      paper.width - SHEET_MARGIN_MM,
      paper.height - SHEET_MARGIN_MM
    )
  )
    return 'past-border';
  const block = titleBlockBox(sheet);
  if (
    right > block.x + e &&
    box.x < block.x + block.width - e &&
    top > block.y + e &&
    box.y < block.y + block.height - e
  )
    return 'over-title-block';
  return null;
}

/** Room kept between a fitted layout and the edges of the view area. */
const FIT_INSET_MM = 5;

/**
 * "Fit views to sheet": the sheet's views laid out again above the title
 * block, as one group. The group is centred in the view area and, only when
 * it does not fit at the sheet's scale, drawn at the largest preset scale at
 * which it does — every centre moves by the same rule, so projected views
 * stay aligned with their base and the layout keeps its arrangement. An
 * explicit scale and centres, never a viewport zoom (drawing-mvp-design.md).
 * Null when the sheet has no view with an extent, or nothing fits.
 */
export function fitViewsToSheet(
  sheet: DrawingSheet,
  extents: ReadonlyMap<string, ViewExtent>,
  units: UnitSystem
): {
  scale: DrawingSheet['scale'];
  centers: {
    viewId: DrawingView['viewId'];
    centerMm: { x: number; y: number };
  }[];
} | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const view of sheet.views) {
    const extent = extents.get(view.viewId);
    if (!extent) continue;
    const box = viewPageBox(view, extent, sheet, units);
    minX = Math.min(minX, box.x);
    minY = Math.min(minY, box.y);
    maxX = Math.max(maxX, box.x + box.width);
    maxY = Math.max(maxY, box.y + box.height);
  }
  if (!Number.isFinite(minX)) return null;
  const area = sheetViewArea(sheet);
  const width = area.width - 2 * FIT_INSET_MM;
  const height = area.height - 2 * FIT_INSET_MM;
  const current = drawingPaperPerModelUnit(sheet.scale, units);
  const fits = (ratio: number) =>
    (maxX - minX) * ratio <= width + PLACEMENT_TOLERANCE_MM &&
    (maxY - minY) * ratio <= height + PLACEMENT_TOLERANCE_MM;
  let scale = sheet.scale;
  let ratio = 1;
  if (!fits(1)) {
    // Presets run from the largest scale down; take the first that fits.
    const preset = DRAWING_SCALE_PRESETS.find((candidate) => {
      const r = drawingPaperPerModelUnit(candidate, units) / current;
      return r < 1 && fits(r);
    });
    if (!preset) return null;
    scale = preset;
    ratio = drawingPaperPerModelUnit(preset, units) / current;
  }
  const from = { x: (minX + maxX) / 2, y: (minY + maxY) / 2 };
  const to = {
    x: area.x + area.width / 2,
    y: area.y + area.height / 2
  };
  const round = (value: number) => Math.round(value * 10) / 10;
  return {
    scale,
    centers: sheet.views.map((view) => ({
      viewId: view.viewId,
      centerMm: {
        x: round(to.x + (view.centerMm.x - from.x) * ratio),
        y: round(to.y + (view.centerMm.y - from.y) * ratio)
      }
    }))
  };
}

/**
 * The orientation "Add view" offers first: the first standard view the sheet
 * does not show yet, so the default never adds a second Front to a sheet
 * that has one (review I65). Section views do not count; with every
 * orientation shown it falls back to the first.
 */
export function nextViewOrientation(
  sheet: Pick<DrawingSheet, 'views'>
): DrawingViewOrientation {
  const shown = new Set(
    sheet.views
      .filter((view) => view.section === undefined)
      .map((view) => view.orientation)
  );
  return (
    DRAWING_VIEW_ORIENTATIONS.find((orientation) => !shown.has(orientation)) ??
    DRAWING_VIEW_ORIENTATIONS[0]!
  );
}

/** Paper kept clear around a view placed in free space. */
const FREE_PLACEMENT_GAP_MM = 10;
/** Spacing of the candidate centres a free placement tries. */
const FREE_PLACEMENT_STEP_MM = 5;

/**
 * Where a view of `size` mm goes when nothing aligns it to a base: the free
 * spot above the title block nearest the middle of the view area, clear of
 * every view already on the sheet by a gap. It was always the middle, on top
 * of the starter's layout (review I65). The middle when the view is larger
 * than the area or no spot is free.
 */
export function freeViewCenter(
  sheet: DrawingSheet,
  extents: ReadonlyMap<string, ViewExtent>,
  units: UnitSystem,
  size: { width: number; height: number }
): { x: number; y: number } {
  const area = sheetViewArea(sheet);
  const centre = { x: area.x + area.width / 2, y: area.y + area.height / 2 };
  const taken = sheet.views.flatMap((view) => {
    const extent = extents.get(view.viewId);
    return extent ? [viewPageBox(view, extent, sheet, units)] : [];
  });
  const halfW = size.width / 2 + FIT_INSET_MM;
  const halfH = size.height / 2 + FIT_INSET_MM;
  const reachX = Math.floor((area.width / 2 - halfW) / FREE_PLACEMENT_STEP_MM);
  const reachY = Math.floor((area.height / 2 - halfH) / FREE_PLACEMENT_STEP_MM);
  if (reachX < 0 || reachY < 0) return centre;
  const clear = (x: number, y: number) =>
    taken.every(
      (box) =>
        x + size.width / 2 + FREE_PLACEMENT_GAP_MM <= box.x ||
        x - size.width / 2 - FREE_PLACEMENT_GAP_MM >= box.x + box.width ||
        y + size.height / 2 + FREE_PLACEMENT_GAP_MM <= box.y ||
        y - size.height / 2 - FREE_PLACEMENT_GAP_MM >= box.y + box.height
    );
  let best: { x: number; y: number; distance: number } | null = null;
  for (let i = -reachX; i <= reachX; i += 1)
    for (let j = -reachY; j <= reachY; j += 1) {
      const x = centre.x + i * FREE_PLACEMENT_STEP_MM;
      const y = centre.y + j * FREE_PLACEMENT_STEP_MM;
      const distance = Math.hypot(x - centre.x, y - centre.y);
      if (best && distance >= best.distance) continue;
      if (clear(x, y)) best = { x, y, distance };
    }
  const round = (value: number) => Math.round(value * 10) / 10;
  return best ? { x: round(best.x), y: round(best.y) } : centre;
}

/** Paper kept between "Auto scale" grid cells and around them. */
const AUTO_SCALE_GAP_MM = 15;
/** View centres closer than this on paper share a row or column. */
const AUTO_SCALE_ALIGN_MM = 0.5;

/**
 * "Auto scale": the sheet's views laid out again as a grid above the title
 * block, at the largest preset scale at which the grid fits. Views whose
 * centres line up keep sharing a row or column, so projected views stay
 * aligned with their base and the arrangement survives — but, unlike "Fit
 * views to sheet", the gaps between views are set afresh, so a layout that
 * overlaps or sprawls after a scale change comes out evenly spaced at the
 * scale that fills the paper. Null when the sheet has no view with an
 * extent, or the grid fits at no preset.
 */
export function autoScaleSheet(
  sheet: DrawingSheet,
  extents: ReadonlyMap<string, ViewExtent>,
  units: UnitSystem
): {
  scale: DrawingSheet['scale'];
  centers: {
    viewId: DrawingView['viewId'];
    centerMm: { x: number; y: number };
  }[];
} | null {
  const placed = sheet.views.flatMap((view) => {
    const extent = extents.get(view.viewId);
    return extent
      ? [
          {
            view,
            width: extent.maxU - extent.minU,
            height: extent.maxV - extent.minV
          }
        ]
      : [];
  });
  if (placed.length === 0) return null;
  // Track index per view along one axis, and each track's model size.
  const tracks = (axis: 'x' | 'y', size: 'width' | 'height') => {
    const order = [...placed].sort(
      (a, b) => a.view.centerMm[axis] - b.view.centerMm[axis]
    );
    const index = new Map<DrawingView['viewId'], number>();
    const sizes: number[] = [];
    let last = -Infinity;
    for (const entry of order) {
      if (entry.view.centerMm[axis] - last > AUTO_SCALE_ALIGN_MM) sizes.push(0);
      last = entry.view.centerMm[axis];
      index.set(entry.view.viewId, sizes.length - 1);
      sizes[sizes.length - 1] = Math.max(sizes.at(-1)!, entry[size]);
    }
    return { index, sizes };
  };
  const columns = tracks('x', 'width');
  const rows = tracks('y', 'height');
  const sum = (values: number[]) => values.reduce((a, b) => a + b, 0);
  const needU = sum(columns.sizes);
  const needV = sum(rows.sizes);
  const area = sheetViewArea(sheet);
  // Presets run from the largest scale down; take the first that fits.
  const scale = DRAWING_SCALE_PRESETS.find((candidate) => {
    const k = drawingPaperPerModelUnit(candidate, units);
    return (
      needU * k + (columns.sizes.length + 1) * AUTO_SCALE_GAP_MM <=
        area.width + PLACEMENT_TOLERANCE_MM &&
      needV * k + (rows.sizes.length + 1) * AUTO_SCALE_GAP_MM <=
        area.height + PLACEMENT_TOLERANCE_MM
    );
  });
  if (!scale) return null;
  const k = drawingPaperPerModelUnit(scale, units);
  // Leftover paper is shared evenly between the gaps, as in the starter.
  const trackCenters = (sizes: number[], start: number, span: number) => {
    const gap = (span - sum(sizes) * k) / (sizes.length + 1);
    let at = start;
    return sizes.map((size) => {
      at += gap;
      const center = at + (size * k) / 2;
      at += size * k;
      return center;
    });
  };
  const xs = trackCenters(columns.sizes, area.x, area.width);
  const ys = trackCenters(rows.sizes, area.y, area.height);
  const round = (value: number) => Math.round(value * 10) / 10;
  return {
    scale,
    centers: placed.map(({ view }) => ({
      viewId: view.viewId,
      centerMm: {
        x: round(xs[columns.index.get(view.viewId)!]!),
        y: round(ys[rows.index.get(view.viewId)!]!)
      }
    }))
  };
}
