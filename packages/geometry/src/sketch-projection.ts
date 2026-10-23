import type { EdgeTopology, SketchObjectData } from '@openzcad/shared';
import type { PlaneBasis, Vec3 } from './index';

/**
 * I01 sketch projection: one model edge, orthographically projected along
 * the sketch normal into sketch coordinates, as the sketch object that draws
 * it exactly.
 *
 * Pure and kernel-free so the browser (projecting a pick from the published
 * topology) and the exact build (re-projecting a linked edge at the sketch's
 * history position from kernel handles) produce the same object from the
 * same curve. Only exact curves project: a straight edge becomes a line; a
 * circle or arc becomes a circle or arc when its plane is parallel to the
 * sketch and an ellipse or elliptical arc otherwise. Anything else, and any
 * edge that collapses (a line along the normal, a circle seen edge-on), is
 * refused by name rather than approximated.
 */

/** One model edge's exact curve in world coordinates. */
export type ProjectableEdgeCurve =
  | { kind: 'line'; start: Vec3; end: Vec3 }
  | {
      kind: 'circle';
      center: Vec3;
      /** Unit normal of the circle's plane; its sign does not matter. */
      axis: Vec3;
      radius: number;
      /**
       * Absent for a full circle. For an arc, its two ends and any point
       * strictly inside it, which says which of the two arcs the ends bound.
       */
      arc?: { start: Vec3; end: Vec3; inside: Vec3 };
    }
  | {
      /** A curve kind no projection exists for yet, named for the refusal. */
      kind: 'unsupported';
      curveType: string;
    };

export type SketchProjectionGeometry = Extract<
  SketchObjectData,
  { objectKind: 'line' | 'arc' | 'circle' | 'ellipse' }
>;

export type SketchProjectionOutcome =
  | { status: 'projected'; data: SketchProjectionGeometry }
  | { status: 'refused'; reason: string };

/** Below this cosine a circle's plane is treated as edge-on to the sketch. */
const EDGE_ON_COSINE = 1e-6;
/** Above this cosine a circle's plane is treated as parallel to the sketch. */
const PARALLEL_COSINE = 1 - 1e-12;
/** Relative length below which a projected line has collapsed to a point. */
const COLLAPSED_RELATIVE = 1e-9;

const sub = (a: Vec3, b: Vec3): Vec3 => ({
  x: a.x - b.x,
  y: a.y - b.y,
  z: a.z - b.z
});
const dot = (a: Vec3, b: Vec3): number => a.x * b.x + a.y * b.y + a.z * b.z;
const cross = (a: Vec3, b: Vec3): Vec3 => ({
  x: a.y * b.z - a.z * b.y,
  y: a.z * b.x - a.x * b.z,
  z: a.x * b.y - a.y * b.x
});
const length = (a: Vec3): number => Math.hypot(a.x, a.y, a.z);

function finiteVec(value: Vec3): boolean {
  return (
    Number.isFinite(value.x) &&
    Number.isFinite(value.y) &&
    Number.isFinite(value.z)
  );
}

/** Folds -0 into 0 so a stored projection never carries a signed zero. */
function clean(value: number): number {
  return value === 0 ? 0 : value;
}

/** A world point in sketch coordinates, dropping its height off the plane. */
export function projectPointToSketch(
  basis: PlaneBasis,
  point: Vec3
): { x: number; y: number } {
  const offset = sub(point, basis.origin);
  return { x: clean(dot(offset, basis.u)), y: clean(dot(offset, basis.v)) };
}

const RAD_TO_DEG = 180 / Math.PI;

/** The counter-clockwise sweep from `from` to `to`, in [0, 360). */
function ccwSweep(from: number, to: number): number {
  return (((to - from) % 360) + 360) % 360;
}

/**
 * The counter-clockwise range (in degrees) from one end to the other that
 * contains `inside`. Edge direction never decides it, so the result does not
 * change when a rebuild reverses the edge.
 */
function ccwRange(
  startDeg: number,
  endDeg: number,
  insideDeg: number
): [number, number] {
  return ccwSweep(startDeg, insideDeg) <= ccwSweep(startDeg, endDeg)
    ? [startDeg, endDeg]
    : [endDeg, startDeg];
}

/** Project one exact edge curve onto the sketch plane. */
export function projectEdgeToSketch(
  curve: ProjectableEdgeCurve,
  basis: PlaneBasis
): SketchProjectionOutcome {
  const refuse = (reason: string): SketchProjectionOutcome => ({
    status: 'refused',
    reason
  });
  if (curve.kind === 'unsupported') {
    return refuse(
      `a ${curve.curveType.toLowerCase()} edge cannot be projected; only straight and circular edges project exactly.`
    );
  }
  if (curve.kind === 'line') {
    if (!finiteVec(curve.start) || !finiteVec(curve.end)) {
      return refuse('the edge has a non-finite end.');
    }
    const start = projectPointToSketch(basis, curve.start);
    const end = projectPointToSketch(basis, curve.end);
    const span = length(sub(curve.end, curve.start));
    if (
      Math.hypot(end.x - start.x, end.y - start.y) <=
      Math.max(span, 1) * COLLAPSED_RELATIVE
    ) {
      return refuse(
        'the edge runs along the sketch normal, so it projects to a point.'
      );
    }
    return {
      status: 'projected',
      data: {
        objectKind: 'line',
        x1: start.x,
        y1: start.y,
        x2: end.x,
        y2: end.y
      }
    };
  }
  const { radius } = curve;
  const axisLength = length(curve.axis);
  if (
    !finiteVec(curve.center) ||
    !finiteVec(curve.axis) ||
    !(radius > 0) ||
    !Number.isFinite(radius) ||
    !(axisLength > 0)
  ) {
    return refuse('the circular edge has no finite centre, axis or radius.');
  }
  const axis = {
    x: curve.axis.x / axisLength,
    y: curve.axis.y / axisLength,
    z: curve.axis.z / axisLength
  };
  const cosine = Math.abs(dot(axis, basis.normal));
  if (cosine < EDGE_ON_COSINE) {
    return refuse(
      'the circular edge is seen edge-on from the sketch plane, so it projects to a line.'
    );
  }
  const center = projectPointToSketch(basis, curve.center);
  const angleAbout = (
    point: Vec3,
    toParameter: (dx: number, dy: number) => number
  ) => {
    const local = projectPointToSketch(basis, point);
    return toParameter(local.x - center.x, local.y - center.y);
  };
  if (cosine >= PARALLEL_COSINE) {
    if (!curve.arc) {
      return {
        status: 'projected',
        data: {
          objectKind: 'circle',
          centerX: center.x,
          centerY: center.y,
          radius
        }
      };
    }
    const polar = (dx: number, dy: number) => Math.atan2(dy, dx) * RAD_TO_DEG;
    const [startAngleDeg, endAngleDeg] = ccwRange(
      angleAbout(curve.arc.start, polar),
      angleAbout(curve.arc.end, polar),
      angleAbout(curve.arc.inside, polar)
    );
    return {
      status: 'projected',
      data: {
        objectKind: 'arc',
        centerX: center.x,
        centerY: center.y,
        radius,
        startAngleDeg: clean(startAngleDeg),
        endAngleDeg: clean(endAngleDeg)
      }
    };
  }
  // A tilted circle: its in-plane diameter (along axis × normal) keeps the
  // full radius and is the major axis; the perpendicular one shrinks by the
  // cosine between the two planes. The eccentric anomaly of the projected
  // ellipse is the circle's own angle, so arc ends map without fitting.
  const majorWorld = cross(axis, basis.normal);
  const majorLength = length(majorWorld);
  // Either direction along the major axis draws the same ellipse; the one
  // within a quarter turn of +u is kept, so the stored rotation does not
  // depend on which way the circle's axis happened to point.
  const sense =
    dot(majorWorld, basis.u) < 0 ||
    (dot(majorWorld, basis.u) === 0 && dot(majorWorld, basis.v) < 0)
      ? -1
      : 1;
  const major = {
    x: (sense * dot(majorWorld, basis.u)) / majorLength,
    y: (sense * dot(majorWorld, basis.v)) / majorLength
  };
  const rotationDeg = clean(Math.atan2(major.y, major.x) * RAD_TO_DEG);
  const minorRadius = radius * cosine;
  // `minor` is `major` turned a quarter counter-clockwise, as the sketch
  // ellipse defines its own axes.
  const eccentric = (dx: number, dy: number) =>
    Math.atan2(
      (-major.y * dx + major.x * dy) / minorRadius,
      (major.x * dx + major.y * dy) / radius
    ) * RAD_TO_DEG;
  const ellipse = {
    objectKind: 'ellipse' as const,
    centerX: center.x,
    centerY: center.y,
    radiusX: radius,
    radiusY: minorRadius,
    rotationDeg
  };
  if (!curve.arc) {
    return { status: 'projected', data: ellipse };
  }
  const [startParamDeg, endParamDeg] = ccwRange(
    angleAbout(curve.arc.start, eccentric),
    angleAbout(curve.arc.end, eccentric),
    angleAbout(curve.arc.inside, eccentric)
  );
  return {
    status: 'projected',
    data: {
      ...ellipse,
      startParamDeg: clean(startParamDeg),
      endParamDeg: clean(endParamDeg)
    }
  };
}

/** Absolute agreement, in document units or degrees, for "unchanged". */
export const SKETCH_PROJECTION_TOLERANCE = 1e-6;

function near(a: unknown, b: unknown): boolean {
  return (
    typeof a === 'number' &&
    typeof b === 'number' &&
    Math.abs(a - b) <= SKETCH_PROJECTION_TOLERANCE
  );
}

function nearAngle(a: unknown, b: unknown): boolean {
  if (typeof a !== 'number' || typeof b !== 'number') return false;
  const turn = ccwSweep(b, a);
  return Math.min(turn, 360 - turn) <= SKETCH_PROJECTION_TOLERANCE;
}

/**
 * Whether stored projection geometry already matches a fresh projection, so
 * a rebuild leaves it alone. Stored values are literal numbers; an
 * expression (never written by projection) never matches.
 */
export function sameProjectedGeometry(
  stored: SketchObjectData,
  fresh: SketchProjectionGeometry
): boolean {
  if (stored.objectKind !== fresh.objectKind) return false;
  switch (fresh.objectKind) {
    case 'line': {
      const line = stored as typeof fresh;
      return (
        near(line.x1, fresh.x1) &&
        near(line.y1, fresh.y1) &&
        near(line.x2, fresh.x2) &&
        near(line.y2, fresh.y2)
      );
    }
    case 'circle': {
      const circle = stored as typeof fresh;
      return (
        near(circle.centerX, fresh.centerX) &&
        near(circle.centerY, fresh.centerY) &&
        near(circle.radius, fresh.radius)
      );
    }
    case 'arc': {
      const arc = stored as typeof fresh;
      return (
        near(arc.centerX, fresh.centerX) &&
        near(arc.centerY, fresh.centerY) &&
        near(arc.radius, fresh.radius) &&
        nearAngle(arc.startAngleDeg, fresh.startAngleDeg) &&
        nearAngle(arc.endAngleDeg, fresh.endAngleDeg)
      );
    }
    case 'ellipse': {
      const ellipse = stored as typeof fresh;
      const ranged = fresh.startParamDeg !== undefined;
      return (
        near(ellipse.centerX, fresh.centerX) &&
        near(ellipse.centerY, fresh.centerY) &&
        near(ellipse.radiusX, fresh.radiusX) &&
        near(ellipse.radiusY, fresh.radiusY) &&
        nearAngle(ellipse.rotationDeg, fresh.rotationDeg) &&
        (ellipse.startParamDeg !== undefined) === ranged &&
        (!ranged ||
          (nearAngle(ellipse.startParamDeg, fresh.startParamDeg) &&
            nearAngle(ellipse.endParamDeg, fresh.endParamDeg)))
      );
    }
  }
}

/**
 * A fresh line projection oriented like the stored line it replaces: when
 * the edge's ends came back in the other order (a rebuild may reverse an
 * edge), the ends swap back so `start` and `end` keep naming the same end
 * for every relation that holds them. Other kinds have no end order.
 */
export function orientLikeStored(
  stored: SketchObjectData,
  fresh: SketchProjectionGeometry
): SketchProjectionGeometry {
  if (fresh.objectKind !== 'line' || stored.objectKind !== 'line') {
    return fresh;
  }
  const number = (value: unknown) => (typeof value === 'number' ? value : NaN);
  const [x1, y1, x2, y2] = [
    number(stored.x1),
    number(stored.y1),
    number(stored.x2),
    number(stored.y2)
  ];
  const [a1, b1, a2, b2] = [
    number(fresh.x1),
    number(fresh.y1),
    number(fresh.x2),
    number(fresh.y2)
  ];
  const kept = Math.hypot(a1 - x1, b1 - y1) + Math.hypot(a2 - x2, b2 - y2);
  const swapped = Math.hypot(a2 - x1, b2 - y1) + Math.hypot(a1 - x2, b1 - y2);
  return swapped < kept
    ? { ...fresh, x1: fresh.x2, y1: fresh.y2, x2: fresh.x1, y2: fresh.y1 }
    : fresh;
}

/**
 * A published topology edge's exact curve, for projecting a pick: the
 * polyline's ends are the edge's vertices, and an arc's middle sample says
 * which side of its ends it runs. A circle is used only where the adapter
 * proved one (`curve.circle`); any other kind is named for the refusal.
 */
export function projectableCurveFromTopology(
  edge: Pick<EdgeTopology, 'curve' | 'points' | 'vertexIds'>
): ProjectableEdgeCurve {
  const { points } = edge;
  const count = Math.floor(points.length / 3);
  const at = (index: number): Vec3 => ({
    x: points[index * 3] ?? Number.NaN,
    y: points[index * 3 + 1] ?? Number.NaN,
    z: points[index * 3 + 2] ?? Number.NaN
  });
  const type = edge.curve?.type ?? 'unknown';
  if (count < 2) {
    return { kind: 'unsupported', curveType: type };
  }
  const start = at(0);
  const end = at(count - 1);
  if (type === 'LINE') {
    return { kind: 'line', start, end };
  }
  const circle = edge.curve?.circle;
  if (type !== 'CIRCLE' || !circle) {
    return {
      kind: 'unsupported',
      curveType: type === 'CIRCLE' ? 'unproven circle' : type
    };
  }
  const closed =
    edge.vertexIds !== undefined
      ? edge.vertexIds[0] === edge.vertexIds[1]
      : length(sub(start, end)) <= circle.radius * 1e-9;
  if (closed) {
    return { kind: 'circle', ...circle };
  }
  if (count < 3) {
    return {
      kind: 'unsupported',
      curveType: 'circular arc without an interior sample'
    };
  }
  return {
    kind: 'circle',
    ...circle,
    arc: { start, end, inside: at(Math.floor((count - 1) / 2)) }
  };
}
