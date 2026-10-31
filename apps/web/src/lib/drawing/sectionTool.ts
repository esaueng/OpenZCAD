import {
  DRAWING_VIEW_FRAMES,
  drawingPaperPerModelUnit,
  drawingSectionOrientations,
  nextDrawingSectionLabel,
  projectedViewSide,
  projectToView,
  type BodyId,
  type DrawingSheet,
  type DrawingView,
  type DrawingViewId,
  type DrawingViewOrientation,
  type UnitSystem
} from '@openzcad/shared';
import { annotationBody, type AnnotationBodies } from './annotations';
import { viewPageTransform, type ComposedView } from './sheetPage';

/**
 * D03 section tool: from a line drawn across a view to the section view it
 * makes. Pure, so the canvas and the tests share one rule.
 *
 * A drag across a principal view draws the cutting-plane line: mostly
 * sideways makes a horizontal line, mostly up or down a vertical one, at the
 * press point's height or position — snapped to a circle's centre or the
 * view's middle within {@link SECTION_SNAP_MM}, so a section through a
 * bore's axis is one gesture. The section view then follows the pointer
 * along the line's normal, aligned with its source; which side it is on
 * decides which way it looks, by the sheet's projection angle (third angle
 * puts a view on the side it is seen from, as for projected views).
 */

type XY = [number, number];

/** How close, on the paper, a line snaps to a centre. */
export const SECTION_SNAP_MM = 2;

export interface SectionLine {
  sourceViewId: DrawingViewId;
  axis: 'horizontal' | 'vertical';
  /** The line's model coordinate in the source: its v (horizontal) or u. */
  at: number;
}

/** The view a press lands in, if it may take a section line. */
export function sectionSourceAt(
  sheet: Pick<DrawingSheet, 'scale'>,
  views: readonly ComposedView[],
  point: XY,
  units: UnitSystem,
  padMm = 3
): ComposedView | null {
  for (const entry of views) {
    const { view, projection } = entry;
    if (view.section || view.orientation === 'iso' || !projection.bounds)
      continue;
    const toPage = viewPageTransform(view, projection.bounds, sheet, units);
    const [x0, y0] = toPage(projection.bounds.minU, projection.bounds.minV);
    const [x1, y1] = toPage(projection.bounds.maxU, projection.bounds.maxV);
    if (
      point[0] >= x0 - padMm &&
      point[0] <= x1 + padMm &&
      point[1] >= y0 - padMm &&
      point[1] <= y1 + padMm
    )
      return entry;
  }
  return null;
}

/**
 * Model coordinates a line across `source` snaps to, along `axis`'s normal:
 * the view's middle and every circular edge's centre it draws.
 */
export function sectionSnapTargets(
  source: ComposedView,
  bodies: AnnotationBodies,
  axis: SectionLine['axis']
): number[] {
  const { view, projection } = source;
  const out: number[] = [];
  if (projection.bounds)
    out.push(
      axis === 'horizontal'
        ? (projection.bounds.minV + projection.bounds.maxV) / 2
        : (projection.bounds.minU + projection.bounds.maxU) / 2
    );
  const frame = DRAWING_VIEW_FRAMES[view.orientation];
  for (const bodyId of view.bodyIds) {
    for (const edge of annotationBody(bodies, view, bodyId)?.topology?.edges ??
      []) {
      const circle = edge.curve?.circle;
      if (!circle) continue;
      const { u, v } = projectToView(frame, circle.center);
      out.push(axis === 'horizontal' ? v : u);
    }
  }
  return out;
}

/**
 * The cutting-plane line a drag from `start` to `end` draws across
 * `source`, or null for a drag too short to say which way it runs.
 */
export function sectionLineFromDrag(
  sheet: Pick<DrawingSheet, 'scale'>,
  source: ComposedView,
  start: XY,
  end: XY,
  units: UnitSystem,
  snaps: readonly number[] = [],
  minDragMm = 3
): SectionLine | null {
  const bounds = source.projection.bounds;
  if (!bounds) return null;
  const dx = end[0] - start[0];
  const dy = end[1] - start[1];
  if (Math.hypot(dx, dy) < minDragMm) return null;
  const axis = Math.abs(dx) >= Math.abs(dy) ? 'horizontal' : 'vertical';
  const k = drawingPaperPerModelUnit(sheet.scale, units);
  const centre: XY = [
    (bounds.minU + bounds.maxU) / 2,
    (bounds.minV + bounds.maxV) / 2
  ];
  // Paper to model, through the view's own transform.
  const at =
    axis === 'horizontal'
      ? centre[1] + (start[1] - source.view.centerMm.y) / k
      : centre[0] + (start[0] - source.view.centerMm.x) / k;
  let snapped = at;
  let best = SECTION_SNAP_MM / k;
  for (const target of snaps) {
    const distance = Math.abs(target - at);
    if (distance <= best) {
      best = distance;
      snapped = target;
    }
  }
  return { sourceViewId: source.view.viewId, axis, at: snapped };
}

/**
 * The section view a line makes with the pointer at `pointer`: the
 * orientation that looks away from the side it is placed on (by the
 * projection angle), its cut depth, and its centre on the source's shared
 * axis. A line whose only aligned orientation belongs on the other side
 * places there instead. Null when no orientation folds from the source.
 */
export function sectionPlacement(
  sheet: Pick<DrawingSheet, 'projectionAngle' | 'views'>,
  source: DrawingView,
  line: SectionLine,
  pointer: XY,
  bodyIds: readonly BodyId[],
  /** The least distance, in paper mm, from the source's centre. */
  minReachMm = 20
): DrawingView | null {
  const candidates = drawingSectionOrientations(source.orientation, line.axis);
  if (candidates.length === 0) return null;
  const free = line.axis === 'horizontal' ? 1 : 0;
  const offset = pointer[free] - [source.centerMm.x, source.centerMm.y][free]!;
  const wanted = offset >= 0 ? 1 : -1;
  const sideOf = (orientation: DrawingViewOrientation) =>
    projectedViewSide(source.orientation, orientation, sheet.projectionAngle);
  const orientation =
    candidates.find((entry) => sideOf(entry) === wanted) ?? candidates[0]!;
  const side = sideOf(orientation);
  const direction = DRAWING_VIEW_FRAMES[orientation].direction;
  const frame = DRAWING_VIEW_FRAMES[source.orientation];
  const along = line.axis === 'horizontal' ? frame.up : frame.x;
  // `along` is ±direction, and the line sits at `at` on it.
  const sign =
    along.x * direction.x + along.y * direction.y + along.z * direction.z;
  const depth = line.at * sign;
  const reach = side * Math.max(side * offset, minReachMm);
  const centerMm =
    line.axis === 'horizontal'
      ? { x: source.centerMm.x, y: source.centerMm.y + reach }
      : { x: source.centerMm.x + reach, y: source.centerMm.y };
  return {
    viewId: 'dvw_section_preview' as DrawingViewId,
    orientation,
    bodyIds: [...bodyIds],
    centerMm,
    hiddenLines: false,
    section: {
      sourceViewId: source.viewId,
      label: nextDrawingSectionLabel(sheet),
      // −0 and 0 are one plane; keep the stored number plain.
      depth: depth === 0 ? 0 : depth
    }
  };
}
