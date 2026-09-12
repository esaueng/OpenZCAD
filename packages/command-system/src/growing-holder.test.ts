import { describe, expect, it } from 'vitest';
import {
  createProjectDocument,
  evaluateExpression,
  getParameterScope,
  listFeaturesInOrder,
  setParameter
} from '@openzcad/document-core';
import { toUserId, type BodyId, type SketchObjectData } from '@openzcad/shared';
import {
  CommandManager,
  commandFactories,
  GROWING_HOLDER_RECIPE_METADATA_KEY,
  growingHolderCommand,
  growingHolderHistories,
  growingHolderPlan,
  replayCommands,
  validateGrowingHolderRecipe,
  type GrowingHolderRecipe
} from './index';

/** The measured 20 × 8 mm hammer-holder bridge section with R3 upper corners. */
export const hammerSection: SketchObjectData[] = [
  { objectKind: 'line', x1: 39.5, y1: 4.5, x2: 59.5, y2: 4.5 },
  { objectKind: 'line', x1: 59.5, y1: 4.5, x2: 59.5, y2: 9.5 },
  {
    objectKind: 'arc',
    centerX: 56.5,
    centerY: 9.5,
    radius: 3,
    startAngleDeg: 0,
    endAngleDeg: 90
  },
  { objectKind: 'line', x1: 56.5, y1: 12.5, x2: 42.5, y2: 12.5 },
  {
    objectKind: 'arc',
    centerX: 42.5,
    centerY: 9.5,
    radius: 3,
    startAngleDeg: 90,
    endAngleDeg: 180
  },
  { objectKind: 'line', x1: 39.5, y1: 9.5, x2: 39.5, y2: 4.5 }
];

/** The hammer holder as measured on the private source at its 46 mm opening. */
export function hammerRecipe(targetBodyId: BodyId): GrowingHolderRecipe {
  return {
    version: 1,
    name: 'Hammer opening',
    targetBodyId,
    axis: 'x',
    envelope: {
      min: { x: -26, y: 6.5, z: 4.5 },
      max: { x: 48, y: 59.5, z: 62.5 }
    },
    cuts: [-4, 26],
    center: 11,
    sourceOpening: 46,
    parameter: 'opening_width',
    minimumOpening: 16.1,
    section: hammerSection
  };
}

function setup() {
  const root = createProjectDocument('Growing holder', toUserId('user_grow'));
  const manager = new CommandManager(root);
  manager.execute(
    commandFactories.importStep({
      name: 'Source',
      artifactId: 'source',
      sourceName: 'source.step',
      stepText: 'ISO-10303-21;'
    })
  );
  const targetBodyId = manager.document.bodyOrder[0]!;
  return { root, manager, recipe: hammerRecipe(targetBodyId) };
}

const width = 'require_min(opening_width, 16.1)';

describe('growing holder recipe compiler', () => {
  it('emits the plan expressions the prototype used, generalized', () => {
    const plan = growingHolderPlan(hammerRecipe('body_x' as BodyId));
    expect(plan).toMatchObject({
      plane: 'YZ',
      axisIndex: 0,
      width,
      sectionOffset: `(-4) + (46 - (${width})) / 2`,
      bridgeLength: `30 + (${width}) - 46`,
      negativeShift: `(46 - (${width})) / 2`,
      positiveShift: `((${width}) - 46) / 2`
    });
    // Masks overshoot the 74 mm envelope by 1 + 5 % = 4.7 mm and stop at the cuts.
    expect(plan.masks.negative).toEqual({
      min: { x: -30.7, y: 1.8, z: -0.2 },
      max: { x: -4, y: 64.2, z: 67.2 }
    });
    expect(plan.masks.positive.min.x).toBe(26);
    expect(plan.masks.positive.max.x).toBeCloseTo(52.7, 9);
    const at = (expression: string, opening_width: number) =>
      evaluateExpression(expression, { opening_width });
    expect(at(plan.sectionOffset, 46)).toBe(-4);
    expect(at(plan.sectionOffset, 55)).toBe(-8.5);
    expect(at(plan.bridgeLength, 46)).toBe(30);
    expect(at(plan.bridgeLength, 55)).toBe(39);
    expect(at(plan.negativeShift, 55)).toBe(-4.5);
    expect(at(plan.positiveShift, 55)).toBe(4.5);
    expect(at(plan.bridgeLength, 16.1)).toBeCloseTo(0.1, 9);
    expect(() => at(plan.bridgeLength, 16)).toThrow();
    expect(
      growingHolderPlan({ ...hammerRecipe('b' as BodyId), axis: 'y', cuts: [10, 50] })
    ).toMatchObject({ plane: 'XZ', axisIndex: 1 });
    expect(
      growingHolderPlan({ ...hammerRecipe('b' as BodyId), axis: 'z', cuts: [10, 50] })
    ).toMatchObject({ plane: 'XY', axisIndex: 2 });
  });

  it('compiles to two carved ends, a bridge, two moves and one union', () => {
    const { root, manager, recipe } = setup();
    const before = manager.document;
    const compiled = growingHolderCommand(before, recipe);
    manager.execute(compiled.command);
    const doc = manager.document;
    const features = listFeaturesInOrder(doc);
    expect(features.map((f) => f.data.featureKind)).toEqual([
      'imported-step',
      'primitive',
      'transform',
      'boolean',
      'imported-step',
      'primitive',
      'transform',
      'boolean',
      'sketch',
      'extrude',
      'transform',
      'transform',
      'boolean'
    ]);
    expect(getParameterScope(doc).scope.opening_width).toBe(46);
    const [
      source,
      negativeMask,
      placeNegative,
      negativeEnd,
      copy,
      positiveMask,
      placePositive,
      positiveEnd,
      ,
      bridge,
      moveNegative,
      movePositive,
      union
    ] = features;
    // The second reference shares the source's payload; nothing is re-cut by hand.
    expect(copy!.data).toEqual(source!.data);
    expect(negativeMask!.data).toMatchObject({
      primitiveKind: 'box',
      dimensions: { width: 26.7, height: 62.4, depth: 67.4 }
    });
    expect(placeNegative!.data).toMatchObject({
      targetBodyId: negativeMask!.bodyId,
      transform: { translation: { x: -30.7, y: 1.8 } }
    });
    expect(negativeEnd!.data).toMatchObject({
      operation: 'intersect',
      targetBodyIds: [recipe.targetBodyId, negativeMask!.bodyId]
    });
    expect(negativeEnd!.bodyId).toBe(compiled.negativeEndBodyId);
    expect(positiveMask!.data).toMatchObject({ primitiveKind: 'box' });
    expect(placePositive!.data).toMatchObject({
      transform: { translation: { x: 26 } }
    });
    expect(positiveEnd!.data).toMatchObject({
      operation: 'intersect',
      targetBodyIds: [copy!.bodyId, positiveMask!.bodyId]
    });
    expect(positiveEnd!.bodyId).toBe(compiled.positiveEndBodyId);
    expect(bridge!.data).toMatchObject({ distance: `30 + (${width}) - 46` });
    expect(bridge!.bodyId).toBe(compiled.bridgeBodyId);
    expect(moveNegative!.data).toMatchObject({
      targetBodyId: compiled.negativeEndBodyId,
      transform: { translation: { x: `(46 - (${width})) / 2`, y: 0, z: 0 } }
    });
    expect(movePositive!.data).toMatchObject({
      targetBodyId: compiled.positiveEndBodyId,
      transform: { translation: { x: `((${width}) - 46) / 2`, y: 0, z: 0 } }
    });
    expect(union!.data).toMatchObject({
      operation: 'union',
      targetBodyIds: [
        compiled.negativeEndBodyId,
        compiled.bridgeBodyId,
        compiled.positiveEndBodyId
      ]
    });
    expect(union!.bodyId).toBe(compiled.bodyId);
    expect(
      JSON.parse(String(union!.metadata?.[GROWING_HOLDER_RECIPE_METADATA_KEY]))
    ).toEqual(recipe);

    const histories = growingHolderHistories(doc);
    expect(histories).toHaveLength(1);
    expect(histories[0]).toMatchObject({
      recipe,
      negativeEndBodyId: compiled.negativeEndBodyId,
      positiveEndBodyId: compiled.positiveEndBodyId,
      bridgeBodyId: compiled.bridgeBodyId,
      resultBodyId: compiled.bodyId
    });
    expect(histories[0]!.union.featureId).toBe(union!.featureId);
    expect(histories[0]!.bodies).toEqual({
      negativeEnd: compiled.negativeEndBodyId,
      bridge: compiled.bridgeBodyId,
      positiveEnd: compiled.positiveEndBodyId
    });

    const replayed = replayCommands(root, doc.commandLog);
    expect(replayed.featureOrder).toEqual(doc.featureOrder);
    expect(growingHolderHistories(replayed)).toHaveLength(1);
    manager.undo();
    expect(manager.document.featureOrder).toEqual(before.featureOrder);
    expect(growingHolderHistories(manager.document)).toEqual([]);
    manager.redo();
    expect(manager.document.featureOrder).toEqual(doc.featureOrder);
  });

  it('keeps an existing parameter and its expression', () => {
    const { manager, recipe } = setup();
    manager.execute(
      commandFactories.setParameter({ name: 'opening_width', expression: '50' })
    );
    manager.execute(growingHolderCommand(manager.document, recipe).command);
    expect(getParameterScope(manager.document).scope.opening_width).toBe(50);
    expect(
      manager.document.commandLog.filter((c) => c.kind === 'parameter.set')
    ).toHaveLength(1);
  });

  it('refuses to claim a history that was edited by hand', () => {
    const { manager, recipe } = setup();
    manager.execute(growingHolderCommand(manager.document, recipe).command);
    const doc = manager.document;
    const history = growingHolderHistories(doc)[0]!;
    const unrelated = setParameter(doc, { name: 'unused', expression: '1' });
    expect(growingHolderHistories(unrelated)).toHaveLength(1);
    const edit = (
      featureId: (typeof history)['negativeMove']['featureId'],
      data: Record<string, unknown>
    ) => {
      const edited = new CommandManager(doc);
      edited.execute(
        commandFactories.updateFeature({ featureId, data: data })
      );
      return growingHolderHistories(edited.document);
    };
    expect(
      edit(history.negativeMove.featureId, {
        transform: {
          translation: { x: '(46 - opening_width) / 2', y: 0, z: 0 },
          rotationDeg: { x: 0, y: 0, z: 0 }
        }
      })
    ).toEqual([]);
    expect(
      edit(history.negativeEnd.featureId, { operation: 'union' })
    ).toEqual([]);
    const suppressed = new CommandManager(doc);
    suppressed.execute(
      commandFactories.setNodeMetadata({
        nodeId: history.bridge.id,
        metadata: { suppressed: true }
      })
    );
    expect(growingHolderHistories(suppressed.document)).toEqual([]);
    const forged = new CommandManager(doc);
    forged.execute(
      commandFactories.setNodeMetadata({
        nodeId: history.union.id,
        metadata: {
          [GROWING_HOLDER_RECIPE_METADATA_KEY]: JSON.stringify({
            ...recipe,
            cuts: [-5, 26]
          })
        }
      })
    );
    expect(growingHolderHistories(forged.document)).toEqual([]);
  });

  it('rejects malformed recipes and modified sources before mutation', () => {
    const { manager, recipe } = setup();
    const bad = (patch: Partial<GrowingHolderRecipe>, message: RegExp) =>
      expect(() =>
        validateGrowingHolderRecipe({ ...recipe, ...patch })
      ).toThrow(message);
    bad({ version: 2 as never }, /version/);
    bad({ cuts: [26, -4] }, /increasing/);
    bad({ cuts: [-4, Number.NaN] }, /finite/);
    bad({ cuts: [-26, 26] }, /inside the source along x/);
    bad({ cuts: [-4, 48] }, /inside the source along x/);
    bad(
      { envelope: { min: { x: 0, y: 0, z: 0 }, max: { x: 0, y: 1, z: 1 } } },
      /envelope/
    );
    bad({ center: 30 }, /between the cut planes/);
    bad({ sourceOpening: 0 }, /positive/);
    bad({ minimumOpening: 47 }, /cannot exceed/);
    bad({ minimumOpening: 16 }, /vanish/);
    bad({ section: [] }, /section profile/);
    bad(
      { section: [{ objectKind: 'line', x1: 'a', y1: 0, x2: 1, y2: 0 }] },
      /section profile/
    );
    bad(
      {
        section: [
          { objectKind: 'circle', centerX: 0, centerY: 0, radius: 1 } as never
        ]
      },
      /section profile/
    );
    bad({ axis: 'w' as never }, /axis/);
    expect(() =>
      growingHolderCommand(manager.document, {
        ...recipe,
        targetBodyId: 'body_missing' as BodyId
      })
    ).toThrow(/imported STEP source/);
    manager.execute(
      commandFactories.transformBody({
        name: 'Move',
        targetBodyId: recipe.targetBodyId,
        translation: { x: 1, y: 0, z: 0 }
      })
    );
    expect(() => growingHolderCommand(manager.document, recipe)).toThrow(
      /unmodified/
    );
  });
});
