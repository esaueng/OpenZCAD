import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CommandManager, commandFactories } from '@openzcad/command-system';
import {
  addPrimitiveFeature,
  addSketchFeature,
  createProjectDocument,
  extrudeSketch,
  getLatestBodyId,
  getLatestSketchId,
  listFeaturesInOrder,
  transformBody,
  updateFeature
} from '@openzcad/document-core';
import {
  createExactKernelAdapter,
  type ExactKernelAdapter
} from '@openzcad/kernel-adapter/exact';
import {
  classifyExtrudeOperation,
  type ExtrudeInferenceBody
} from '@openzcad/kernel-adapter';
import { toBodyId, toUserId, type ProjectDocument } from '@openzcad/shared';
import { resolveExtrudeOperation } from '../apps/web/src/lib/extrudeInference';

function inferenceBody(
  id: string,
  volume: number,
  min = 0,
  max = 10
): ExtrudeInferenceBody {
  return {
    bodyId: toBodyId(id),
    name: id,
    volume,
    bbox: {
      min: { x: min, y: min, z: min },
      max: { x: max, y: max, z: max }
    }
  };
}

describe('extrude operation inference', () => {
  const extrusion = inferenceBody('extrusion', 100, 2, 8);
  const target = inferenceBody('target', 1_000);

  it('classifies enclosure as cut and partial overlap as add', () => {
    expect(
      classifyExtrudeOperation(extrusion, [
        { target, unionVolume: target.volume }
      ])
    ).toMatchObject({
      operation: 'cut',
      targetBodyId: target.bodyId,
      reason: 'enclosed'
    });
    expect(
      classifyExtrudeOperation(extrusion, [
        { target, unionVolume: target.volume + 50 }
      ])
    ).toMatchObject({
      operation: 'add',
      targetBodyId: target.bodyId,
      reason: 'partial-overlap'
    });
  });

  it('keeps tangency, coincidence, multiple targets, and refusals conservative', () => {
    expect(
      classifyExtrudeOperation(
        extrusion,
        [{ target, unionVolume: target.volume + extrusion.volume }],
        [],
        1
      )
    ).toMatchObject({ operation: 'new-body', reason: 'no-overlap' });

    const coincident = inferenceBody('coincident', extrusion.volume, 2, 8);
    expect(
      classifyExtrudeOperation(extrusion, [
        { target: coincident, unionVolume: extrusion.volume }
      ])
    ).toMatchObject({ operation: 'new-body', reason: 'coincident' });

    const second = inferenceBody('second', 500);
    expect(
      classifyExtrudeOperation(extrusion, [
        { target, unionVolume: target.volume },
        { target: second, unionVolume: second.volume }
      ])
    ).toMatchObject({ operation: 'new-body', reason: 'multiple-overlap' });

    expect(classifyExtrudeOperation(extrusion, [], [target], 1)).toMatchObject({
      operation: 'new-body',
      reason: 'exact-measurement-refused'
    });
  });
});

function baseSketchDocument(offset: number): {
  document: ProjectDocument;
  targetBodyId: ReturnType<typeof toBodyId>;
} {
  let document = createProjectDocument(
    'Stored extrusion operation',
    toUserId('user_extrude_operation')
  );
  document = addPrimitiveFeature(document, {
    name: 'Base',
    primitiveKind: 'box',
    dimensions: { width: 20, height: 20, depth: 10 }
  });
  const targetBodyId = getLatestBodyId(document)!;
  document = addSketchFeature(document, {
    name: 'Profile',
    plane: 'XY',
    offset,
    object: {
      objectKind: 'rectangle',
      width: 4,
      height: 4,
      centerX: 10,
      centerY: 10
    }
  }).document;
  return { document, targetBodyId };
}

function extrudeDocument(
  operation: 'new-body' | 'add' | 'cut' | undefined,
  offset: number,
  distance: number
): { document: ProjectDocument; targetBodyId: ReturnType<typeof toBodyId> } {
  const created = baseSketchDocument(offset);
  const document = extrudeSketch(created.document, {
    name: 'Extrude',
    sketchId: getLatestSketchId(created.document)!,
    distance,
    ...(operation === undefined ? {} : { operation }),
    ...(operation === 'add' || operation === 'cut'
      ? { targetBodyId: created.targetBodyId }
      : {})
  }).document;
  return { document, targetBodyId: created.targetBodyId };
}

describe('stored extrude operations', { timeout: 30_000 }, () => {
  let kernel: ExactKernelAdapter;

  beforeAll(async () => {
    kernel = await createExactKernelAdapter();
  });

  afterAll(() => kernel.dispose());

  it('stores and replays an enclosed cut without exposing its consumed target', async () => {
    const { document, targetBodyId } = extrudeDocument('cut', 2, 4);
    const feature = listFeaturesInOrder(document).at(-1)!;
    expect(feature.data).toMatchObject({
      featureKind: 'extrude',
      operation: 'cut',
      targetBodyId
    });

    const derived = await kernel.syncDocument(document);
    const result = derived.bodyRepresentations[feature.bodyId!]!;
    expect(derived.warnings).toEqual([]);
    expect(derived.bodyRepresentations[targetBodyId]?.consumed).toBe(true);
    expect(result.consumed).toBe(false);
    expect(result.volume).toBeCloseTo(3_936, 3);
  });

  it('requires a canonical target for command-created add and cut features', () => {
    const created = extrudeDocument(undefined, 2, 4);
    const sketchId = getLatestSketchId(created.document)!;
    const manager = new CommandManager(created.document);

    expect(() =>
      manager.execute(
        commandFactories.extrudeSketch({
          name: 'Invalid cut',
          sketchId,
          distance: 2,
          operation: 'cut'
        })
      )
    ).toThrow(/requires a stored target body/);
    expect(() =>
      manager.execute(
        commandFactories.extrudeSketch({
          name: 'Invalid new body',
          sketchId,
          distance: 2,
          operation: 'new-body',
          targetBodyId: created.targetBodyId
        })
      )
    ).toThrow(/cannot store a target body/);
  });

  it('resolves the live preview operation once from exact geometry', async () => {
    for (const expectation of [
      { offset: 2, distance: 4, operation: 'cut' },
      { offset: 8, distance: 4, operation: 'add' },
      { offset: 10, distance: 4, operation: 'new-body' }
    ] as const) {
      const base = baseSketchDocument(expectation.offset).document;
      const resolved = await resolveExtrudeOperation({
        base,
        input: {
          name: 'Preview',
          sketchId: getLatestSketchId(base)!,
          distance: expectation.distance
        },
        derive: (document) => kernel.syncDocument(document)
      });
      expect(resolved.inference.operation).toBe(expectation.operation);
      expect(resolved.command.payload.operation).toBe(expectation.operation);
    }
  });

  it('ignores an exact zero-overlap candidate whose bounds overlap', async () => {
    let document = createProjectDocument(
      'Extrude overlap decoy',
      toUserId('user_extrude_overlap_decoy')
    );
    document = addPrimitiveFeature(document, {
      name: 'Base',
      primitiveKind: 'box',
      dimensions: { width: 20, height: 20, depth: 10 }
    });
    const targetBodyId = getLatestBodyId(document)!;
    document = addPrimitiveFeature(document, {
      name: 'Decoy',
      primitiveKind: 'box',
      dimensions: { width: 1, height: 1, depth: 4 }
    });
    const decoyBodyId = getLatestBodyId(document)!;
    document = transformBody(document, {
      name: 'Place decoy',
      targetBodyId: decoyBodyId,
      translation: { x: 13.5, y: 13.5, z: 2 }
    }).document;
    document = addSketchFeature(document, {
      name: 'Round cut',
      plane: 'XY',
      offset: 2,
      object: {
        objectKind: 'circle',
        radius: 4,
        centerX: 10,
        centerY: 10
      }
    }).document;

    const resolved = await resolveExtrudeOperation({
      base: document,
      input: {
        name: 'Preview',
        sketchId: getLatestSketchId(document)!,
        distance: 4
      },
      derive: (candidate) => kernel.syncDocument(candidate)
    });

    expect(resolved.inference).toMatchObject({
      operation: 'cut',
      targetBodyId,
      reason: 'enclosed'
    });
  });

  it('stores a partial-overlap add and preserves the legacy new-body default', async () => {
    const added = extrudeDocument('add', 8, 4);
    const addFeature = listFeaturesInOrder(added.document).at(-1)!;
    const addDerived = await kernel.syncDocument(added.document);
    expect(addDerived.warnings).toEqual([]);
    expect(
      addDerived.bodyRepresentations[addFeature.bodyId!]!.volume
    ).toBeCloseTo(4_032, 3);
    expect(addDerived.bodyRepresentations[added.targetBodyId]?.consumed).toBe(
      true
    );

    const legacy = extrudeDocument(undefined, 2, 4);
    const legacyFeature = listFeaturesInOrder(legacy.document).at(-1)!;
    const legacyDerived = await kernel.syncDocument(legacy.document);
    expect(legacyFeature.data).not.toHaveProperty('operation');
    expect(legacyDerived.warnings).toEqual([]);
    expect(
      legacyDerived.bodyRepresentations[legacy.targetBodyId]?.consumed
    ).toBe(false);
    expect(
      legacyDerived.bodyRepresentations[legacyFeature.bodyId!]?.consumed
    ).toBe(false);
  });

  it('fails visibly instead of re-inferring when an edit removes stored overlap', async () => {
    const created = extrudeDocument('add', 8, 4);
    const baseFeature = listFeaturesInOrder(created.document)[0]!;
    const extrudeFeature = listFeaturesInOrder(created.document).at(-1)!;
    const edited = updateFeature(created.document, {
      featureId: baseFeature.featureId,
      data: { dimensions: { depth: 5 } }
    });
    const derived = await kernel.syncDocument(edited);

    expect(derived.bodyRepresentations[extrudeFeature.bodyId!]).toBeUndefined();
    expect(derived.bodyRepresentations[created.targetBodyId]?.consumed).toBe(
      false
    );
    expect(derived.warnings).toContain(
      'Feature "Extrude": Stored add extrusion no longer overlaps Base Body; operation was not re-inferred.'
    );
  });
});
