import {
  DRAWING_PAPER_LABELS,
  DRAWING_SCALE_PRESETS,
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

export type SheetStrokeKind =
  'visible' | 'hidden' | 'border' | 'thin' | 'dimension';

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
    thin: 0.25,
    dimension: 0.25
  };
/** Hidden-line dash and gap, in paper millimetres. */
export const SHEET_HIDDEN_DASH_MM: readonly [number, number] = [3, 1.5];

export const SHEET_MARGIN_MM = 10;
export const TITLE_BLOCK_HEIGHT_MM = 32;
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
  // REV and DATE each hold a full ISO date ("2026-10-28" is about 21.4 mm
  // at 3 mm text). Every paper, A4 portrait included, is wide enough to give
  // the block its full TITLE_BLOCK_MAX_WIDTH_MM, so these widths hold on all.
  const columns = [0.3, 0.18, 0.22, 0.3];
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
  context: { projectName: string; units: UnitSystem },
  /** D02 dimensions and notes, already laid out on this page. */
  annotations?: { strokes: SheetStroke[]; texts: SheetText[] }
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
  // Views and annotations can be placed past the paper's edge (a smaller
  // paper, a drag); what lies there is not on the page, so it is not drawn.
  const onPaper: PaperRect = {
    minX: 0,
    minY: 0,
    maxX: paper.width,
    maxY: paper.height
  };
  return {
    widthMm: paper.width,
    heightMm: paper.height,
    strokes: [
      ...strokes,
      ...(annotations?.strokes ?? []),
      ...block.strokes
    ].flatMap((stroke) => clipStroke(stroke, onPaper)),
    texts: [...(annotations?.texts ?? []), ...block.texts].filter((text) =>
      insideRect(onPaper, text.x, text.y)
    )
  };
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
