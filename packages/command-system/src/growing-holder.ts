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
import type { RecognizedOpening } from '@openzcad/shared';
import { commandFactories, composeCommands, type AnyCommand } from './index';

export const GROWING_HOLDER_HEIGHT_PARAMETER = 'holder_height';

/**
 * A recipe from an app measurement: the opening's values verbatim, the
 * height's values verbatim when measured, plus the names the recipe needs.
 */
export function recipeFromRecognizedOpening(
  opening: RecognizedOpening,
  names: {
    name: string;
    targetBodyId: BodyId;
    parameter: string;
    heightParameter?: string | null;
  }
): GrowingHolderRecipe {
  const { height, ...measured } = opening;
  return {
    version: 1,
    name: names.name,
    targetBodyId: names.targetBodyId,
    parameter: names.parameter,
    ...measured,
    ...(height
      ? {
          height: {
            axis: height.axis,
            cuts: height.cuts,
            sourceHeight: height.sourceHeight,
            minimumHeight: height.minimumHeight,
            sections: height.sections,
            parameter: names.heightParameter ?? GROWING_HOLDER_HEIGHT_PARAMETER
          }
        }
      : {})
  };
}

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
 * The arm-height half of a recipe: along `axis` (never the opening axis) each
 * end has a straight section between `cuts`; the material above the upper cut
 * moves up with the height, the material below keeps its place.
 */
export interface GrowingHolderHeight {
  axis: OpeningAxis;
  cuts: [number, number];
  /** Extent of the source along `axis`; the parameter's initial value. */
  sourceHeight: number;
  parameter: string;
  minimumHeight: number;
  /** Closed numeric profile of each end's straight section, in the sketch frame. */
  sections: { negative: SketchObjectData[]; positive: SketchObjectData[] };
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
  /** Optional arm-height control; additive, absent on older recipes. */
  height?: GrowingHolderHeight;
}

/** A rigid piece of the source: the intersection with `mask`, then moved. */
export interface GrowingHolderPiece {
  key: string;
  mask: Box3;
  /** Translation per axis: an expression, or 0. */
  move: Record<OpeningAxis, ParamValue>;
}

/** A rebuilt straight section: a sketch extruded by a parametric length. */
export interface GrowingHolderBridge {
  key: string;
  plane: PlaneId;
  /** Which axis the extrusion runs along. */
  axis: OpeningAxis;
  offset: ParamValue;
  section: SketchObjectData[];
  distance: string;
  move: Record<OpeningAxis, ParamValue>;
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
  /** Guarded height and the shift of the upper pieces, when the recipe has one. */
  height?: { value: string; shift: string; bridgeLength: string };
  /** Every carved piece, in union order together with the bridges. */
  pieces: GrowingHolderPiece[];
  bridges: GrowingHolderBridge[];
  /** Keys of pieces and bridges in the order the final union takes them. */
  unionOrder: string[];
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
const tidy = (value: number) => Math.round(value * 1e9) / 1e9;
const zeroMove = (): Record<OpeningAxis, ParamValue> => ({ x: 0, y: 0, z: 0 });

export function growingHolderPlan(recipe: GrowingHolderRecipe): GrowingHolderPlan {
  const width = `require_min(${recipe.parameter}, ${literal(recipe.minimumOpening)})`;
  const source = literal(recipe.sourceOpening);
  const { min, max } = recipe.envelope;
  // Masks overshoot the envelope so a face lying exactly on it is kept whole.
  const margin =
    1 + 0.05 * Math.max(...AXES.map((axis) => max[axis] - min[axis]));
  const grown = (side: 'min' | 'max'): Vector3 => ({
    x: tidy(side === 'min' ? min.x - margin : max.x + margin),
    y: tidy(side === 'min' ? min.y - margin : max.y + margin),
    z: tidy(side === 'min' ? min.z - margin : max.z + margin)
  });
  const negative = { min: grown('min'), max: grown('max') };
  negative.max[recipe.axis] = recipe.cuts[0];
  const positive = { min: grown('min'), max: grown('max') };
  positive.min[recipe.axis] = recipe.cuts[1];
  const negativeShift = `(${source} - (${width})) / 2`;
  const positiveShift = `((${width}) - ${source}) / 2`;
  const sectionOffset = `${literal(recipe.cuts[0])} + (${source} - (${width})) / 2`;
  const bridgeLength = `${literal(recipe.cuts[1] - recipe.cuts[0])} + (${width}) - ${source}`;
  const widthBridge: GrowingHolderBridge = {
    key: 'bridge',
    plane: PLANE_FOR_AXIS[recipe.axis],
    axis: recipe.axis,
    offset: sectionOffset,
    section: recipe.section,
    distance: bridgeLength,
    move: zeroMove()
  };
  const base = {
    plane: PLANE_FOR_AXIS[recipe.axis],
    axisIndex: AXIS_INDEX[recipe.axis],
    width,
    sectionOffset,
    bridgeLength,
    negativeShift,
    positiveShift,
    masks: { negative, positive }
  };
  const sideMove = (side: 'negative' | 'positive') => {
    const move = zeroMove();
    move[recipe.axis] = side === 'negative' ? negativeShift : positiveShift;
    return move;
  };
  if (!recipe.height) {
    return {
      ...base,
      pieces: [
        { key: 'negativeEnd', mask: negative, move: sideMove('negative') },
        { key: 'positiveEnd', mask: positive, move: sideMove('positive') }
      ],
      bridges: [widthBridge],
      unionOrder: ['negativeEnd', 'bridge', 'positiveEnd']
    };
  }
  const h = recipe.height;
  const heightValue = `require_min(${h.parameter}, ${literal(h.minimumHeight)})`;
  const heightShift = `(${heightValue}) - ${literal(h.sourceHeight)}`;
  const armLength = `${literal(h.cuts[1] - h.cuts[0])} + (${heightValue}) - ${literal(h.sourceHeight)}`;
  const split = (mask: Box3, part: 'lower' | 'upper'): Box3 => {
    const box = { min: { ...mask.min }, max: { ...mask.max } };
    if (part === 'lower') box.max[h.axis] = h.cuts[0];
    else box.min[h.axis] = h.cuts[1];
    return box;
  };
  const upperMove = (side: 'negative' | 'positive') => {
    const move = sideMove(side);
    move[h.axis] = heightShift;
    return move;
  };
  const armBridge = (side: 'negative' | 'positive'): GrowingHolderBridge => ({
    key: `${side}Arm`,
    plane: PLANE_FOR_AXIS[h.axis],
    axis: h.axis,
    offset: h.cuts[0],
    section: h.sections[side],
    distance: armLength,
    move: sideMove(side)
  });
  return {
    ...base,
    height: { value: heightValue, shift: heightShift, bridgeLength: armLength },
    pieces: [
      { key: 'negativeLower', mask: split(negative, 'lower'), move: sideMove('negative') },
      { key: 'negativeUpper', mask: split(negative, 'upper'), move: upperMove('negative') },
      { key: 'positiveLower', mask: split(positive, 'lower'), move: sideMove('positive') },
      { key: 'positiveUpper', mask: split(positive, 'upper'), move: upperMove('positive') }
    ],
    bridges: [widthBridge, armBridge('negative'), armBridge('positive')],
    unionOrder: [
      'negativeLower',
      'negativeArm',
      'negativeUpper',
      'bridge',
      'positiveLower',
      'positiveArm',
      'positiveUpper'
    ]
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

const isSection = (value: unknown): value is SketchObjectData[] =>
  Array.isArray(value) && value.length >= 2 && value.every(isNumericSectionObject);

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
  if (!isSection(recipe.section))
    throw new Error(
      'The section profile needs at least two numeric lines or arcs.'
    );
  const height = recipe.height;
  if (height === undefined) return;
  if (!(height.axis in PLANE_FOR_AXIS) || height.axis === recipe.axis)
    throw new Error('The height axis must differ from the opening axis.');
  if (
    !Array.isArray(height.cuts) ||
    height.cuts.length !== 2 ||
    !isNumber(height.cuts[0]) ||
    !isNumber(height.cuts[1]) ||
    height.cuts[0] >= height.cuts[1] ||
    height.cuts[0] <= recipe.envelope.min[height.axis] ||
    height.cuts[1] >= recipe.envelope.max[height.axis]
  )
    throw new Error(
      `Height cuts must be two finite, increasing coordinates inside the source along ${height.axis}.`
    );
  if (!isNumber(height.sourceHeight) || height.sourceHeight <= 0)
    throw new Error('The source height must be positive.');
  if (
    typeof height.parameter !== 'string' ||
    !height.parameter ||
    height.parameter === recipe.parameter
  )
    throw new Error('The height needs its own parameter name.');
  if (!isNumber(height.minimumHeight) || height.minimumHeight <= 0)
    throw new Error('The minimum height must be positive.');
  if (height.minimumHeight > height.sourceHeight)
    throw new Error('The minimum height cannot exceed the source height.');
  if (height.cuts[1] - height.cuts[0] + height.minimumHeight - height.sourceHeight <= 0)
    throw new Error(
      'The arm bridge would vanish at the minimum height; raise the minimum or widen the cuts.'
    );
  if (!isSection(height.sections?.negative) || !isSection(height.sections?.positive))
    throw new Error('Each arm section needs at least two numeric lines or arcs.');
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
  /** The piece on each side that keeps the base (and the mounting bore). */
  negativeEndBodyId: BodyId;
  positiveEndBodyId: BodyId;
  /** The width bridge. */
  bridgeBodyId: BodyId;
  /** Every carved piece and rebuilt bridge by layout key. */
  bodies: Record<string, BodyId>;
}

const boxDimensions = (box: Box3) => ({
  width: tidy(box.max.x - box.min.x),
  height: tidy(box.max.y - box.min.y),
  depth: tidy(box.max.z - box.min.z)
});

/**
 * Compile a measured recipe into ordinary history. Each piece is the exact
 * intersection of the source with a box mask — every piece after the first
 * from its own reference to the same import, because a Boolean consumes its
 * operands and the kernel's plane split cannot cross the curved faces of a
 * real section. Sketches and extrusions rebuild each straight section at its
 * parametric length, the pieces move, and one union joins the holder.
 * Nothing is inferred and the source is not edited.
 *
 * The carving reads no parameter, so its checkpoints survive every edit;
 * only the bridges, the moves and the union rebuild.
 */
export function growingHolderCommand(
  document: ProjectDocument,
  recipe: GrowingHolderRecipe
): GrowingHolderCompilation {
  validateGrowingHolderRecipe(recipe);
  const source = sourceFeature(document, recipe.targetBodyId);
  const sourceData = source.data;
  if (sourceData.featureKind !== 'imported-step') throw new Error('unreachable');
  const plan = growingHolderPlan(recipe);
  const commands: AnyCommand[] = [];
  const parameters: [string, number][] = [[recipe.parameter, recipe.sourceOpening]];
  if (recipe.height)
    parameters.push([recipe.height.parameter, recipe.height.sourceHeight]);
  for (const [parameter, value] of parameters)
    if (!hasParameter(document, parameter))
      commands.push(
        commandFactories.setParameter({ name: parameter, expression: String(value) })
      );
  const bodies: Record<string, BodyId> = {};
  plan.pieces.forEach((piece, index) => {
    let sourceBodyId = recipe.targetBodyId;
    if (index > 0) {
      const copy = createBodyFeatureIds();
      commands.push(
        commandFactories.importStep({
          name: `${recipe.name}: source for ${piece.key}`,
          ...sourceData,
          ids: copy
        })
      );
      sourceBodyId = copy.bodyId;
    }
    const mask = createBodyFeatureIds();
    commands.push(
      commandFactories.addPrimitive({
        name: `${recipe.name}: ${piece.key} mask`,
        primitiveKind: 'box',
        dimensions: boxDimensions(piece.mask),
        ids: mask
      })
    );
    commands.push(
      commandFactories.transformBody({
        name: `${recipe.name}: ${piece.key} mask placement`,
        targetBodyId: mask.bodyId,
        translation: piece.mask.min,
        ids: createFeatureOnlyIds()
      })
    );
    const end = createBodyFeatureIds();
    commands.push(
      commandFactories.booleanBodies({
        name: `${recipe.name}: ${piece.key}`,
        operation: 'intersect',
        targetBodyIds: [sourceBodyId, mask.bodyId],
        ids: end
      })
    );
    bodies[piece.key] = end.bodyId;
  });
  for (const bridge of plan.bridges) {
    const section = createSketchFeatureIds(bridge.section.length);
    commands.push(
      commandFactories.addSketch({
        name: `${recipe.name}: ${bridge.key} section`,
        planeRef: { type: 'canonical', plane: bridge.plane, offset: bridge.offset },
        objects: bridge.section,
        ids: section
      })
    );
    const body = createBodyFeatureIds();
    commands.push(
      commandFactories.extrudeSketch({
        name: `${recipe.name}: ${bridge.key}`,
        sketchId: section.sketchId,
        distance: bridge.distance,
        profile: { all: true, sourceEntityIds: section.objectNodeIds },
        ids: body
      })
    );
    bodies[bridge.key] = body.bodyId;
  }
  for (const part of [...plan.pieces, ...plan.bridges]) {
    if (AXES.every((axis) => part.move[axis] === 0)) continue;
    commands.push(
      commandFactories.transformBody({
        name: `${recipe.name}: ${part.key} position`,
        targetBodyId: bodies[part.key]!,
        translation: part.move,
        ids: createFeatureOnlyIds()
      })
    );
  }
  const result = createBodyFeatureIds();
  commands.push(
    commandFactories.booleanBodies({
      name: recipe.name,
      operation: 'union',
      targetBodyIds: plan.unionOrder.map((key) => bodies[key]!),
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
    negativeEndBodyId: bodies[recipe.height ? 'negativeLower' : 'negativeEnd']!,
    positiveEndBodyId: bodies[recipe.height ? 'positiveLower' : 'positiveEnd']!,
    bridgeBodyId: bodies.bridge!,
    bodies
  };
}

/** The compiled features of one recipe, resolved from a document. */
export interface GrowingHolderHistory {
  recipe: GrowingHolderRecipe;
  plan: GrowingHolderPlan;
  source: FeatureNode;
  /** The intersect that carves the piece keeping each side's base. */
  negativeEnd: FeatureNode;
  positiveEnd: FeatureNode;
  /** The width bridge's sketch and extrusion. */
  sketch: FeatureNode;
  bridge: FeatureNode;
  negativeMove: FeatureNode;
  positiveMove: FeatureNode;
  union: FeatureNode;
  negativeEndBodyId: BodyId;
  positiveEndBodyId: BodyId;
  bridgeBodyId: BodyId;
  resultBodyId: BodyId;
  /** Every piece and bridge body by layout key. */
  bodies: Record<string, BodyId>;
  /** The import reference each piece was carved from, by piece key. */
  pieceSources: Record<string, BodyId>;
  /** The intersect feature of each piece, by piece key. */
  pieceFeatures: Record<string, FeatureNode>;
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

const sameValue = (actual: ParamValue | undefined, expected: ParamValue) =>
  typeof expected === 'string' ? actual === expected : sameNumbers(actual, expected);

function translationMatches(
  data: FeatureNode['data'],
  target: BodyId,
  translation: Record<OpeningAxis, ParamValue>
): boolean {
  return (
    data.featureKind === 'transform' &&
    data.targetBodyId === target &&
    AXES.every((axis) => sameValue(data.transform.translation[axis], translation[axis])) &&
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
  /**
   * The one live transform moving `target` exactly by `translation`; `null`
   * when the translation is zero and no transform targets the body; `false`
   * on any other arrangement.
   */
  const movedExactly = (
    target: BodyId,
    translation: Record<OpeningAxis, ParamValue>
  ): FeatureNode | null | false => {
    const targeting = moves.filter(
      (f) => f.data.featureKind === 'transform' && f.data.targetBodyId === target
    );
    if (AXES.every((axis) => translation[axis] === 0))
      return targeting.length === 0 ? null : false;
    const match = targeting[0];
    return targeting.length === 1 &&
      live(match) &&
      translationMatches(match.data, target, translation)
      ? match
      : false;
  };
  /** The live intersect of a source reference with a placed box mask of `box`. */
  const carvedPiece = (
    pieceBody: BodyId,
    box: Box3
  ): { feature: FeatureNode; sourceBody: BodyId } | null => {
    const piece = byBody.get(pieceBody);
    if (
      !live(piece) ||
      piece.data.featureKind !== 'boolean' ||
      piece.data.operation !== 'intersect' ||
      piece.data.activeWhen !== undefined ||
      piece.data.targetBodyIds.length !== 2
    )
      return null;
    const [sourceBody, maskBody] = piece.data.targetBodyIds as [BodyId, BodyId];
    const mask = byBody.get(maskBody);
    if (
      !live(mask) ||
      mask.data.featureKind !== 'primitive' ||
      mask.data.primitiveKind !== 'box' ||
      !sameNumericObject(mask.data.dimensions, boxDimensions(box)) ||
      !movedExactly(maskBody, box.min)
    )
      return null;
    return { feature: piece, sourceBody };
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
      data.targetBodyIds.length !== plan.unionOrder.length
    )
      continue;
    const bodies: Record<string, BodyId> = {};
    plan.unionOrder.forEach((key, index) => {
      bodies[key] = data.targetBodyIds[index]!;
    });
    const source = byBody.get(recipe.targetBodyId);
    if (!live(source) || source.data.featureKind !== 'imported-step') continue;
    let intact = true;
    const pieceFeatures: Record<string, FeatureNode> = {};
    const pieceSources: Record<string, BodyId> = {};
    plan.pieces.forEach((piece, index) => {
      if (!intact) return;
      const carved = carvedPiece(bodies[piece.key]!, piece.mask);
      if (!carved) {
        intact = false;
        return;
      }
      pieceSources[piece.key] = carved.sourceBody;
      if (index === 0) {
        if (carved.sourceBody !== recipe.targetBodyId) intact = false;
      } else {
        const copy = byBody.get(carved.sourceBody);
        if (
          !live(copy) ||
          copy.data.featureKind !== 'imported-step' ||
          JSON.stringify(copy.data) !== JSON.stringify(source.data)
        )
          intact = false;
      }
      if (intact && movedExactly(bodies[piece.key]!, piece.move) === false)
        intact = false;
      pieceFeatures[piece.key] = carved.feature;
    });
    if (!intact) continue;
    const bridgeFeatures: Record<string, { sketch: FeatureNode; extrude: FeatureNode }> = {};
    for (const bridge of plan.bridges) {
      const extrude = byBody.get(bodies[bridge.key]!);
      if (!live(extrude)) {
        intact = false;
        break;
      }
      const extrudeData = extrude.data;
      if (
        extrudeData.featureKind !== 'extrude' ||
        extrudeData.distance !== bridge.distance ||
        extrudeData.symmetric ||
        extrudeData.backDistance !== undefined ||
        (extrudeData.operation && extrudeData.operation !== 'new-body')
      ) {
        intact = false;
        break;
      }
      const sketchNode = findSketch(document, extrudeData.sketchId);
      const sketch = features.find(
        (f) =>
          f.data.featureKind === 'sketch' &&
          f.data.sketchId === extrudeData.sketchId
      );
      if (
        !sketchNode ||
        !live(sketch) ||
        sketchNode.constraints?.length ||
        sketchNode.planeRef.type !== 'canonical' ||
        sketchNode.planeRef.plane !== bridge.plane ||
        !sameValue(sketchNode.planeRef.offset, bridge.offset) ||
        sketchNode.objectIds.length !== bridge.section.length ||
        sketchNode.objectIds.some((id, index) => {
          const node = document.nodes[id];
          return (
            node?.kind !== 'sketch-object' ||
            !sameNumericObject(node.data, bridge.section[index])
          );
        }) ||
        movedExactly(bodies[bridge.key]!, bridge.move) === false
      ) {
        intact = false;
        break;
      }
      bridgeFeatures[bridge.key] = { sketch, extrude };
    }
    if (!intact) continue;
    const baseKeys = recipe.height
      ? (['negativeLower', 'positiveLower'] as const)
      : (['negativeEnd', 'positiveEnd'] as const);
    const negativeMove = movedExactly(
      bodies[baseKeys[0]]!,
      plan.pieces.find((p) => p.key === baseKeys[0])!.move
    );
    const positiveMove = movedExactly(
      bodies[baseKeys[1]]!,
      plan.pieces.find((p) => p.key === baseKeys[1])!.move
    );
    if (!negativeMove || !positiveMove) continue;
    histories.push({
      recipe,
      plan,
      source,
      negativeEnd: pieceFeatures[baseKeys[0]]!,
      positiveEnd: pieceFeatures[baseKeys[1]]!,
      sketch: bridgeFeatures.bridge!.sketch,
      bridge: bridgeFeatures.bridge!.extrude,
      negativeMove,
      positiveMove,
      union,
      negativeEndBodyId: bodies[baseKeys[0]]!,
      positiveEndBodyId: bodies[baseKeys[1]]!,
      bridgeBodyId: bodies.bridge!,
      resultBodyId: union.bodyId,
      bodies,
      pieceSources,
      pieceFeatures
    });
  }
  return histories;
}
