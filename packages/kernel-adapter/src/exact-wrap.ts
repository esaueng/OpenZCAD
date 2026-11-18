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
      /** The face is a bore's: its material lies away from the axis. */
      bore: boolean;
    }
  | {
      kind: 'cone';
      origin: V3;
      axis: V3;
      reference: V3;
      apex: V3;
      halfAngle: number;
      bore: boolean;
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
  // Which side the material is on: the face's outward normal points away
  // from the axis on a post or a cup's outside, toward it in a bore. It is
  // read at a point of the face's own surface, beside the face's centre:
  // never projected from elsewhere, which on a cone could land on its
  // continuation past the apex, where the normal turns over.
  const probe = wrapOrientationProbe(
    axisPoint,
    axis,
    geometry?.center ?? axisPoint,
    shape.kind === 'cylinder' ? { radius: shape.radius } : { halfAngle: shape.halfAngle }
  );
  const projected = kernel.projectPointOnSurface(face.value, probe.x, probe.y, probe.z);
  const at = { x: projected[2]!, y: projected[3]!, z: projected[4]! };
  const raw = kernel.evaluateSurfaceNormal(face.value, projected[0]!, projected[1]!);
  const toAxis = sub(at, add(axisPoint, scale(axis, dot(sub(at, axisPoint), axis))));
  const bore = dot({ x: raw[0]!, y: raw[1]!, z: raw[2]! }, toAxis) < 0;
  return shape.kind === 'cylinder'
    ? { kind: 'cylinder', origin, axis, reference, radius: shape.radius, bore }
    : {
        kind: 'cone',
        origin,
        axis,
        reference,
        apex: shape.apex,
        halfAngle: shape.halfAngle,
        bore
      };
}

/**
 * A point on a wrap face's own surface at the height of `center`, where its
 * outward normal is read: on a cylinder at its radius, on a cone at the
 * radius its half-angle gives there (`axisPoint` is the apex and `axis`
 * runs into the cone, toward the face), never on the cone's continuation
 * past the apex.
 */
export function wrapOrientationProbe(
  axisPoint: V3,
  axis: V3,
  center: V3,
  shape: { radius: number } | { halfAngle: number }
): V3 {
  const level = dot(sub(center, axisPoint), axis);
  const side = unit(
    Math.abs(axis.x) < 0.9
      ? cross(axis, { x: 1, y: 0, z: 0 })
      : cross(axis, { x: 0, y: 1, z: 0 })
  );
  const reach =
    'radius' in shape
      ? shape.radius
      : (level * Math.cos(shape.halfAngle)) / Math.sin(shape.halfAngle);
  return add(add(axisPoint, scale(axis, level)), scale(side, reach));
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
  // A cylinder takes radii; a cone takes offsets along its normal. Out of
  // the face is away from its material: away from the axis on a post, toward
  // it in a bore.
  const base = frame.kind === 'cylinder' ? frame.radius : 0;
  const outward = (data.mode === 'emboss') !== frame.bore;
  const [inner, outer] = outward
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
