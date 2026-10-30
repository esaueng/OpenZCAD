import { listFeaturesInOrder } from '@openzcad/document-core';
import {
  isFeatureSuppressed,
  type DirectEditOperation,
  type FeatureId,
  type ProjectDocument,
  type Vector3
} from '@openzcad/shared';

type CylinderResizeOperation = Extract<
  DirectEditOperation,
  { kind: 'resize-cylindrical-face' | 'resize-through-hole' }
>;

export interface CylinderResizeFold {
  featureId: FeatureId;
  operation: CylinderResizeOperation;
}

/** The wall a radius drag holds, in the terms a fold compares. */
export interface HeldCylinderWall {
  bodyId: string;
  radius: number;
  axisStart: Vector3;
  axisEnd: Vector3;
  concavity?: 'hole' | 'boss';
}

function onAxisLine(
  point: Vector3,
  start: Vector3,
  end: Vector3,
  tolerance: number
): boolean {
  const axis = { x: end.x - start.x, y: end.y - start.y, z: end.z - start.z };
  const length = Math.hypot(axis.x, axis.y, axis.z);
  if (length <= tolerance) return false;
  const offset = {
    x: point.x - start.x,
    y: point.y - start.y,
    z: point.z - start.z
  };
  const cross = {
    x: offset.y * axis.z - offset.z * axis.y,
    y: offset.z * axis.x - offset.x * axis.z,
    z: offset.x * axis.y - offset.y * axis.x
  };
  return Math.hypot(cross.x, cross.y, cross.z) / length <= tolerance;
}

/**
 * The resize a new drag on the same wall should rewrite rather than follow.
 *
 * Dragging a hole, letting go and dragging it again is one adjustment, not
 * two: each release used to append another "Resize Hole", four rows for one
 * hole. When the last feature in the history is a resize of this body's wall
 * — same axis line, and the wall now sits at the size that resize produced —
 * the new size goes into that feature instead. Anything after it in the
 * history, a symbolic size, or a drag back to where that resize started
 * (which it could not express) appends as before.
 */
export function cylinderResizeFold(
  document: ProjectDocument,
  wall: HeldCylinderWall,
  nextRadius: number
): CylinderResizeFold | null {
  const tip = listFeaturesInOrder(document).at(-1);
  if (!tip || isFeatureSuppressed(tip)) return null;
  const data = tip.data;
  if (data.featureKind !== 'direct-edit' || data.targetBodyId !== wall.bodyId)
    return null;
  const operation = data.operation;
  if (
    operation.kind !== 'resize-cylindrical-face' &&
    operation.kind !== 'resize-through-hole'
  )
    return null;
  // A size bound to a named parameter is edited through the parameter.
  if (operation.kind === 'resize-through-hole' && operation.parameterBinding)
    return null;
  const scale = Math.max(
    1,
    wall.radius,
    Math.hypot(wall.axisStart.x, wall.axisStart.y, wall.axisStart.z),
    Math.hypot(wall.axisEnd.x, wall.axisEnd.y, wall.axisEnd.z)
  );
  const tolerance = scale * 1e-6;
  const [producedRadius, sourceRadius] =
    operation.kind === 'resize-cylindrical-face'
      ? [operation.radius, operation.sourceRadius]
      : [
          typeof operation.diameter === 'number'
            ? operation.diameter / 2
            : operation.diameter,
          operation.sourceDiameter / 2
        ];
  if (
    typeof producedRadius !== 'number' ||
    Math.abs(producedRadius - wall.radius) > tolerance ||
    Math.abs(nextRadius - sourceRadius) <= tolerance ||
    (operation.kind === 'resize-cylindrical-face' &&
      wall.concavity !== undefined &&
      operation.concavity !== wall.concavity) ||
    !onAxisLine(
      wall.axisStart,
      operation.sourceAxisStart,
      operation.sourceAxisEnd,
      tolerance
    ) ||
    !onAxisLine(
      wall.axisEnd,
      operation.sourceAxisStart,
      operation.sourceAxisEnd,
      tolerance
    )
  )
    return null;
  return {
    featureId: tip.featureId,
    operation:
      operation.kind === 'resize-cylindrical-face'
        ? { ...operation, radius: nextRadius }
        : { ...operation, diameter: nextRadius * 2 }
  };
}
