import {
  EXTRUDE_TO_FACE_UNRESOLVED,
  TO_FACE_SLANT_COSINE_LIMIT
} from '@openzcad/document-core';
import type { PlaneBasis, Vec3 } from '@openzcad/geometry';
import type { FeatureNode, ProjectDocument, SketchId } from '@openzcad/shared';

import type { RemusKernel } from './remus-runtime';
import type { ExactShape } from './exact-types';
import { buildSweep } from './exact-profile-builders';
import { hasFaceOnPlane } from './extrude-to-next';
import {
  resolveExtrudeDraftDeg,
  resolveExtrudeStartOffset,
  resolveToFaceOffset
} from './extrude-options';
import { remusHashOnlyLineage } from './remus-lineage';

type ExtrudeData = Extract<FeatureNode['data'], { featureKind: 'extrude' }>;

/** Why an extrude up to a slanted face publishes hash-only references. */
export const SLANTED_TO_FACE_HASH_ONLY_REASON =
  'An extrude up to a slanted face is a long sweep split by the face plane; Remus publishes no face evolution for that split, so the straight-wall extrude roles do not carry over.';

const dot = (a: Vec3, b: Vec3) => a.x * b.x + a.y * b.y + a.z * b.z;
const along = (p: Vec3, d: Vec3, t: number): Vec3 => ({
  x: p.x + d.x * t,
  y: p.y + d.y * t,
  z: p.z + d.z * t
});
const sub = (a: Vec3, b: Vec3): Vec3 => ({
  x: a.x - b.x,
  y: a.y - b.y,
  z: a.z - b.z
});

function unresolved(detail: string): Error {
  return new Error(`${EXTRUDE_TO_FACE_UNRESOLVED} ${detail}`);
}

/**
 * F01 (slanted to-face): where an extrude up to a slanted planar face ends.
 * `point`/`normal` are the face plane, already moved by any offset from the
 * face (positive toward the start); `start`/`direction` the start plane and
 * the unit way the extrusion leaves it; `length` a sweep that provably passes
 * the face plane over the whole profile footprint.
 */
export interface SlantedToFace {
  point: Vec3;
  normal: Vec3;
  start: Vec3;
  direction: Vec3;
  length: number;
}

/** The eight corners of a kernel AABB. */
function corners(box: ArrayLike<number>): Vec3[] {
  return [0, 1].flatMap((x) =>
    [0, 1].flatMap((y) =>
      [0, 1].map((z) => ({
        x: box[x * 3]!,
        y: box[y * 3 + 1]!,
        z: box[z * 3 + 2]!
      }))
    )
  );
}

/**
 * The plan for a slanted face: the face plane `frame` (its point and unit
 * normal, as the verified lineage resolved it here), measured against the
 * start plane. The direction is the side the face's own point lies on. The
 * reach over the profile is read from a unit probe sweep's exact bounds:
 * the face plane is linear, so its farthest crossing over the profile's
 * footprint lies at a corner of any box that holds it.
 */
export function planSlantedToFace(
  kernel: RemusKernel,
  document: ProjectDocument,
  feature: FeatureNode,
  data: ExtrudeData,
  frame: { origin: Vec3; zAxis: Vec3 },
  basis: PlaneBasis,
  sketchBases: ReadonlyMap<SketchId, PlaneBasis>,
  scope: Record<string, number>
): { sweep: FeatureNode; slanted: SlantedToFace } {
  const n = basis.normal;
  const m = frame.zAxis;
  const cosine = dot(m, n);
  if (!(Math.abs(cosine) >= TO_FACE_SLANT_COSINE_LIMIT)) {
    throw unresolved(
      'the face is nearly perpendicular to the sketch plane; pick a face that faces the sketch.'
    );
  }
  const start = along(
    basis.origin,
    n,
    resolveExtrudeStartOffset(data, scope, document)
  );
  const {
    endCondition: _endCondition,
    toFace: _toFace,
    toFaceOffset: _toFaceOffset,
    draftAngleDeg: _draftAngleDeg,
    ...rest
  } = data;
  // The profile's footprint on the start plane: a unit probe's exact box
  // corners moved back onto it. The face plane is linear, so where it
  // meets every point of the footprint lies between its values there.
  const probe = buildSweep(
    kernel,
    document,
    { ...feature, data: { ...rest, distance: 1 } },
    scope,
    sketchBases,
    () => {}
  );
  const footprint: Vec3[] = [];
  for (const solid of probe.solids) {
    for (const corner of corners(kernel.boundingBox(solid))) {
      footprint.push(along(corner, n, -dot(sub(corner, start), n)));
    }
    kernel.deleteSolid(solid);
  }
  // Signed along the sketch normal: where the face plane is reached from
  // each footprint corner.
  const crossing = (point: Vec3, base: Vec3) =>
    dot(sub(point, base), m) / dot(n, m);
  const heights = footprint.map((base) => crossing(frame.origin, base));
  // The way to the face is the side the whole footprint reaches it on;
  // where the plane crosses the footprint, the face's middle decides and
  // the split below refuses a plane that crosses the profile itself.
  let sign: 1 | -1;
  if (heights.length > 0 && heights.every((h) => h > 0)) sign = 1;
  else if (heights.length > 0 && heights.every((h) => h < 0)) sign = -1;
  else {
    // Mixed: the plane's height over the middle of the footprint decides
    // (the mean of its box corners); the split refuses a plane that truly
    // crosses the profile.
    const middle = heights.reduce((a, b) => a + b, 0) / heights.length;
    if (!(Math.abs(middle) > 1e-9 * Math.max(1, Math.abs(middle)))) {
      throw unresolved(
        'the slanted face crosses the start plane under the profile, so which way to extrude is unclear.'
      );
    }
    sign = middle < 0 ? -1 : 1;
  }
  const direction = { x: n.x * sign, y: n.y * sign, z: n.z * sign };
  // Toward the start along the face normal: positive offsets stop short.
  const towardStart = dot(m, direction) > 0 ? -1 : 1;
  const offset = resolveToFaceOffset(data, scope, document);
  const point = along(frame.origin, m, towardStart * offset);
  const reach = Math.max(
    0,
    ...footprint.map((base) => sign * crossing(point, base))
  );
  if (!(reach > 0)) {
    throw new Error(
      'The slanted face lies behind where the extrusion starts over the whole profile; move the start or pick another face.'
    );
  }
  // A flaring draft widens the section by tan|draft| per unit of height, and
  // across the footprint the face plane rises at most `slope` per unit, so
  // its walls meet the plane by reach / (1 − slope · tan|draft|): the sweep
  // reaches that, a hair past, and no further for a narrowing draft to close
  // up in. A flare that outruns the face never meets it.
  const draft = resolveExtrudeDraftDeg(data, scope, document);
  const slope =
    Math.sqrt(Math.max(0, 1 - dot(m, n) ** 2)) / Math.abs(dot(m, n));
  const flare = draft < 0 ? Math.tan((-draft * Math.PI) / 180) : 0;
  if (!(slope * flare < 1 - 1e-9)) {
    throw new Error(
      `The draft flares out faster than the slanted face rises, so its walls never meet it; reduce the draft or pick another face.`
    );
  }
  const walls = reach / (1 - slope * flare);
  const length = walls + 1e-4 * Math.max(1, walls);
  const {
    endCondition: _end,
    toFace: _face,
    toFaceOffset: _faceOffset,
    ...kept
  } = data;
  return {
    sweep: { ...feature, data: { ...kept, distance: sign * length } },
    slanted: { point, normal: m, start, direction, length }
  };
}

/**
 * Each long swept solid split by the face plane, keeping the half that
 * stands on the start plane. A plane that crosses the profile where the
 * extrusion starts (both halves stand on it) refuses by name, and so does a
 * kept half that still reaches the far end of the sweep (a flaring draft
 * carried the walls past the face's reach). The halves are exact.
 */
export function trimToSlantedFace(
  kernel: RemusKernel,
  extrusion: ExactShape,
  plan: SlantedToFace,
  label: string
): ExactShape {
  const tolerance = 1e-7 * Math.max(1, plan.length);
  const far = along(plan.start, plan.direction, plan.length);
  const solids = extrusion.solids.map((solid) => {
    let halves: Uint32Array;
    try {
      halves = kernel.split(
        solid,
        plan.point.x,
        plan.point.y,
        plan.point.z,
        plan.normal.x,
        plan.normal.y,
        plan.normal.z
      );
    } catch (error) {
      throw new Error(
        `${label} could not be cut at the slanted face: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error }
      );
    }
    const standing = Array.from(halves).filter((half) =>
      hasFaceOnPlane(kernel, half, plan.start, plan.direction, tolerance)
    );
    if (standing.length !== 1) {
      throw new Error(
        `${label}: the slanted face crosses the profile where the extrusion starts; move the start or pick a face clear of the profile.`
      );
    }
    const kept = standing[0]!;
    if (hasFaceOnPlane(kernel, kept, far, plan.direction, tolerance)) {
      throw new Error(
        `${label} flares past the slanted face before reaching it; reduce the draft.`
      );
    }
    return kept;
  });
  return {
    solids,
    lineage: remusHashOnlyLineage('sweep', SLANTED_TO_FACE_HASH_ONLY_REASON)
  };
}
