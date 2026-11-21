import { resolveParamValue } from '@openzcad/document-core';
import type { PlaneBasis, Vec3 } from '@openzcad/geometry';
import type { FeatureNode, ProjectDocument } from '@openzcad/shared';

import type { RemusKernel } from './remus-runtime';
import type { ExactShape } from './exact-types';
import { collapseShape } from './exact-boolean-helpers';
import { measureFaceGeometry } from './exact-measure';
import { MEASUREMENT_DEFLECTION } from './exact-witnesses';
import { GEOMETRY_LINEAR_TOLERANCE } from '@openzcad/geometry';
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

/**
 * Whether the start caps `kept` are the sweep's own `profile` caps: the same
 * edge count, the same exact area, and the same vertex bounds within the
 * kernel's linear tolerance (a strip far thinner than the area allowance
 * still moves a corner).
 */
export function sameStartCaps(
  kernel: RemusKernel,
  kept: readonly number[],
  profile: readonly number[]
): boolean {
  const measure = (faces: readonly number[]) => {
    const lo = [Infinity, Infinity, Infinity];
    const hi = [-Infinity, -Infinity, -Infinity];
    for (const face of faces) {
      for (const vertex of Array.from(kernel.getFaceVertices(face))) {
        const p = kernel.getVertexPosition(vertex);
        for (let axis = 0; axis < 3; axis += 1) {
          lo[axis] = Math.min(lo[axis]!, p[axis]!);
          hi[axis] = Math.max(hi[axis]!, p[axis]!);
        }
      }
    }
    return {
      area: faces.reduce(
        (sum, face) => sum + kernel.faceArea(face, MEASUREMENT_DEFLECTION),
        0
      ),
      edges: faces.reduce(
        (sum, face) => sum + kernel.getFaceEdges(face).length,
        0
      ),
      bounds: [...lo, ...hi]
    };
  };
  const a = measure(kept);
  const b = measure(profile);
  return (
    a.edges === b.edges &&
    Math.abs(a.area - b.area) <= 1e-9 * Math.max(1e-12, b.area) &&
    a.bounds.every(
      (value, index) =>
        Math.abs(value - b.bounds[index]!) <= GEOMETRY_LINEAR_TOLERANCE
    )
  );
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
  let regions: number[];
  try {
    regions = Array.from(
      kernel.getCompoundSolids(
        kernel.booleanRegions(
          operation === 'add' ? 'cut' : 'intersect',
          tool,
          body
        )
      )
    );
  } catch (error) {
    throw new Error(
      `${label} could not be split against ${targetName} exactly: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error }
    );
  }
  const tolerance = 1e-7 * Math.max(1, reach.length);
  // The start plane itself, tightly: a face a thin ledge below it is not a
  // start cap.
  const startTolerance = 1e-9 * Math.max(1, reach.length);
  const far = {
    x: reach.start.x + reach.direction.x * reach.length,
    y: reach.start.y + reach.direction.y * reach.length,
    z: reach.start.z + reach.direction.z * reach.length
  };
  // The regions stay owned by the kernel's region compound, which has no
  // release call: they are left to the build's arena, never deleted.
  const kept = regions.filter((region) =>
    hasFaceOnPlane(kernel, region, reach.start, reach.direction, startTolerance)
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
  // start plane are the sweep's own start face, by exact area and by edge
  // count (a notch or a hole under part of the profile changes one or both).
  const capsOf = (solids: readonly number[]) =>
    solids.flatMap((solid) =>
      facesOnPlane(kernel, solid, reach.start, reach.direction, startTolerance)
    );
  if (!sameStartCaps(kernel, capsOf(kept), capsOf([tool]))) {
    throw new Error(
      operation === 'add'
        ? `${label} starts partly inside ${targetName}; keep the whole profile outside the body to grow it up to the next face.`
        : `${label} starts partly outside ${targetName}; keep the whole profile on or inside the body to cut it down to the next face.`
    );
  }
  if (operation === 'cut') {
    // Each corner of the profile must start in the body or on its face,
    // within the kernel's own linear tolerance: a start a gap off the body
    // is no start in it.
    const outside = capsOf([tool])
      .flatMap((face) => Array.from(kernel.getFaceVertices(face)))
      .some((vertex) => {
        const p = kernel.getVertexPosition(vertex);
        return (
          kernel.classifyPoint(
            body,
            p[0]!,
            p[1]!,
            p[2]!,
            GEOMETRY_LINEAR_TOLERANCE
          ) === 'outside'
        );
      });
    if (outside) {
      throw new Error(
        `${label} does not start in ${targetName}: the profile lies off the body's face; sketch on or inside the body.`
      );
    }
  }
  // Exactly one stretch per line of travel: every face of a kept region but
  // its start caps faces forward along the extrusion, or runs along it. A
  // region that wraps round a cavity, a vent or a post the profile only
  // partly meets has a face turned back against the travel there (the far
  // side of what it wrapped), so it is refused by name, never run on past
  // the next face. Faces this cannot judge exactly are refused too.
  for (const region of kept) {
    const caps = new Set(
      facesOnPlane(kernel, region, reach.start, reach.direction, startTolerance)
    );
    for (const face of Array.from(kernel.getSolidFaces(region))) {
      if (caps.has(face)) continue;
      const surface = kernel.getSurfaceType(face).toLowerCase();
      if (surface === 'plane') {
        const n = kernel.getFaceNormal(face);
        const facing =
          n[0]! * reach.direction.x +
          n[1]! * reach.direction.y +
          n[2]! * reach.direction.z;
        if (facing < -1e-9) {
          throw new Error(
            `${label} does not meet one next face of ${targetName} everywhere: under part of the profile the ${operation === 'add' ? 'body stands in the way and the extrusion would run on beside it' : 'body opens into a cavity and the cut would run on beside it'}. Keep the profile over one face, or use a distance.`
          );
        }
        continue;
      }
      if (surface === 'cylinder') {
        const geometry = measureFaceGeometry(kernel, face);
        if (geometry?.axisStart && geometry.axisEnd) {
          const axis = {
            x: geometry.axisEnd.x - geometry.axisStart.x,
            y: geometry.axisEnd.y - geometry.axisStart.y,
            z: geometry.axisEnd.z - geometry.axisStart.z
          };
          const size = Math.hypot(axis.x, axis.y, axis.z);
          if (
            size > 0 &&
            Math.abs(
              axis.x * reach.direction.x +
                axis.y * reach.direction.y +
                axis.z * reach.direction.z
            ) /
              size >=
              1 - 1e-9
          ) {
            continue;
          }
        }
      }
      throw new Error(
        `${label} meets a curved face of ${targetName} on the way; up to next stops on flat faces for now. Use a distance, or a face.`
      );
    }
  }
  return {
    solids: kept,
    lineage: remusHashOnlyLineage('sweep', TO_NEXT_HASH_ONLY_REASON)
  };
}
