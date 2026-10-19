import { commandFactories } from '@openzcad/command-system';
import {
  findSketch,
  getParameterScope,
  listFeaturesInOrder,
  resolveParamValue
} from '@openzcad/document-core';
import type {
  ExtrudeToFaceTarget,
  FeatureId,
  ProjectDocument,
  SketchId,
  TopologySelection
} from '@openzcad/shared';
import { faceSketchAttachment } from './faceSketchAttachment';
import { resolvedSketchPlaneBasis } from './sketch/planeBasis';

/**
 * F01 (v29): the to-face target a viewport pick gives an extrude, or a
 * refusal in words for the status line. The pick must be an exact planar
 * face with an identity a rebuild can find again — the same qualification an
 * R01 datum's face source needs, because the same resolver re-finds it.
 */
export function extrudeToFaceTargetFromPick(
  document: ProjectDocument,
  selection: TopologySelection
): ExtrudeToFaceTarget {
  if (selection.kind !== 'face') {
    throw new Error('Click a planar face for the extrusion to reach.');
  }
  const attachment = faceSketchAttachment({
    bodyId: selection.bodyId,
    pickedHash: selection.hash,
    face: document.derived.bodyRepresentations[
      selection.bodyId
    ]?.topology?.faces.find((face) => face.hash === selection.hash)
  });
  if (!attachment.ok) {
    throw new Error('Pick an exact planar face for the extrusion to reach.');
  }
  const ref = attachment.planeRef;
  if (ref.type !== 'face' || !ref.faceReference || !ref.sourceCentroid) {
    throw new Error(
      'This face has no identity a rebuild can find again, so an extrusion cannot follow it. Pick a face of an extruded, primitive or moved body.'
    );
  }
  return ref as ExtrudeToFaceTarget;
}

/**
 * The signed distance from the sketch plane to the target, as the build will
 * derive it, from the current projection: where the viewport arrow sits and
 * the depth Distance falls back to. Null when either plane cannot be placed
 * here, or the face is not parallel to the sketch — the build then refuses
 * by name, and the form says so before Apply.
 */
export function toFaceDistanceEstimate(
  document: ProjectDocument,
  sketchId: SketchId,
  target: ExtrudeToFaceTarget
): number | null {
  const sketch = findSketch(document, sketchId);
  if (!sketch) return null;
  const { scope } = getParameterScope(document);
  let basis;
  try {
    basis = resolvedSketchPlaneBasis(
      document,
      sketch.planeRef,
      (value) =>
        resolveParamValue(value, scope, 'sketch offset', document.units),
      sketch.name
    );
  } catch {
    return null;
  }
  const point = target.sourceCentroid;
  const normal = target.sourceNormal;
  const alignment =
    normal.x * basis.normal.x +
    normal.y * basis.normal.y +
    normal.z * basis.normal.z;
  if (Math.abs(Math.abs(alignment) - 1) > 1e-6) return null;
  const distance =
    (point.x - basis.origin.x) * basis.normal.x +
    (point.y - basis.origin.y) * basis.normal.y +
    (point.z - basis.origin.z) * basis.normal.z;
  return Math.abs(distance) > 1e-9 ? distance : null;
}

/** "Ceiling · face", for the extrude card and the history row. */
export function toFaceTargetLabel(
  document: ProjectDocument,
  target: ExtrudeToFaceTarget
): string {
  const body = document.derived.bodyRepresentations[target.bodyId]?.name;
  return `${body ?? 'Deleted body'} · face`;
}

/**
 * The repair a re-pick makes on an unresolved to-face extrude: only its
 * target face changes. Throws, in words, when the pick cannot be a target.
 */
export function extrudeToFaceRepair(
  document: ProjectDocument,
  featureId: FeatureId,
  selection: TopologySelection
) {
  const feature = listFeaturesInOrder(document).find(
    (candidate) => candidate.featureId === featureId
  );
  if (
    feature?.data.featureKind !== 'extrude' ||
    feature.data.endCondition !== 'to-face'
  ) {
    throw new Error('Only an extrude to a face can have its face re-picked.');
  }
  const toFace = extrudeToFaceTargetFromPick(document, selection);
  const label = `Re-pick face for ${feature.name}`;
  return {
    feature,
    label,
    command: commandFactories.updateFeature(
      { featureId, data: { toFace } },
      label
    )
  };
}
