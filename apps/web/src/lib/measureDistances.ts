import type { Vector3 } from '@openzcad/shared';

/*
 * M13: maximum, central and parallel distances between analytic entities,
 * in closed form. Each answer comes with the two points that realise it, so
 * the viewport can draw the span it measured. Anything without an exact
 * closed form here (an arc, a circle against a circle, a curved face) is
 * refused with a reason rather than estimated.
 */

/** What a pick is, geometrically, for these distances. */
export type MeasureEntity =
  | { type: 'point'; point: Vector3 }
  | { type: 'segment'; start: Vector3; end: Vector3 }
  | {
      type: 'circle';
      center: Vector3;
      axis: Vector3;
      radius: number;
      /** A full circle (a closed rim), not an arc. */
      closed: boolean;
    }
  | { type: 'plane'; point: Vector3; normal: Vector3 }
  | {
      type: 'cylinder';
      /** A point on the axis and its unit direction. */
      origin: Vector3;
      axis: Vector3;
      radius: number;
    };

export interface DistanceAnswer {
  value: number;
  from: Vector3;
  to: Vector3;
  /** What the figure is, when the entity pair decides it ("radial difference"). */
  note?: string;
}

export type DistanceRefusal = { refused: string };

/** Angles (as sines) and lengths below which two entities count as aligned. */
const PARALLEL_SINE = 1e-9;
const COINCIDENT = 1e-9;

const sub = (a: Vector3, b: Vector3): Vector3 => ({
  x: a.x - b.x,
  y: a.y - b.y,
  z: a.z - b.z
});
const add = (a: Vector3, b: Vector3): Vector3 => ({
  x: a.x + b.x,
  y: a.y + b.y,
  z: a.z + b.z
});
const scale = (a: Vector3, s: number): Vector3 => ({
  x: a.x * s,
  y: a.y * s,
  z: a.z * s
});
const dot = (a: Vector3, b: Vector3) => a.x * b.x + a.y * b.y + a.z * b.z;
const cross = (a: Vector3, b: Vector3): Vector3 => ({
  x: a.y * b.z - a.z * b.y,
  y: a.z * b.x - a.x * b.z,
  z: a.x * b.y - a.y * b.x
});
const length = (a: Vector3) => Math.hypot(a.x, a.y, a.z);
const unit = (a: Vector3): Vector3 | null => {
  const l = length(a);
  return l > 0 ? scale(a, 1 / l) : null;
};
const distance = (a: Vector3, b: Vector3) => length(sub(a, b));

/** A line through `origin` along unit `axis`: the foot of `point` on it. */
function footOnLine(point: Vector3, origin: Vector3, axis: Vector3): Vector3 {
  return add(origin, scale(axis, dot(sub(point, origin), axis)));
}

/** An entity's axis line, if it has one: a segment, a circle or cylinder. */
function lineOf(
  entity: MeasureEntity
): { origin: Vector3; axis: Vector3 } | null {
  switch (entity.type) {
    case 'segment': {
      const axis = unit(sub(entity.end, entity.start));
      return axis ? { origin: entity.start, axis } : null;
    }
    case 'circle':
      return { origin: entity.center, axis: entity.axis };
    case 'cylinder':
      return { origin: entity.origin, axis: entity.axis };
    default:
      return null;
  }
}

const parallel = (a: Vector3, b: Vector3) =>
  length(cross(a, b)) <= PARALLEL_SINE;

/**
 * The parallel distance between two entities: two parallel lines (edges or
 * axes), two parallel planes, a line parallel to a plane, or the radial
 * difference of two concentric circles or cylinders.
 */
export function parallelDistance(
  first: MeasureEntity,
  second: MeasureEntity,
  size: number
): DistanceAnswer | DistanceRefusal {
  const radial = (e: MeasureEntity) =>
    e.type === 'circle' || e.type === 'cylinder' ? e : null;
  const a = radial(first);
  const b = radial(second);
  if (a && b && parallel(a.axis, b.axis)) {
    const originA = a.type === 'circle' ? a.center : a.origin;
    const originB = b.type === 'circle' ? b.center : b.origin;
    const offAxis = distance(originB, footOnLine(originB, originA, a.axis));
    if (offAxis <= COINCIDENT * Math.max(1, size)) {
      // Concentric: the radial difference, measured along one radius, each
      // end on its own rim (a circle's plane, or level with the other pick
      // on a cylinder).
      const radius = perpendicular(a.axis);
      const atA =
        a.type === 'circle' ? a.center : footOnLine(originB, originA, a.axis);
      const atB =
        b.type === 'circle' ? b.center : footOnLine(atA, originB, b.axis);
      return {
        value: Math.abs(a.radius - b.radius),
        from: add(atA, scale(radius, a.radius)),
        to: add(atB, scale(radius, b.radius)),
        note: 'radial difference'
      };
    }
  }
  const planeA = first.type === 'plane' ? first : null;
  const planeB = second.type === 'plane' ? second : null;
  if (planeA && planeB) {
    if (!parallel(planeA.normal, planeB.normal))
      return { refused: 'Those faces are not parallel.' };
    const gap = dot(sub(planeB.point, planeA.point), planeA.normal);
    return {
      value: Math.abs(gap),
      from: planeA.point,
      to: sub(planeA.point, scale(planeA.normal, -gap))
    };
  }
  const plane = planeA ?? planeB;
  const other = planeA ? second : first;
  if (plane) {
    const line = lineOf(other);
    if (!line || Math.abs(dot(line.axis, plane.normal)) > PARALLEL_SINE)
      return {
        refused: 'That edge or axis is not parallel to the face.'
      };
    const gap = dot(sub(line.origin, plane.point), plane.normal);
    const from = line.origin;
    const to = sub(from, scale(plane.normal, gap));
    return planeA
      ? { value: Math.abs(gap), from: to, to: from }
      : { value: Math.abs(gap), from, to };
  }
  const lineA = lineOf(first);
  const lineB = lineOf(second);
  if (!lineA || !lineB)
    return {
      refused:
        'Parallel distance takes two edges, faces or axes, or two circles or cylinders.'
    };
  if (!parallel(lineA.axis, lineB.axis))
    return { refused: 'Those edges or axes are not parallel.' };
  const to = lineB.origin;
  const from = footOnLine(to, lineA.origin, lineA.axis);
  return { value: distance(from, to), from, to };
}

/** Any unit vector square to `axis`. */
function perpendicular(axis: Vector3): Vector3 {
  const helper =
    Math.abs(axis.x) < 0.9 ? { x: 1, y: 0, z: 0 } : { x: 0, y: 1, z: 0 };
  return unit(cross(axis, helper))!;
}

/**
 * The central distance from a centre or axis: from a circle's centre, or
 * square from a cylinder's axis, to the other pick's point (`toward`). The
 * centre or axis is whichever pick has one, the first when both do.
 */
export function centralDistance(
  first: MeasureEntity,
  firstPoint: Vector3,
  second: MeasureEntity,
  secondPoint: Vector3
): DistanceAnswer | DistanceRefusal {
  const centred = (e: MeasureEntity) =>
    e.type === 'circle' || e.type === 'cylinder';
  const [source, point] = centred(first)
    ? [first, secondPoint]
    : centred(second)
      ? [second, firstPoint]
      : [null, null];
  if (!source || !point)
    return {
      refused:
        'Central distance needs a circle, arc, cylinder or hole to measure from.'
    };
  if (source.type === 'circle')
    return {
      value: distance(source.center, point),
      from: source.center,
      to: point
    };
  if (source.type !== 'cylinder') throw new Error('unreachable');
  const foot = footOnLine(point, source.origin, source.axis);
  return {
    value: distance(foot, point),
    from: foot,
    to: point,
    note: 'from axis'
  };
}

/** The farthest point of a full circle from `point`, and its distance. */
function farthestOnCircle(
  point: Vector3,
  circle: Extract<MeasureEntity, { type: 'circle' }>
): { at: Vector3; value: number } {
  const offset = sub(point, circle.center);
  const radial = sub(offset, scale(circle.axis, dot(offset, circle.axis)));
  // On the axis every rim point is equally far: any radius will do. "On"
  // is relative, so projection roundoff on a far point cannot pick a
  // direction that leaves the circle's plane.
  const onAxis =
    length(radial) <= COINCIDENT * Math.max(1, length(offset), circle.radius);
  const away = onAxis ? perpendicular(circle.axis) : unit(radial)!;
  const at = sub(circle.center, scale(away, circle.radius));
  return { at, value: distance(point, at) };
}

/** The points a maximum over `entity` is reached at (it is convex). */
function extremes(entity: MeasureEntity): Vector3[] | null {
  switch (entity.type) {
    case 'point':
      return [entity.point];
    case 'segment':
      return [entity.start, entity.end];
    default:
      return null;
  }
}

/**
 * The maximum distance between two entities: points, straight edges and
 * full circles. Over a segment the farthest distance from a point, or from
 * a circle, is convex along it, so it is reached at an end; from a point to
 * a full circle it is √(h² + (ρ + r)²), at the rim point opposite the point.
 */
export function maximumDistance(
  first: MeasureEntity,
  second: MeasureEntity
): DistanceAnswer | DistanceRefusal {
  const refuse = (e: MeasureEntity): string | null =>
    e.type === 'circle' && !e.closed
      ? 'Maximum distance to an arc needs the kernel; pick a full circle, an edge or a point.'
      : e.type === 'plane' || e.type === 'cylinder'
        ? 'Maximum distance takes points, straight edges and full circles, not faces.'
        : null;
  const problem = refuse(first) ?? refuse(second);
  if (problem) return { refused: problem };
  const a = extremes(first);
  const b = extremes(second);
  if (!a && !b)
    return {
      refused:
        'Maximum distance between two circles needs the kernel; pick a point or straight edge for one.'
    };
  let best: DistanceAnswer | null = null;
  const consider = (from: Vector3, to: Vector3, value = distance(from, to)) => {
    if (!best || value > best.value) best = { value, from, to };
  };
  if (a && b) {
    for (const from of a) for (const to of b) consider(from, to);
  } else {
    const points = (a ?? b)!;
    const circle = (a ? second : first) as Extract<
      MeasureEntity,
      { type: 'circle' }
    >;
    for (const point of points) {
      const far = farthestOnCircle(point, circle);
      if (a) consider(point, far.at, far.value);
      else consider(far.at, point, far.value);
    }
  }
  return best!;
}
