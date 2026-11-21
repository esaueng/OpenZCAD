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
  const height = dot(sub(frame.origin, start), n);
  if (!(Math.abs(height) > 1e-9 * Math.max(1, Math.abs(height)))) {
    throw unresolved(
      'the middle of the slanted face lies on the start plane, so which way to extrude is unclear.'
    );
  }
  const sign = height < 0 ? -1 : 1;
  const direction = { x: n.x * sign, y: n.y * sign, z: n.z * sign };
  // Toward the start along the face normal: positive offsets stop short.
  const towardStart = dot(m, direction) > 0 ? -1 : 1;
  const offset = resolveToFaceOffset(data, scope, document);
  const point = along(frame.origin, m, towardStart * offset);
  const {
    endCondition: _endCondition,
    toFace: _toFace,
    toFaceOffset: _toFaceOffset,
    draftAngleDeg: _draftAngleDeg,
    ...rest
  } = data;
  const probe = buildSweep(
    kernel,
    document,
    { ...feature, data: { ...rest, distance: sign } },
    scope,
    sketchBases,
    () => {}
  );
  const md = dot(m, direction);
  let reach = 0;
  for (const solid of probe.solids) {
    for (const corner of corners(kernel.boundingBox(solid))) {
      // The corner moved back onto the start plane, then along the
      // direction until it meets the face plane.
      const base = along(
        corner,
        direction,
        -dot(sub(corner, start), direction)
      );
      reach = Math.max(reach, dot(sub(point, base), m) / md);
    }
    kernel.deleteSolid(solid);
  }
  if (!(reach > 0)) {
    throw new Error(
      'The slanted face lies behind where the extrusion starts over the whole profile; move the start or pick another face.'
    );
  }
  const length = reach * 1.02 + 1e-3 * Math.max(1, reach);
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
