import { resolveParamValue } from '@openzcad/document-core';
import type { PlaneBasis, Vec3 } from '@openzcad/geometry';
import type { FeatureNode, ProjectDocument } from '@openzcad/shared';

import type { RemusKernel } from './remus-runtime';
import type { ExactShape } from './exact-types';
import { collapseShape } from './exact-boolean-helpers';
import { measureFaceGeometry } from './exact-measure';
import { MEASUREMENT_DEFLECTION } from './exact-witnesses';
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
export function hasFaceOnPlane(
  kernel: RemusKernel,
  solid: number,
  point: Vec3,
  normal: Vec3,
  tolerance: number
): boolean {
  return facesOnPlane(kernel, solid, point, normal, tolerance).length > 0;
}

/** The planar faces of `solid` lying on the plane at `point`. */
function facesOnPlane(
  kernel: RemusKernel,
  solid: number,
  point: Vec3,
  normal: Vec3,
  tolerance: number
): number[] {
  return Array.from(kernel.getSolidFaces(solid)).filter((face) => {
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
 * The box behind an air pocket along the extrusion: the pocket's world box,
 * from just past its far side to the sweep's far end. Null when the pocket
 * already reaches the far end. For a direction off the axes the world box
 * is conservative, which can only refuse more, never cut more.
 */
function shadowBox(
  kernel: RemusKernel,
  box: ArrayLike<number>,
  reach: ToNextReach,
  far: Vec3
): number | null {
  const d = reach.direction;
  const lo = { x: box[0]!, y: box[1]!, z: box[2]! };
  const hi = { x: box[3]!, y: box[4]!, z: box[5]! };
  const margin = 1e-6 * Math.max(1, reach.length);
  const min = { ...lo };
  const max = { ...hi };
  for (const axis of ['x', 'y', 'z'] as const) {
    const component = d[axis];
    if (Math.abs(component) < 1e-12) continue;
    if (component > 0) {
      min[axis] = hi[axis] + margin;
      max[axis] = Math.max(hi[axis], far[axis]) + margin;
    } else {
      max[axis] = lo[axis] - margin;
      min[axis] = Math.min(lo[axis], far[axis]) - margin;
    }
  }
  const size = { x: max.x - min.x, y: max.y - min.y, z: max.z - min.z };
  if (!(size.x > margin && size.y > margin && size.z > margin)) return null;
  const solid = kernel.makeBox(size.x, size.y, size.z);
  kernel.transformSolid(
    solid,
    Float64Array.of(1, 0, 0, min.x, 0, 1, 0, min.y, 0, 0, 1, min.z, 0, 0, 0, 1)
  );
  return solid;
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
  // The whole profile starts on one side: the kept regions' faces on the
  // start plane cover all of the sweep's own start face, exactly.
  const area = (solids: readonly number[]) =>
    solids.reduce(
      (sum, solid) =>
        sum +
        facesOnPlane(kernel, solid, reach.start, reach.direction, tolerance)
          .map((face) => kernel.faceArea(face, MEASUREMENT_DEFLECTION))
          .reduce((a, b) => a + b, 0),
      0
    );
  const profileArea = area([tool]);
  if (
    !(Math.abs(area(kept) - profileArea) <= 1e-6 * Math.max(1e-9, profileArea))
  ) {
    throw new Error(
      operation === 'add'
        ? `${label} starts partly inside ${targetName}; keep the whole profile outside the body to grow it up to the next face.`
        : `${label} starts partly outside ${targetName}; keep the whole profile on or inside the body to cut it down to the next face.`
    );
  }
  if (operation === 'cut') {
    // Each corner of the profile must start in the body or on its face: a
    // start the slightest gap off the body is no start in it.
    const touch = 1e-9 * Math.max(1, reach.length);
    const outside = facesOnPlane(
      kernel,
      tool,
      reach.start,
      reach.direction,
      tolerance
    )
      .flatMap((face) => Array.from(kernel.getFaceVertices(face)))
      .some((vertex) => {
        const p = kernel.getVertexPosition(vertex);
        return (
          kernel.classifyPoint(body, p[0]!, p[1]!, p[2]!, touch) === 'outside'
        );
      });
    if (outside) {
      throw new Error(
        `${label} does not start in ${targetName}: the profile lies off the body's face; sketch on or inside the body.`
      );
    }
    // A pocket of air inside the sweep with kept material beyond it means
    // some of the profile left the body there and some did not: there is
    // no one next face, so the cut is refused rather than run on past it.
    const air = Array.from(
      kernel.getCompoundSolids(kernel.booleanRegions('cut', tool, body))
    ).filter(
      (region) =>
        !hasFaceOnPlane(kernel, region, reach.start, reach.direction, tolerance)
    );
    for (const pocket of air) {
      const beyond = shadowBox(kernel, kernel.boundingBox(pocket), reach, far);
      if (beyond === null) continue;
      const shared = kept.some((region) => {
        let common: number;
        try {
          common = kernel.intersect(region, beyond);
        } catch {
          // Nothing shared: the kernel refuses an empty common.
          return false;
        }
        return (
          kernel.volume(common, MEASUREMENT_DEFLECTION) >
          1e-9 * Math.max(1, profileArea * reach.length)
        );
      });
      kernel.deleteSolid(beyond);
      if (shared) {
        throw new Error(
          `${label} does not leave ${targetName} at one next face: under part of the profile the body opens into a cavity, and beside it the cut would run on. Sketch over the cavity alone, or use a distance.`
        );
      }
    }
  }
  return {
    solids: kept,
    lineage: remusHashOnlyLineage('sweep', TO_NEXT_HASH_ONLY_REASON)
  };
}
