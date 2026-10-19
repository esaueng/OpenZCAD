import { commandFactories } from '@openzcad/command-system';
import {
  findSketch,
  getParameterScope,
  listFeaturesInOrder,
  resolveParamValue,
  toFaceSignedDistance
} from '@openzcad/document-core';
import type {
  BodyId,
  ExtrudeToFaceTarget,
  FaceTopology,
  FeatureId,
  FeatureNode,
  ParamValue,
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
  selection: TopologySelection,
  /**
   * The extrude being edited or repaired, if any. A face picked on its own
   * result body is resolved where the extrude reads it: a face the boolean
   * carried from the add/cut/intersect input body is re-found on that input
   * body (as it stood when this extrude consumed it), and a face the
   * extrusion itself creates is refused.
   */
  editing?: FeatureNode
): ExtrudeToFaceTarget {
  if (selection.kind !== 'face') {
    throw new Error('Click a planar face for the extrusion to reach.');
  }
  const face = document.derived.bodyRepresentations[
    selection.bodyId
  ]?.topology?.faces.find((candidate) => candidate.hash === selection.hash);
  if (
    editing?.bodyId !== undefined &&
    selection.bodyId === editing.bodyId &&
    editing.data.featureKind === 'extrude'
  ) {
    return carriedInputFace(document, editing, face);
  }
  return targetForFace(document, selection.bodyId, face);
}

/** The prefix the add/cut/intersect lineage puts on its input body's faces. */
const CARRIED_TARGET_FACE = 'boolean.face.target.';

function carriedInputFace(
  document: ProjectDocument,
  editing: FeatureNode,
  face: FaceTopology | undefined
): ExtrudeToFaceTarget {
  const input =
    editing.data.featureKind === 'extrude'
      ? editing.data.targetBodyId
      : undefined;
  const reference = face?.reference;
  if (
    !input ||
    !reference ||
    reference.producingFeatureId !== editing.featureId ||
    !reference.lineageName.startsWith(CARRIED_TARGET_FACE)
  ) {
    throw new Error(
      'That face is made by this extrusion itself; pick a face it does not create.'
    );
  }
  const lineageName = reference.lineageName.slice(CARRIED_TARGET_FACE.length);
  const original = document.derived.bodyRepresentations[
    input
  ]?.topology?.faces.find(
    (candidate) => candidate.reference?.lineageName === lineageName
  );
  if (!original) {
    throw new Error(
      'That face cannot be found on the body this extrusion consumes; pick another face.'
    );
  }
  return targetForFace(document, input, original);
}

function targetForFace(
  document: ProjectDocument,
  bodyId: BodyId,
  face: FaceTopology | undefined
): ExtrudeToFaceTarget {
  const attachment = faceSketchAttachment({
    bodyId,
    pickedHash: face?.hash,
    face
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
  const resolve = (value: ParamValue) =>
    resolveParamValue(value, scope, 'sketch offset', document.units);
  // Both planes are re-resolved against the current projection, as the
  // build re-resolves them: an upstream edit can move the sketch and the
  // face together, so the face's pick-time snapshot is not where it is now.
  let basis;
  let face;
  try {
    basis = resolvedSketchPlaneBasis(
      document,
      sketch.planeRef,
      resolve,
      sketch.name
    );
    face = resolvedSketchPlaneBasis(document, target, resolve, sketch.name);
  } catch {
    return null;
  }
  // The exact build's own test, so the card never offers a face it refuses.
  return toFaceSignedDistance(basis, {
    point: face.origin,
    normal: face.normal
  });
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
  const toFace = extrudeToFaceTargetFromPick(document, selection, feature);
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
