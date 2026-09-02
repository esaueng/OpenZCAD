import type {
  BodyId,
  FaceTopology,
  SketchPlaneRef,
  Vector3
} from '@openzcad/shared';
import { frameFromFace } from './sketch/session';

/**
 * Why a sketch on this face is fixed in space rather than attached to it.
 *
 * Every planar face of a boolean, fillet or direct-edit result is measured
 * rather than named, so the rebuild cannot find it again; a sketch pinned to
 * it would silently move. The reference CAD lets the user sketch there
 * anyway and keeps the sketch where it was drawn, so the task proceeds and
 * nothing moves behind the user's back. That is what happens here: the
 * sketch lands on a fixed plane coincident with the face, and this sentence
 * says so wherever the sketch is offered or started.
 */
export const UNSTABLE_FACE_SKETCH_REASON =
  'This face has no identity a rebuild can find again — booleans, fillets and direct edits lose it — so the sketch is placed on a fixed plane here and stays put if the face moves.';

const INVALID_FACE_SKETCH_REASON =
  'Pick an exact planar face with valid measurements to sketch on, or choose a principal plane.';

type FaceSketchPlaneRef = Extract<SketchPlaneRef, { type: 'face' }>;
type FixedSketchPlaneRef = Extract<SketchPlaneRef, { type: 'frame' }>;

export type FaceSketchAttachmentResult =
  | { ok: true; attachment: 'associative'; planeRef: FaceSketchPlaneRef }
  | {
      /**
       * The face is planar and measurable but has no lineage: the sketch is
       * placed on a fixed frame coincident with it. `note` is the sentence to
       * show the user, because a sketch that will not follow its face must
       * never be mistaken for one that will.
       */
      ok: true;
      attachment: 'fixed';
      planeRef: FixedSketchPlaneRef;
      note: string;
    }
  | { ok: false; reason: string };

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
 * Builds the plane a sketch on this face should use: an associative face plane
 * when the exact topology projection proves the face has a current schema-v5
 * lineage reference, and a fixed frame coincident with the face when it does
 * not. Only a face that cannot be measured is refused.
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
  const reference = face.reference;
  if (!reference || reference.currentHash !== face.hash) {
    return {
      ok: true,
      attachment: 'fixed',
      note: UNSTABLE_FACE_SKETCH_REASON,
      planeRef: {
        type: 'frame',
        frame: {
          origin: cloneVector(frame.origin),
          xAxis: cloneVector(frame.xAxis),
          yAxis: cloneVector(frame.yAxis),
          zAxis: cloneVector(frame.zAxis)
        }
      }
    };
  }
  return {
    ok: true,
    attachment: 'associative',
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
