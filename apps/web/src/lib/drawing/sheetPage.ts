import {
  DRAWING_PAPER_LABELS,
  DRAWING_VIEW_FRAMES,
  drawingPaperMm,
  drawingPaperPerModelUnit,
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

export type SheetStrokeKind = 'visible' | 'hidden' | 'border' | 'thin';

export interface SheetStroke {
  kind: SheetStrokeKind;
  /** Flat `[x0, y0, x1, y1, …]` paper millimetres. */
  points: number[];
  closed?: boolean;
}

export interface SheetText {
  x: number;
  y: number;
  /** Cap-to-baseline size in millimetres. */
  sizeMm: number;
  text: string;
  bold?: boolean;
}

export interface SheetPage {
  widthMm: number;
  heightMm: number;
  strokes: SheetStroke[];
  texts: SheetText[];
}

/** Stroke weights in paper millimetres (ISO 128 0.35/0.25 pair). */
export const SHEET_STROKE_WIDTH_MM: Readonly<Record<SheetStrokeKind, number>> =
  {
    visible: 0.35,
    hidden: 0.25,
    border: 0.5,
    thin: 0.25
  };
/** Hidden-line dash and gap, in paper millimetres. */
export const SHEET_HIDDEN_DASH_MM: readonly [number, number] = [3, 1.5];

export const SHEET_MARGIN_MM = 10;
export const TITLE_BLOCK_HEIGHT_MM = 32;
const TITLE_BLOCK_MAX_WIDTH_MM = 170;

/** Helvetica advance widths for U+0020–U+007E, per 1000 em. */
const HELVETICA_WIDTHS = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278,
  278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584,
  584, 556, 1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556,
  833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278,
  278, 278, 469, 556, 333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222,
  500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500,
  500, 334, 260, 334, 584
];

/**
 * Sheet text is drawn in the PDF base-14 Helvetica, which every reader
 * supplies, so nothing is embedded. That font covers WinAnsi only: anything
 * else becomes "?" here, before layout, so the preview, SVG and PDF show the
 * same characters.
 */
export function sheetSafeText(text: string): string {
  let out = '';
  for (const char of text.replace(/\s+/g, ' ').trim()) {
    const code = char.codePointAt(0)!;
    out +=
      (code >= 0x20 && code <= 0x7e) || (code >= 0xa0 && code <= 0xff)
        ? char
        : '?';
  }
  return out;
}

export function textWidthMm(
  text: string,
  sizeMm: number,
  bold = false
): number {
  let units = 0;
  for (const char of text) {
    const code = char.codePointAt(0)!;
    units += HELVETICA_WIDTHS[code - 0x20] ?? 556;
  }
  // Renderers convert cap height to font size by the same 0.718 factor.
  // Helvetica-Bold runs about 5% wider; this only decides truncation.
  return ((units * (sizeMm / 0.718)) / 1000) * (bold ? 1.05 : 1);
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
  points: Iterable<ArrayLike<number>>
): ViewExtent | null {
  const frame = DRAWING_VIEW_FRAMES[orientation];
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

/** Maps a view's model (u, v) to paper millimetres. */
export function viewPageTransform(
  view: Pick<DrawingView, 'centerMm'>,
  extent: ViewExtent,
  sheet: Pick<DrawingSheet, 'scale'>,
  units: UnitSystem
): (u: number, v: number) => [number, number] {
  const k = drawingPaperPerModelUnit(sheet.scale, units);
  const cu = (extent.minU + extent.maxU) / 2;
  const cv = (extent.minV + extent.maxV) / 2;
  return (u, v) => [
    view.centerMm.x + (u - cu) * k,
    view.centerMm.y + (v - cv) * k
  ];
}

/** A view's footprint on paper, in millimetres. */
export function viewPageBox(
  view: Pick<DrawingView, 'centerMm'>,
  extent: ViewExtent,
  sheet: Pick<DrawingSheet, 'scale'>,
  units: UnitSystem
): { x: number; y: number; width: number; height: number } {
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
export function titleBlockBox(sheet: Pick<DrawingSheet, 'paper'>): {
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
    height: TITLE_BLOCK_HEIGHT_MM
  };
}

/** The drawable area above the title block, for fitting views. */
export function sheetViewArea(sheet: Pick<DrawingSheet, 'paper'>): {
  x: number;
  y: number;
  width: number;
  height: number;
} {
  const paper = drawingPaperMm(sheet.paper);
  const bottom = SHEET_MARGIN_MM + TITLE_BLOCK_HEIGHT_MM;
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

function titleBlock(
  sheet: DrawingSheet,
  context: { projectName: string; units: UnitSystem }
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
  const titleTop = box.y + box.height;
  const titleBottom = titleTop - (box.height - 2 * rowHeight);
  strokes.push(
    {
      kind: 'thin',
      points: [box.x, titleBottom, box.x + box.width, titleBottom]
    },
    {
      kind: 'thin',
      points: [box.x, box.y + rowHeight, box.x + box.width, box.y + rowHeight]
    }
  );
  const block = sheet.titleBlock;
  const title = sheetSafeText(block.title ?? context.projectName);
  texts.push({
    x: box.x + 2,
    y: titleBottom + 3.5,
    sizeMm: 5,
    bold: true,
    text: fitText(title, 5, box.width - 4, true)
  });
  const unitLabel = {
    mm: 'Millimetres',
    cm: 'Centimetres',
    m: 'Metres',
    inch: 'Inches'
  }[context.units];
  const rows: [string, string][][] = [
    [
      ['DWG NO.', block.drawingNumber ?? ''],
      ['REV', block.revision ?? ''],
      ['SCALE', formatDrawingScale(sheet.scale)],
      ['SHEET', DRAWING_PAPER_LABELS[sheet.paper.size]]
    ],
    [
      ['DRAWN', block.author ?? ''],
      ['DATE', block.date ?? ''],
      ['UNITS', unitLabel],
      [
        'PROJECTION',
        sheet.projectionAngle === 'first' ? 'First angle' : 'Third angle'
      ]
    ]
  ];
  const columns = [0.34, 0.14, 0.22, 0.3];
  rows.forEach((cells, rowIndex) => {
    const top = titleBottom - rowIndex * rowHeight;
    let x = box.x;
    cells.forEach(([label, value], column) => {
      const width = box.width * columns[column]!;
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

/**
 * The page for a sheet whose views are all projected. Views missing from
 * `views` (stale, refused or still projecting) are simply not drawn; the
 * export path refuses before calling this unless every view is ready.
 */
export function composeSheetPage(
  sheet: DrawingSheet,
  views: readonly ComposedView[],
  context: { projectName: string; units: UnitSystem }
): SheetPage {
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
    // Hidden first, so a visible line drawn over a coincident hidden one wins.
    for (const [kind, lines] of [
      ['hidden', projection.hidden],
      ['visible', projection.visible]
    ] as const)
      for (const line of lines) {
        const points: number[] = [];
        for (let i = 0; i + 1 < line.length; i += 2) {
          const [x, y] = toPage(line[i]!, line[i + 1]!);
          points.push(x, y);
        }
        strokes.push({ kind, points });
      }
  }
  const block = titleBlock(sheet, context);
  return {
    widthMm: paper.width,
    heightMm: paper.height,
    strokes: [...strokes, ...block.strokes],
    texts: block.texts
  };
}
