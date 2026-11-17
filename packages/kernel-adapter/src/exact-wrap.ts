import {
  findSketch,
  listFeaturesInOrder,
  resolveParamValue
} from '@openzcad/document-core';
import { mergeAdjacentProfiles, type PlaneBasis } from '@openzcad/geometry';
import type { ProjectDocument } from '@openzcad/shared';
import type { FeatureDataOf } from './exact-build-loop';
import type { RemusKernel } from './remus-runtime';
import type { ExactShape } from './exact-types';
import { makeRegionFace } from './exact-profile-builders';
import {
  connectedRegionGroups,
  resolveRegionProfilesInSketch
} from './region-profile';
import { resolveRevolutionFace } from './face-attachment';
import { faceAttachmentCandidatesForShape } from './exact-shape-utils';
import { measureFaceGeometry } from './exact-measure';

/**
 * M12 (schema v111): the exact wrap. Each selected sketch region is wrapped
 * onto a cylinder by the kernel's `wrapProfileOnCylinder` (arc length
 * preserved, exact cylinders and planes, certified fits elsewhere) as the
 * solid between two radii, or onto a cone by `wrapProfileOnCone` (through
 * the cone's development, exact cones and certified fits) as the solid
 * between two normal offsets, which the caller then unites with the body
 * (emboss) or cuts from it (engrave), leaving one body.
 *
 * An emboss's solid reaches a quarter of its depth inside the surface and
 * an engrave's a quarter of its depth outside, so the boolean meets the face
 * across a margin rather than along a coincident surface.
 */

type V3 = { x: number; y: number; z: number };

const dot = (a: V3, b: V3) => a.x * b.x + a.y * b.y + a.z * b.z;
const sub = (a: V3, b: V3): V3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
const add = (a: V3, b: V3): V3 => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z });
const scale = (a: V3, k: number): V3 => ({ x: a.x * k, y: a.y * k, z: a.z * k });
const cross = (a: V3, b: V3): V3 => ({
  x: a.y * b.z - a.z * b.y,
  y: a.z * b.x - a.x * b.z,
  z: a.x * b.y - a.y * b.x
});
const unit = (a: V3): V3 => scale(a, 1 / (Math.hypot(a.x, a.y, a.z) || 1));

/**
 * The surface a wrap's regions go onto: a cylinder (axis, radius) or a cone
 * (apex, axis into the cone, remus half-angle), with the angle-zero
 * direction and the axis point whose circle is the regions' zero height.
 */
export type WrapFrame =
  | {
      kind: 'cylinder';
      origin: V3;
      axis: V3;
      reference: V3;
      radius: number;
    }
  | {
      kind: 'cone';
      origin: V3;
      axis: V3;
      reference: V3;
      apex: V3;
      halfAngle: number;
    };

/**
 * The cylinder or cone a wrap's face names at its history position, with
 * the angle-zero direction pointing at the sketch plane (turned by the
 * wrap's rotation) and the origin moved along the axis by its offset.
 */
export function resolveWrapFrame(
  kernel: RemusKernel,
  document: ProjectDocument,
  data: FeatureDataOf<'wrap'>,
  target: ExactShape,
  basis: PlaneBasis,
  scope: Record<string, number>,
  name: string
): WrapFrame {
  const sourceFeatureName =
    listFeaturesInOrder(document).find(
      (candidate) =>
        candidate.featureId === data.faceReference.producingFeatureId
    )?.name ?? String(data.faceReference.producingFeatureId);
  const face = resolveRevolutionFace({
    reference: data.faceReference,
    candidates: faceAttachmentCandidatesForShape(kernel, target),
    datumName: name,
    sourceFeatureName
  });
  if (!face.revolution || typeof face.value !== 'number') {
    throw new Error(
      `Wrap "${name}" needs a cylindrical or conical face; the picked face is a ${face.witness.surfaceType.toLowerCase()}.`
    );
  }
  const geometry = measureFaceGeometry(kernel, face.value);
  let axis = unit(face.revolution.direction);
  let shape:
    | { kind: 'cylinder'; radius: number }
    | { kind: 'cone'; apex: V3; halfAngle: number };
  if (face.revolution.kind === 'cylinder') {
    const radius = geometry?.radius;
    if (!(radius !== undefined && radius > 0)) {
      throw new Error(`Wrap "${name}" could not read its cylinder's radius.`);
    }
    shape = { kind: 'cylinder', radius };
  } else {
    const apex = geometry?.apex;
    const halfAngle = geometry?.halfAngle;
    if (!apex || !geometry?.axis || !(halfAngle !== undefined && halfAngle > 0)) {
      throw new Error(`Wrap "${name}" could not read its cone.`);
    }
    // The axis runs from the apex into the cone, toward the face.
    axis = unit(geometry.axis);
    if (dot(sub(geometry.center, apex), axis) < 0) axis = scale(axis, -1);
    shape = { kind: 'cone', apex, halfAngle };
  }
  const normal = unit(basis.normal);
  if (Math.abs(dot(normal, axis)) > 1e-9) {
    throw new Error(
      `Wrap "${name}" needs its sketch in a plane parallel to the ${shape.kind === 'cylinder' ? "cylinder's" : "cone's"} axis.`
    );
  }
  const axisPoint = shape.kind === 'cone' ? shape.apex : face.revolution.point;
  // Angle zero is where the sketch plane faces the axis from.
  const toPlane = dot(sub(basis.origin, axisPoint), normal);
  const facing = Math.abs(toPlane) > 1e-9 ? scale(normal, Math.sign(toPlane)) : normal;
  const turn =
    (resolveParamValue(data.rotationDeg ?? 0, scope, 'wrap rotation', document.units) *
      Math.PI) /
    180;
  const across = cross(axis, facing);
  const reference = add(scale(facing, Math.cos(turn)), scale(across, Math.sin(turn)));
  const offset = resolveParamValue(
    data.axialOffset ?? 0,
    scope,
    'wrap axial offset',
    document.units
  );
  // The sketch's height maps along the axis (along the generator, on a
  // cone) from the axis foot of its origin, moved back by the offset so the
  // regions move forward by it.
  const origin = sub(
    add(axisPoint, scale(axis, dot(sub(basis.origin, axisPoint), axis))),
    scale(axis, offset)
  );
  return shape.kind === 'cylinder'
    ? { kind: 'cylinder', origin, axis, reference, radius: shape.radius }
    : {
        kind: 'cone',
        origin,
        axis,
        reference,
        apex: shape.apex,
        halfAngle: shape.halfAngle
      };
}

/** The wrap's material, one solid per connected region group. */
export function buildWrapSolids(
  kernel: RemusKernel,
  document: ProjectDocument,
  data: FeatureDataOf<'wrap'>,
  frame: WrapFrame,
  basis: PlaneBasis,
  scope: Record<string, number>,
  warn: (message: string) => void,
  name: string
): number[] {
  const sketch = findSketch(document, data.sketchId);
  if (!sketch) throw new Error(`Wrap "${name}" sketch no longer exists.`);
  const depth = resolveParamValue(data.depth, scope, 'wrap depth', document.units);
  if (!(depth > 0)) throw new Error(`Wrap "${name}" needs a positive depth.`);
  const margin = depth / 4;
  // A cylinder takes radii; a cone takes offsets along its normal.
  const base = frame.kind === 'cylinder' ? frame.radius : 0;
  const [inner, outer] =
    data.mode === 'emboss'
      ? [base - margin, base + depth]
      : [base - depth, base + margin];
  if (frame.kind === 'cylinder' && !(inner > 0)) {
    throw new Error(
      `Wrap "${name}" is deeper than its cylinder's radius; use a smaller depth.`
    );
  }
  const { regions } = resolveRegionProfilesInSketch(
    document,
    sketch,
    { profiles: data.profiles },
    scope
  );
  return connectedRegionGroups(regions).map((group) => {
    const face = makeRegionFace(kernel, mergeAdjacentProfiles(group), basis, warn);
    if (frame.kind === 'cone') {
      return kernel.wrapProfileOnCone(
        face,
        frame.apex.x,
        frame.apex.y,
        frame.apex.z,
        frame.axis.x,
        frame.axis.y,
        frame.axis.z,
        frame.reference.x,
        frame.reference.y,
        frame.reference.z,
        frame.origin.x,
        frame.origin.y,
        frame.origin.z,
        frame.halfAngle,
        inner,
        outer
      );
    }
    return kernel.wrapProfileOnCylinder(
      face,
      frame.origin.x,
      frame.origin.y,
      frame.origin.z,
      frame.axis.x,
      frame.axis.y,
      frame.axis.z,
      frame.reference.x,
      frame.reference.y,
      frame.reference.z,
      frame.radius,
      inner,
      outer
    );
  });
}
