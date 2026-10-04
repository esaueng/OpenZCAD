import { listFeaturesInOrder } from '@openzcad/document-core';
import { frameForPlaneRef, type PlaneBasis } from '@openzcad/geometry';
import {
  resolveFaceAttachment,
  type FaceAttachmentCandidate
} from '@openzcad/kernel-adapter/face-attachment';
import type {
  ParamValue,
  ProjectDocument,
  SketchPlaneRef
} from '@openzcad/shared';

/**
 * The plane a sketch draws on: a canonical plane's frame, or a face-attached
 * sketch's frame re-resolved against the current topology. Lives beside the
 * rest of the sketch code rather than in the workspace component, which is
 * measured as the launcher chunk.
 */
export function resolvedSketchPlaneBasis(
  document: ProjectDocument,
  planeRef: SketchPlaneRef,
  resolveOffset: (value: ParamValue) => number,
  sketchName: string
): PlaneBasis {
  if (planeRef.type !== 'face' || !planeRef.faceReference) {
    return frameForPlaneRef(planeRef, resolveOffset);
  }
  const body = document.derived.bodyRepresentations[planeRef.bodyId];
  const candidates: FaceAttachmentCandidate[] = (body?.topology?.faces ?? [])
    .filter(
      (face) => face.reference?.kind === 'face' && face.geometry !== undefined
    )
    .map((face) => {
      const reference = face.reference!;
      const geometry = face.geometry!;
      return {
        kind: 'face',
        currentHash: face.hash,
        witnessVersion: 1,
        witness: reference.witness,
        plane:
          geometry.surfaceType.toLowerCase() === 'plane' && geometry.normal
            ? {
                center: geometry.center,
                centroid: geometry.centroid ?? null,
                normal: geometry.normal
              }
            : null,
        lineage: {
          source: 'derived',
          identity: {
            producingFeatureId: reference.producingFeatureId,
            lineageName: reference.lineageName
          }
        }
      };
    });
  const sourceFeature = listFeaturesInOrder(document).find(
    (feature) =>
      feature.featureId === planeRef.faceReference?.producingFeatureId
  );
  const frame = resolveFaceAttachment({
    reference: planeRef.faceReference,
    candidates,
    snapshot: {
      sourceArea: planeRef.sourceArea,
      sourceCenter: planeRef.sourceCenter,
      ...(planeRef.sourceCentroid
        ? { sourceCentroid: planeRef.sourceCentroid }
        : {}),
      sourceNormal: planeRef.sourceNormal,
      frame: planeRef.frame
    },
    sketchName,
    sourceFeatureName:
      sourceFeature?.name ?? String(planeRef.faceReference.producingFeatureId)
  });
  return {
    origin: frame.origin,
    u: frame.xAxis,
    v: frame.yAxis,
    normal: frame.zAxis
  };
}
