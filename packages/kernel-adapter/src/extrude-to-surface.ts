import {
  EXTRUDE_TO_FACE_UNRESOLVED,
  listFeaturesInOrder,
  resolveParamValue
} from '@openzcad/document-core';
import type { PlaneBasis, Vec3 } from '@openzcad/geometry';
import type { FeatureNode, ProjectDocument, SketchId } from '@openzcad/shared';

import type { RemusKernel } from './remus-runtime';
import type { ExactBuildResult, ExactShape } from './exact-types';
import {
  bodyName,
  faceAttachmentCandidatesForShape
} from './exact-shape-utils';
import { resolveRevolutionFace } from './face-attachment';
import { measureFaceGeometry } from './exact-measure';
import { hasFaceOnPlane } from './extrude-to-next';
import {
  resolveExtrudeStartOffset,
  resolveToFaceOffset
} from './extrude-options';
import { throughAllSpan, unionBounds } from './through-all';
import { remusHashOnlyLineage } from './remus-lineage';
import { buildSweep } from './exact-profile-builders';

type ExtrudeData = Extract<FeatureNode['data'], { featureKind: 'extrude' }>;

/** Why an extrude up to a curved face publishes hash-only references. */
export const CURVED_TO_FACE_HASH_ONLY_REASON =
  'An extrude up to a curved face is the part of a long sweep on the near side of the face’s cylinder, split out by an exact boolean of regions; Remus publishes no face evolution for that split, so the straight-wall extrude roles do not carry over.';

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
const unit = (a: Vec3): Vec3 => {
  const size = Math.hypot(a.x, a.y, a.z) || 1;
  return { x: a.x / size, y: a.y / size, z: a.z / size };
};

function unresolved(detail: string): Error {
  return new Error(`${EXTRUDE_TO_FACE_UNRESOLVED} ${detail}`);
}

/**
 * F01 (v131): where an extrude up to a cylindrical face ends: the face's
 * cylinder (its axis and radius, the radius already moved by any offset
 * from the face, positive toward the start), which side of it the profile
 * starts on, and the long sweep (start plane, unit direction, length) that
 * provably passes the face's body.
 */
export interface CurvedToFace {
  axisPoint: Vec3;
  axis: Vec3;
  radius: number;
  inside: boolean;
  start: Vec3;
  direction: Vec3;
  length: number;
}

/** Distance from `point` to the line through `p` along unit `a`. */
function fromAxis(point: Vec3, p: Vec3, a: Vec3): number {
  const offset = sub(point, p);
  const radial = along(offset, a, -dot(offset, a));
  return Math.hypot(radial.x, radial.y, radial.z);
}

/**
 * The plan for a curved target, re-found by its lineage at this history
 * position. The face must be an exact cylinder whose axis is not along the
 * extrusion (whose wall a straight extrusion could never meet). The way the
 * extrusion runs is the side the face's middle lies on; whether it starts
 * inside or outside the cylinder is read at the start plane, where the
 * profile's own bounds sit.
 */
export function planCurvedToFace(
  kernel: RemusKernel,
  document: ProjectDocument,
  feature: FeatureNode,
  data: ExtrudeData,
  basis: PlaneBasis,
  sketchBases: ReadonlyMap<SketchId, PlaneBasis>,
  result: Pick<ExactBuildResult, 'shapes' | 'consumed'>,
  scope: Record<string, number>
): { sweep: FeatureNode; curved: CurvedToFace } {
  const target = data.toSurface!;
  if (!document.bodyOrder.includes(target.bodyId)) {
    throw unresolved('the body that carried the face was deleted.');
  }
  const owner = bodyName(document, target.bodyId);
  if (result.consumed.has(target.bodyId)) {
    throw unresolved(
      `${owner}, which carried the face, was consumed earlier in history.`
    );
  }
  const shape = result.shapes.get(target.bodyId);
  if (!shape) {
    throw unresolved(
      `${owner}, which carried the face, is not available at this point in history.`
    );
  }
  const source = listFeaturesInOrder(document).find(
    (candidate) =>
      candidate.featureId === target.faceReference.producingFeatureId
  );
  let face;
  try {
    face = resolveRevolutionFace({
      reference: target.faceReference,
      candidates: faceAttachmentCandidatesForShape(kernel, shape),
      datumName: feature.name,
      sourceFeatureName:
        source?.name ?? String(target.faceReference.producingFeatureId)
    });
  } catch (error) {
    throw unresolved(error instanceof Error ? error.message : String(error));
  }
  if (face.revolution?.kind !== 'cylinder' || typeof face.value !== 'number') {
    throw unresolved(
      `the face is a ${face.revolution?.kind ?? face.witness.surfaceType.toLowerCase()}; an extrusion reaches a cylindrical curved face only.`
    );
  }
  const geometry = measureFaceGeometry(kernel, face.value);
  const radius = geometry?.radius;
  if (!(radius !== undefined && radius > 0) || !geometry) {
    throw unresolved('the cylinder’s radius could not be read.');
  }
  const axis = unit(face.revolution.direction);
  const axisPoint = face.revolution.point;
  const n = basis.normal;
  if (Math.abs(dot(axis, n)) > 1 - 1e-6) {
    throw unresolved(
      'the extrusion runs along the cylinder’s axis, so it never meets its wall; pick a face it runs toward.'
    );
  }
  const start = along(
    basis.origin,
    n,
    resolveExtrudeStartOffset(data, scope, document)
  );
  // The way to the face is the side its middle lies on. From inside a whole
  // cylinder its middle is on the axis, level with a start through it, and
  // either way meets the wall: then the stored distance's sign (the
  // direction the editor's Reverse sets) decides.
  const height = dot(sub(geometry.center, start), n);
  let sign: 1 | -1;
  if (Math.abs(height) > 1e-6 * Math.max(1, radius)) {
    sign = height < 0 ? -1 : 1;
  } else {
    const distance = resolveParamValue(
      data.distance,
      scope,
      'distance',
      document.units
    );
    if (!Number.isFinite(distance) || distance === 0) {
      throw unresolved(
        'the middle of the curved face lies on the start plane, so which way to extrude is unclear; reverse the direction to choose.'
      );
    }
    sign = distance < 0 ? -1 : 1;
  }
  const direction = { x: n.x * sign, y: n.y * sign, z: n.z * sign };
  const {
    endCondition: _endCondition,
    toSurface: _toSurface,
    toFaceOffset: _toFaceOffset,
    ...rest
  } = data;
  // Inside or outside is read where the profile starts: the middle of a
  // unit probe sweep's exact bounds, moved back onto the start plane.
  const { draftAngleDeg: _draft, ...straight } = rest;
  const probe = buildSweep(
    kernel,
    document,
    { ...feature, data: { ...straight, distance: sign } },
    scope,
    sketchBases,
    () => {}
  );
  const boxes = probe.solids.map((solid) => kernel.boundingBox(solid));
  for (const solid of probe.solids) kernel.deleteSolid(solid);
  const bounds = unionBounds(boxes);
  const middle = {
    x: (bounds[0]! + bounds[3]!) / 2,
    y: (bounds[1]! + bounds[4]!) / 2,
    z: (bounds[2]! + bounds[5]!) / 2
  };
  const inside =
    fromAxis(
      along(middle, direction, -dot(sub(middle, start), direction)),
      axisPoint,
      axis
    ) < radius;
  const offset = resolveToFaceOffset(data, scope, document);
  // Short of the face is toward the start: a smaller cylinder from inside,
  // a larger one from outside.
  const reached = inside ? radius - offset : radius + offset;
  if (!(reached > 0)) {
    throw new Error(
      `Offset from face ${offset} closes the cylinder up (radius ${Math.round(radius * 1e6) / 1e6}); make it smaller.`
    );
  }
  let reach: number;
  try {
    reach = throughAllSpan(
      unionBounds(shape.solids.map((solid) => kernel.boundingBox(solid))),
      start,
      direction,
      'forward'
    ).forward;
  } catch {
    throw new Error(
      `${owner}, which carries the curved face, lies entirely behind where the extrusion starts; move the start or pick another face.`
    );
  }
  const length = reach + Math.max(reach * 0.05, 1e-3);
  return {
    sweep: { ...feature, data: { ...rest, distance: sign * length } },
    curved: {
      axisPoint,
      axis,
      radius: reached,
      inside,
      start,
      direction,
      length
    }
  };
}

/** An exact solid cylinder on the axis, long enough to hold `boxes`. */
function solidCylinder(
  kernel: RemusKernel,
  plan: CurvedToFace,
  boxes: readonly ArrayLike<number>[]
): number {
  let low = Infinity;
  let high = -Infinity;
  for (const box of boxes) {
    for (const x of [0, 3])
      for (const y of [1, 4])
        for (const z of [2, 5]) {
          const t = dot(
            sub({ x: box[x]!, y: box[y]!, z: box[z]! }, plan.axisPoint),
            plan.axis
          );
          low = Math.min(low, t);
          high = Math.max(high, t);
        }
  }
  const margin = Math.max(1, (high - low) * 0.1);
  const base = along(plan.axisPoint, plan.axis, low - margin);
  const edge = kernel.makeCircleEdge(
    base.x,
    base.y,
    base.z,
    plan.axis.x,
    plan.axis.y,
    plan.axis.z,
    plan.radius
  );
  const face = kernel.makePlanarFaceFromWire(
    kernel.makeWire(Uint32Array.of(edge), true)
  );
  return kernel.extrude(
    face,
    plan.axis.x,
    plan.axis.y,
    plan.axis.z,
    high - low + 2 * margin
  );
}

/**
 * The part of each long swept solid on the start side of the face's
 * cylinder: from inside, the regions of the sweep common with the solid
 * cylinder; from outside, the regions left when it is cut away. Either way
 * only the regions standing on the start plane are kept. None standing (the
 * profile does not start on that side) or one still reaching the far end of
 * the sweep (part of the profile passes the cylinder by) refuses by name.
 */
export function trimToCurvedFace(
  kernel: RemusKernel,
  extrusion: ExactShape,
  plan: CurvedToFace,
  label: string
): ExactShape {
  const tolerance = 1e-7 * Math.max(1, plan.length);
  const far = along(plan.start, plan.direction, plan.length);
  const cylinder = solidCylinder(
    kernel,
    plan,
    extrusion.solids.map((solid) => kernel.boundingBox(solid))
  );
  const solids = extrusion.solids.flatMap((solid) => {
    const regions = Array.from(
      kernel.getCompoundSolids(
        kernel.booleanRegions(
          plan.inside ? 'intersect' : 'cut',
          solid,
          cylinder
        )
      )
    );
    // The regions stay owned by the kernel's region compound, which has no
    // release call: they are left to the build's arena, never deleted.
    const kept = regions.filter((region) =>
      hasFaceOnPlane(kernel, region, plan.start, plan.direction, tolerance)
    );
    if (kept.length === 0) {
      throw new Error(
        `${label}: the profile does not start ${plan.inside ? 'inside' : 'outside'} the curved face's cylinder all over; keep it to one side.`
      );
    }
    if (
      kept.some((region) =>
        hasFaceOnPlane(kernel, region, far, plan.direction, tolerance)
      )
    ) {
      throw new Error(
        `${label} does not meet the curved face everywhere: part of the profile passes its cylinder by. Move the profile over the face, or use a distance.`
      );
    }
    return kept;
  });
  try {
    kernel.deleteSolid(cylinder);
  } catch {
    // A scratch handle that could not be retired is a leak, not an error.
  }
  return {
    solids,
    lineage: remusHashOnlyLineage('sweep', CURVED_TO_FACE_HASH_ONLY_REASON)
  };
}
