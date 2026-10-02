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
  /**
   * The entry face's measured geometry; null when the picked face is no
   * longer on the target body.
   */
  face: { normal?: Vector3; centroid?: Vector3; center?: Vector3 } | null;
  /** Which point (u, v) is measured from — see the builder's `positionAnchor`. */
  anchor: 'centroid' | 'center';
  u: number;
  v: number;
  diameter: number;
  /**
   * The widest tool the hole cuts with: the counterbore or countersink
   * diameter when the style has one, else the bore's. Null when it does not
   * resolve, which only withholds the miss notice.
   */
  outerDiameter: number | null;
  /** A blind depth, or 'through' to run to the far side of the body. */
  depth: number | 'through';
  /** The target body's mesh positions (x, y, z triples). */
  bodyPositions: ArrayLike<number>;
}

/**
 * What the viewport draws for the Hole card and what the card says about it.
 * `notice` is set whenever there is no ghost, so the bore never just fails to
 * appear, and also beside a ghost that clearly misses the body.
 */
export interface HolePreview {
  ghost: HoleGhost | null;
  notice: string | null;
}

/** Said beside a ghost that cannot touch the body; Create would refuse it. */
export const HOLE_MISSES_NOTICE =
  'This position misses the body — the bore removes no material here, so Create will refuse it.';

function noPreview(reason: string): HolePreview {
  return { ghost: null, notice: `No preview — ${reason}` };
}

function bounds(
  positions: ArrayLike<number>
): { min: Vector3; max: Vector3 } | null {
  if (positions.length < 3) return null;
  const min = { x: Infinity, y: Infinity, z: Infinity };
  const max = { x: -Infinity, y: -Infinity, z: -Infinity };
  for (let index = 0; index + 2 < positions.length; index += 3) {
    const x = positions[index]!;
    const y = positions[index + 1]!;
    const z = positions[index + 2]!;
    if (x < min.x) min.x = x;
    if (y < min.y) min.y = y;
    if (z < min.z) min.z = z;
    if (x > max.x) max.x = x;
    if (y > max.y) max.y = y;
    if (z > max.z) max.z = z;
  }
  return { min, max };
}

/**
 * Whether a bore of `radius`, run along `axis` from `start` for `length`,
 * lies wholly outside the box grown by `margin`. A sufficient test only: it
 * never calls a hole that cuts a miss, and stays silent on a miss the box
 * cannot see (a bore through a bracket's empty inside corner). The exact
 * check after Create still has the last word.
 */
function boreClearOfBox(
  start: Vector3,
  axis: Vector3,
  length: number,
  radius: number,
  box: { min: Vector3; max: Vector3 },
  margin: number
): boolean {
  const end = {
    x: start.x + axis.x * length,
    y: start.y + axis.y * length,
    z: start.z + axis.z * length
  };
  return (['x', 'y', 'z'] as const).some((key) => {
    // A disc of `radius` normal to `axis` reaches r·√(1 − a²) along a world axis.
    const reach = radius * Math.sqrt(Math.max(0, 1 - axis[key] ** 2));
    const low = Math.min(start[key], end[key]) - reach;
    const high = Math.max(start[key], end[key]) + reach;
    return high < box.min[key] - margin || low > box.max[key] + margin;
  });
}

/**
 * Where the Hole card's current values would drill, computed the way the
 * kernel-adapter's hole builder computes it (`buildHoleFeature` in
 * `exact-feature-builders.ts`): the same face frame, the same anchor, and a
 * through hole run to the farthest corner of the body's bounding box along
 * the bore. The card's U and V used to be numbers with no picture: a −40
 * that missed a 60 mm plate was found out only when the exact check refused
 * it.
 *
 * When no ghost can be drawn, the notice says why in the builder's own words.
 * A ghost wholly outside the body is still drawn, because seeing it miss is
 * the point, and it carries a notice too. Nothing here decides what Create
 * builds; the exact kernel check does.
 */
export function holePreview(input: HoleGhostInput): HolePreview {
  const { face } = input;
  if (!face) {
    return noPreview(
      'the entry face is no longer on this body. Pick the face again.'
    );
  }
  if (!face.normal) {
    return noPreview(
      'a hole needs a planar entry face with an analytic normal.'
    );
  }
  const axes = holePositionAxes(face.normal);
  if (!axes) {
    return noPreview('the entry face normal is degenerate.');
  }
  if (input.anchor === 'centroid' && !face.centroid) {
    return noPreview(
      'the entry face no longer reports an area centroid, and this hole is positioned from one.'
    );
  }
  const anchor = input.anchor === 'centroid' ? face.centroid : face.center;
  if (!anchor) {
    return noPreview('the entry face reports no centre to measure from.');
  }
  // The form refuses these before they reach here; a caller that does not
  // still gets a sentence rather than a cylinder of NaNs.
  if (!Number.isFinite(input.u) || !Number.isFinite(input.v)) {
    return noPreview('the position must resolve to finite numbers.');
  }
  if (!(input.diameter > 0) || !Number.isFinite(input.diameter)) {
    return noPreview('the hole diameter must be greater than zero.');
  }
  const box = bounds(input.bodyPositions);
  if (!box) {
    // The body's mesh has not arrived: nothing to say yet.
    return { ghost: null, notice: null };
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
    // The builder's rule, corner for corner, so "points away" agrees with it.
    depth = 0;
    for (const x of [box.min.x, box.max.x]) {
      for (const y of [box.min.y, box.max.y]) {
        for (const z of [box.min.z, box.max.z]) {
          const reach =
            (x - entry.x) * axis.x +
            (y - entry.y) * axis.y +
            (z - entry.z) * axis.z;
          if (reach > depth) depth = reach;
        }
      }
    }
    if (!(depth > 0)) {
      return noPreview('the hole points away from the body.');
    }
  } else {
    depth = input.depth;
    if (!(depth > 0) || !Number.isFinite(depth)) {
      return noPreview('the hole depth must be greater than zero.');
    }
  }
  const ghost = { entry, axis, radius: input.diameter / 2, depth };
  if (input.outerDiameter === null) {
    return { ghost, notice: null };
  }
  // The builder starts its tools a little above the face and, through,
  // overshoots the far side; grow the tested bore by the same overshoot.
  const overshoot = Math.max(depth * 0.02, input.diameter * 0.01);
  // A mesh's box can sit inside the exact one by the chord height on a
  // curved extreme; one percent of the diagonal keeps the notice honest.
  const margin =
    0.01 *
    Math.hypot(
      box.max.x - box.min.x,
      box.max.y - box.min.y,
      box.max.z - box.min.z
    );
  const start = {
    x: entry.x - axis.x * overshoot,
    y: entry.y - axis.y * overshoot,
    z: entry.z - axis.z * overshoot
  };
  const misses = boreClearOfBox(
    start,
    axis,
    depth + 2 * overshoot,
    Math.max(input.diameter, input.outerDiameter) / 2,
    box,
    margin
  );
  return { ghost, notice: misses ? HOLE_MISSES_NOTICE : null };
}
