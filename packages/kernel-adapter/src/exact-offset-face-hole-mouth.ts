/**
 * A face offset must carry the chamfer of a hole in the face, not stretch it.
 *
 * Issue #1595. The kernel's general face move keeps every neighbouring
 * surface where it is and re-intersects it with the moved plane. For the
 * cone of a chamfer (or countersink) on a hole in the moved face that is the
 * wrong answer: the cone stays put, so its rim on the face grows by the
 * offset times the tangent of the cone's half angle. A 0.5 mm chamfer under
 * a +4 mm offset becomes a 4.5 mm one, the hole's mouth spreads across the
 * face and can leave its outline, and the kernel still validates the result
 * as a clean solid, so it used to be committed. The kernel already carries
 * such a chamfer when the face also touches a fillet; the chamfer-only case
 * is esaueng/remus#1799.
 *
 * Until the pinned kernel carries it, this is the adapter's guard. Before
 * the move it records every hole-mouth rim of the face: a circle on one of
 * the face's inner loops whose other face is a cone about the face normal.
 * After the move each of those rims must still be there, on the moved
 * plane, about the same axis and at the same radius. A result that stretched
 * one is refused, typed, and nothing is committed.
 *
 * The kernel catches some of these itself, as prose: a rim stretched past
 * the face's outline ("inner loop leaves the outer loop"), far enough to
 * turn the shell inside out, or, pulled inward, a face that runs into the
 * hole's own wall. On a face with a hole-mouth rim those read as the same
 * typed refusal, with the kernel's words kept as the detail.
 *
 * Only inner loops are read. A cone on the face's OUTER loop is the body's
 * own flank (the end of a conical or drafted part), and extending it to the
 * moved face is what an offset of that face means there; a chamfered rod end
 * has its own exact paths (`exact-chamfered-cylinder.ts`,
 * `exact-local-chamfer-cap.ts`).
 */
import type { Vec3 } from '@openzcad/geometry';

import { analyticSurfaceRecord } from './exact-brep';
import {
  ANALYTIC_MATCH_EPSILON,
  dot,
  finiteVec3,
  length,
  normalized,
  scale,
  subtract
} from './exact-math';
import { OffsetFaceRefusal } from './exact-offset-face-refusal';
import { KernelRefusal } from './kernel-refusal';
import { surfaceTypeOf } from './exact-sync-memo';
import type { RemusKernel } from './remus-runtime';

/** The adapter's code for this refusal; the kernel has none. */
export const OFFSET_FACE_HOLE_CHAMFER_NOT_CARRIED =
  'offset_face_hole_chamfer_not_carried';

/** The rim of a chamfered or countersunk hole on the face being moved. */
export interface HoleMouthRim {
  /** A point on the cone's axis. */
  axisPoint: Vec3;
  /** The cone's axis, unit length; parallel to the face normal. */
  axis: Vec3;
  /** The rim's radius on the face. */
  radius: number;
}

/** Lengths compare at the analytic match tolerance, scaled by size. */
const lengthTolerance = (size: number) =>
  Math.max(1, Math.abs(size)) * ANALYTIC_MATCH_EPSILON;

/** Distance from `point` to the line through `axisPoint` along `axis`. */
function radialDistance(point: Vec3, axisPoint: Vec3, axis: Vec3): number {
  const offset = subtract(point, axisPoint);
  return length(subtract(offset, scale(axis, dot(offset, axis))));
}

/** A cone face's axis as a line, when it runs along `normal`. */
function coneAxisAlong(
  kernel: RemusKernel,
  face: number,
  normal: Vec3
): { axisPoint: Vec3; axis: Vec3 } | null {
  if (surfaceTypeOf(kernel, face) !== 'cone') return null;
  const record = analyticSurfaceRecord(kernel, face);
  const axisPoint = finiteVec3(record?.apex);
  const rawAxis = finiteVec3(record?.axis);
  const axis = rawAxis ? normalized(rawAxis) : null;
  if (!axisPoint || !axis) return null;
  return Math.abs(Math.abs(dot(axis, normal)) - 1) <= ANALYTIC_MATCH_EPSILON
    ? { axisPoint, axis }
    : null;
}

function edgeStart(kernel: RemusKernel, edge: number): Vec3 | null {
  const vertices = kernel.getEdgeVertices(edge);
  return finiteVec3([vertices[0], vertices[1], vertices[2]]);
}

function edgeEnds(kernel: RemusKernel, edge: number): Vec3[] {
  const vertices = kernel.getEdgeVertices(edge);
  return [
    finiteVec3([vertices[0], vertices[1], vertices[2]]),
    finiteVec3([vertices[3], vertices[4], vertices[5]])
  ].filter((point): point is Vec3 => point !== null);
}

/** The solid's cone faces about `normal`, each with the edges that bound it. */
function coaxialCones(kernel: RemusKernel, solid: number, normal: Vec3) {
  const cones: { axisPoint: Vec3; axis: Vec3; edges: Set<number> }[] = [];
  for (const face of kernel.getSolidFaces(solid)) {
    const cone = coneAxisAlong(kernel, face, normal);
    if (cone)
      cones.push({ ...cone, edges: new Set(kernel.getFaceEdges(face)) });
  }
  return cones;
}

/**
 * Every hole-mouth rim of `face`: one entry per cone and radius, however
 * many arcs the kernel split the circle into. Empty for a face with no
 * holes, which is every call but the ones this guard exists for. `normal`
 * is the face's current outward normal.
 */
export function holeMouthRims(
  kernel: RemusKernel,
  solid: number,
  face: number,
  normal: Vec3
): HoleMouthRim[] {
  const outer = kernel.getFaceOuterWire(face);
  const inner = Array.from(kernel.getFaceWires(face)).filter(
    (wire) => wire !== outer
  );
  if (inner.length === 0) return [];
  const circles = inner.flatMap((wire) =>
    Array.from(kernel.getWireEdges(wire)).filter(
      (edge) => kernel.getEdgeCurveType(edge) === 'CIRCLE'
    )
  );
  if (circles.length === 0) return [];
  const cones = coaxialCones(kernel, solid, normal);
  const rims: HoleMouthRim[] = [];
  for (const edge of circles) {
    const cone = cones.find((candidate) => candidate.edges.has(edge));
    const start = cone ? edgeStart(kernel, edge) : null;
    if (!cone || !start) continue;
    // A hole's mouth runs from the face into the body; a tapered boss
    // standing on the face rises out of it, and moving the face up its
    // flank is a correct result. Only a cone wholly behind the face counts.
    // Both ends of every edge: a pocket that runs to its apex has only the
    // rim and a seam, and the seam may start on the rim.
    const depths = [...cone.edges].flatMap((other) =>
      edgeEnds(kernel, other).map((point) =>
        dot(subtract(point, start), normal)
      )
    );
    const tolerance = lengthTolerance(
      radialDistance(start, cone.axisPoint, cone.axis)
    );
    if (
      !depths.some((depth) => depth < -tolerance) ||
      depths.some((depth) => depth > tolerance)
    )
      continue;
    const radius = radialDistance(start, cone.axisPoint, cone.axis);
    const known = rims.some(
      (rim) =>
        Math.abs(rim.radius - radius) <= lengthTolerance(radius) &&
        radialDistance(rim.axisPoint, cone.axisPoint, cone.axis) <=
          lengthTolerance(radius)
    );
    if (!known)
      rims.push({ axisPoint: cone.axisPoint, axis: cone.axis, radius });
  }
  return rims;
}

/**
 * Whether `output` still has every recorded rim: a circle on the plane
 * through `planePoint` across `normal`, bounding a cone about the rim's own
 * axis, at the rim's radius.
 */
export function holeMouthRimsCarried(
  kernel: RemusKernel,
  output: number,
  rims: readonly HoleMouthRim[],
  planePoint: Vec3,
  normal: Vec3
): boolean {
  if (rims.length === 0) return true;
  const cones = coaxialCones(kernel, output, normal);
  return rims.every((rim) => {
    const tolerance = lengthTolerance(rim.radius);
    return cones.some(
      (cone) =>
        radialDistance(cone.axisPoint, rim.axisPoint, rim.axis) <= tolerance &&
        [...cone.edges].some((edge) => {
          if (kernel.getEdgeCurveType(edge) !== 'CIRCLE') return false;
          const start = edgeStart(kernel, edge);
          return (
            start !== null &&
            Math.abs(dot(subtract(start, planePoint), normal)) <= tolerance &&
            Math.abs(
              radialDistance(start, rim.axisPoint, rim.axis) - rim.radius
            ) <= tolerance
          );
        })
    );
  });
}

/**
 * The typed refusal of a face offset that did not carry a hole's chamfer.
 * `cause` is the kernel's own refusal when it caught the result itself.
 */
export function holeChamferNotCarriedRefusal(
  offset: number,
  cause?: Error
): OffsetFaceRefusal {
  const reason =
    'This face has a chamfered or countersunk hole, and offsetting the face cannot move that chamfer with it yet. Remove the chamfer, offset the face, then chamfer the hole again.';
  const detail =
    cause?.message ??
    `Offsetting the face by ${offset} left a hole-mouth cone in place and re-cut its rim on the moved face, so the rim radius changed.`;
  return new OffsetFaceRefusal({
    family: 'direct-edit',
    category: 'unsupported',
    kernelCode: OFFSET_FACE_HOLE_CHAMFER_NOT_CARRIED,
    kernelMessage: detail,
    reason,
    message: `${reason}\n${detail}`,
    ...(cause ? { cause } : {})
  });
}

/**
 * The same refusal for a move the kernel refused on its own account, or
 * null when the face has no hole-mouth rim or the kernel's reason is not one
 * a cone left in place produces.
 */
export function holeChamferRefusalOf(
  error: unknown,
  rims: readonly HoleMouthRim[],
  offset: number
): OffsetFaceRefusal | null {
  if (
    rims.length === 0 ||
    !(error instanceof Error) ||
    error instanceof KernelRefusal
  ) {
    return null;
  }
  // What the pinned kernel's general move says when a hole-mouth cone it
  // left in place breaks the result. Read only on a face that has such a
  // rim, and only to choose the sentence: a message this does not match
  // keeps the generic typed refusal, so a change of wording costs clarity,
  // never safety. Recorded in `test/kernel-prose-matching.test.ts`.
  return /inner loop \d+ leaves the outer loop|outer shell is inside out|swept face reaches nonadjacent face/i.test(
    error.message
  )
    ? holeChamferNotCarriedRefusal(offset, error)
    : null;
}
