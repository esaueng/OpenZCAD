import type { Vector3 } from '@openzcad/shared';

/**
 * Angle measurement, with the convention named rather than assumed.
 *
 * "The angle between these two faces" is three different numbers, and a CAD
 * viewer that reports one of them without saying which is not measuring, it is
 * guessing on the reader's behalf. A 30 degree wedge has faces whose outward
 * normals are 150 degrees apart and whose material meets at 30; both are
 * correct answers to differently-worded questions.
 *
 * Before this module the app answered none of them. `createAngleMeasurement`
 * took `Math.abs` of the dot product and then clamped the result to a
 * non-negative range, folding every angle into 0-90: a 135 degree pair read
 * 45, and no wedge over square could be measured at all.
 *
 * The fix is not simply to drop the `Math.abs`, because it is doing real work
 * for one of the two inputs:
 *
 *  - A planar face's normal is DIRECTED. It points out of the material, so the
 *    sign carries meaning and the honest range is 0-180.
 *  - A straight edge's direction is NOT. It comes from the order the kernel
 *    happened to traverse the curve, so flipping that order would flip a
 *    signed answer. Two edges in isolation therefore only support the acute
 *    angle between their lines, 0-90 — which is what a drawing means by the
 *    angle between two lines that do not meet.
 *
 * The exception is two edges that DO meet. Once a shared endpoint is known,
 * both edges can be oriented away from it and the included angle at that
 * corner is well defined over the full 0-180 — which is the number someone
 * measuring a dovetail or a chamfered corner is actually after.
 */

export type AngleConvention =
  /** Between two directed face normals. 0-180. */
  | 'between-normals'
  /** The material angle where two faces meet: 180 minus the normals. 0-180. */
  | 'dihedral'
  /** At the corner two edges share, both oriented away from it. 0-180. */
  | 'included'
  /** Between two undirected lines that do not meet. 0-90. */
  | 'acute'
  /** Between a line and the plane it crosses. 0-90. */
  | 'line-to-plane';

export interface AngleMeasurement {
  degrees: number;
  convention: AngleConvention;
}

/** How each convention reads in a row label and in exported data. */
export const ANGLE_CONVENTION_LABELS: Record<AngleConvention, string> = {
  'between-normals': 'between normals',
  dihedral: 'dihedral',
  included: 'included',
  acute: 'between lines',
  'line-to-plane': 'line to plane'
};

const DEGREES = 180 / Math.PI;

/** Endpoints are welded at the ADR-011 quantum, the same one meshes use. */
const SHARED_VERTEX_TOLERANCE = 1e-6;

export function normalize(direction: Vector3): Vector3 | null {
  const magnitude = Math.hypot(direction.x, direction.y, direction.z);
  if (!Number.isFinite(magnitude) || magnitude <= 1e-12) {
    return null;
  }
  return {
    x: direction.x / magnitude,
    y: direction.y / magnitude,
    z: direction.z / magnitude
  };
}

export function dot(first: Vector3, second: Vector3): number {
  return first.x * second.x + first.y * second.y + first.z * second.z;
}

function subtract(from: Vector3, to: Vector3): Vector3 {
  return { x: from.x - to.x, y: from.y - to.y, z: from.z - to.z };
}

function samePoint(first: Vector3, second: Vector3): boolean {
  return (
    Math.abs(first.x - second.x) <= SHARED_VERTEX_TOLERANCE &&
    Math.abs(first.y - second.y) <= SHARED_VERTEX_TOLERANCE &&
    Math.abs(first.z - second.z) <= SHARED_VERTEX_TOLERANCE
  );
}

/**
 * Angle between two directed vectors over the full 0-180.
 *
 * The dot product is clamped to [-1, 1] before `acos` because floating-point
 * error on two unit vectors can put it a few ulps outside, where `acos`
 * returns NaN — a silent hole exactly at the parallel and antiparallel cases,
 * which are the two a person is most likely to measure deliberately.
 */
export function angleBetweenDirections(
  first: Vector3,
  second: Vector3
): number | null {
  const a = normalize(first);
  const b = normalize(second);
  if (!a || !b) {
    return null;
  }
  return Math.acos(Math.min(1, Math.max(-1, dot(a, b)))) * DEGREES;
}

/** The acute angle between two undirected lines. 0-90. */
export function acuteAngleBetweenLines(
  first: Vector3,
  second: Vector3
): number | null {
  const a = normalize(first);
  const b = normalize(second);
  if (!a || !b) {
    return null;
  }
  return Math.acos(Math.min(1, Math.abs(dot(a, b)))) * DEGREES;
}

/**
 * The angle between two planar faces, from their outward normals.
 *
 * Defaults to the dihedral — the angle of the material itself — because that
 * is what someone measuring a bend, a wedge, or a countersink means. The
 * between-normals figure is the supplement and stays available by name.
 */
export function angleBetweenFaces(
  firstNormal: Vector3,
  secondNormal: Vector3,
  convention: 'dihedral' | 'between-normals' = 'dihedral'
): AngleMeasurement | null {
  const between = angleBetweenDirections(firstNormal, secondNormal);
  if (between === null) {
    return null;
  }
  return convention === 'between-normals'
    ? { degrees: between, convention: 'between-normals' }
    : { degrees: 180 - between, convention: 'dihedral' };
}

/** The angle a line makes with a plane, from the plane's normal. 0-90. */
export function angleBetweenLineAndPlane(
  lineDirection: Vector3,
  planeNormal: Vector3
): AngleMeasurement | null {
  const toNormal = acuteAngleBetweenLines(lineDirection, planeNormal);
  if (toNormal === null) {
    return null;
  }
  return { degrees: 90 - toNormal, convention: 'line-to-plane' };
}

/**
 * The angle between two straight edges.
 *
 * When endpoints are supplied and the edges meet, both are oriented away from
 * the shared corner and the included angle is reported over 0-180. Otherwise
 * only the acute angle between the two lines is defensible, because an edge's
 * stored direction follows the kernel's traversal order rather than anything
 * about the geometry.
 */
export function angleBetweenEdges(
  first: { direction: Vector3; endpoints?: readonly [Vector3, Vector3] },
  second: { direction: Vector3; endpoints?: readonly [Vector3, Vector3] }
): AngleMeasurement | null {
  const corner = sharedEndpoint(first.endpoints, second.endpoints);
  if (corner) {
    const included = angleBetweenDirections(
      subtract(corner.firstFar, corner.point),
      subtract(corner.secondFar, corner.point)
    );
    if (included !== null) {
      return { degrees: included, convention: 'included' };
    }
  }
  const acute = acuteAngleBetweenLines(first.direction, second.direction);
  return acute === null ? null : { degrees: acute, convention: 'acute' };
}

function sharedEndpoint(
  first: readonly [Vector3, Vector3] | undefined,
  second: readonly [Vector3, Vector3] | undefined
): { point: Vector3; firstFar: Vector3; secondFar: Vector3 } | null {
  if (!first || !second) {
    return null;
  }
  for (const a of [0, 1] as const) {
    for (const b of [0, 1] as const) {
      if (samePoint(first[a], second[b])) {
        return {
          point: first[a],
          firstFar: first[a === 0 ? 1 : 0],
          secondFar: second[b === 0 ? 1 : 0]
        };
      }
    }
  }
  return null;
}
