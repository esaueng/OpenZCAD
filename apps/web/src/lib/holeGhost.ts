import { holePositionAxes } from './holePositionAxes';

interface Vector3 {
  x: number;
  y: number;
  z: number;
}

/** A hole drawn before it exists: where it enters, which way, how big. */
export interface HoleGhost {
  /** Centre of the bore on the entry face. */
  entry: Vector3;
  /** Unit direction the bore runs into the body (the face normal, reversed). */
  axis: Vector3;
  radius: number;
  depth: number;
}

export interface HoleGhostInput {
  face: { normal?: Vector3; centroid?: Vector3; center: Vector3 };
  /** Which point (u, v) is measured from — see the builder's `positionAnchor`. */
  anchor: 'centroid' | 'center';
  u: number;
  v: number;
  diameter: number;
  /** A blind depth, or 'through' to run to the far side of the body. */
  depth: number | 'through';
  /** The target body's mesh positions (x, y, z triples), for a through hole. */
  bodyPositions: ArrayLike<number>;
}

/**
 * Where the Hole card's current values would drill, computed the way the
 * kernel-adapter's hole builder computes it (same face frame, same anchor,
 * and a through hole running to the farthest point of the body along the
 * bore). The card's U and V used to be numbers with no picture: a −40 that
 * missed a 60 mm plate was found out only when the exact check refused it.
 *
 * Null when the values cannot place a hole yet; a ghost that ends up wholly
 * outside the body is still returned, because seeing it miss is the point.
 */
export function holeGhost(input: HoleGhostInput): HoleGhost | null {
  const { face } = input;
  if (!face.normal) return null;
  const axes = holePositionAxes(face.normal);
  if (!axes) return null;
  const anchor =
    input.anchor === 'centroid' ? (face.centroid ?? null) : face.center;
  if (!anchor) return null;
  if (
    !Number.isFinite(input.u) ||
    !Number.isFinite(input.v) ||
    !(input.diameter > 0)
  ) {
    return null;
  }
  const length = Math.hypot(face.normal.x, face.normal.y, face.normal.z);
  const axis = {
    x: -face.normal.x / length,
    y: -face.normal.y / length,
    z: -face.normal.z / length
  };
  const entry = {
    x: anchor.x + axes.u.x * input.u + axes.v.x * input.v,
    y: anchor.y + axes.u.y * input.u + axes.v.y * input.v,
    z: anchor.z + axes.u.z * input.u + axes.v.z * input.v
  };
  let depth: number;
  if (input.depth === 'through') {
    depth = 0;
    const positions = input.bodyPositions;
    for (let index = 0; index + 2 < positions.length; index += 3) {
      const reach =
        (positions[index]! - entry.x) * axis.x +
        (positions[index + 1]! - entry.y) * axis.y +
        (positions[index + 2]! - entry.z) * axis.z;
      if (reach > depth) depth = reach;
    }
  } else {
    depth = input.depth;
  }
  if (!(depth > 0)) return null;
  return { entry, axis, radius: input.diameter / 2, depth };
}
