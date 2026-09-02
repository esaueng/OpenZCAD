import { listFeaturesInOrder } from '@openzcad/document-core';
import {
  isFeatureSuppressed,
  type BodyId,
  type FaceTopologyReferenceV5,
  type FeatureNode,
  type ProjectDocument
} from '@openzcad/shared';

/**
 * The far cap of a one-sided extrude, under every vocabulary that names it:
 * the whole-sketch and region builders' own role, and the same role carried
 * through the add/cut boolean as the tool operand's cap.
 */
const FAR_CAP_LINEAGE =
  /^(?:boolean\.face\.tool\.)?sweep\.face\.cap\.end(?:\.|$)/;

export interface ExtrudeCapAncestor {
  feature: FeatureNode;
  /** The stored distance, as a number; an expression fails closed. */
  distance: number;
  /**
   * The sign a drag along the cap's outward normal applies to the stored
   * signed distance. A boss or a free body grows away from its sketch, so
   * the drag carries the distance's own sign; a pocket's floor faces back
   * out of the hole, so pulling it outward adds to a negative distance and
   * the cut gets shallower.
   */
  sense: 1 | -1;
}

/**
 * The extrude whose far cap the picked face is, when that is proven by
 * lineage rather than guessed from geometry.
 *
 * Only the extrude's own output body qualifies: a modifier downstream
 * republishes the cap under its own vocabulary, and the primitive ancestry
 * helpers already decide what a drag means there. Two-sided extrusions are
 * refused because the far cap is one of two faces the distance moves.
 */
export function extrudeCapAncestor(
  document: ProjectDocument,
  bodyId: BodyId,
  faceReference: FaceTopologyReferenceV5 | undefined,
  faceHash: number
): ExtrudeCapAncestor | null {
  if (
    !faceReference ||
    faceReference.currentHash !== faceHash ||
    !FAR_CAP_LINEAGE.test(faceReference.lineageName)
  ) {
    return null;
  }
  const feature = listFeaturesInOrder(document).find(
    (candidate) => candidate.featureId === faceReference.producingFeatureId
  );
  if (
    !feature ||
    feature.bodyId !== bodyId ||
    isFeatureSuppressed(feature) ||
    feature.data.featureKind !== 'extrude'
  ) {
    return null;
  }
  const { distance, symmetric, backDistance, operation } = feature.data;
  if (
    symmetric ||
    (backDistance !== undefined && backDistance !== 0) ||
    typeof distance !== 'number' ||
    !(Math.abs(distance) > 0)
  ) {
    return null;
  }
  const outward: 1 | -1 = distance > 0 ? 1 : -1;
  return {
    feature,
    distance,
    sense: operation === 'cut' ? (outward === 1 ? -1 : 1) : outward
  };
}
