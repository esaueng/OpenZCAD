import { beforeAll, describe, expect, it } from 'vitest';
import {
  addPrimitiveFeature,
  addSketchFeature,
  attachDerivedState,
  createProjectDocument,
  listFeaturesInOrder,
  type ExtrudeInput
} from '@openzcad/document-core';
import {
  CommandManager,
  commandFactories,
  composeCommands
} from '@openzcad/command-system';
import {
  createExactKernelAdapter,
  type ExactKernelAdapter
} from '@openzcad/kernel-adapter/exact';
import { toUserId, type BodyId, type ProjectDocument } from '@openzcad/shared';
import {
  regionExtrudeOutcome,
  resolveExtrudeOperation
} from '../apps/web/src/lib/extrudeInference';
import {
  extrudeDraftRefusal,
  extrudeDraftValue,
  initialExtrudeDraft,
  type ExtrudeDraftContext
} from '../apps/web/src/lib/extrudeDraft';

/**
 * F01: a through-all cut through several bodies. Three 20 × 20 × 10 plates
 * stand apart at z = 0, 20 and 40, each its own body. One through-all cut of
 * a 4 × 4 square sketched above them goes through the target and every
 * further body picked, as one through-all extrude per body, each consuming
 * and replacing its body exactly as a single-target through-all cut does,
 * created and undone as one step. No new stored field or schema: each
 * feature is the through-all cut every client since v20 builds.
 */
const PLATE = 20 * 20 * 10;
const HOLE = 4 * 4 * 10;

function plates(): { document: ProjectDocument; ids: BodyId[] } {
  let document = createProjectDocument(
    'Through several',
    toUserId('user_through_multi')
  );
  const ids: BodyId[] = [];
  for (const z of [0, 20, 40]) {
    document = addPrimitiveFeature(document, {
      name: `Plate ${z}`,
      primitiveKind: 'box',
      dimensions: { width: 20, height: 20, depth: 10 }
    });
    const bodyId = document.bodyOrder.at(-1)!;
    ids.push(bodyId);
    document = commandFactories
      .transformBody({
        name: `Lift ${z}`,
        targetBodyId: bodyId,
        translation: { x: 0, y: 0, z }
      })
      .apply(document);
  }
  return { document, ids };
}

describe('F01 through all, several bodies', { timeout: 90_000 }, () => {
  let adapter: ExactKernelAdapter;
  beforeAll(async () => {
    adapter = await createExactKernelAdapter();
  });

  async function setup(centerX = 10) {
    const { document, ids } = plates();
    const sketched = addSketchFeature(document, {
      name: 'Hole sketch',
      planeRef: { type: 'canonical', plane: 'XY', offset: 60 },
      objects: [
        { objectKind: 'rectangle', width: 4, height: 4, centerX, centerY: 10 }
      ]
    });
    const base = attachDerivedState(
      sketched.document,
      await adapter.syncDocument(sketched.document)
    );
    const input: ExtrudeInput = {
      name: 'Through',
      sketchId: sketched.sketchId,
      distance: 1,
      endCondition: 'through-all',
      throughAllSide: 'backward'
    };
    return { base, ids, input };
  }

  it('cuts every picked body as its own through-all cut, committed and undone as one step', async () => {
    const { base, ids, input } = await setup();
    const resolved = await resolveExtrudeOperation({
      base,
      input,
      choice: {
        operation: 'cut',
        targetBodyId: ids[0],
        alsoTargetBodyIds: [ids[1]!, ids[2]!]
      },
      derive: (document) => adapter.syncDocument(document)
    });
    expect(resolved.extraCommands).toHaveLength(2);
    // The preview already holds all three cuts.
    const previewed = [resolved.command, ...resolved.extraCommands!].map(
      (command) =>
        resolved.derived.bodyRepresentations[command.payload.ids!.bodyId]!
          .volume
    );
    for (const volume of previewed) expect(volume).toBeCloseTo(PLATE - HOLE, 6);

    const manager = new CommandManager(base);
    manager.execute(
      composeCommands(resolved.command.label, [
        resolved.command,
        ...resolved.extraCommands!
      ])
    );
    const features = listFeaturesInOrder(manager.document).filter((feature) =>
      feature.name.startsWith('Through')
    );
    expect(features).toHaveLength(3);
    // Review: each cut is its own History row, so each is numbered.
    expect(features.map((feature) => feature.name)).toEqual([
      'Through',
      'Through 2',
      'Through 3'
    ]);
    features.forEach((feature, index) => {
      expect(feature.data).toMatchObject({
        operation: 'cut',
        targetBodyId: ids[index],
        endCondition: 'through-all',
        throughAllSide: 'backward'
      });
    });
    const derived = await adapter.syncDocument(manager.document);
    expect(derived.warnings).toEqual([]);
    for (const feature of features) {
      expect(derived.bodyRepresentations[feature.bodyId!]!.volume).toBeCloseTo(
        PLATE - HOLE,
        6
      );
    }
    expect(
      regionExtrudeOutcome(
        { ...resolved, inference: { operation: 'cut' } },
        1,
        'mm'
      )
    ).toBe('Cut the region through all of 3 bodies.');
    manager.undo();
    expect(
      listFeaturesInOrder(manager.document).filter((feature) =>
        feature.name.startsWith('Through')
      )
    ).toHaveLength(0);
  });

  it('refuses the whole step when the profile misses a further body', async () => {
    const { base, ids, input } = await setup();
    // A fourth plate off to the side, which the square never meets.
    let document = addPrimitiveFeature(base, {
      name: 'Aside',
      primitiveKind: 'box',
      dimensions: { width: 10, height: 10, depth: 10 }
    });
    const aside = document.bodyOrder.at(-1)!;
    document = commandFactories
      .transformBody({
        name: 'Move aside',
        targetBodyId: aside,
        translation: { x: 100, y: 0, z: 20 }
      })
      .apply(document);
    document = attachDerivedState(
      document,
      await adapter.syncDocument(document)
    );
    await expect(
      resolveExtrudeOperation({
        base: document,
        input,
        choice: {
          operation: 'cut',
          targetBodyId: ids[0],
          alsoTargetBodyIds: [aside]
        },
        derive: (candidate) => adapter.syncDocument(candidate)
      })
    ).rejects.toThrow(/Through-all has no target|no longer overlaps|Aside/);
  });

  it('refuses a body named twice, or the target named again', async () => {
    const { base, ids, input } = await setup();
    for (const also of [[ids[0]!], [ids[1]!, ids[1]!]]) {
      await expect(
        resolveExtrudeOperation({
          base,
          input,
          choice: {
            operation: 'cut',
            targetBodyId: ids[0],
            alsoTargetBodyIds: also
          },
          derive: (candidate) => adapter.syncDocument(candidate)
        })
      ).rejects.toThrow(/named once/);
    }
  });

  it('builds no further cut off through all', async () => {
    const { base, ids, input } = await setup();
    const { endCondition: _end, throughAllSide: _side, ...blind } = input;
    const resolved = await resolveExtrudeOperation({
      base,
      input: { ...blind, distance: -25 },
      choice: {
        operation: 'cut',
        targetBodyId: ids[2],
        alsoTargetBodyIds: [ids[1]!]
      },
      derive: (candidate) => adapter.syncDocument(candidate)
    });
    expect(resolved.extraCommands).toBeUndefined();
  });

  describe('editor', () => {
    const [a, b, c] = ['body_a', 'body_b', 'body_c'] as BodyId[];
    const ctx: ExtrudeDraftContext = {
      scope: {},
      units: 'mm',
      initial: { name: 'Extrude', sketchId: 'sketch_a' as never, distance: 0 },
      bodies: [
        { bodyId: a!, name: 'A' },
        { bodyId: b!, name: 'B' },
        { bodyId: c!, name: 'C' }
      ]
    };
    const draft = {
      ...initialExtrudeDraft(ctx.initial, true),
      choice: {
        operation: 'cut' as const,
        targetBodyId: a!,
        alsoTargetBodyIds: [b!, c!]
      },
      endCondition: 'through-all' as const
    };

    it('sends the further bodies with a through-all cut only', () => {
      expect(extrudeDraftValue(draft, ctx)?.choice).toEqual(draft.choice);
      expect(
        extrudeDraftValue(
          { ...draft, endCondition: 'blind', distance: '5' },
          ctx
        )?.choice
      ).toEqual({ operation: 'cut', targetBodyId: a });
    });

    it('refuses a further body named twice, or the target again', () => {
      expect(extrudeDraftRefusal(draft, ctx, true)).toBeNull();
      for (const also of [[a!], [b!, b!], ['body_gone' as BodyId]]) {
        expect(
          extrudeDraftRefusal(
            { ...draft, choice: { ...draft.choice, alsoTargetBodyIds: also } },
            ctx,
            true
          )
        ).toMatch(/Pick each body the cut goes through once/);
      }
    });
  });
});
