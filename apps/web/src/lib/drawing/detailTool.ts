import {
  DRAWING_SCALE_PRESETS,
  drawingPaperPerModelUnit,
  nextDrawingSectionLabel,
  type DrawingScale,
  type DrawingSheet,
  type DrawingView,
  type UnitSystem
} from '@openzcad/shared';
import { viewPageBox, type ComposedView } from './sheetPage';

/**
 * D03 detail view tool (schema v78): a circle dragged on a view (pressed at
 * its centre, released on its rim) picks the region; the detail then
 * follows the pointer at its own scale until a click places it.
 */

type XY = [number, number];

/** Below this a dragged circle is a slip, not a region, in paper mm. */
const MIN_DETAIL_RADIUS_MM = 2;

/** The drawn view whose box holds `point`, if it can be detailed. */
export function detailSourceAt(
  sheet: Pick<DrawingSheet, 'scale'>,
  views: readonly ComposedView[],
  point: XY,
  units: UnitSystem
): ComposedView | null {
  for (const entry of views) {
    const { view, projection } = entry;
    // A detail's source is a principal view: not a section, another detail
    // or (v81) an auxiliary view, which validation refuses as a source.
    // AS03 (v113): nor an exploded view, whose parts are pulled apart.
    if (
      !projection.bounds ||
      view.section ||
      view.detail ||
      view.auxiliary ||
      view.exploded
    )
      continue;
    const box = viewPageBox(view, projection.bounds, sheet, units);
    if (
      point[0] >= box.x &&
      point[0] <= box.x + box.width &&
      point[1] >= box.y &&
      point[1] <= box.y + box.height
    )
      return entry;
  }
  return null;
}

/**
 * The region a drag from `start` (the centre) to `end` (the rim) picks on
 * `source`, in its model (u, v): null when the drag is too short.
 */
export function detailRegionFromDrag(
  sheet: Pick<DrawingSheet, 'scale'>,
  source: ComposedView,
  start: XY,
  end: XY,
  units: UnitSystem
): { center: { u: number; v: number }; radius: number } | null {
  const bounds = source.projection.bounds;
  if (!bounds) return null;
  const dragged = Math.hypot(end[0] - start[0], end[1] - start[1]);
  if (dragged < MIN_DETAIL_RADIUS_MM) return null;
  const k = drawingPaperPerModelUnit(sheet.scale, units);
  const cu = (bounds.minU + bounds.maxU) / 2;
  const cv = (bounds.minV + bounds.maxV) / 2;
  const round = (value: number) => Math.round(value * 1e6) / 1e6;
  return {
    center: {
      u: round(cu + (start[0] - source.view.centerMm.x) / k),
      v: round(cv + (start[1] - source.view.centerMm.y) / k)
    },
    radius: round(dragged / k)
  };
}

/** A sheet scale's paper : model ratio. */
function ratio(scale: DrawingScale): number {
  return scale.numerator / scale.denominator;
}

/**
 * The detail's default scale: the smallest preset at least twice the
 * sheet's, so the region is enlarged; the largest preset when none is.
 */
export function defaultDetailScale(sheetScale: DrawingScale): DrawingScale {
  const wanted = 2 * ratio(sheetScale);
  const larger = DRAWING_SCALE_PRESETS.filter(
    (preset) => ratio(preset) >= wanted - 1e-12
  );
  return { ...(larger.at(-1) ?? DRAWING_SCALE_PRESETS[0]!) };
}

/** The detail view a click at `pointer` would place, without its id. */
export function detailDraft(
  sheet: Pick<DrawingSheet, 'scale' | 'views'>,
  source: DrawingView,
  region: { center: { u: number; v: number }; radius: number },
  pointer: XY
): Omit<DrawingView, 'viewId'> {
  const round = (value: number) => Math.round(value * 10) / 10;
  return {
    orientation: source.orientation,
    bodyIds: [...source.bodyIds],
    centerMm: { x: round(pointer[0]), y: round(pointer[1]) },
    hiddenLines: source.hiddenLines,
    detail: {
      sourceViewId: source.viewId,
      label: nextDrawingSectionLabel(sheet),
      center: { ...region.center },
      radius: region.radius,
      scale: defaultDetailScale(sheet.scale)
    }
  };
}
