import type {
  BodyId,
  FaceTopology,
  SketchPlaneRef,
  Vector3
} from '@openzcad/shared';
import { frameFromFace } from './sketch/session';

/**
 * Why a face cannot carry a sketch.
 *
 * This is the refusal a user meets on the face of any boolean, fillet or
 * direct-edit result — measured, every planar face of those bodies — so it
 * cannot describe itself as being about an "edited face" and it cannot offer
 * remodelling an offset as the way out. What all of them share is that the
 * face has no identity the rebuild can find again, so a sketch pinned to it
 * would silently move.
 */
export const UNSTABLE_FACE_SKETCH_REASON =
  'This face is produced by an operation that cannot name it again after a rebuild — booleans, fillets and direct edits all lose that identity — so a sketch attached here would silently move. Sketch on a principal plane, or on a face of the primitive that made it.';

const INVALID_FACE_SKETCH_REASON =
  'Pick an exact planar face with valid measurements to sketch on, or choose a principal plane.';

type FaceSketchPlaneRef = Extract<SketchPlaneRef, { type: 'face' }>;

export type FaceSketchAttachmentResult =
  { ok: true; planeRef: FaceSketchPlaneRef } | { ok: false; reason: string };

function finiteVector(vector: Vector3 | undefined): vector is Vector3 {
  return (
    vector !== undefined &&
    Number.isFinite(vector.x) &&
    Number.isFinite(vector.y) &&
    Number.isFinite(vector.z)
  );
}

function cloneVector(vector: Vector3): Vector3 {
  return { x: vector.x, y: vector.y, z: vector.z };
}

/**
 * Builds a new associative face plane only when the exact topology projection
 * proves that the selected face has a current schema-v5 lineage reference.
 */
export function faceSketchAttachment(input: {
  bodyId: BodyId;
  pickedHash: number | undefined;
  face: FaceTopology | undefined;
}): FaceSketchAttachmentResult {
  const { face, pickedHash } = input;
  const geometry = face?.geometry;
  if (
    !face ||
    geometry?.surfaceType !== 'plane' ||
    !Number.isFinite(geometry.area) ||
    geometry.area <= 0 ||
    !finiteVector(geometry.center) ||
    !finiteVector(geometry.normal) ||
    Math.abs(
      Math.hypot(geometry.normal.x, geometry.normal.y, geometry.normal.z) - 1
    ) > 1e-6 ||
    pickedHash === undefined ||
    pickedHash !== face.hash
  ) {
    return { ok: false, reason: INVALID_FACE_SKETCH_REASON };
  }

  const reference = face.reference;
  if (!reference || reference.currentHash !== face.hash) {
    return { ok: false, reason: UNSTABLE_FACE_SKETCH_REASON };
  }

  const center = cloneVector(geometry.center);
  const normal = cloneVector(geometry.normal);
  // The sketch is placed on the middle of the face, which is its area centroid
  // and not `center` — that one is the mean of the face's vertices, and on a
  // round face its single seam vertex puts it on the rim. A face whose boundary
  // could not be walked has no centroid to offer and keeps the old anchor,
  // which the absent `sourceCentroid` then tells the rebuild to reuse.
  const centroid = finiteVector(geometry.centroid)
    ? cloneVector(geometry.centroid)
    : null;
  const frame = frameFromFace(centroid ?? center, normal);
  return {
    ok: true,
    planeRef: {
      type: 'face',
      bodyId: input.bodyId,
      faceHash: face.hash,
      faceReference: reference,
      sourceArea: geometry.area,
      sourceCenter: center,
      ...(centroid ? { sourceCentroid: centroid } : {}),
      sourceNormal: normal,
      frame: {
        origin: cloneVector(frame.origin),
        xAxis: cloneVector(frame.xAxis),
        yAxis: cloneVector(frame.yAxis),
        zAxis: cloneVector(frame.zAxis)
      }
    }
  };
}

/**
 * Converts a legacy face snapshot into an explicit fixed frame without moving
 * the sketch. Current associative attachments are intentionally left alone.
 */
export function fixedPlaneRefForLegacyAttachment(
  planeRef: SketchPlaneRef
): Extract<SketchPlaneRef, { type: 'frame' }> | null {
  if (planeRef.type !== 'face' || planeRef.faceReference) {
    return null;
  }
  return {
    type: 'frame',
    frame: {
      origin: cloneVector(planeRef.frame.origin),
      xAxis: cloneVector(planeRef.frame.xAxis),
      yAxis: cloneVector(planeRef.frame.yAxis),
      zAxis: cloneVector(planeRef.frame.zAxis)
    }
  };
}
