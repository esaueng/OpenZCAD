import {
  DRAWING_VIEW_FRAMES,
  nextDrawingSectionLabel,
  type DrawingProjectionAngle,
  type DrawingSheet,
  type DrawingView,
  type Vector3
} from '@openzcad/shared';
import { edgeEndsInPageOrder } from './annotations';
import type { PickableEdge } from './annotationPicking';

/**
 * D03 auxiliary view tool (schema v81): pick a straight edge a principal
 * view draws true length (an inclined face seen edge-on), then a click on
 * one side of it places the view seen square to that edge from that side.
 */

type XY = [number, number];

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
 * Why `hit` cannot make an auxiliary view, or null: it must be a straight
 * edge of a principal (not isometric, section, detail or auxiliary) view,
 * drawn true length and inclined to the view's axes (a horizontal or
 * vertical edge would make a principal view).
 */
export function auxiliaryEdgeRefusal(hit: PickableEdge): string | null {
  const view = hit.view;
  if (
    view.orientation === 'iso' ||
    view.section ||
    view.detail ||
    view.auxiliary
  )
    return 'Pick an edge in a front, top or side view.';
  if (hit.edge.curve?.type !== 'LINE') return 'Pick a straight edge.';
  const ends = edgeEndsInPageOrder(view, hit.edge);
  if (!ends) return 'Pick a straight edge.';
  const du = ends[1][0] - ends[0][0];
  const dv = ends[1][1] - ends[0][1];
  const length = Math.hypot(du, dv);
  if (length < 1e-9) return 'That edge is seen end-on here.';
  if (Math.abs(du) < 1e-6 * length || Math.abs(dv) < 1e-6 * length)
    return 'That edge is horizontal or vertical: a principal view already sees it square.';
  // True length: both ends at one depth.
  const frame = DRAWING_VIEW_FRAMES[view.orientation];
  const p = hit.edge.points;
  const depth = (i: number) =>
    frame.direction.x * p[i]! +
    frame.direction.y * p[i + 1]! +
    frame.direction.z * p[i + 2]!;
  if (Math.abs(depth(0) - depth(p.length - 3)) > 1e-6 * Math.max(1, length))
    return 'That edge slopes into the view; pick one the view draws true length.';
  return null;
}

/**
 * The auxiliary view a click at `pointer` places for the edge `hit`: seen
 * square to the edge, from the side of it the click is on in third angle
 * (the view lies on the side it is seen from), the other in first angle.
 */
export function auxiliaryDraft(
  sheet: Pick<DrawingSheet, 'views'> & {
    projectionAngle: DrawingProjectionAngle;
  },
  hit: PickableEdge,
  pointer: XY
): Omit<DrawingView, 'viewId'> | null {
  const view = hit.view;
  const ends = edgeEndsInPageOrder(view, hit.edge);
  if (!ends) return null;
  const frame = DRAWING_VIEW_FRAMES[view.orientation];
  const du = ends[1][0] - ends[0][0];
  const dv = ends[1][1] - ends[0][1];
  // The edge's normal in the source's page, toward the click's side.
  const first = hit.page[0]!;
  const last = hit.page[hit.page.length - 1]!;
  const middle: XY = [(first[0] + last[0]) / 2, (first[1] + last[1]) / 2];
  let n: XY = [-dv, du];
  if ((pointer[0] - middle[0]) * n[0] + (pointer[1] - middle[1]) * n[1] < 0)
    n = [dv, -du];
  // Third angle: seen from the click's side, so sight runs back toward the
  // edge; first angle looks the other way.
  const sign = sheet.projectionAngle === 'third' ? -1 : 1;
  const direction = unit({
    x: sign * (n[0] * frame.x.x + n[1] * frame.up.x),
    y: sign * (n[0] * frame.x.y + n[1] * frame.up.y),
    z: sign * (n[0] * frame.x.z + n[1] * frame.up.z)
  });
  // Page-up is the source's direction of sight, so page-right is
  // direction × up.
  const up = frame.direction;
  const x = unit({
    x: direction.y * up.z - direction.z * up.y,
    y: direction.z * up.x - direction.x * up.z,
    z: direction.x * up.y - direction.y * up.x
  });
  const round = (value: number) => Math.round(value * 10) / 10;
  return {
    orientation: view.orientation,
    bodyIds: [...view.bodyIds],
    centerMm: { x: round(pointer[0]), y: round(pointer[1]) },
    hiddenLines: false,
    auxiliary: {
      sourceViewId: view.viewId,
      label: nextDrawingSectionLabel(sheet),
      direction: {
        x: tidy(direction.x),
        y: tidy(direction.y),
        z: tidy(direction.z)
      },
      x: { x: tidy(x.x), y: tidy(x.y), z: tidy(x.z) }
    }
  };
}
