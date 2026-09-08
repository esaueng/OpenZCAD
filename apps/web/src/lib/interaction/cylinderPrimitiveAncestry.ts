import {
  getParameterScope,
  listFeaturesInOrder,
  resolveParamValue
} from '@openzcad/document-core';
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

const CAP_LINEAGE =
  /^(?:primitive|modifier)\.cylinder\.face\.cap\.(start|end)$/;

interface PrimitiveChain {
  primitive: FeatureNode;
  /** Features whose lineage may legitimately name a face on the picked body. */
  publishers: Set<FeatureId>;
  scale: number;
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
  if (hasBlockingDirectEdit) return null;
  let scale = 1;
  const { scope } = getParameterScope(document);
  for (const [index, feature] of features.entries()) {
    if (
      isFeatureSuppressed(feature) ||
      feature.data.featureKind !== 'transform' ||
      !ancestryBodyIds.has(feature.data.targetBodyId)
    )
      continue;
    const producer = producerByBodyId.get(feature.data.targetBodyId);
    const consumerIndex =
      consumerIndexByBodyId.get(feature.data.targetBodyId) ?? features.length;
    if (
      !producer ||
      index <= features.indexOf(producer) ||
      index >= consumerIndex
    )
      continue;
    try {
      scale *= resolveParamValue(
        feature.data.transform.scale ?? 1,
        scope,
        'scale'
      );
    } catch {
      return null;
    }
  }
  return Number.isFinite(scale) && scale > 0
    ? { primitive, publishers, scale }
    : null;
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

export interface CylinderCapAncestor {
  primitive: FeatureNode;
  side: 'start' | 'end';
  /** Converts stored primitive dimensions to distances in the selected body's frame. */
  scale: number;
}

/** Both caps drive the source primitive; the start cap also needs a base shift. */
export function primitiveCylinderCapAncestor(
  document: ProjectDocument,
  selectedBodyId: BodyId,
  faceReference: FaceTopologyReferenceV5 | undefined,
  faceHash: number
): CylinderCapAncestor | null {
  if (!faceReference || faceReference.currentHash !== faceHash) return null;
  const match = CAP_LINEAGE.exec(faceReference.lineageName);
  if (!match) return null;
  const chain = primitiveChain(document, selectedBodyId, 'cylinder', 'height');
  return chain?.publishers.has(faceReference.producingFeatureId)
    ? {
        primitive: chain.primitive,
        side: match[1] as 'start' | 'end',
        scale: chain.scale
      }
    : null;
}

export function primitiveCylinderHeightAncestor(
  document: ProjectDocument,
  selectedBodyId: BodyId,
  faceReference: FaceTopologyReferenceV5 | undefined,
  faceHash: number
): FeatureNode | null {
  return (
    primitiveCylinderCapAncestor(
      document,
      selectedBodyId,
      faceReference,
      faceHash
    )?.primitive ?? null
  );
}

export function primitiveCylinderScale(
  document: ProjectDocument,
  selectedBodyId: BodyId
): number | null {
  return (
    primitiveChain(document, selectedBodyId, 'cylinder', 'radius')?.scale ??
    null
  );
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
