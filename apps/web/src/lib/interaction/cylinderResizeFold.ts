import { listFeaturesInOrder } from '@openzcad/document-core';
import {
  isFeatureSuppressed,
  type DirectEditOperation,
  type FaceTopologyReferenceV5,
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
  /** The held face's v5 name, when the rebuilt body publishes one. */
  reference?: FaceTopologyReferenceV5;
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

const near = (a: Vector3, b: Vector3, tolerance: number) =>
  Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z) <= tolerance;

/** The length the held wall's span shares with the recorded one. */
function sharedSpan(
  wall: HeldCylinderWall,
  start: Vector3,
  end: Vector3
): number {
  const axis = { x: end.x - start.x, y: end.y - start.y, z: end.z - start.z };
  const length = Math.hypot(axis.x, axis.y, axis.z);
  const along = (point: Vector3) =>
    ((point.x - start.x) * axis.x +
      (point.y - start.y) * axis.y +
      (point.z - start.z) * axis.z) /
    length;
  const [a, b] = [along(wall.axisStart), along(wall.axisEnd)];
  return Math.min(Math.max(a, b), length) - Math.max(Math.min(a, b), 0);
}

/**
 * Whether the held wall is the face the resize targeted, by the rules the
 * exact rebuild resolves that face with. When both carry a v5 name, the
 * names decide, whatever the geometry says. Otherwise the resize rewrote the
 * face's hash, so the stored hash cannot name the resized wall, and coaxial
 * sibling patches share the radius and axis line: the span tells them apart.
 *
 * A through-hole is a complete turn, so no other hole wall at its radius on
 * its axis can share any of its axial range, and a span that overlaps the
 * recorded one is the same bore even when the resize re-trimmed its ends
 * against a chamfer. Any other wall may be a partial turn beside a sibling
 * over the same range, so it must sit at the recorded endpoints, in either
 * order. A repeat drag of such a wall whose ends the resize moved appends a
 * second edit rather than risk rewriting a sibling's.
 */
function sameResizedFace(
  wall: HeldCylinderWall,
  operation: CylinderResizeOperation,
  tolerance: number
): boolean {
  const stored = operation.faceReference;
  if (stored && wall.reference)
    return (
      wall.reference.producingFeatureId === stored.producingFeatureId &&
      wall.reference.lineageName === stored.lineageName
    );
  const { sourceAxisStart: start, sourceAxisEnd: end } = operation;
  if (operation.kind === 'resize-through-hole' && wall.concavity === 'hole')
    return sharedSpan(wall, start, end) > tolerance;
  return (
    (near(wall.axisStart, start, tolerance) &&
      near(wall.axisEnd, end, tolerance)) ||
    (near(wall.axisStart, end, tolerance) &&
      near(wall.axisEnd, start, tolerance))
  );
}

/**
 * The resize a new drag on the same wall should rewrite rather than follow.
 *
 * Dragging a hole, letting go and dragging it again is one adjustment, not
 * two: each release used to append another "Resize Hole", four rows for one
 * hole. When the last feature in the history is a resize of this body's wall
 * — the same face, on the same axis line, now at the size that resize
 * produced — the new size goes into that feature instead. A coaxial sibling
 * patch at the same size is another face, so its drag appends. Anything
 * after it in the history, a symbolic size, or a drag back to where that
 * resize started (which it could not express) appends as before.
 *
 * Tolerances scale with the wall's own size, as the exact rebuild's checks
 * do, never with its distance from the origin: far out, a position-scaled
 * band would merge a bore with the outer wall a fraction of a millimetre
 * away.
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
  const { sourceAxisStart, sourceAxisEnd } = operation;
  const recordedLength = Math.hypot(
    sourceAxisEnd.x - sourceAxisStart.x,
    sourceAxisEnd.y - sourceAxisStart.y,
    sourceAxisEnd.z - sourceAxisStart.z
  );
  // DIRECT_EDIT_TOLERANCE, relative to the radius and the recorded length.
  const radiusTolerance = Math.max(1e-6, wall.radius * 1e-6);
  const axisTolerance = Math.max(
    1e-6,
    wall.radius * 1e-6,
    recordedLength * 1e-6
  );
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
    Math.abs(producedRadius - wall.radius) > radiusTolerance ||
    Math.abs(nextRadius - sourceRadius) <= radiusTolerance ||
    (wall.concavity !== undefined &&
      (operation.kind === 'resize-cylindrical-face'
        ? operation.concavity
        : 'hole') !== wall.concavity) ||
    !onAxisLine(
      wall.axisStart,
      sourceAxisStart,
      sourceAxisEnd,
      axisTolerance
    ) ||
    !onAxisLine(wall.axisEnd, sourceAxisStart, sourceAxisEnd, axisTolerance) ||
    !sameResizedFace(wall, operation, axisTolerance)
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
