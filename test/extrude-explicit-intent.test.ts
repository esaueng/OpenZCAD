import {
  IDLE,
  interactionReducer,
  type InteractionState
} from '../apps/web/src/lib/interaction/machine';
import { isExtrudeSessionCurrent } from '../apps/web/src/lib/extrudeSession';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  addPrimitiveFeature,
  addSketchFeature,
  addSketchObjects,
  createProjectDocument,
  getLatestBodyId,
  getLatestSketchId,
  listFeaturesInOrder,
  findSketch
} from '@openzcad/document-core';
import {
  createExactKernelAdapter,
  type ExactKernelAdapter
} from '@openzcad/kernel-adapter/exact';
import { toBodyId, toUserId } from '@openzcad/shared';
import {
  resolveExtrudeOperation,
  resolveCurrentExtrude
} from '../apps/web/src/lib/extrudeInference';

describe('explicit extrusion intent', { timeout: 30_000 }, () => {
  let kernel: ExactKernelAdapter;
  beforeAll(async () => {
    kernel = await createExactKernelAdapter();
  });
  afterAll(() => kernel.dispose());

  async function plateWithBores() {
    let base = createProjectDocument(
      'Bore intent regression',
      toUserId('intent-test')
    );
    base = addPrimitiveFeature(base, {
      name: 'Plate',
      primitiveKind: 'box',
      dimensions: { width: 74, height: 53, depth: 8 }
    });
    const targetBodyId = getLatestBodyId(base)!;
    base = addSketchFeature(base, {
      name: 'Bore layout',
      plane: 'XY',
      offset: 8,
      object: { objectKind: 'circle', radius: 2.5, centerX: 17, centerY: 20 }
    }).document;
    const sketchId = getLatestSketchId(base)!;
    base = addSketchObjects(base, {
      sketchId,
      objects: [{ objectKind: 'circle', radius: 2.5, centerX: 57, centerY: 20 }]
    }).document;
    base = { ...base, derived: await kernel.syncDocument(base) };
    return {
      base,
      targetBodyId,
      input: {
        name: 'Bores',
        sketchId,
        distance: -8,
        profiles: [
          {
            all: true as const,
            sourceEntityIds: findSketch(base, sketchId)!.objectIds
          }
        ]
      }
    };
  }

  it('removes two inward bores with the chosen Cut and keeps that operation in the stored feature', async () => {
    const { base, targetBodyId, input } = await plateWithBores();
    const derive = vi.fn((document: typeof base) =>
      kernel.syncDocument(document)
    );
    const cut = await resolveExtrudeOperation({
      base,
      input,
      choice: { operation: 'cut', targetBodyId },
      derive
    });
    expect(derive).toHaveBeenCalledTimes(1);
    expect(cut.command.payload).toMatchObject({
      operation: 'cut',
      targetBodyId
    });
    expect(cut.derived.warnings).toEqual([]);
    const result =
      cut.derived.bodyRepresentations[cut.command.payload.ids!.bodyId]!;
    expect(result.volume).toBeCloseTo(
      74 * 53 * 8 - 2 * Math.PI * 2.5 ** 2 * 8,
      1
    );
    expect(cut.derived.bodyRepresentations[targetBodyId]?.consumed).toBe(true);
    expect(listFeaturesInOrder(base)).toHaveLength(2);
    expect(listFeaturesInOrder(cut.document).at(-1)?.data).toMatchObject({
      operation: 'cut',
      targetBodyId
    });
    const replay = await kernel.syncDocument(cut.document);
    expect(
      replay.bodyRepresentations[cut.command.payload.ids!.bodyId]?.volume
    ).toBeCloseTo(result.volume, 5);
  });

  it('honors New Body even when the same volumes would otherwise classify as Cut', async () => {
    const { base, input } = await plateWithBores();
    const result = await resolveExtrudeOperation({
      base,
      input,
      choice: { operation: 'new-body' },
      derive: (document) => kernel.syncDocument(document)
    });
    expect(result.command.payload.operation).toBe('new-body');
    expect(result.command.payload.targetBodyId).toBeUndefined();
    expect(
      Object.values(result.derived.bodyRepresentations).filter(
        (body) => !body.consumed
      )
    ).toHaveLength(2);
  });

  it('refuses missing and unavailable targets before any geometry call, without substituting Add', async () => {
    const { base, input } = await plateWithBores();
    const derive = vi.fn((document: typeof base) =>
      kernel.syncDocument(document)
    );
    await expect(
      resolveExtrudeOperation({
        base,
        input,
        choice: { operation: 'cut' },
        derive
      })
    ).rejects.toThrow('Select a target body for Cut.');
    await expect(
      resolveExtrudeOperation({
        base,
        input,
        choice: { operation: 'cut', targetBodyId: toBodyId('missing') },
        derive
      })
    ).rejects.toThrow('no longer available');
    expect(derive).not.toHaveBeenCalled();
    expect(listFeaturesInOrder(base)).toHaveLength(2);
  });
  it.each(['result', 'refusal'] as const)(
    'discards a late %s after Escape cancels pending extrusion validation',
    async (outcome) => {
      const { base, input, targetBodyId } = await plateWithBores();
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let state: InteractionState = interactionReducer(IDLE, {
        type: 'select-region',
        target: {
          sketchId: input.sketchId,
          regionFingerprint: 1,
          samplePoint: { x: 17, y: 20 },
          area: Math.PI * 2.5 ** 2,
          sourceEntityIds: []
        }
      });
      if (state.mode !== 'region')
        throw new Error('Expected extrusion session');
      const started = state;
      const selected: unknown[] = [];
      state = interactionReducer(state, {
        type: 'validation-start',
        value: -8
      });
      const pending = resolveCurrentExtrude(
        {
          base,
          input,
          choice: { operation: 'cut', targetBodyId },
          derive: async (document) => {
            await gate;
            if (outcome === 'refusal') throw new Error('Late geometry refusal');
            return kernel.syncDocument(document);
          }
        },
        () => isExtrudeSessionCurrent(started, state, selected, selected)
      );
      state = interactionReducer(state, { type: 'escape' });
      expect(state).toEqual(IDLE);
      release();
      expect(await pending).toBeNull();
      expect(listFeaturesInOrder(base)).toHaveLength(2);
    }
  );
});
