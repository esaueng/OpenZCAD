import {
  drawingViewFrame,
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
  type UnitSystem,
  type Vector3
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

export type SectionLine =
  | {
      sourceViewId: DrawingViewId;
      axis: 'horizontal' | 'vertical';
      /** The line's model coordinate in the source: its v (horizontal) or u. */
      at: number;
    }
  | {
      /**
       * D03 (v91): a free section line, at an angle: through a model
       * (u, v) point of the source, along a unit (u, v) direction.
       */
      sourceViewId: DrawingViewId;
      axis: 'free';
      through: XY;
      along: XY;
      /** Where `through` lies on the paper: which side a click is on. */
      throughMm: XY;
    };

/**
 * A drag further than this from horizontal or vertical draws a free
 * section line (v91); nearer, it snaps square, as before.
 */
export const SECTION_FREE_MIN_DEG = 10;

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
    // AS03 (v113): an exploded view's parts are pulled apart; none is cut.
    if (
      view.section ||
      view.orientation === 'iso' ||
      view.exploded ||
      !projection.bounds
    )
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
  const frame = drawingViewFrame(view);
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
 * Model (u, v) points a free line across `source` snaps through: the
 * view's middle and every circular edge's centre it draws.
 */
export function sectionSnapPoints(
  source: ComposedView,
  bodies: AnnotationBodies
): XY[] {
  const { view, projection } = source;
  const out: XY[] = [];
  if (projection.bounds)
    out.push([
      (projection.bounds.minU + projection.bounds.maxU) / 2,
      (projection.bounds.minV + projection.bounds.maxV) / 2
    ]);
  const frame = drawingViewFrame(view);
  for (const bodyId of view.bodyIds) {
    for (const edge of annotationBody(bodies, view, bodyId)?.topology?.edges ??
      []) {
      const circle = edge.curve?.circle;
      if (!circle) continue;
      const { u, v } = projectToView(frame, circle.center);
      out.push([u, v]);
    }
  }
  return out;
}

/**
 * The cutting-plane line a drag from `start` to `end` draws across
 * `source`, or null for a drag too short to say which way it runs. A drag
 * within {@link SECTION_FREE_MIN_DEG} of horizontal or vertical snaps
 * square; one further off draws a free line through the press point (or a
 * centre in `points` within {@link SECTION_SNAP_MM} of it).
 */
export function sectionLineFromDrag(
  sheet: Pick<DrawingSheet, 'scale'>,
  source: ComposedView,
  start: XY,
  end: XY,
  units: UnitSystem,
  snaps: readonly number[] = [],
  minDragMm = 3,
  points: readonly XY[] = []
): SectionLine | null {
  const bounds = source.projection.bounds;
  if (!bounds) return null;
  const dx = end[0] - start[0];
  const dy = end[1] - start[1];
  const length = Math.hypot(dx, dy);
  if (length < minDragMm) return null;
  const axis = Math.abs(dx) >= Math.abs(dy) ? 'horizontal' : 'vertical';
  const k = drawingPaperPerModelUnit(sheet.scale, units);
  const centre: XY = [
    (bounds.minU + bounds.maxU) / 2,
    (bounds.minV + bounds.maxV) / 2
  ];
  const offAxisDeg =
    (Math.atan2(
      Math.min(Math.abs(dx), Math.abs(dy)),
      Math.max(Math.abs(dx), Math.abs(dy))
    ) *
      180) /
    Math.PI;
  if (offAxisDeg > SECTION_FREE_MIN_DEG) {
    // Paper to model, through the view's own transform (paper and model
    // axes run the same way).
    let through: XY = [
      centre[0] + (start[0] - source.view.centerMm.x) / k,
      centre[1] + (start[1] - source.view.centerMm.y) / k
    ];
    let best = SECTION_SNAP_MM / k;
    const pressed = through;
    for (const point of points) {
      const distance = Math.hypot(point[0] - pressed[0], point[1] - pressed[1]);
      if (distance <= best) {
        best = distance;
        through = [point[0], point[1]];
      }
    }
    return {
      sourceViewId: source.view.viewId,
      axis: 'free',
      through,
      along: [dx / length, dy / length],
      throughMm: [
        source.view.centerMm.x + (through[0] - centre[0]) * k,
        source.view.centerMm.y + (through[1] - centre[1]) * k
      ]
    };
  }
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
  if (line.axis === 'free')
    return freeSectionPlacement(sheet, source, line, pointer, bodyIds);
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

/** Rounded so a stored frame is short and exact across reloads. */
function tidy(value: number): number {
  const rounded = Math.round(value * 1e12) / 1e12;
  return Object.is(rounded, -0) ? 0 : rounded;
}

function unit(v: Vector3): Vector3 {
  const length = Math.hypot(v.x, v.y, v.z);
  return { x: v.x / length, y: v.y / length, z: v.z / length };
}

/**
 * D03 (v91): the free section a line at an angle makes, placed at
 * `pointer`. Its plane holds the line and the source's direction of sight;
 * it is seen square to it from the side the pointer is on in third angle
 * (the view lies on the side it is seen from), the other in first angle,
 * as an auxiliary view is. Page-up is the source's direction of sight.
 * Null for a source that cannot take one (the isometric).
 */
function freeSectionPlacement(
  sheet: Pick<DrawingSheet, 'projectionAngle' | 'views'>,
  source: DrawingView,
  line: Extract<SectionLine, { axis: 'free' }>,
  pointer: XY,
  bodyIds: readonly BodyId[]
): DrawingView | null {
  if (source.orientation === 'iso') return null;
  const frame = DRAWING_VIEW_FRAMES[source.orientation];
  const [tu, tv] = line.along;
  // The line's normal in the source's page, toward the pointer's side of
  // the line itself (not of the view's middle, which it may be off).
  const [px, py] = line.throughMm;
  let n: XY = [-tv, tu];
  if ((pointer[0] - px) * n[0] + (pointer[1] - py) * n[1] < 0) n = [tv, -tu];
  const sign = sheet.projectionAngle === 'third' ? -1 : 1;
  const direction = unit({
    x: sign * (n[0] * frame.x.x + n[1] * frame.up.x),
    y: sign * (n[0] * frame.x.y + n[1] * frame.up.y),
    z: sign * (n[0] * frame.x.z + n[1] * frame.up.z)
  });
  const up = frame.direction;
  const x = unit({
    x: direction.y * up.z - direction.z * up.y,
    y: direction.z * up.x - direction.x * up.z,
    z: direction.x * up.y - direction.y * up.x
  });
  const stored = {
    direction: {
      x: tidy(direction.x),
      y: tidy(direction.y),
      z: tidy(direction.z)
    },
    x: { x: tidy(x.x), y: tidy(x.y), z: tidy(x.z) }
  };
  // The plane through the line: its depth along the stored normal, read at
  // the line's model point (the source's sight is square to the normal).
  const [u, v] = line.through;
  const p = {
    x: u * frame.x.x + v * frame.up.x,
    y: u * frame.x.y + v * frame.up.y,
    z: u * frame.x.z + v * frame.up.z
  };
  const d = stored.direction;
  const depth = d.x * p.x + d.y * p.y + d.z * p.z;
  const round = (value: number) => Math.round(value * 10) / 10;
  return {
    viewId: 'dvw_section_preview' as DrawingViewId,
    orientation: source.orientation,
    bodyIds: [...bodyIds],
    centerMm: { x: round(pointer[0]), y: round(pointer[1]) },
    hiddenLines: false,
    section: {
      sourceViewId: source.viewId,
      label: nextDrawingSectionLabel(sheet),
      depth: depth === 0 ? 0 : depth,
      frame: stored
    }
  };
}
