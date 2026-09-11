import {
  createBodyFeatureIds,
  createFeatureOnlyIds,
  createSketchFeatureIds,
  findSketch,
  listFeaturesInOrder
} from '@openzcad/document-core';
import type {
  BodyId,
  FeatureNode,
  ParamValue,
  PlaneId,
  ProjectDocument,
  SketchObjectData,
  Vector3
} from '@openzcad/shared';
import { commandFactories, composeCommands, type AnyCommand } from './index';

/**
 * Feature metadata key under which the compiled union carries its recipe, as
 * JSON. The preview and later tooling read the recipe back from here and then
 * verify the surrounding history against it; the metadata alone proves nothing.
 */
export const GROWING_HOLDER_RECIPE_METADATA_KEY = 'openzcad.growingHolderRecipe';

export type OpeningAxis = 'x' | 'y' | 'z';

export interface Box3 {
  min: Vector3;
  max: Vector3;
}

/**
 * A measured description of one opening in an imported solid whose two ends
 * are rigid and whose connecting section is straight. Every value is in
 * document units and in the source's own coordinate frame; nothing here is
 * inferred by the compiler. Version 1; later versions add fields, never
 * reinterpret these.
 */
export interface GrowingHolderRecipe {
  version: 1;
  name: string;
  /** The unmodified imported STEP body the recipe carves. */
  targetBodyId: BodyId;
  /** World axis along which the opening is measured and the ends move. */
  axis: OpeningAxis;
  /** Measured bounds of the source; the retained ends are carved inside them. */
  envelope: Box3;
  /**
   * Coordinates along `axis` of the two cut planes. Material outside them is
   * retained exactly; the straight section between them is replaced.
   */
  cuts: [number, number];
  /** Coordinate along `axis` about which both ends move symmetrically. */
  center: number;
  /** Opening measured on the source; the parameter's initial value. */
  sourceOpening: number;
  /** Parameter that drives the opening; created at `sourceOpening` if absent. */
  parameter: string;
  /** Smallest opening the construction stays valid at (`require_min`). */
  minimumOpening: number;
  /**
   * Closed profile of the replaced section, drawn in the canonical sketch
   * plane perpendicular to `axis` (u, v per that plane's basis). Numeric
   * lines and arcs only: the section is measured, not parameterized.
   */
  section: SketchObjectData[];
}

/** Expressions and frame the compiler emits and the preview verifies. */
export interface GrowingHolderPlan {
  plane: PlaneId;
  axisIndex: 0 | 1 | 2;
  /** Guarded opening: `require_min(parameter, minimumOpening)`. */
  width: string;
  /** Sketch-plane offset along the axis: the negative cut, moved with its end. */
  sectionOffset: string;
  /** Bridge length: the replaced section grown by the opening change. */
  bridgeLength: string;
  negativeShift: string;
  positiveShift: string;
  /** Box masks that keep each end: everything outside its cut plane. */
  masks: { negative: Box3; positive: Box3 };
}

const PLANE_FOR_AXIS: Record<OpeningAxis, PlaneId> = {
  x: 'YZ',
  y: 'XZ',
  z: 'XY'
};
const AXIS_INDEX: Record<OpeningAxis, 0 | 1 | 2> = { x: 0, y: 1, z: 2 };
const AXES = ['x', 'y', 'z'] as const;

const literal = (value: number): string =>
  value < 0 ? `(${value})` : String(value);

export function growingHolderPlan(recipe: GrowingHolderRecipe): GrowingHolderPlan {
  const width = `require_min(${recipe.parameter}, ${literal(recipe.minimumOpening)})`;
  const source = literal(recipe.sourceOpening);
  const { min, max } = recipe.envelope;
  // Masks overshoot the envelope so a face lying exactly on it is kept whole.
  const margin =
    1 + 0.05 * Math.max(...AXES.map((axis) => max[axis] - min[axis]));
  // Rounded so the emitted literals stay short and digest-stable.
  const tidy = (value: number) => Math.round(value * 1e9) / 1e9;
  const grown = (side: 'min' | 'max'): Vector3 => ({
    x: tidy(side === 'min' ? min.x - margin : max.x + margin),
    y: tidy(side === 'min' ? min.y - margin : max.y + margin),
    z: tidy(side === 'min' ? min.z - margin : max.z + margin)
  });
  const negative = { min: grown('min'), max: grown('max') };
  negative.max[recipe.axis] = recipe.cuts[0];
  const positive = { min: grown('min'), max: grown('max') };
  positive.min[recipe.axis] = recipe.cuts[1];
  return {
    plane: PLANE_FOR_AXIS[recipe.axis],
    axisIndex: AXIS_INDEX[recipe.axis],
    width,
    sectionOffset: `${literal(recipe.cuts[0])} + (${source} - (${width})) / 2`,
    bridgeLength: `${literal(recipe.cuts[1] - recipe.cuts[0])} + (${width}) - ${source}`,
    negativeShift: `(${source} - (${width})) / 2`,
    positiveShift: `((${width}) - ${source}) / 2`,
    masks: { negative, positive }
  };
}

const isNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);

const isVector = (value: unknown): value is Vector3 =>
  !!value &&
  typeof value === 'object' &&
  AXES.every((axis) => isNumber((value as Record<string, unknown>)[axis]));

function isNumericSectionObject(object: unknown): object is SketchObjectData {
  if (!object || typeof object !== 'object') return false;
  const data = object as Record<string, unknown>;
  const fields =
    data.objectKind === 'line'
      ? ['x1', 'y1', 'x2', 'y2']
      : data.objectKind === 'arc'
        ? ['centerX', 'centerY', 'radius', 'startAngleDeg', 'endAngleDeg']
        : null;
  return (
    fields !== null &&
    Object.keys(data).length === fields.length + 1 &&
    fields.every((field) => isNumber(data[field]))
  );
}

/** Throws with the first structural or numeric defect of a recipe. */
export function validateGrowingHolderRecipe(
  recipe: GrowingHolderRecipe
): void {
  if (recipe.version !== 1)
    throw new Error('Unsupported growing-holder recipe version.');
  if (typeof recipe.name !== 'string' || !recipe.name.trim())
    throw new Error('A growing-holder recipe needs a name.');
  if (typeof recipe.targetBodyId !== 'string' || !recipe.targetBodyId)
    throw new Error('A growing-holder recipe needs a target body.');
  if (!(recipe.axis in PLANE_FOR_AXIS))
    throw new Error('The opening axis must be x, y or z.');
  if (
    !recipe.envelope ||
    !isVector(recipe.envelope.min) ||
    !isVector(recipe.envelope.max) ||
    AXES.some((axis) => recipe.envelope.min[axis] >= recipe.envelope.max[axis])
  )
    throw new Error('The source envelope must be finite with positive extent.');
  if (
    !Array.isArray(recipe.cuts) ||
    recipe.cuts.length !== 2 ||
    !isNumber(recipe.cuts[0]) ||
    !isNumber(recipe.cuts[1]) ||
    recipe.cuts[0] >= recipe.cuts[1]
  )
    throw new Error('Cut planes must be two finite, increasing coordinates.');
  const lo = recipe.envelope.min[recipe.axis];
  const hi = recipe.envelope.max[recipe.axis];
  if (recipe.cuts[0] <= lo || recipe.cuts[1] >= hi)
    throw new Error(
      `Cut planes must lie inside the source along ${recipe.axis} (${lo} to ${hi}).`
    );
  if (
    !isNumber(recipe.center) ||
    recipe.center <= recipe.cuts[0] ||
    recipe.center >= recipe.cuts[1]
  )
    throw new Error('The symmetry center must lie between the cut planes.');
  if (!isNumber(recipe.sourceOpening) || recipe.sourceOpening <= 0)
    throw new Error('The source opening must be positive.');
  if (typeof recipe.parameter !== 'string' || !recipe.parameter)
    throw new Error('A growing-holder recipe needs a parameter name.');
  if (!isNumber(recipe.minimumOpening) || recipe.minimumOpening <= 0)
    throw new Error('The minimum opening must be positive.');
  if (recipe.minimumOpening > recipe.sourceOpening)
    throw new Error('The minimum opening cannot exceed the source opening.');
  const sectionLength = recipe.cuts[1] - recipe.cuts[0];
  if (sectionLength + recipe.minimumOpening - recipe.sourceOpening <= 0)
    throw new Error(
      'The bridge would vanish at the minimum opening; raise the minimum or widen the cuts.'
    );
  if (
    !Array.isArray(recipe.section) ||
    recipe.section.length < 2 ||
    !recipe.section.every(isNumericSectionObject)
  )
    throw new Error(
      'The section profile needs at least two numeric lines or arcs.'
    );
}

function sourceFeature(
  document: ProjectDocument,
  targetBodyId: BodyId
): FeatureNode {
  const features = listFeaturesInOrder(document);
  const index = features.findIndex(
    (f) => f.bodyId === targetBodyId && f.data.featureKind === 'imported-step'
  );
  const source = features[index];
  if (!source || source.data.featureKind !== 'imported-step')
    throw new Error('Growing-holder recipes require an imported STEP source.');
  if (
    features
      .slice(index + 1)
      .some(
        (f) =>
          ('targetBodyId' in f.data && f.data.targetBodyId === targetBodyId) ||
          ('targetBodyIds' in f.data &&
            f.data.targetBodyIds.includes(targetBodyId))
      )
  )
    throw new Error('Growing-holder recipes require an unmodified imported source.');
  return source;
}

function hasParameter(document: ProjectDocument, name: string): boolean {
  return Object.values(document.nodes).some(
    (node) => node.kind === 'parameter' && node.name === name
  );
}

export interface GrowingHolderCompilation {
  command: AnyCommand;
  /** The joined holder. */
  bodyId: BodyId;
  /** Consumed operands, useful for tests and previews. */
  negativeEndBodyId: BodyId;
  positiveEndBodyId: BodyId;
  bridgeBodyId: BodyId;
}

const boxDimensions = (box: Box3) => ({
  width: Math.round((box.max.x - box.min.x) * 1e9) / 1e9,
  height: Math.round((box.max.y - box.min.y) * 1e9) / 1e9,
  depth: Math.round((box.max.z - box.min.z) * 1e9) / 1e9
});

/**
 * Compile a measured recipe into ordinary history. Each end is the exact
 * intersection of the source with a box mask outside its cut plane — the
 * positive end from a second reference to the same import, because a Boolean
 * consumes its operands and the kernel's plane split cannot cross the curved
 * faces of a real section. A sketch and extrusion rebuild the straight
 * section at the parametric length, the ends move symmetrically, and one
 * union joins the holder. Nothing is inferred and the source is not edited.
 *
 * The end carving reads no parameter, so its checkpoints survive every
 * opening edit; only the bridge, the moves and the union rebuild.
 */
export function growingHolderCommand(
  document: ProjectDocument,
  recipe: GrowingHolderRecipe
): GrowingHolderCompilation {
  validateGrowingHolderRecipe(recipe);
  const source = sourceFeature(document, recipe.targetBodyId);
  if (source.data.featureKind !== 'imported-step') throw new Error('unreachable');
  const plan = growingHolderPlan(recipe);
  const commands: AnyCommand[] = [];
  if (!hasParameter(document, recipe.parameter))
    commands.push(
      commandFactories.setParameter({
        name: recipe.parameter,
        expression: String(recipe.sourceOpening)
      })
    );
  const copy = createBodyFeatureIds();
  commands.push(
    commandFactories.importStep({
      name: `${recipe.name}: positive source`,
      ...source.data,
      ids: copy
    })
  );
  const carve = (
    side: 'negative' | 'positive',
    sourceBodyId: BodyId
  ): BodyId => {
    const box = plan.masks[side];
    const mask = createBodyFeatureIds();
    commands.push(
      commandFactories.addPrimitive({
        name: `${recipe.name}: ${side} mask`,
        primitiveKind: 'box',
        dimensions: boxDimensions(box),
        ids: mask
      })
    );
    commands.push(
      commandFactories.transformBody({
        name: `${recipe.name}: ${side} mask placement`,
        targetBodyId: mask.bodyId,
        translation: box.min,
        ids: createFeatureOnlyIds()
      })
    );
    const end = createBodyFeatureIds();
    commands.push(
      commandFactories.booleanBodies({
        name: `${recipe.name}: ${side} end`,
        operation: 'intersect',
        targetBodyIds: [sourceBodyId, mask.bodyId],
        ids: end
      })
    );
    return end.bodyId;
  };
  const negativeEnd = carve('negative', recipe.targetBodyId);
  const positiveEnd = carve('positive', copy.bodyId);
  const section = createSketchFeatureIds(recipe.section.length);
  commands.push(
    commandFactories.addSketch({
      name: `${recipe.name}: bridge section`,
      planeRef: {
        type: 'canonical',
        plane: plan.plane,
        offset: plan.sectionOffset
      },
      objects: recipe.section,
      ids: section
    })
  );
  const bridge = createBodyFeatureIds();
  commands.push(
    commandFactories.extrudeSketch({
      name: `${recipe.name}: bridge`,
      sketchId: section.sketchId,
      distance: plan.bridgeLength,
      profile: { all: true, sourceEntityIds: section.objectNodeIds },
      ids: bridge
    })
  );
  const shift = (side: 'negative' | 'positive'): Record<OpeningAxis, ParamValue> => {
    const translation: Record<OpeningAxis, ParamValue> = { x: 0, y: 0, z: 0 };
    translation[recipe.axis] =
      side === 'negative' ? plan.negativeShift : plan.positiveShift;
    return translation;
  };
  commands.push(
    commandFactories.transformBody({
      name: `${recipe.name}: negative end position`,
      targetBodyId: negativeEnd,
      translation: shift('negative'),
      ids: createFeatureOnlyIds()
    })
  );
  commands.push(
    commandFactories.transformBody({
      name: `${recipe.name}: positive end position`,
      targetBodyId: positiveEnd,
      translation: shift('positive'),
      ids: createFeatureOnlyIds()
    })
  );
  const result = createBodyFeatureIds();
  commands.push(
    commandFactories.booleanBodies({
      name: recipe.name,
      operation: 'union',
      targetBodyIds: [negativeEnd, bridge.bodyId, positiveEnd],
      ids: result
    })
  );
  commands.push(
    commandFactories.setNodeMetadata({
      nodeId: result.featureNodeId,
      metadata: { [GROWING_HOLDER_RECIPE_METADATA_KEY]: JSON.stringify(recipe) }
    })
  );
  return {
    command: composeCommands(recipe.name, commands),
    bodyId: result.bodyId,
    negativeEndBodyId: negativeEnd,
    positiveEndBodyId: positiveEnd,
    bridgeBodyId: bridge.bodyId
  };
}

/** The compiled features of one recipe, resolved from a document. */
export interface GrowingHolderHistory {
  recipe: GrowingHolderRecipe;
  plan: GrowingHolderPlan;
  source: FeatureNode;
  sourceCopy: FeatureNode;
  negativeEnd: FeatureNode;
  positiveEnd: FeatureNode;
  sketch: FeatureNode;
  bridge: FeatureNode;
  negativeMove: FeatureNode;
  positiveMove: FeatureNode;
  union: FeatureNode;
  negativeEndBodyId: BodyId;
  positiveEndBodyId: BodyId;
  bridgeBodyId: BodyId;
  resultBodyId: BodyId;
}

function parseRecipe(value: unknown): GrowingHolderRecipe | null {
  if (typeof value !== 'string') return null;
  try {
    const recipe = JSON.parse(value) as GrowingHolderRecipe;
    validateGrowingHolderRecipe(recipe);
    return recipe;
  } catch {
    return null;
  }
}

const sameNumbers = (a: unknown, b: unknown): boolean =>
  isNumber(a) && isNumber(b) && a === b;

/** Key-order-independent equality of two flat records of numbers and kinds. */
function sameNumericObject(a: unknown, b: unknown): boolean {
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const keys = Object.keys(left).sort();
  return (
    JSON.stringify(keys) === JSON.stringify(Object.keys(right).sort()) &&
    keys.every((key) =>
      typeof left[key] === 'string'
        ? left[key] === right[key]
        : sameNumbers(left[key], right[key])
    )
  );
}

function translationMatches(
  data: FeatureNode['data'],
  target: BodyId,
  translation: Record<OpeningAxis, ParamValue>
): boolean {
  return (
    data.featureKind === 'transform' &&
    data.targetBodyId === target &&
    AXES.every((axis) =>
      typeof translation[axis] === 'string'
        ? data.transform.translation[axis] === translation[axis]
        : sameNumbers(data.transform.translation[axis], translation[axis])
    ) &&
    Object.values(data.transform.rotationDeg).every((v) => sameNumbers(v, 0)) &&
    (data.transform.scale === undefined || sameNumbers(data.transform.scale, 1))
  );
}

/**
 * Find every growing-holder recipe in a document whose compiled history is
 * intact: the union carries the recipe, and each feature it implies is
 * present, unsuppressed and unchanged from what the compiler emits. A recipe
 * whose history was edited by hand is not returned — the caller must not
 * assume its geometry.
 */
export function growingHolderHistories(
  document: ProjectDocument
): GrowingHolderHistory[] {
  const features = listFeaturesInOrder(document);
  const byBody = new Map<BodyId, FeatureNode>();
  for (const feature of features)
    if (feature.bodyId && !byBody.has(feature.bodyId))
      byBody.set(feature.bodyId, feature);
  const live = (feature: FeatureNode | undefined): feature is FeatureNode =>
    !!feature &&
    !feature.metadata?.suppressed &&
    !feature.metadata?.rollbackSuppressed;
  const moves = features.filter((f) => f.data.featureKind === 'transform');
  /** The one live transform that moves `target` exactly by `translation`. */
  const soleMove = (
    target: BodyId,
    translation: Record<OpeningAxis, ParamValue>
  ): FeatureNode | null => {
    const targeting = moves.filter(
      (f) => f.data.featureKind === 'transform' && f.data.targetBodyId === target
    );
    const match = targeting[0];
    return targeting.length === 1 &&
      live(match) &&
      translationMatches(match.data, target, translation)
      ? match
      : null;
  };
  /** The live intersect of `sourceBody` with a placed box mask of `box`. */
  const carvedEnd = (
    endBody: BodyId,
    sourceBody: BodyId,
    box: Box3
  ): FeatureNode | null => {
    const end = byBody.get(endBody);
    if (
      !live(end) ||
      end.data.featureKind !== 'boolean' ||
      end.data.operation !== 'intersect' ||
      end.data.activeWhen !== undefined ||
      end.data.targetBodyIds.length !== 2 ||
      end.data.targetBodyIds[0] !== sourceBody
    )
      return null;
    const maskBody = end.data.targetBodyIds[1]!;
    const mask = byBody.get(maskBody);
    const dimensions = boxDimensions(box);
    if (
      !live(mask) ||
      mask.data.featureKind !== 'primitive' ||
      mask.data.primitiveKind !== 'box' ||
      !sameNumericObject(mask.data.dimensions, dimensions) ||
      !soleMove(maskBody, box.min)
    )
      return null;
    return end;
  };
  const histories: GrowingHolderHistory[] = [];
  for (const union of features) {
    const recipe = parseRecipe(
      union.metadata?.[GROWING_HOLDER_RECIPE_METADATA_KEY]
    );
    if (!recipe || !live(union) || !union.bodyId) continue;
    const plan = growingHolderPlan(recipe);
    const data = union.data;
    if (
      data.featureKind !== 'boolean' ||
      data.operation !== 'union' ||
      data.activeWhen !== undefined ||
      data.targetBodyIds.length !== 3
    )
      continue;
    const [negativeEndBody, bridgeBody, positiveEndBody] =
      data.targetBodyIds as [BodyId, BodyId, BodyId];
    const source = byBody.get(recipe.targetBodyId);
    if (!live(source) || source.data.featureKind !== 'imported-step') continue;
    const negativeEnd = carvedEnd(
      negativeEndBody,
      recipe.targetBodyId,
      plan.masks.negative
    );
    if (!negativeEnd) continue;
    const positiveEndFeature = byBody.get(positiveEndBody);
    const copyBody =
      positiveEndFeature?.data.featureKind === 'boolean'
        ? positiveEndFeature.data.targetBodyIds[0]
        : undefined;
    const sourceCopy = copyBody ? byBody.get(copyBody) : undefined;
    if (
      !copyBody ||
      !live(sourceCopy) ||
      sourceCopy.data.featureKind !== 'imported-step' ||
      JSON.stringify(sourceCopy.data) !== JSON.stringify(source.data)
    )
      continue;
    const positiveEnd = carvedEnd(positiveEndBody, copyBody, plan.masks.positive);
    if (!positiveEnd) continue;
    const bridge = byBody.get(bridgeBody);
    if (!live(bridge)) continue;
    const bridgeData = bridge.data;
    if (
      bridgeData.featureKind !== 'extrude' ||
      bridgeData.distance !== plan.bridgeLength ||
      bridgeData.symmetric ||
      bridgeData.backDistance !== undefined ||
      (bridgeData.operation && bridgeData.operation !== 'new-body')
    )
      continue;
    const sketchNode = findSketch(document, bridgeData.sketchId);
    const sketch = features.find(
      (f) =>
        f.data.featureKind === 'sketch' &&
        f.data.sketchId === bridgeData.sketchId
    );
    if (
      !sketchNode ||
      !live(sketch) ||
      sketchNode.constraints?.length ||
      sketchNode.planeRef.type !== 'canonical' ||
      sketchNode.planeRef.plane !== plan.plane ||
      sketchNode.planeRef.offset !== plan.sectionOffset ||
      sketchNode.objectIds.length !== recipe.section.length ||
      sketchNode.objectIds.some((id, index) => {
        const node = document.nodes[id];
        return (
          node?.kind !== 'sketch-object' ||
          !sameNumericObject(node.data, recipe.section[index])
        );
      })
    )
      continue;
    const shift = (expression: string): Record<OpeningAxis, ParamValue> => {
      const translation: Record<OpeningAxis, ParamValue> = { x: 0, y: 0, z: 0 };
      translation[recipe.axis] = expression;
      return translation;
    };
    const negativeMove = soleMove(negativeEndBody, shift(plan.negativeShift));
    const positiveMove = soleMove(positiveEndBody, shift(plan.positiveShift));
    if (!negativeMove || !positiveMove) continue;
    histories.push({
      recipe,
      plan,
      source,
      sourceCopy,
      negativeEnd,
      positiveEnd,
      sketch,
      bridge,
      negativeMove,
      positiveMove,
      union,
      negativeEndBodyId: negativeEndBody,
      positiveEndBodyId: positiveEndBody,
      bridgeBodyId: bridgeBody,
      resultBodyId: union.bodyId
    });
  }
  return histories;
}
