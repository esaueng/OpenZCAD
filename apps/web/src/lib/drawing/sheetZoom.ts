/**
 * The Draw workspace's sheet zoom: which part of the paper the canvas shows.
 * It is editor state only — never saved, never in an export — and it moves
 * the SVG viewBox, so `getScreenCTM` keeps mapping the pointer to paper
 * millimetres for picking and dragging at any zoom.
 *
 * `zoom` is relative to the whole sheet fitted in the canvas (1 = fit), and
 * (cx, cy) is the paper point, in SVG user units (millimetres, y down), at the
 * canvas centre.
 */
export interface SheetZoom {
  zoom: number;
  cx: number;
  cy: number;
}

export const MIN_SHEET_ZOOM = 1;
export const MAX_SHEET_ZOOM = 16;
/** One zoom-in or zoom-out button press. */
export const SHEET_ZOOM_STEP = 1.25;

interface Paper {
  width: number;
  height: number;
}

interface CanvasRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export function fitSheetZoom(paper: Paper): SheetZoom {
  return { zoom: 1, cx: paper.width / 2, cy: paper.height / 2 };
}

/** Zoom within its range; the centre stays on the paper, and fit is fit. */
export function clampSheetZoom(state: SheetZoom, paper: Paper): SheetZoom {
  const zoom = Math.min(
    MAX_SHEET_ZOOM,
    Math.max(MIN_SHEET_ZOOM, Number.isFinite(state.zoom) ? state.zoom : 1)
  );
  if (zoom <= MIN_SHEET_ZOOM + 1e-6) return fitSheetZoom(paper);
  const clamp = (value: number, max: number) =>
    Math.min(max, Math.max(0, Number.isFinite(value) ? value : max / 2));
  return {
    zoom,
    cx: clamp(state.cx, paper.width),
    cy: clamp(state.cy, paper.height)
  };
}

export function sheetViewBox(state: SheetZoom, paper: Paper): string {
  if (state.zoom <= MIN_SHEET_ZOOM) return `0 0 ${paper.width} ${paper.height}`;
  const width = paper.width / state.zoom;
  const height = paper.height / state.zoom;
  const r = (value: number) => Math.round(value * 1000) / 1000;
  return `${r(state.cx - width / 2)} ${r(state.cy - height / 2)} ${r(width)} ${r(height)}`;
}

/**
 * Canvas pixels per paper millimetre at `state`: the viewBox has the paper's
 * proportions and is fitted whole ("meet"), so its scale is the fitted
 * sheet's times the zoom.
 */
export function sheetPxPerMm(
  state: SheetZoom,
  paper: Paper,
  rect: Pick<CanvasRect, 'width' | 'height'>
): number {
  return (
    Math.min(rect.width / paper.width, rect.height / paper.height) * state.zoom
  );
}

/**
 * `state` zoomed to `zoom`, keeping the paper point under `client` (a
 * pointer, a pinch's midpoint) where it is on screen. Without a point, or a
 * canvas that has no size yet, it zooms about the canvas centre.
 */
export function zoomSheetAt(
  state: SheetZoom,
  paper: Paper,
  zoom: number,
  rect?: CanvasRect,
  client?: { x: number; y: number }
): SheetZoom {
  const next = Math.min(MAX_SHEET_ZOOM, Math.max(MIN_SHEET_ZOOM, zoom));
  const before = rect ? sheetPxPerMm(state, paper, rect) : 0;
  if (!rect || !client || !(before > 0))
    return clampSheetZoom({ ...state, zoom: next }, paper);
  const after = sheetPxPerMm({ ...state, zoom: next }, paper, rect);
  const dx = client.x - (rect.left + rect.width / 2);
  const dy = client.y - (rect.top + rect.height / 2);
  const px = state.cx + dx / before;
  const py = state.cy + dy / before;
  return clampSheetZoom(
    { zoom: next, cx: px - dx / after, cy: py - dy / after },
    paper
  );
}

/** `state` moved so the paper follows the pointer by (dx, dy) pixels. */
export function panSheet(
  state: SheetZoom,
  paper: Paper,
  rect: Pick<CanvasRect, 'width' | 'height'>,
  dx: number,
  dy: number
): SheetZoom {
  const scale = sheetPxPerMm(state, paper, rect);
  if (!(scale > 0)) return state;
  return clampSheetZoom(
    { ...state, cx: state.cx - dx / scale, cy: state.cy - dy / scale },
    paper
  );
}

/** A wheel delta in pixels, whatever unit the device reported it in. */
export function wheelPixels(
  event: Pick<WheelEvent, 'deltaX' | 'deltaY' | 'deltaMode'>
): { x: number; y: number } {
  const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 400 : 1;
  return { x: event.deltaX * unit, y: event.deltaY * unit };
}
