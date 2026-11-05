import {
  booleanConsumedBodyIds,
  getParameterScope,
  listFeaturesInOrder,
  resolveParamValue
} from '@openzcad/document-core';
import {
  isFeatureSuppressed,
  type BodyId,
  type FaceTopologyReferenceV5,
  type FeatureId,
  type BooleanOperation,
  type DirectEditOperation,
  type FeatureNode,
  type ProjectDocument,
  isInPlaceTransform
} from '@openzcad/shared';

/** Primitive dimension a face drag on a derived body can still drive. */
type CylinderDimension = 'radius' | 'height';
type BoxDimension = 'width' | 'height' | 'depth';
type BoxAxis = 'x' | 'y' | 'z';

/**
 * Cap roles, including a gear's: teeth cut along a cylinder name its caps
 * `gear.face.cap.start|end`, at the same ends as the cylinder's own.
 */
const CAP_LINEAGE =
  /^(?:(?:primitive|modifier)\.cylinder|gear)\.face\.cap\.(start|end)$/;

interface PrimitiveChain {
  primitive: FeatureNode;
  /** Features whose lineage may legitimately name a face on the picked body. */
  publishers: Set<FeatureId>;
  scale: number;
}

/**
 * A face whose v5 role names one consumed operand of a boolean, so a
 * dimension drag on it may cross that boolean to the operand's primitive.
 */
interface BooleanOperandPath {
  reference: FaceTopologyReferenceV5;
  operandIndex: number;
  /** Boolean operations this crossing is qualified for. */
  operations: readonly BooleanOperation[];
  /**
   * A box side may cross only after a fillet or chamfer: without one, the
   * plain face offset already resolves the union's side exactly.
   */
  requireEdgeModifier: boolean;
  /**
   * Whether an earlier direct edit downstream of the operand keeps the
   * primitive's stored dimension authoritative.
   */
  allowsDirectEdit: (operation: DirectEditOperation) => boolean;
}

/**
 * Finds the source primitive that owns one selected face, along
 * with the features allowed to have named that face.
 *
 * Fillets and chamfers create new BodyIds, so a face on their result no
 * longer points directly at the primitive; so do gear teeth cut along a
 * cylinder, which stay transparent to its height alone. Walk only that
 * uninterrupted result-body ancestry. A construction-named maximum box side
 * may also cross one union to its consumed operand; other body-producing
 * features make a primitive dimension edit ambiguous. In-place transforms are deliberately
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
  dimension: CylinderDimension | BoxDimension,
  unionPath?: BooleanOperandPath
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
  let crossedUnion = false;
  let hasEdgeModifier = false;

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
      (typeof producer.data.dimensions[dimension] === 'number' ||
        (primitiveKind === 'box' &&
          typeof producer.data.dimensions[dimension] === 'string'))
    ) {
      primitive = producer;
      break;
    }
    const data = producer.data;
    if (data.featureKind === 'boolean' && unionPath) {
      const operand = data.targetBodyIds[unionPath.operandIndex];
      // Only a construction-named operand face proves which input to resize.
      // Cuts, intersections, nested/shared carriers and kept source bodies
      // cannot inherit this bounded resize contract.
      if (
        crossedUnion ||
        (unionPath.requireEdgeModifier && !hasEdgeModifier) ||
        !unionPath.operations.includes(data.operation) ||
        producer.featureId !== unionPath.reference.producingFeatureId ||
        !operand ||
        !booleanConsumedBodyIds(data).includes(operand)
      )
        return null;
      crossedUnion = true;
      consumerIndexByBodyId.set(operand, features.indexOf(producer));
      bodyId = operand;
      continue;
    }
    const targetBodyId =
      data.featureKind === 'fillet' || data.featureKind === 'chamfer'
        ? data.targetBodyId
        : // Teeth cut along a cylinder span its whole wall and regenerate at
          // any height, so a cap drag on the gear still means the cylinder's
          // height. Its radius is the gear's to own.
          data.featureKind === 'gear' &&
            primitiveKind === 'cylinder' &&
            dimension === 'height'
          ? data.targetBodyId
          : undefined;
    if (targetBodyId === undefined) {
      return null;
    }
    hasEdgeModifier ||=
      data.featureKind === 'fillet' || data.featureKind === 'chamfer';
    consumerIndexByBodyId.set(targetBodyId, features.indexOf(producer));
    bodyId = targetBodyId;
  }

  if (!primitive || (unionPath && !crossedUnion)) {
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
  if (
    unionPath &&
    features.some((feature) => {
      if (isFeatureSuppressed(feature) || publishers.has(feature.featureId))
        return false;
      const data = feature.data;
      const inputs =
        'targetBodyIds' in data
          ? data.targetBodyIds
          : 'targetBodyId' in data && data.targetBodyId
            ? [data.targetBodyId]
            : [];
      if (!inputs.some((input) => ancestryBodyIds.has(input))) return false;
      if (data.featureKind === 'direct-edit') {
        // A previous local move of this dimension has its own baseline. Do
        // not replace that baseline with the primitive's stored dimension.
        return !unionPath.allowsDirectEdit(data.operation);
      }
      // A copied/patterned/shared source would resize another branch too.
      return !isInPlaceTransform(data);
    })
  )
    return null;
  let scale = 1;
  const { scope } = getParameterScope(document);
  for (const [index, feature] of features.entries()) {
    if (
      isFeatureSuppressed(feature) ||
      // A copy (M10) scales its own body, not the ancestry it reads.
      !isInPlaceTransform(feature.data) ||
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
      // Modifier box roles are recovered in the modifier's axis-aligned frame.
      // A rotation before that modifier cannot prove the primitive's local axis.
      if (
        primitiveKind === 'box' &&
        (unionPath || consumerIndex < features.length) &&
        [
          feature.data.transform.rotationDeg.x,
          feature.data.transform.rotationDeg.y,
          feature.data.transform.rotationDeg.z
        ].some(
          (value) =>
            resolveParamValue(value, scope, 'rotation', document.units) !== 0
        )
      )
        return null;
      scale *= resolveParamValue(
        feature.data.transform.scale ?? 1,
        scope,
        'scale',
        document.units
      );
    } catch {
      return null;
    }
  }
  return Number.isFinite(scale) && scale > 0
    ? { primitive, publishers, scale }
    : null;
}

/**
 * A cylinder wall that survived a union or subtract, named for the operand
 * it came from. The K10 combination matrix qualifies a source radius edit
 * across both operations, including where a direct wall resize is refused
 * (a boss or bore meeting a sphere).
 */
const BOOLEAN_CYLINDER_WALL_LINEAGE =
  /^boolean\.face\.operand\.(0|[1-9]\d*)\.(?:primitive|modifier)\.cylinder\.face\.wall$/;

function cylinderRadiusChain(
  document: ProjectDocument,
  selectedBodyId: BodyId,
  faceReference?: FaceTopologyReferenceV5,
  faceHash?: number
): PrimitiveChain | null {
  const operand =
    faceReference && faceReference.currentHash === faceHash
      ? BOOLEAN_CYLINDER_WALL_LINEAGE.exec(faceReference.lineageName)
      : null;
  if (!operand || !faceReference) {
    return primitiveChain(document, selectedBodyId, 'cylinder', 'radius');
  }
  const chain = primitiveChain(document, selectedBodyId, 'cylinder', 'radius', {
    reference: faceReference,
    operandIndex: Number(operand[1]),
    operations: ['union', 'subtract'],
    requireEdgeModifier: false,
    // A lineage-resolved planar offset (a cap pushed after the union) is
    // regenerated on the resized operand. A wall resize or any measured
    // edit pins the pre-edit radius and keeps the edit local.
    allowsDirectEdit: (operation) =>
      operation.kind === 'offset-face' && operation.faceReference !== undefined
  });
  if (!chain?.publishers.has(faceReference.producingFeatureId)) return null;
  // A fillet or chamfer after the boolean that holds a hash-only edge pick
  // loses it when the operand changes size: the seam a resized boss makes is
  // a new edge, and nothing but a lineage name can find it again. Keep those
  // chains on the local wall resize, which leaves the seam in place. When
  // the pick is the boss seam itself the local resize cannot carry the blend
  // either, and the adapter refuses it (`resize_left_blend_behind`) rather
  // than leave the blend behind at the old radius: neither route is correct
  // there yet, so the refusal is the answer.
  const pickedByHashOnly = listFeaturesInOrder(document).some(
    (feature) =>
      chain.publishers.has(feature.featureId) &&
      (feature.data.featureKind === 'fillet' ||
        feature.data.featureKind === 'chamfer') &&
      (feature.data.edgeReferences?.length ?? 0) <
        feature.data.edgeHashes.length
  );
  return pickedByHashOnly ? null : chain;
}

/**
 * The primitive a cylindrical wall drag should resize instead of the body.
 * Pass the picked face's v5 reference to let the drag cross one union or
 * subtract that consumed the cylinder.
 */
export function primitiveCylinderRadiusAncestor(
  document: ProjectDocument,
  selectedBodyId: BodyId,
  faceReference?: FaceTopologyReferenceV5,
  faceHash?: number
): FeatureNode | null {
  return (
    cylinderRadiusChain(document, selectedBodyId, faceReference, faceHash)
      ?.primitive ?? null
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
  selectedBodyId: BodyId,
  faceReference?: FaceTopologyReferenceV5,
  faceHash?: number
): number | null {
  return (
    cylinderRadiusChain(document, selectedBodyId, faceReference, faceHash)
      ?.scale ?? null
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

const UNION_BOX_SIDE_LINEAGE =
  /^boolean\.face\.operand\.(0|[1-9]\d*)\.((?:primitive|modifier)\.box\.face\.[xyz]-max)$/;

export interface BoxFaceAncestor {
  primitive: FeatureNode;
  dimension: BoxDimension;
  axis: BoxAxis;
  side: 'min' | 'max';
  scale: number;
}

/**
 * The box primitive whose side a planar face drag should resize.
 *
 * Same contract as {@link primitiveCylinderHeightAncestor}: identity is
 * proven by a v5 role published by a feature in the walked chain, never by
 * geometry. A minimum-side edit additionally shifts the primitive base so
 * the opposite side stays fixed. Across a union only maximum sides qualify:
 * shifting an input's base could move its junction with the other operands.
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
  const union = UNION_BOX_SIDE_LINEAGE.exec(faceReference.lineageName);
  const match = BOX_SIDE_LINEAGE.exec(union?.[2] ?? faceReference.lineageName);
  if (!match) {
    return null;
  }
  const axis = match[1] as BoxAxis;
  const side = match[2] as 'min' | 'max';
  const dimension = BOX_DIMENSION_BY_AXIS[axis];
  const chain = primitiveChain(
    document,
    selectedBodyId,
    'box',
    dimension,
    union
      ? {
          reference: faceReference,
          operandIndex: Number(union[1]),
          operations: ['union'],
          requireEdgeModifier: true,
          allowsDirectEdit: (operation) =>
            operation.kind === 'offset-face' &&
            Math.abs(operation.sourceNormal[axis]) <= 1e-6
        }
      : undefined
  );
  return chain?.publishers.has(faceReference.producingFeatureId)
    ? { primitive: chain.primitive, dimension, axis, side, scale: chain.scale }
    : null;
}
