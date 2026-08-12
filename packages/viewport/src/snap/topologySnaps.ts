import type { EdgeTopology } from '@openzcad/shared';
import type { SnapCandidate, Vec3 } from './SnapEngine';

/**
 * Snap candidates read off the exact topology the kernel already publishes.
 *
 * What the viewport offers is endpoints and midpoints of the edges, and the
 * centre of any edge that closes on itself, which is what puts a snap at the
 * middle of every hole and boss.
 *
 * Two sources feed those, and they are not equally good:
 *
 * - `EdgeTopology.curve`, the exact circle a circular edge lies on. Where it
 *   is published, a midpoint or centre taken from it is on the real geometry,
 *   not near it. Endpoints are exact from the polyline already.
 * - The display polyline, for everything else. A straight edge's midpoint by
 *   length is exact. A sampled curve's is not: at the app's display deflection
 *   a quarter fillet arc arrives with 28 points, not as the single chord an
 *   earlier version of this note described, so the polyline midpoint sits
 *   about 4e-4 of a radius inside the true arc rather than the 0.29 radii a
 *   two-point chord would give. Small, but it is an error that never has to be
 *   made when the curve record is there.
 *
 * The curve record is optional by design: absent means the kernel would not
 * answer, not that the edge is degenerate. Every use of it below falls back to
 * the polyline, which is what this file did for all edges before.
 *
 * There is a sharper limit worth naming, because it is invisible from the
 * data: a CLOSED edge's polyline does not begin at its vertex. The sampler
 * starts a quarter turn away, so a bore rim's first point is an arbitrary
 * point on the circle rather than the model vertex it looks like. That is why
 * `snapsFromEdges` offers a closed edge only its centre and no endpoints —
 * the skip below is load-bearing, not a simplification. It is also why a
 * closed edge gets no midpoint even now that the exact circle is available:
 * "halfway round from the seam" is halfway round from an arbitrary place.
 */

function pointAt(points: number[], index: number): Vec3 {
  return {
    x: points[index * 3] ?? 0,
    y: points[index * 3 + 1] ?? 0,
    z: points[index * 3 + 2] ?? 0
  };
}

function distance(a: Vec3, b: Vec3): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

function subtract(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}

function dot(a: Vec3, b: Vec3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x
  };
}

function normalized(vector: Vec3): Vec3 | null {
  const length = Math.hypot(vector.x, vector.y, vector.z);
  if (!Number.isFinite(length) || length <= 0) {
    return null;
  }
  return { x: vector.x / length, y: vector.y / length, z: vector.z / length };
}

interface ExactCircle {
  center: Vec3;
  /** Unit normal of the circle's plane. Unoriented — see `EdgeCurve`. */
  axis: Vec3;
  radius: number;
}

/**
 * The exact circle an edge lies on, or null when there is not one to have.
 *
 * `EdgeCurve` publishes `circle` only for `type === 'CIRCLE'` and only after
 * checking it against the edge's own polyline, so this does not re-derive it.
 * What it does do is refuse anything that cannot be used arithmetically — a
 * zero or non-finite radius, an axis with no direction — because a snap point
 * built from a NaN is worse than no snap at all.
 */
function exactCircleOf(edge: EdgeTopology): ExactCircle | null {
  const circle = edge.curve?.type === 'CIRCLE' ? edge.curve.circle : undefined;
  if (!circle) {
    return null;
  }
  const { center, radius } = circle;
  if (!Number.isFinite(radius) || radius <= 0) {
    return null;
  }
  if (
    !Number.isFinite(center.x) ||
    !Number.isFinite(center.y) ||
    !Number.isFinite(center.z)
  ) {
    return null;
  }
  const axis = normalized(circle.axis);
  if (!axis) {
    return null;
  }
  return { center, axis, radius };
}

/**
 * How far off the published circle a polyline endpoint may sit and still be
 * treated as lying on it, as a fraction of the radius.
 *
 * Relative so it means the same thing on a 0.5 mm fillet and a 500 mm bore.
 * Deliberately looser than the 1e-6 misfit the kernel accepts a circle at:
 * this is a guard against a record that is nonsense, not a second opinion on
 * one the kernel already proved.
 */
const CIRCLE_FIT_TOLERANCE = 1e-3;

function liesOnCircle(point: Vec3, circle: ExactCircle): boolean {
  const offset = subtract(point, circle.center);
  const axial = dot(offset, circle.axis);
  const inPlane = {
    x: offset.x - circle.axis.x * axial,
    y: offset.y - circle.axis.y * axial,
    z: offset.z - circle.axis.z * axial
  };
  const radial = Math.hypot(inPlane.x, inPlane.y, inPlane.z);
  const slack = circle.radius * CIRCLE_FIT_TOLERANCE;
  return Math.abs(radial - circle.radius) <= slack && Math.abs(axial) <= slack;
}

/** An angle folded into (-pi, pi], for summing a walk around a circle. */
function wrapToPi(angle: number): number {
  const turn = Math.PI * 2;
  const folded = ((angle + Math.PI) % turn + turn) % turn;
  return folded - Math.PI;
}

/**
 * The point halfway along an arc BY ARC LENGTH, on the exact circle.
 *
 * Which midpoint this is matters, so: it is the point equidistant along the
 * curve from both of the edge's own endpoints. It is NOT the midpoint of the
 * underlying circle's parameter range — `EdgeCurve` publishes no range for
 * exactly this reason, since the kernel's range describes the whole circle and
 * its middle lands on a trimmed arc's end vertex rather than its middle. On a
 * circle, equal arc length is equal angle, so half the arc's swept angle from
 * its start point is the answer, and it is the point a user means by "the
 * middle of this arc".
 *
 * The sweep is accumulated from the polyline rather than guessed from the two
 * endpoints, because the endpoints alone cannot say which way round the edge
 * runs or whether it takes the long way: a 270 degree arc and the 90 degree
 * one it complements share both ends. Summing wrapped step angles answers both
 * at once. It needs consecutive samples less than half a turn apart, which the
 * 0.06 rad angular deflection guarantees with three degrees to spare — a
 * two-point arc is the one case it cannot resolve, and it then reads as the
 * short way round, which is the only defensible reading of two points.
 *
 * The returned point is on the published circle to floating point, by
 * construction rather than by tolerance: it is built as centre plus radius
 * times a unit combination of two in-plane unit vectors.
 */
function exactArcMidpointOf(
  points: number[],
  count: number,
  circle: ExactCircle
): Vec3 | null {
  const start = pointAt(points, 0);
  const end = pointAt(points, count - 1);
  if (!liesOnCircle(start, circle) || !liesOnCircle(end, circle)) {
    return null;
  }
  // Measure angles from the edge's own start point, so a canonically signed
  // axis cannot rotate the frame; only the sweep's sign depends on the axis,
  // and that cancels when the same frame builds the result.
  const radial = subtract(start, circle.center);
  const axial = dot(radial, circle.axis);
  const u = normalized({
    x: radial.x - circle.axis.x * axial,
    y: radial.y - circle.axis.y * axial,
    z: radial.z - circle.axis.z * axial
  });
  if (!u) {
    return null;
  }
  const v = cross(circle.axis, u);
  let previous = 0;
  let sweep = 0;
  for (let index = 1; index < count; index += 1) {
    const offset = subtract(pointAt(points, index), circle.center);
    const angle = Math.atan2(dot(offset, v), dot(offset, u));
    if (!Number.isFinite(angle)) {
      return null;
    }
    sweep += wrapToPi(angle - previous);
    previous = angle;
  }
  if (!Number.isFinite(sweep) || sweep === 0) {
    return null;
  }
  const half = sweep / 2;
  const along = Math.cos(half) * circle.radius;
  const across = Math.sin(half) * circle.radius;
  return {
    x: circle.center.x + u.x * along + v.x * across,
    y: circle.center.y + u.y * along + v.y * across,
    z: circle.center.z + u.z * along + v.z * across
  };
}

/** Tolerance for deciding an edge returns to where it started. */
const CLOSED_TOLERANCE = 1e-6;

/**
 * The point half the polyline's length along it.
 *
 * By length rather than by index, so an unevenly sampled curve does not put
 * its "midpoint" wherever the sampler happened to crowd its points.
 *
 * Exact for a straight edge, and the fallback for a curved one with no
 * published circle. On a curve it is a chord point, so it sits inside the true
 * arc — `exactArcMidpointOf` is preferred wherever it can answer.
 */
function midpointOf(points: number[], count: number): Vec3 | null {
  let total = 0;
  for (let index = 1; index < count; index += 1) {
    total += distance(pointAt(points, index - 1), pointAt(points, index));
  }
  if (total <= 0) {
    return null;
  }
  let travelled = 0;
  for (let index = 1; index < count; index += 1) {
    const from = pointAt(points, index - 1);
    const to = pointAt(points, index);
    const step = distance(from, to);
    if (travelled + step >= total / 2) {
      const along = step > 0 ? (total / 2 - travelled) / step : 0;
      return {
        x: from.x + (to.x - from.x) * along,
        y: from.y + (to.y - from.y) * along,
        z: from.z + (to.z - from.z) * along
      };
    }
    travelled += step;
  }
  return pointAt(points, count - 1);
}

/**
 * The centre of an edge that closes on itself, read off its samples.
 *
 * Averaging is exact for a circle sampled at even angles and close enough for
 * anything else the kernel draws, but it is the fallback: a closed edge with a
 * published circle uses that centre instead, which is right whatever the
 * sampling did. An open edge has no centre worth offering, so it gets none
 * rather than a plausible wrong one.
 */
function closedCenterOf(points: number[], count: number): Vec3 | null {
  const first = pointAt(points, 0);
  const last = pointAt(points, count - 1);
  const closed = distance(first, last) <= CLOSED_TOLERANCE;
  // A closed edge drawn as a triangle is not a shape with a useful centre.
  if (!closed || count < 5) {
    return null;
  }
  let x = 0;
  let y = 0;
  let z = 0;
  // The repeated seam point would weight itself twice.
  const distinct = count - 1;
  for (let index = 0; index < distinct; index += 1) {
    const point = pointAt(points, index);
    x += point.x;
    y += point.y;
    z += point.z;
  }
  return { x: x / distinct, y: y / distinct, z: z / distinct };
}

export interface TopologySnapOptions {
  /** Kinds to offer; omit for all of them. */
  kinds?: readonly SnapCandidate['kind'][];
  label?: string;
}

/** Every snap candidate a body's edges provide. */
export function snapsFromEdges(
  edges: readonly EdgeTopology[],
  options: TopologySnapOptions = {}
): SnapCandidate[] {
  const wanted = options.kinds
    ? new Set<string>(options.kinds)
    : null;
  const allowed = (kind: SnapCandidate['kind']) => !wanted || wanted.has(kind);
  const candidates: SnapCandidate[] = [];
  const seen = new Set<string>();
  const add = (kind: SnapCandidate['kind'], point: Vec3) => {
    if (!allowed(kind)) {
      return;
    }
    // Edges meeting at a vertex each offer it; one glyph there, not three.
    const key = `${kind}:${point.x.toFixed(6)},${point.y.toFixed(6)},${point.z.toFixed(6)}`;
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    candidates.push({ kind, point, label: options.label });
  };

  for (const edge of edges) {
    if (edge.displayRole === 'seam') {
      continue;
    }
    const count = Math.floor(edge.points.length / 3);
    if (count < 2) {
      continue;
    }
    const circle = exactCircleOf(edge);
    const sampledCenter = closedCenterOf(edge.points, count);
    if (sampledCenter) {
      // A closed edge has no ends to speak of, and its midpoint by length is
      // just the point opposite the seam — neither is a place anyone aims at.
      // Which edges are closed is still decided from the polyline: the circle
      // record describes the whole circle either way and cannot tell a rim
      // from the fillet arc lying on the same one.
      add('center', circle ? circle.center : sampledCenter);
      continue;
    }
    add('endpoint', pointAt(edge.points, 0));
    add('endpoint', pointAt(edge.points, count - 1));
    const middle =
      (circle && exactArcMidpointOf(edge.points, count, circle)) ||
      midpointOf(edge.points, count);
    if (middle) {
      add('midpoint', middle);
    }
  }
  return candidates;
}
