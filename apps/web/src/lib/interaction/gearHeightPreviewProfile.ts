import {
  getParameterScope,
  listFeaturesInOrder,
  resolveParamValue
} from '@openzcad/document-core';
import type {
  BodyRepresentation,
  FaceTopology,
  ProjectDocument
} from '@openzcad/shared';
import type { LinearPreviewProfile } from '@openzcad/viewport';
import { primitiveCylinderCapAncestor } from './cylinderPrimitiveAncestry';

/**
 * A spur gear cut along a cylinder regenerates the same cross-section at any
 * height. Stretch every axial vertex, including the ones inside a curved tooth
 * wall: moving only vertices touching the cap pins the middle of those walls
 * and the generic face preview stops at its first folding triangle.
 *
 * History proves the straight extrusion, not the triangles' normals: even a
 * straight curved surface can tessellate into triangles oblique to its axis.
 * This is only a disposable display; release still needs exact validation.
 */
export function gearHeightPreviewProfile(
  document: ProjectDocument,
  body: BodyRepresentation | undefined,
  cap: FaceTopology | undefined
): LinearPreviewProfile | null {
  const faces = body?.topology?.faces;
  if (
    !body?.exportableStep ||
    !faces ||
    !cap ||
    !faces.includes(cap) ||
    cap.geometry?.surfaceType !== 'plane' ||
    !cap.geometry.normal ||
    !primitiveCylinderCapAncestor(
      document,
      body.bodyId,
      cap.reference,
      cap.hash
    )
  )
    return null;
  const producer = listFeaturesInOrder(document).find(
    (feature) => feature.bodyId === body.bodyId
  );
  if (
    producer?.data.featureKind !== 'gear' ||
    producer.data.gearType !== 'external' ||
    !producer.data.targetBodyId
  )
    return null;
  try {
    const { scope } = getParameterScope(document);
    if (
      resolveParamValue(
        producer.data.helixAngleDeg ?? 0,
        scope,
        'angle',
        document.units
      ) !== 0
    )
      return null;
  } catch {
    return null;
  }
  const normal = cap.geometry.normal;
  const magnitude = Math.hypot(normal.x, normal.y, normal.z);
  if (!Number.isFinite(magnitude) || magnitude < 1e-9) return null;
  const direction = {
    x: normal.x / magnitude,
    y: normal.y / magnitude,
    z: normal.z / magnitude
  };
  const other = faces.find(
    (face) =>
      face !== cap &&
      face.geometry?.surfaceType === 'plane' &&
      face.reference?.lineageName ===
        (cap.reference?.lineageName.endsWith('.end')
          ? 'gear.face.cap.start'
          : 'gear.face.cap.end')
  );
  if (!other?.geometry?.normal) return null;
  const oppositeNormal = other.geometry.normal;
  if (
    oppositeNormal.x * direction.x +
      oppositeNormal.y * direction.y +
      oppositeNormal.z * direction.z >
    -1 + 1e-6
  )
    return null;
  const end = cap.geometry.center;
  const start = other.geometry.center;
  const span =
    (end.x - start.x) * direction.x +
    (end.y - start.y) * direction.y +
    (end.z - start.z) * direction.z;
  if (!Number.isFinite(span) || span <= 1e-9) return null;
  // Use the selected cap's axis, so the other end stays fixed even when a
  // sampled cap centre differs slightly from its opposite's centre.
  return {
    axisStart: {
      x: end.x - direction.x * span,
      y: end.y - direction.y * span,
      z: end.z - direction.z * span
    },
    axisEnd: { ...end }
  };
}
