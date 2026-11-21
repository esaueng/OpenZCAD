import { resolveParamValue } from '@openzcad/document-core';
import type { PlaneBasis, Vec3 } from '@openzcad/geometry';
import type { FeatureNode, ProjectDocument } from '@openzcad/shared';

import type { RemusKernel } from './remus-runtime';
import type { ExactShape } from './exact-types';
import { collapseShape } from './exact-boolean-helpers';
import { measureFaceGeometry } from './exact-measure';
import { remusHashOnlyLineage } from './remus-lineage';
import { resolveExtrudeStartOffset } from './extrude-options';
import { throughAllSpan, unionBounds } from './through-all';

type ExtrudeData = Extract<FeatureNode['data'], { featureKind: 'extrude' }>;

/** Why an extrude up to the next face publishes hash-only references. */
export const TO_NEXT_HASH_ONLY_REASON =
  'An extrude up to the next face is the part of a long sweep the target bounds, split out of an exact boolean of regions; Remus publishes no face evolution for that split, so the straight-wall extrude roles do not carry over.';

/**
 * F01 (v130): where an extrude up to the next face runs, at this history
 * position. `direction` is the unit way it leaves the start plane (the
 * sketch normal, reversed by a negative stored distance); `length` is a
 * finite sweep that provably passes every point of the target (its exact
 * bounds' support along `direction`, plus a margin), so whatever stops the
 * extrusion lies inside it.
 */
export interface ToNextReach {
  start: Vec3;
  direction: Vec3;
  length: number;
}

export function toNextReach(
  kernel: RemusKernel,
  document: ProjectDocument,
  data: ExtrudeData,
  basis: PlaneBasis,
  target: ExactShape,
  targetName: string,
  scope: Record<string, number>
): ToNextReach {
  const distance = resolveParamValue(
    data.distance,
    scope,
    'distance',
    document.units
  );
  if (!Number.isFinite(distance) || distance === 0) {
    throw new Error(
      'An extrude up to the next face takes its direction from its distance, which must not be zero.'
    );
  }
  const sign = distance < 0 ? -1 : 1;
  const offset = resolveExtrudeStartOffset(data, scope, document);
  const start = {
    x: basis.origin.x + basis.normal.x * offset,
    y: basis.origin.y + basis.normal.y * offset,
    z: basis.origin.z + basis.normal.z * offset
  };
  const direction = {
    x: basis.normal.x * sign,
    y: basis.normal.y * sign,
    z: basis.normal.z * sign
  };
  let reach: number;
  try {
    reach = throughAllSpan(
      unionBounds(target.solids.map((solid) => kernel.boundingBox(solid))),
      start,
      direction,
      'forward'
    ).forward;
  } catch {
    throw new Error(
      `${targetName} lies entirely behind where the extrusion starts, so there is no next face to reach; reverse the direction.`
    );
  }
  return {
    start,
    direction,
    // Past the far side of the target: a far cap that lands exactly on one
    // of its faces would be a coplanar boolean for nothing.
    length: reach + Math.max(reach * 0.05, 1e-3)
  };
}

/** The blind sweep a to-next extrude cuts its regions from. */
export function toNextSweepFeature(
  feature: FeatureNode,
  data: ExtrudeData,
  reach: ToNextReach,
  sign: 1 | -1
): FeatureNode {
  const {
    endCondition: _endCondition,
    symmetric: _symmetric,
    backDistance: _backDistance,
    ...rest
  } = data;
  return { ...feature, data: { ...rest, distance: sign * reach.length } };
}

/** Whether `solid` has a planar face lying on the plane at `point`. */
function hasFaceOnPlane(
  kernel: RemusKernel,
  solid: number,
  point: Vec3,
  normal: Vec3,
  tolerance: number
): boolean {
  return Array.from(kernel.getSolidFaces(solid)).some((face) => {
    if (kernel.getSurfaceType(face).toLowerCase() !== 'plane') return false;
    const n = kernel.getFaceNormal(face);
    const alignment = Math.abs(
      n[0]! * normal.x + n[1]! * normal.y + n[2]! * normal.z
    );
    if (alignment < 1 - 1e-9) return false;
    const center = measureFaceGeometry(kernel, face)?.center;
    if (!center) return false;
    const height =
      (center.x - point.x) * normal.x +
      (center.y - point.y) * normal.y +
      (center.z - point.z) * normal.z;
    return Math.abs(height) <= tolerance;
  });
}

/**
 * F01 (v130): the part of the long sweep `extrusion` that runs from the
 * start plane up to the next face of `target`.
 *
 * - add: the sweep is cut by the target into regions, and the extrusion is
 *   every region still standing on the start plane: it grows out of the
 *   profile until it meets the target. A region that also reaches the far
 *   end of the sweep passed the target by, so some of the profile has no
 *   next face: refused by name, never trimmed to a guess.
 * - cut: the sweep is intersected with the target into regions, and the cut
 *   removes every region standing on the start plane: material from the
 *   profile down to where it first leaves the target (a cavity, or the far
 *   side). With none, the profile does not start in the target: refused.
 *
 * The regions are exact solids from one exact boolean; nothing is sampled.
 */
export function trimToNext(
  kernel: RemusKernel,
  extrusion: ExactShape,
  target: ExactShape,
  operation: 'add' | 'cut',
  reach: ToNextReach,
  label: string,
  targetName: string
): ExactShape {
  const tool = collapseShape(kernel, extrusion);
  const body = collapseShape(kernel, target);
  const regions = Array.from(
    kernel.getCompoundSolids(
      kernel.booleanRegions(
        operation === 'add' ? 'cut' : 'intersect',
        tool,
        body
      )
    )
  );
  const tolerance = 1e-7 * Math.max(1, reach.length);
  const far = {
    x: reach.start.x + reach.direction.x * reach.length,
    y: reach.start.y + reach.direction.y * reach.length,
    z: reach.start.z + reach.direction.z * reach.length
  };
  // The regions stay owned by the kernel's region compound, which has no
  // release call: they are left to the build's arena, never deleted.
  const kept = regions.filter((region) =>
    hasFaceOnPlane(kernel, region, reach.start, reach.direction, tolerance)
  );
  if (kept.length === 0) {
    throw new Error(
      operation === 'add'
        ? `${label} starts inside ${targetName}, so there is nothing to grow up to its next face; move the sketch out of the body or use a cut.`
        : `${label} does not start in ${targetName}, so there is no material to cut up to its next face; sketch on or inside the body.`
    );
  }
  if (
    kept.some((region) =>
      hasFaceOnPlane(kernel, region, far, reach.direction, tolerance)
    )
  ) {
    throw new Error(
      `${label} does not meet ${targetName} everywhere: part of the profile has no next face of the body ahead of it. Move the profile over the body, or use a distance.`
    );
  }
  return {
    solids: kept,
    lineage: remusHashOnlyLineage('sweep', TO_NEXT_HASH_ONLY_REASON)
  };
}
