import { FEATURE_ROLLBACK_SUPPRESSED_METADATA_KEY } from '@openzcad/shared';
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
  if (editing) {
    const earlier = faceAtHistoryPosition(
      document,
      editing,
      selection.bodyId,
      face
    );
    return targetForFace(document, earlier.bodyId, earlier.face);
  }
  return targetForFace(document, selection.bodyId, face);
}

/**
 * The lineage a boolean (an add/cut/intersect extrude or a Boolean feature)
 * gives the faces it carries from an input: `boolean.face.<slot>.<input
 * lineage>`, where the slot is `target`, `tool` or `operand.<index>`.
 */
const CARRIED_FACE = /^boolean\.face\.(target|tool|operand\.(\d+))\.(.+)$/;

/** Where a body comes from in history: its producing feature's position. */
function producerIndex(document: ProjectDocument, bodyId: BodyId): number {
  const body = Object.values(document.nodes).find(
    (node) => node.kind === 'body' && node.bodyId === bodyId
  );
  return body?.kind === 'body'
    ? document.featureOrder.indexOf(body.featureId)
    : -1;
}

/**
 * A face picked on today's model, re-found on the body the edited extrude
 * reads at its own history position. The viewport shows only live bodies,
 * so a face of a body consumed at or after the extrude (by the extrude
 * itself, or by a later Boolean or add/cut) is picked on its consumer's
 * result; its carried lineage names the input slot it came from, and the
 * face with the inner lineage on that input body is the one the extrude
 * reaches. The walk repeats until the body comes from before the extrude.
 * A face the extrusion itself creates, or one whose lineage does not lead
 * back, is refused by name.
 */
function faceAtHistoryPosition(
  document: ProjectDocument,
  editing: FeatureNode,
  bodyId: BodyId,
  face: FaceTopology | undefined
): { bodyId: BodyId; face: FaceTopology | undefined } {
  const position = document.featureOrder.indexOf(editing.featureId);
  const features = listFeaturesInOrder(document);
  let current = { bodyId, face };
  for (let step = 0; step < features.length; step += 1) {
    const at = producerIndex(document, current.bodyId);
    if (at >= 0 && at < position) return current;
    const reference = current.face?.reference;
    const match = reference ? CARRIED_FACE.exec(reference.lineageName) : null;
    const producer = features.find(
      (feature) => feature.featureId === reference?.producingFeatureId
    );
    if (!match || !producer) break;
    const [, slot, index, inner] = match;
    if (producer.featureId === editing.featureId && slot === 'tool') {
      throw new Error(
        'That face is made by this extrusion itself; pick a face it does not create.'
      );
    }
    const data = producer.data;
    const input =
      data.featureKind === 'boolean'
        ? data.targetBodyIds[
            index !== undefined ? Number(index) : slot === 'target' ? 0 : -1
          ]
        : data.featureKind === 'extrude' && slot === 'target'
          ? data.targetBodyId
          : undefined;
    const original = input
      ? document.derived.bodyRepresentations[input]?.topology?.faces.find(
          (candidate) => candidate.reference?.lineageName === inner
        )
      : undefined;
    if (!input || !original) break;
    current = { bodyId: input, face: original };
  }
  if (
    current.face?.reference?.producingFeatureId === editing.featureId ||
    current.bodyId === editing.bodyId
  ) {
    throw new Error(
      'That face is made by this extrusion itself; pick a face it does not create.'
    );
  }
  throw new Error(
    'That face cannot be traced back to a body made before this extrusion; pick a face that existed when it was made.'
  );
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

/** Read-only replay input immediately before an existing extrusion. */
export function extrudeHistoryDocument(
  document: ProjectDocument,
  featureId: FeatureId
): ProjectDocument {
  const features = listFeaturesInOrder(document);
  const index = features.findIndex(
    (feature) => feature.featureId === featureId
  );
  if (index < 0)
    throw new Error('The extrusion is no longer in this document.');
  const nodes = { ...document.nodes };
  for (const feature of features.slice(index)) {
    nodes[feature.id] = {
      ...feature,
      metadata: {
        ...feature.metadata,
        [FEATURE_ROLLBACK_SUPPRESSED_METADATA_KEY]: true
      }
    };
  }
  return { ...document, nodes };
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
