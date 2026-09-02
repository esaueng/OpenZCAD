import { listFeaturesInOrder } from '@openzcad/document-core';
import {
  isFeatureSuppressed,
  type BodyId,
  type FaceTopologyReferenceV5,
  type FeatureId,
  type FeatureNode,
  type ProjectDocument
} from '@openzcad/shared';

/** Primitive dimension a face drag on a derived body can still drive. */
type CylinderDimension = 'radius' | 'height';
type BoxDimension = 'width' | 'height' | 'depth';
type BoxAxis = 'x' | 'y' | 'z';

/**
 * The top cap under both lineage vocabularies that can name one: a bare
 * cylinder primitive's own roles, and the roles the kernel republishes for a
 * filleted or chamfered cylinder. Both call the axial maximum `cap.end`.
 */
const TOP_CAP_LINEAGE_NAMES = new Set([
  'primitive.cylinder.face.cap.end',
  'modifier.cylinder.face.cap.end'
]);

interface PrimitiveChain {
  primitive: FeatureNode;
  /** Features whose lineage may legitimately name a face on the picked body. */
  publishers: Set<FeatureId>;
}

/**
 * Finds the literal cylinder primitive that owns one selected face, along
 * with the features allowed to have named that face.
 *
 * Fillets and chamfers create new BodyIds, so a face on their result no
 * longer points directly at the primitive. Walk only that uninterrupted
 * result-body ancestry: crossing another body-producing feature would make a
 * primitive dimension edit ambiguous. In-place transforms are deliberately
 * transparent, matching the existing transformed-cylinder behavior.
 *
 * Direct edits in the chain are transparent only for a planar face offset
 * that carries a v5 face reference: it re-resolves its face by lineage and
 * the kernel gates a lineage-resolved offset on orientation alone, so a
 * primitive dimension edit regenerates it exactly. Every other direct edit —
 * an absolute-radius wall resize above all — remains a hard boundary,
 * because its recorded measurements pin the pre-edit geometry.
 */
function primitiveChain(
  document: ProjectDocument,
  selectedBodyId: BodyId,
  primitiveKind: 'cylinder' | 'box',
  dimension: CylinderDimension | BoxDimension
): PrimitiveChain | null {
  const features = listFeaturesInOrder(document);
  const producerByBodyId = new Map(
    features.flatMap((feature) =>
      feature.bodyId ? [[feature.bodyId, feature] as const] : []
    )
  );
  const ancestryBodyIds = new Set<BodyId>();
  const publishers = new Set<FeatureId>();
  const consumerIndexByBodyId = new Map<BodyId, number>();
  let bodyId = selectedBodyId;
  let primitive: FeatureNode | null = null;

  while (!ancestryBodyIds.has(bodyId)) {
    ancestryBodyIds.add(bodyId);
    const producer = producerByBodyId.get(bodyId);
    if (!producer || isFeatureSuppressed(producer)) {
      return null;
    }
    publishers.add(producer.featureId);
    if (
      producer.data.featureKind === 'primitive' &&
      producer.data.primitiveKind === primitiveKind &&
      typeof producer.data.dimensions[dimension] === 'number'
    ) {
      primitive = producer;
      break;
    }
    if (
      producer.data.featureKind !== 'fillet' &&
      producer.data.featureKind !== 'chamfer'
    ) {
      return null;
    }
    consumerIndexByBodyId.set(
      producer.data.targetBodyId,
      features.indexOf(producer)
    );
    bodyId = producer.data.targetBodyId;
  }

  if (!primitive) {
    return null;
  }
  const hasBlockingDirectEdit = features.some((feature, index) => {
    if (
      isFeatureSuppressed(feature) ||
      feature.data.featureKind !== 'direct-edit' ||
      !ancestryBodyIds.has(feature.data.targetBodyId)
    ) {
      return false;
    }
    const producer = producerByBodyId.get(feature.data.targetBodyId);
    const producerIndex = producer ? features.indexOf(producer) : -1;
    const consumerIndex =
      consumerIndexByBodyId.get(feature.data.targetBodyId) ?? features.length;
    if (index <= producerIndex || index >= consumerIndex) {
      return false;
    }
    return !(
      feature.data.operation.kind === 'offset-face' &&
      feature.data.operation.faceReference
    );
  });
  return hasBlockingDirectEdit ? null : { primitive, publishers };
}

/** The primitive a cylindrical wall drag should resize instead of the body. */
export function primitiveCylinderRadiusAncestor(
  document: ProjectDocument,
  selectedBodyId: BodyId
): FeatureNode | null {
  return (
    primitiveChain(document, selectedBodyId, 'cylinder', 'radius')?.primitive ??
    null
  );
}

/**
 * The primitive a top-cap offset should grow instead of push-pulling the cap.
 *
 * Offsetting the cap of a filleted cylinder is not what the gesture means:
 * the blend belongs to the rim, so pushing only the flat remainder leaves a
 * step where the part should simply have become taller. Growing the
 * primitive instead extends the wall and regenerates the fillet at the new
 * rim, which is the whole point of keeping the modifier in history.
 *
 * Identity is proven by role, not geometry. Only a v5 reference naming the
 * axial-maximum cap qualifies, and only when the feature that published that
 * name is one of the features in the walked chain — lineage names are scoped
 * by their producing feature, so a same-named role from anywhere else is not
 * evidence about this face. Everything unproven falls back to the generic
 * offset, which is still exact, just local.
 *
 * Deliberately one-sided: the primitive grows from its base along its axis,
 * so only the far cap moves under a height edit. A start-cap drag has to move
 * the body as well and keeps the existing offset path.
 */
export function primitiveCylinderHeightAncestor(
  document: ProjectDocument,
  selectedBodyId: BodyId,
  faceReference: FaceTopologyReferenceV5 | undefined,
  faceHash: number
): FeatureNode | null {
  if (
    !faceReference ||
    faceReference.currentHash !== faceHash ||
    !TOP_CAP_LINEAGE_NAMES.has(faceReference.lineageName)
  ) {
    return null;
  }
  const chain = primitiveChain(document, selectedBodyId, 'cylinder', 'height');
  return chain?.publishers.has(faceReference.producingFeatureId)
    ? chain.primitive
    : null;
}

/** `makeBox(width, height, depth)` lays those along x, y, z in that order. */
const BOX_DIMENSION_BY_AXIS: Record<BoxAxis, BoxDimension> = {
  x: 'width',
  y: 'height',
  z: 'depth'
};

/**
 * Both vocabularies that name a box side: the primitive's own roles and the
 * roles the kernel republishes for a filleted or chamfered box.
 */
const BOX_SIDE_LINEAGE =
  /^(?:primitive|modifier)\.box\.face\.([xyz])-(min|max)$/;

export interface BoxFaceAncestor {
  primitive: FeatureNode;
  dimension: BoxDimension;
  axis: BoxAxis;
  side: 'min' | 'max';
}

/**
 * The box primitive whose side a planar face drag should resize.
 *
 * Same contract as {@link primitiveCylinderHeightAncestor}: identity is
 * proven by a v5 role published by a feature in the walked chain, never by
 * geometry. The box is anchored at its minimum corner, so only a `max` side
 * moves under a pure dimension edit; the caller decides what a `min` side
 * falls back to.
 */
export function primitiveBoxFaceAncestor(
  document: ProjectDocument,
  selectedBodyId: BodyId,
  faceReference: FaceTopologyReferenceV5 | undefined,
  faceHash: number
): BoxFaceAncestor | null {
  if (!faceReference || faceReference.currentHash !== faceHash) {
    return null;
  }
  const match = BOX_SIDE_LINEAGE.exec(faceReference.lineageName);
  if (!match) {
    return null;
  }
  const axis = match[1] as BoxAxis;
  const side = match[2] as 'min' | 'max';
  const dimension = BOX_DIMENSION_BY_AXIS[axis];
  const chain = primitiveChain(document, selectedBodyId, 'box', dimension);
  return chain?.publishers.has(faceReference.producingFeatureId)
    ? { primitive: chain.primitive, dimension, axis, side }
    : null;
}
