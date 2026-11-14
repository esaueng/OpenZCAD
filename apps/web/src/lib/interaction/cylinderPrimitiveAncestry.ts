import {
  booleanConsumedBodyIds,
  getParameterScope,
  listFeaturesInOrder,
  resolveParamValue
} from '@openzcad/document-core';
import {
  ownEntry,
  isFeatureSuppressed,
  type BodyId,
  type FaceTopologyReferenceV5,
  type FeatureId,
  type BooleanOperation,
  type DirectEditOperation,
  type FeatureNode,
  type PrimitiveKind,
  type ProjectDocument,
  isInPlaceTransform
} from '@openzcad/shared';

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
  /** The boolean the chain crossed, when it crossed one. */
  crossed?: { operation: BooleanOperation; operandIndex: number };
}

/** The feature at the far end of a chain, whose stored value the drag edits. */
export interface ChainSource {
  matches: (feature: FeatureNode) => boolean;
  /**
   * Box roles are recovered in the modifier's axis-aligned frame, so a
   * rotation before that modifier cannot prove the source's local axis.
   */
  axisAligned?: boolean;
  /** Gear teeth cut along a cylinder stay transparent to its height alone. */
  throughGear?: boolean;
}

function primitiveSource(
  primitiveKind: PrimitiveKind,
  dimension: string
): ChainSource {
  return {
    matches: (feature) =>
      feature.data.featureKind === 'primitive' &&
      feature.data.primitiveKind === primitiveKind &&
      (typeof feature.data.dimensions[dimension] === 'number' ||
        // A box side composes a typed expression with the drag.
        (primitiveKind === 'box' &&
          typeof feature.data.dimensions[dimension] === 'string')),
    axisAligned: primitiveKind === 'box',
    throughGear: primitiveKind === 'cylinder' && dimension === 'height'
  };
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
   * Operand positions this crossing may resize, per operation; absent means
   * any consumed operand. A subtract's tools shape only the cut.
   */
  operandIndices?: Partial<
    Record<BooleanOperation, (index: number) => boolean>
  >;
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
  source: ChainSource,
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
  let crossed: PrimitiveChain['crossed'];
  let hasEdgeModifier = false;

  while (!ancestryBodyIds.has(bodyId)) {
    ancestryBodyIds.add(bodyId);
    const producer = producerByBodyId.get(bodyId);
    if (!producer || isFeatureSuppressed(producer)) {
      return null;
    }
    publishers.add(producer.featureId);
    if (source.matches(producer)) {
      primitive = producer;
      break;
    }
    const data = producer.data;
    if (data.featureKind === 'boolean' && unionPath) {
      const operand = data.targetBodyIds[unionPath.operandIndex];
      // Only a construction-named operand face proves which input to resize.
      // Cuts, intersections, nested/shared carriers and kept source bodies
      // cannot inherit this bounded resize contract.
      const operandAllowed =
        unionPath.operandIndices?.[data.operation] ?? (() => true);
      if (
        crossed ||
        (unionPath.requireEdgeModifier && !hasEdgeModifier) ||
        !unionPath.operations.includes(data.operation) ||
        !operandAllowed(unionPath.operandIndex) ||
        producer.featureId !== unionPath.reference.producingFeatureId ||
        !operand ||
        !booleanConsumedBodyIds(data).includes(operand)
      )
        return null;
      crossed = {
        operation: data.operation,
        operandIndex: unionPath.operandIndex
      };
      consumerIndexByBodyId.set(operand, features.indexOf(producer));
      bodyId = operand;
      continue;
    }
    const targetBodyId =
      data.featureKind === 'fillet' || data.featureKind === 'chamfer'
        ? data.targetBodyId
        : // Teeth cut along a cylinder span its whole wall and regenerate at
          // any height, so a cap drag on the gear still means the cylinder's
          // height. Its radius is the gear's to own. Teeth over part of the
          // wall (schema v55) end at shoulders, not at the cylinder's caps.
          data.featureKind === 'gear' &&
            source.throughGear &&
            data.faceWidth === undefined &&
            data.offset === undefined
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

  if (!primitive || (unionPath && !crossed)) {
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
        source.axisAligned &&
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
    ? { primitive, publishers, scale, ...(crossed ? { crossed } : {}) }
    : null;
}

/**
 * Whether a fillet or chamfer in the chain holds an edge pick by hash alone.
 *
 * Resizing a boolean operand makes new seam edges, which nothing but a
 * lineage name can find again, so such a blend would lose its pick (or
 * silently follow the wrong edge) after a source edit.
 */
function chainHasHashOnlyEdgePick(
  document: ProjectDocument,
  chain: PrimitiveChain
): boolean {
  return listFeaturesInOrder(document).some(
    (feature) =>
      chain.publishers.has(feature.featureId) &&
      (feature.data.featureKind === 'fillet' ||
        feature.data.featureKind === 'chamfer') &&
      (feature.data.edgeReferences?.length ?? 0) <
        feature.data.edgeHashes.length
  );
}

/** A planar offset that re-resolves its face by lineage, as WS4 replays it. */
const isLineageOffset = (operation: DirectEditOperation) =>
  operation.kind === 'offset-face' && operation.faceReference !== undefined;

/**
 * Crosses one union or subtract to the consumed operand a face's v5 role
 * names, under the bounded WS4 contract: the role is current and published
 * by a feature in the walked chain, the operand is consumed, kept or copied
 * sources and earlier local edits of the same value stop it, and so does a
 * fillet or chamfer holding a hash-only edge pick.
 *
 * `role` is the operand role with its `boolean.face.operand.N.` prefix
 * already matched: `operandIndex` is that N.
 */
export function booleanOperandSource(
  document: ProjectDocument,
  selectedBodyId: BodyId,
  faceReference: FaceTopologyReferenceV5,
  operandIndex: number,
  source: ChainSource,
  options: {
    operations?: readonly BooleanOperation[];
    operandIndices?: BooleanOperandPath['operandIndices'];
    allowsDirectEdit?: (operation: DirectEditOperation) => boolean;
  } = {}
): PrimitiveChain | null {
  const chain = primitiveChain(document, selectedBodyId, source, {
    reference: faceReference,
    operandIndex,
    operations: options.operations ?? ['union', 'subtract'],
    requireEdgeModifier: false,
    ...(options.operandIndices
      ? { operandIndices: options.operandIndices }
      : {}),
    allowsDirectEdit: options.allowsDirectEdit ?? isLineageOffset
  });
  if (
    !chain?.publishers.has(faceReference.producingFeatureId) ||
    chainHasHashOnlyEdgePick(document, chain)
  )
    return null;
  return chain;
}

/** `boolean.face.operand.N.<role>`, split into N and the operand's own role. */
export function booleanOperandRole(
  lineageName: string
): { operandIndex: number; role: string } | null {
  const match = /^boolean\.face\.operand\.(0|[1-9]\d*)\.(.+)$/.exec(
    lineageName
  );
  return match ? { operandIndex: Number(match[1]), role: match[2]! } : null;
}

/**
 * +1 when the picked face's outward normal is the source face's own; -1 for
 * a subtract tool's face, which the cut turns inside out (a bore's floor is
 * the tool's cap facing back up the bore).
 */
function crossingSense(chain: PrimitiveChain): 1 | -1 {
  return chain.crossed?.operation === 'subtract' &&
    chain.crossed.operandIndex > 0
    ? -1
    : 1;
}

/**
 * A cylinder wall that survived a union or subtract, named for the operand
 * it came from. The K10 combination matrix qualifies a source radius edit
 * across both operations, including where a direct wall resize is refused
 * (a boss or bore meeting a sphere).
 */
const CYLINDER_WALL_ROLE = /^(?:primitive|modifier)\.cylinder\.face\.wall$/;

function cylinderRadiusChain(
  document: ProjectDocument,
  selectedBodyId: BodyId,
  faceReference?: FaceTopologyReferenceV5,
  faceHash?: number
): PrimitiveChain | null {
  const operand =
    faceReference && faceReference.currentHash === faceHash
      ? booleanOperandRole(faceReference.lineageName)
      : null;
  if (!operand || !faceReference || !CYLINDER_WALL_ROLE.test(operand.role)) {
    return primitiveChain(
      document,
      selectedBodyId,
      primitiveSource('cylinder', 'radius')
    );
  }
  // A lineage-resolved planar offset (a cap pushed after the union) is
  // regenerated on the resized operand. A wall resize or any measured edit
  // pins the pre-edit radius and keeps the edit local. A fillet or chamfer
  // holding a hash-only edge pick keeps the local wall resize too, which
  // leaves the seam in place; when the pick is the boss seam itself the
  // kernel's own local resize cannot carry the blend, so the adapter removes
  // the band, resizes the sharp wall and rebuilds the band (WS6 ladder); a
  // seam it cannot prove and rebuild exactly, such as a chamfer, still
  // refuses (`resize_left_blend_behind`) rather than leave the blend behind
  // at the old radius.
  return booleanOperandSource(
    document,
    selectedBodyId,
    faceReference,
    operand.operandIndex,
    primitiveSource('cylinder', 'radius')
  );
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

/**
 * The source edit a cylindrical wall's radius drag makes, when it makes one.
 *
 * `localBlendGroup` says the kernel can resize this wall in place, carrying
 * the blends it touches as one group (a filleted boss on a kernel with blend
 * group edits). That local edit then owns a wall that reaches its primitive
 * only across a boolean: the boss's seam blends are the body's, not the
 * cylinder's, and a source replay at a new radius can lose their edge
 * lineage where the group edit refuses cleanly with a size to try. A
 * cylinder whose own chain of fillets and chamfers is all that stands
 * between the wall and its primitive keeps the source edit: replaying the
 * rim blends on the resized primitive is exact, history stays parametric,
 * and the drag keeps its viewport projection instead of a kernel rebuild
 * per frame.
 */
export function primitiveCylinderRadiusEdit(
  document: ProjectDocument,
  selectedBodyId: BodyId,
  faceReference: FaceTopologyReferenceV5 | undefined,
  faceHash: number | undefined,
  options: { localBlendGroup?: boolean } = {}
): { primitive: FeatureNode; scale: number } | null {
  const chain = cylinderRadiusChain(
    document,
    selectedBodyId,
    faceReference,
    faceHash
  );
  if (!chain || (options.localBlendGroup && chain.crossed)) return null;
  return { primitive: chain.primitive, scale: chain.scale };
}

export interface CylinderCapAncestor {
  primitive: FeatureNode;
  side: 'start' | 'end';
  /** Converts stored primitive dimensions to distances in the selected body's frame. */
  scale: number;
  /**
   * The sign a drag along the picked face's outward normal applies to the
   * height: -1 for a subtract tool's cap, which faces back out of the cut,
   * so pulling a bore's floor outward makes the bore shallower.
   */
  sense: 1 | -1;
}

/**
 * Any earlier lineage-resolved planar offset may replay on the resized
 * operand except one of the operand's own caps: that move has its own
 * baseline, which the stored height must not replace.
 */
function allowsOffsetOtherThan(role: RegExp) {
  return (operation: DirectEditOperation) =>
    isLineageOffset(operation) &&
    operation.kind === 'offset-face' &&
    !role.test(
      booleanOperandRole(operation.faceReference!.lineageName)?.role ??
        operation.faceReference!.lineageName
    );
}

function capAncestor(
  document: ProjectDocument,
  selectedBodyId: BodyId,
  faceReference: FaceTopologyReferenceV5 | undefined,
  faceHash: number,
  primitiveKind: 'cylinder' | 'cone',
  capRole: RegExp
): CylinderCapAncestor | null {
  if (!faceReference || faceReference.currentHash !== faceHash) return null;
  const operand = booleanOperandRole(faceReference.lineageName);
  const match = capRole.exec(operand?.role ?? faceReference.lineageName);
  if (!match) return null;
  const source = primitiveSource(primitiveKind, 'height');
  const chain = operand
    ? booleanOperandSource(
        document,
        selectedBodyId,
        faceReference,
        operand.operandIndex,
        source,
        { allowsDirectEdit: allowsOffsetOtherThan(capRole) }
      )
    : primitiveChain(document, selectedBodyId, source);
  return chain?.publishers.has(faceReference.producingFeatureId)
    ? {
        primitive: chain.primitive,
        side: match[1] as 'start' | 'end',
        scale: chain.scale,
        sense: crossingSense(chain)
      }
    : null;
}

/**
 * Both caps drive the source primitive; the start cap also needs a base
 * shift. A cap named for one consumed operand of a union or subtract
 * crosses that boolean under the {@link booleanOperandSource} contract.
 */
export function primitiveCylinderCapAncestor(
  document: ProjectDocument,
  selectedBodyId: BodyId,
  faceReference: FaceTopologyReferenceV5 | undefined,
  faceHash: number
): CylinderCapAncestor | null {
  return capAncestor(
    document,
    selectedBodyId,
    faceReference,
    faceHash,
    'cylinder',
    CAP_LINEAGE
  );
}

const CONE_CAP_LINEAGE =
  /^(?:primitive|modifier)\.cone\.face\.cap\.(start|end)$/;

/**
 * The cone whose height a cap drag should edit, under the cylinder cap's
 * contract. Both radii stay fixed, so the drag changes the slope the way
 * editing the stored height does.
 */
export function primitiveConeCapAncestor(
  document: ProjectDocument,
  selectedBodyId: BodyId,
  faceReference: FaceTopologyReferenceV5 | undefined,
  faceHash: number
): CylinderCapAncestor | null {
  return capAncestor(
    document,
    selectedBodyId,
    faceReference,
    faceHash,
    'cone',
    CONE_CAP_LINEAGE
  );
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

/**
 * The primitive a curved face of a sphere, cone or torus traces to.
 *
 * There is no radial drag handle for these surfaces yet, so this proves
 * ownership only: selecting a sphere patch, a cone wall or a torus shell
 * opens its source primitive, directly, through fillets and chamfers, or
 * across one union or subtract that consumed it.
 */
const CURVED_PRIMITIVE_ROLE =
  /^primitive\.(sphere|cone|torus)\.face\.(?:z-max|z-min|wall|shell)$/;

export function primitiveCurvedFaceAncestor(
  document: ProjectDocument,
  selectedBodyId: BodyId,
  faceReference: FaceTopologyReferenceV5 | undefined,
  faceHash: number
): FeatureNode | null {
  if (!faceReference || faceReference.currentHash !== faceHash) return null;
  const operand = booleanOperandRole(faceReference.lineageName);
  const match = CURVED_PRIMITIVE_ROLE.exec(
    operand?.role ?? faceReference.lineageName
  );
  if (!match) return null;
  const primitiveKind = match[1] as 'sphere' | 'cone' | 'torus';
  const dimension =
    primitiveKind === 'sphere'
      ? 'radius'
      : primitiveKind === 'cone'
        ? 'height'
        : 'majorRadius';
  const source: ChainSource = {
    matches: (feature) =>
      feature.data.featureKind === 'primitive' &&
      feature.data.primitiveKind === primitiveKind &&
      feature.data.dimensions[dimension] !== undefined
  };
  const chain = operand
    ? booleanOperandSource(
        document,
        selectedBodyId,
        faceReference,
        operand.operandIndex,
        source
      )
    : primitiveChain(document, selectedBodyId, source);
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

const BOOLEAN_BOX_MAX_SIDE = /^(?:primitive|modifier)\.box\.face\.[xyz]-max$/;

export interface BoxFaceAncestor {
  primitive: FeatureNode;
  dimension: BoxDimension;
  axis: BoxAxis;
  side: 'min' | 'max';
  scale: number;
}

/**
 * Whether no face around the picked side traces to a subtract's tool, so a
 * longer target leaves the cut where it was. A tool that bites into the
 * side meets it in a tool-named or unnamed face; one that splits it leaves
 * the halves unnamed, so the side's own role would not be found at all.
 */
function sideClearOfTools(
  document: ProjectDocument,
  bodyId: BodyId,
  faceHash: number
): boolean {
  const topology = ownEntry(
    document.derived.bodyRepresentations,
    bodyId
  )?.topology;
  if (!topology) return false;
  const lineage = new Map(
    topology.faces.map((face) => [face.hash, face.reference?.lineageName])
  );
  const neighbours = topology.edges.flatMap((edge) =>
    edge.adjacentFaceHashes?.includes(faceHash)
      ? edge.adjacentFaceHashes.filter((hash) => hash !== faceHash)
      : []
  );
  // Each operand role a neighbour's name carries must be the target's: a
  // blend band names both faces it runs between.
  return (
    neighbours.length > 0 &&
    neighbours.every((hash) => {
      const name = lineage.get(hash);
      const operands = name?.match(/boolean\.face\.operand\.\d+\./g);
      return (
        operands !== undefined &&
        operands !== null &&
        operands.every((operand) => operand === 'boolean.face.operand.0.')
      );
    })
  );
}

/**
 * The box primitive whose side a planar face drag should resize.
 *
 * Same contract as {@link primitiveCylinderHeightAncestor}: identity is
 * proven by a v5 role published by a feature in the walked chain, never by
 * geometry. A minimum-side edit additionally shifts the primitive base so
 * the opposite side stays fixed. Across a union or subtract only maximum
 * sides qualify: shifting an input's base could move its junction with the
 * other operands. Across a subtract only the target's sides qualify, and
 * only where no tool reaches the side. Either crossing needs a fillet or
 * chamfer after the boolean; without one the plain face offset already
 * resolves the side exactly.
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
  const operand = booleanOperandRole(faceReference.lineageName);
  if (operand && !BOOLEAN_BOX_MAX_SIDE.test(operand.role)) return null;
  const match = BOX_SIDE_LINEAGE.exec(
    operand?.role ?? faceReference.lineageName
  );
  if (!match) {
    return null;
  }
  const axis = match[1] as BoxAxis;
  const side = match[2] as 'min' | 'max';
  const dimension = BOX_DIMENSION_BY_AXIS[axis];
  const chain = primitiveChain(
    document,
    selectedBodyId,
    primitiveSource('box', dimension),
    operand
      ? {
          reference: faceReference,
          operandIndex: operand.operandIndex,
          operations: ['union', 'subtract'],
          operandIndices: { subtract: (index) => index === 0 },
          requireEdgeModifier: true,
          allowsDirectEdit: (operation) =>
            operation.kind === 'offset-face' &&
            Math.abs(operation.sourceNormal[axis]) <= 1e-6
        }
      : undefined
  );
  if (!chain?.publishers.has(faceReference.producingFeatureId)) return null;
  // The union crossing predates the hash-only guard and keeps its contract;
  // the subtract crossing takes the full WS4 one.
  if (
    chain.crossed?.operation === 'subtract' &&
    (chainHasHashOnlyEdgePick(document, chain) ||
      !sideClearOfTools(document, selectedBodyId, faceHash))
  )
    return null;
  return {
    primitive: chain.primitive,
    dimension,
    axis,
    side,
    scale: chain.scale
  };
}
