import { describe, expect, it, vi } from 'vitest';
import { CommandManager } from '@openzcad/command-system';
import {
  addPrimitiveFeature,
  addSketchFeature,
  createProjectDocument,
  extrudeSketch,
  findSketch,
  importStepBody,
  listFeaturesInOrder,
  setNodeMetadata,
  setParameter,
  transformBody,
  updateFeature,
  updateSketchObject
} from '@openzcad/document-core';
import {
  createExactKernelAdapter,
  type ExactKernelAdapter,
  type RebuildCacheEvent
} from '@openzcad/kernel-adapter/exact';
import {
  FEATURE_SUPPRESSED_METADATA_KEY,
  toUserId,
  type DerivedState,
  type EditAnalysisRequest,
  type ProjectDocument
} from '@openzcad/shared';
import { RemusKernel } from '../packages/kernel-adapter/src/remus-runtime';
import { historyCheckpointIndices } from '../packages/kernel-adapter/src/exact-history-cache';

// Same triangulation-layout normalization as incremental-rebuild-cache.test.
// All topology, references, face ranges, edges, bounds, mass and warnings stay.
function normalized({ updatedAt: _updatedAt, ...derived }: DerivedState) {
  return {
    ...derived,
    bodyRepresentations: Object.fromEntries(
      Object.entries(derived.bodyRepresentations).map(([id, body]) => [
        id,
        {
          ...body,
          mesh: {
            kind: body.mesh.kind,
            triangles: body.mesh.indices.length / 3
          }
        }
      ])
    )
  };
}

async function equivalent(
  document: ProjectDocument,
  actual: DerivedState,
  analysis?: EditAnalysisRequest
) {
  const fresh = await createExactKernelAdapter({ historyCheckpointLimit: 0 });
  try {
    expect(normalized(actual)).toEqual(
      normalized(
        await fresh.syncDocument(document, undefined, undefined, analysis)
      )
    );
  } finally {
    fresh.dispose();
  }
}

function boxes(
  count: number,
  document = createProjectDocument('Bounded history', toUserId('cache-test'))
) {
  for (let i = 0; i < count; i++)
    document = addPrimitiveFeature(document, {
      name: `Box ${i}`,
      primitiveKind: 'box',
      dimensions: { width: 10, height: 8, depth: 6 }
    });
  return document;
}

function edit(document: ProjectDocument, index: number, width: number) {
  return updateFeature(document, {
    featureId: listFeaturesInOrder(document)[index]!.featureId,
    data: { dimensions: { width, height: 8, depth: 6 } }
  });
}

// Inspect both owners: a correct derived result alone cannot detect a dangling
// adapter record or an unbounded stack of inaccessible kernel checkpoints.
function ownership(adapter: ExactKernelAdapter, count: number) {
  const state = adapter as unknown as {
    historyKernel: RemusKernel | null;
    historyCheckpoints: { checkpointId: number }[];
  };
  expect(state.historyCheckpoints.map((entry) => entry.checkpointId)).toEqual(
    Array.from({ length: count }, (_, i) => i)
  );
  expect(state.historyKernel?.checkpointCount() ?? 0).toBe(count);
  return state.historyKernel;
}

function retained(count: number, limit = 32) {
  return historyCheckpointIndices(count, limit);
}

function restoredBefore(count: number, changedIndex: number) {
  return (
    (retained(count)
      .filter((index) => index < changedIndex)
      .at(-1) ?? -1) + 1
  );
}

describe('bounded history retention', { timeout: 120_000 }, () => {
  it('rebuilds only the referenced primitive across an early parameter edit', async () => {
    const events: RebuildCacheEvent[] = [];
    const adapter = await createExactKernelAdapter({
      onRebuildCacheEvent: (event) => events.push(event)
    });
    try {
      let document = setParameter(boxes(100), { name: 'width', expression: '10' });
      document = updateFeature(document, {
        featureId: listFeaturesInOrder(document)[2]!.featureId,
        data: { dimensions: { width: 'width', height: 8, depth: 6 } }
      });
      const before = await adapter.syncDocument(document);
      const kernel = ownership(adapter, 26)!;
      const makeBox = vi.spyOn(kernel, 'makeBox');
      const changed = setParameter(document, { name: 'width', expression: '12' });
      const actual = await adapter.syncDocument(changed);
      expect(ownership(adapter, 26)).toBe(kernel);
      expect(makeBox).toHaveBeenCalledOnce();
      expect(events.at(-1)).toEqual({
        kind: 'independent-reuse', restored: 2, replayed: 1,
        reusedPrimitives: 97, remeasured: 1, reusedMeasurements: 99
      });
      expect(actual.bodyRepresentations[document.bodyOrder[99]!]!.mesh.vertices)
        .toBe(before.bodyRepresentations[document.bodyOrder[99]!]!.mesh.vertices);
      expect(actual.bodyRepresentations[document.bodyOrder[2]!]!.volume).toBe(576);
      await equivalent(changed, actual);
    } finally {
      vi.restoreAllMocks();
      adapter.dispose();
    }
  });

  it('falls back to dependency replay when a modifier follows retained primitives', async () => {
    const events: RebuildCacheEvent[] = [];
    const adapter = await createExactKernelAdapter({
      historyCheckpointLimit: 2,
      onRebuildCacheEvent: (event) => events.push(event)
    });
    try {
      let document = boxes(6);
      await adapter.syncDocument(document);
      document = edit(document, 3, 12);
      await adapter.syncDocument(document);
      expect(events.at(-1)?.kind).toBe('independent-reuse');
      document = transformBody(document, {
        name: 'Dependent move', targetBodyId: document.bodyOrder[3]!,
        translation: { x: 7, y: 0, z: 0 }
      }).document;
      await equivalent(document, await adapter.syncDocument(document));
      expect(events.at(-1)).toMatchObject({
        kind: 'prefix-restore', restored: 2, replayed: 5
      });
      document = edit(document, 3, 14);
      await equivalent(document, await adapter.syncDocument(document));
      expect(events.at(-1)?.reusedPrimitives).toBeUndefined();
    } finally {
      adapter.dispose();
    }
  });

  it('drops retained primitive handles if checkpoint discard fails', async () => {
    const adapter = await createExactKernelAdapter();
    try {
      const document = boxes(33);
      await adapter.syncDocument(document);
      const old = ownership(adapter, retained(33).length)!;
      const free = vi.spyOn(old, 'free');
      vi.spyOn(old, 'discardCheckpoint').mockImplementationOnce(() => {
        throw new Error('Injected discard failure');
      });
      const changed = edit(document, 0, 12);
      await equivalent(changed, await adapter.syncDocument(changed));
      expect(free).toHaveBeenCalledOnce();
      expect(ownership(adapter, retained(33).length)).not.toBe(old);
    } finally {
      vi.restoreAllMocks();
      adapter.dispose();
    }
  });

  it('uses stable sparse positions under the default cap and dense unlimited opt-in', () => {
    const firstHundred = historyCheckpointIndices(100, 32);
    expect(firstHundred).toEqual([
      ...Array.from({ length: 16 }, (_, index) => index),
      17, 19, 21, 23, 27, 31, 39, 47, 63, 79
    ]);
    expect(historyCheckpointIndices(32, 32)).toEqual(
      firstHundred.filter((index) => index < 32)
    );
    expect(historyCheckpointIndices(33, 32)).toEqual(
      firstHundred.filter((index) => index < 33)
    );
    expect(historyCheckpointIndices(10_000, 32)).toHaveLength(32);
    expect(historyCheckpointIndices(10_000, 32).at(-1)).toBe(527);
    expect(historyCheckpointIndices(100, Number.POSITIVE_INFINITY)).toEqual(
      Array.from({ length: 100 }, (_, index) => index)
    );
  });

  it.each([31, 32, 33, 48, 80])(
    'keeps exact early/middle/late edits and honest reuse at %i features',
    async (count) => {
      const events: RebuildCacheEvent[] = [];
      const adapter = await createExactKernelAdapter({
        onRebuildCacheEvent: (e) => events.push(e)
      });
      try {
        let document = boxes(count);
        await equivalent(document, await adapter.syncDocument(document));
        ownership(adapter, retained(count).length);
        for (const [step, index] of [
          count - 1,
          Math.floor(count / 2),
          0,
          count - 1
        ].entries()) {
          document = edit(document, index, 11 + step);
          const actual = await adapter.syncDocument(document);
          const restored = restoredBefore(count, index);
          expect(events.at(-1)).toEqual({
            kind: count - restored > 1 ? 'independent-reuse' : 'prefix-restore',
            restored,
            replayed: 1,
            ...(count - restored > 1
              ? { reusedPrimitives: count - restored - 1 }
              : {}),
            reusedMeasurements: count - 1,
            remeasured: 1
          });
          ownership(adapter, retained(count).length);
          await equivalent(document, actual);
        }
        await equivalent(document, await adapter.syncDocument(document));
        expect(events.at(-1)?.replayed).toBe(0);
        if (count === 80) {
          expect(retained(count).at(-1)).toBe(79);
          expect(events.at(-1)?.replayed).toBe(0);
        }
      } finally {
        adapter.dispose();
        ownership(adapter, 0);
      }
    }
  );

  it('appends, shortens across the budget, reorders, suppresses and restores repeatedly', async () => {
    const events: RebuildCacheEvent[] = [];
    const adapter = await createExactKernelAdapter({
      onRebuildCacheEvent: (e) => events.push(e)
    });
    try {
      const short = boxes(31);
      const long = boxes(17, short);
      const order = [...long.featureOrder];
      [order[10], order[11]] = [order[11]!, order[10]!];
      const reordered = { ...long, featureOrder: order };
      const suppressed = setNodeMetadata(reordered, {
        nodeId: listFeaturesInOrder(reordered)[8]!.id,
        metadata: { [FEATURE_SUPPRESSED_METADATA_KEY]: true }
      });
      for (const [document, restored] of [
        [short, 0],
        [long, 28],
        [short, 28],
        [long, 28],
        [reordered, 10],
        [suppressed, 8],
        [reordered, 8],
        [long, 10]
      ] as const) {
        await equivalent(document, await adapter.syncDocument(document));
        expect(events.at(-1)?.restored).toBe(restored);
        ownership(adapter, retained(document.featureOrder.length).length);
      }
      for (let i = 0; i < 50; i++) {
        const document = edit(long, i % 2 ? 40 : 20, 11 + i);
        await equivalent(document, await adapter.syncDocument(document));
        ownership(adapter, retained(long.featureOrder.length).length);
      }
    } finally {
      adapter.dispose();
    }
  });

  it('retires a replayed kernel before export and sync without serving stale handles', async () => {
    const events: RebuildCacheEvent[] = [];
    const adapter = await createExactKernelAdapter({
      onRebuildCacheEvent: (event) => events.push(event)
    });
    try {
      const base = boxes(100);
      const original = await adapter.syncDocument(base);
      const originalMesh =
        original.bodyRepresentations[base.bodyOrder[0]!]!.mesh;
      let document = base;
      for (let i = 0; i < 512; i++) {
        document = edit(base, 99, 11 + (i % 2));
        await adapter.syncDocument(document);
        expect(events.at(-1)).toMatchObject({ restored: 80, replayed: 1, reusedPrimitives: 19 });
      }
      const old = ownership(adapter, 26)!;
      const free = vi.spyOn(old, 'free');
      const step = await adapter.exportStep(document, [document.bodyOrder[99]!]);
      expect(step).toContain('MANIFOLD_SOLID_BREP');
      expect(free).toHaveBeenCalledOnce();
      expect(ownership(adapter, 26)).not.toBe(old);
      expect(originalMesh.vertices.byteLength).toBeGreaterThan(0);
      expect(originalMesh.indices.byteLength).toBeGreaterThan(0);
      await equivalent(document, await adapter.syncDocument(document));

      for (let i = 0; i < 492; i++) {
        document = edit(base, 99, 13 + (i % 2));
        await adapter.syncDocument(document);
      }
      const next = await adapter.syncDocument(document);
      expect(events.at(-1)).toMatchObject({
        kind: 'full-rebuild',
        recycleReason: 'replay-budget',
        restored: 0,
        replayed: 100
      });
      await equivalent(document, next);
      ownership(adapter, 26);
      const manager = new CommandManager(base);
      manager.applyDocumentEdit(document, 'Resize late box');
      const undone = manager.undo();
      await equivalent(undone, await adapter.syncDocument(undone));
      const redone = manager.redo();
      await equivalent(redone, await adapter.syncDocument(redone));
      free.mockRestore();
    } finally {
      vi.restoreAllMocks();
      adapter.dispose();
      ownership(adapter, 0);
    }
  });

  it.each([0, -1, 2.5, NaN, Infinity])(
    'preserves disabled and integer count semantics for limit %s',
    async (limit) => {
      const events: RebuildCacheEvent[] = [];
      const adapter = await createExactKernelAdapter({
        historyCheckpointLimit: limit,
        onRebuildCacheEvent: (e) => events.push(e)
      });
      try {
        const document = boxes(5);
        await adapter.syncDocument(document);
        await equivalent(document, await adapter.syncDocument(document));
        const retained = Number.isNaN(limit)
          ? 0
          : Math.min(5, Math.max(0, Math.floor(limit)));
        expect(events.at(-1)).toMatchObject({
          restored: retained,
          replayed: retained > 0 ? 0 : 5,
          reusedMeasurements: retained > 0 ? 5 : 0
        });
        ownership(adapter, retained);
      } finally {
        adapter.dispose();
      }
    }
  );

  it('releases all retained state when shortened to an empty document', async () => {
    const events: RebuildCacheEvent[] = [];
    const adapter = await createExactKernelAdapter({
      onRebuildCacheEvent: (event) => events.push(event)
    });
    try {
      const empty = createProjectDocument('Empty', toUserId('cache-test'));
      const document = boxes(33, empty);
      await adapter.syncDocument(document);
      const old = ownership(adapter, retained(33).length)!;
      const free = vi.spyOn(old, 'free');
      await equivalent(empty, await adapter.syncDocument(empty));
      expect(free).toHaveBeenCalledOnce();
      free.mockRestore();
      ownership(adapter, 0);
      expect(events.at(-1)).toMatchObject({
        restored: 0,
        replayed: 0,
        reusedMeasurements: 0
      });
      expect(
        (adapter as unknown as { measuredShapeCacheBytes: number })
          .measuredShapeCacheBytes
      ).toBe(0);
      await equivalent(document, await adapter.syncDocument(document));
      expect(events.at(-1)).toMatchObject({ restored: 0, replayed: 33 });
      ownership(adapter, retained(33).length);
    } finally {
      vi.restoreAllMocks();
      adapter.dispose();
    }
  });

  it('preserves cached failure warnings and invalidates them when repaired', async () => {
    const events: RebuildCacheEvent[] = [];
    const adapter = await createExactKernelAdapter({
      historyCheckpointLimit: 2,
      onRebuildCacheEvent: (event) => events.push(event)
    });
    try {
      const broken = edit(boxes(5), 1, -1);
      const initial = await adapter.syncDocument(broken);
      expect(
        initial.featureWarnings?.some((w) => w.kind === 'build-failed')
      ).toBe(true);
      const changed = edit(broken, 4, 12);
      for (let i = 0; i < 3; i++) {
        const actual = await adapter.syncDocument(changed);
        expect(actual.featureWarnings).toEqual(initial.featureWarnings);
        expect(events.at(-1)).toMatchObject({ restored: 2, replayed: i === 0 ? 1 : 0 });
        ownership(adapter, 2);
        await equivalent(changed, actual);
      }
      const repaired = edit(changed, 1, 10);
      const actual = await adapter.syncDocument(repaired);
      expect(
        actual.featureWarnings?.some((w) => w.kind === 'build-failed')
      ).toBe(false);
      expect(events.at(-1)).toMatchObject({ restored: 1, replayed: 1, reusedPrimitives: 3 });
      ownership(adapter, 2);
      await equivalent(repaired, actual);
    } finally {
      adapter.dispose();
    }
  });

  it('invalidates sketch objects, resolved parameters, units and project identity beyond a small budget', async () => {
    const events: RebuildCacheEvent[] = [];
    const adapter = await createExactKernelAdapter({
      historyCheckpointLimit: 3,
      onRebuildCacheEvent: (e) => events.push(e)
    });
    try {
      const sketch = addSketchFeature(boxes(1), {
        name: 'Profile',
        planeRef: { type: 'canonical', plane: 'XY', offset: 0 },
        objects: [{ objectKind: 'circle', radius: 3, centerX: 40, centerY: 0 }]
      });
      const document = boxes(
        3,
        extrudeSketch(sketch.document, {
          name: 'Extrusion',
          sketchId: sketch.sketchId,
          distance: 4
        }).document
      );
      await adapter.syncDocument(document);
      const changed = updateSketchObject(document, {
        sketchId: sketch.sketchId,
        objectId: findSketch(document, sketch.sketchId)!.objectIds[0]!,
        data: { objectKind: 'circle', radius: 4, centerX: 40, centerY: 0 }
      });
      const parameter = setParameter(changed, { name: 'w', expression: '12' });
      for (const [next, restored] of [
        [changed, 1],
        [parameter, 1],
        [{ ...parameter, units: 'inch' }, 0],
        [
          {
            ...parameter,
            units: 'inch',
            projectId: createProjectDocument('Other', toUserId('cache-test'))
              .projectId
          },
          0
        ]
      ] as const) {
        await equivalent(next, await adapter.syncDocument(next));
        expect(events.at(-1)?.restored).toBe(restored);
        ownership(adapter, 3);
      }
    } finally {
      adapter.dispose();
    }
  });

  it('keeps import measurements only for unchanged source, topology and analysis', async () => {
    const events: RebuildCacheEvent[] = [];
    const adapter = await createExactKernelAdapter({
      historyCheckpointLimit: 2,
      onRebuildCacheEvent: (e) => events.push(e)
    });
    try {
      const seed = boxes(1);
      const source = await adapter.exportStep(seed, seed.bodyOrder);
      const changedSource = await adapter.exportStep(
        edit(seed, 0, 12),
        seed.bodyOrder
      );
      let document = boxes(
        5,
        importStepBody(
          createProjectDocument('Import', toUserId('cache-test')),
          {
            name: 'Import',
            artifactId: 'source',
            sourceName: 'source.step',
            stepText: source
          }
        ).document
      );
      const original = await adapter.syncDocument(document);
      document = edit(document, 5, 11);
      const changed = await adapter.syncDocument(document);
      expect(events.at(-1)).toMatchObject({
        restored: 2,
        replayed: 1,
        reusedPrimitives: 3,
        reusedMeasurements: 5
      });
      const bodyId = document.bodyOrder[0]!;
      expect(changed.bodyRepresentations[bodyId]!.mesh).toEqual(
        original.bodyRepresentations[bodyId]!.mesh
      );
      await equivalent(document, changed);
      const analysis = {
        bodyId,
        faceHashes: [
          changed.bodyRepresentations[bodyId]!.topology!.faces[0]!.hash
        ]
      };
      const analyzed = await adapter.syncDocument(
        document,
        undefined,
        undefined,
        analysis
      );
      expect(events.at(-1)?.reusedMeasurements).toBe(5);
      await equivalent(document, analyzed, analysis);
      await adapter.syncDocument(document, undefined, undefined, analysis);
      expect(events.at(-1)?.reusedMeasurements).toBe(6);
      await equivalent(document, await adapter.syncDocument(document));
      expect(events.at(-1)?.reusedMeasurements).toBe(5);
      document = updateFeature(document, {
        featureId: listFeaturesInOrder(document)[0]!.featureId,
        data: { stepText: changedSource }
      });
      await equivalent(document, await adapter.syncDocument(document));
      expect(events.at(-1)).toMatchObject({
        restored: 0,
        reusedMeasurements: 0
      });
      ownership(adapter, 2);
    } finally {
      adapter.dispose();
    }
  });

  it('reuses independent parametric features and invalidates transitive dependencies', async () => {
    const events: RebuildCacheEvent[] = [];
    const adapter = await createExactKernelAdapter({
      onRebuildCacheEvent: (event) => events.push(event)
    });
    try {
      let document = boxes(2);
      document = setParameter(document, { name: 'width', expression: '10' });
      document = setParameter(document, {
        name: 'doubleWidth',
        expression: 'width * 2'
      });
      document = setParameter(document, { name: 'height', expression: '8' });
      document = updateFeature(document, {
        featureId: listFeaturesInOrder(document)[0]!.featureId,
        data: { dimensions: { width: 'doubleWidth', height: 8, depth: 6 } }
      });
      document = updateFeature(document, {
        featureId: listFeaturesInOrder(document)[1]!.featureId,
        data: { dimensions: { width: 10, height: 'height', depth: 6 } }
      });
      await equivalent(document, await adapter.syncDocument(document));

      const unrelated = setParameter(document, {
        name: 'unused',
        expression: '99'
      });
      await equivalent(unrelated, await adapter.syncDocument(unrelated));
      expect(events.at(-1)).toMatchObject({ restored: 2, replayed: 0 });

      const changedHeight = setParameter(unrelated, {
        name: 'height',
        expression: '9'
      });
      await equivalent(
        changedHeight,
        await adapter.syncDocument(changedHeight)
      );
      expect(events.at(-1)).toMatchObject({ restored: 1, replayed: 1 });

      const changedWidth = setParameter(changedHeight, {
        name: 'width',
        expression: '11'
      });
      await equivalent(changedWidth, await adapter.syncDocument(changedWidth));
      expect(events.at(-1)).toMatchObject({ restored: 0, replayed: 1, reusedPrimitives: 1 });
    } finally {
      adapter.dispose();
    }
  });

  it('replays transitive parameter-dependent dimensions on both sides of the budget', async () => {
    const events: RebuildCacheEvent[] = [];
    const adapter = await createExactKernelAdapter({
      onRebuildCacheEvent: (event) => events.push(event)
    });
    try {
      let document = setParameter(boxes(33), {
        name: 'width',
        expression: '10'
      });
      document = setParameter(document, {
        name: 'twice',
        expression: 'width * 2'
      });
      for (const [index, expression] of [
        [16, 'width'],
        [32, 'twice']
      ] as const) {
        document = updateFeature(document, {
          featureId: listFeaturesInOrder(document)[index]!.featureId,
          data: { dimensions: { width: expression, height: 8, depth: 6 } }
        });
      }
      await adapter.syncDocument(document);
      for (const width of [11, 12, 10]) {
        document = setParameter(document, {
          name: 'width',
          expression: String(width)
        });
        const actual = await adapter.syncDocument(document);
        expect(
          actual.bodyRepresentations[document.bodyOrder[32]!]!.volume
        ).toBeCloseTo(width * 2 * 8 * 6, 8);
        expect(events.at(-1)).toMatchObject({
          restored: 16,
          replayed: 2,
          reusedPrimitives: 15,
          reusedMeasurements: 31
        });
        await equivalent(document, actual);
        ownership(adapter, retained(33).length);
      }
    } finally {
      adapter.dispose();
    }
  });

  it('survives failed suffixes, rollback, undo/redo and exports without stale handles', async () => {
    const events: RebuildCacheEvent[] = [];
    const adapter = await createExactKernelAdapter({
      historyCheckpointLimit: 2,
      onRebuildCacheEvent: (e) => events.push(e)
    });
    try {
      const document = boxes(5);
      await adapter.syncDocument(document);
      const broken = edit(document, 4, -1);
      const refused = await adapter.syncDocument(broken);
      expect(
        refused.featureWarnings?.some((w) => w.kind === 'build-failed')
      ).toBe(true);
      await equivalent(broken, refused);
      await equivalent(document, await adapter.syncDocument(document));
      const manager = new CommandManager(document);
      const changed = manager.applyDocumentEdit(
        edit(document, 4, 12),
        'Resize box'
      );
      for (const next of [changed, manager.undo(), manager.redo()]) {
        const actual = await adapter.syncDocument(next);
        await equivalent(next, actual);
        expect(events.at(-1)).toMatchObject({ restored: 2, replayed: 1 });
        const ids = actual.exportableBodyIds;
        const step = await adapter.exportStep(next, ids);
        ownership(adapter, 2);
        expect(step).toContain('MANIFOLD_SOLID_BREP');
        expect(await adapter.exportStep(next, ids)).toBe(step);
        const stl = await adapter.exportStl(next, ids);
        expect(await adapter.exportStl(next, ids)).toBe(stl);
        ownership(adapter, 2);
        expect((await adapter.meshQuality(next, ids, 0.08)).watertight).toBe(
          true
        );
        await expect(adapter.exportStep(next, [])).rejects.toThrow(
          'Select at least one body'
        );
        ownership(adapter, 2);
        await equivalent(next, await adapter.syncDocument(next));
        ownership(adapter, 2);
      }
    } finally {
      adapter.dispose();
    }
  });

  it.each(['sync', 'export', 'recognize'] as const)(
    'releases partially created checkpoint ownership after a thrown %s build',
    async (operation) => {
      const adapter = await createExactKernelAdapter({
        historyCheckpointLimit: 2
      });
      const original = RemusKernel.prototype.checkpoint;
      const checkpoint = vi.spyOn(RemusKernel.prototype, 'checkpoint');
      let calls = 0;
      checkpoint.mockImplementation(function (this: RemusKernel) {
        const id = original.call(this);
        if (++calls === 2) throw new Error('Injected checkpoint failure');
        return id;
      });
      const document = boxes(5);
      try {
        if (operation === 'sync')
          await expect(adapter.syncDocument(document)).rejects.toThrow(
            'Injected'
          );
        else if (operation === 'export')
          await expect(
            adapter.exportStep(document, document.bodyOrder)
          ).rejects.toThrow('Injected');
        else
          expect(
            (
              await adapter.recognizeImportedFace({
                document,
                bodyId: document.bodyOrder[0]!,
                faceHash: 1
              })
            ).kind
          ).toBe('unsupported');
        expect(ownership(adapter, 0)).toBeNull();
        checkpoint.mockRestore();
        await equivalent(document, await adapter.syncDocument(document));
        ownership(adapter, 2);
      } finally {
        checkpoint.mockRestore();
        adapter.dispose();
      }
    }
  );

  it('falls back exactly after a failed restore and releases the old kernel on reset', async () => {
    const adapter = await createExactKernelAdapter({
      historyCheckpointLimit: Infinity
    });
    try {
      const document = boxes(5);
      await adapter.syncDocument(document);
      const old = ownership(adapter, 5)!;
      const free = vi.spyOn(old, 'free');
      const restore = vi.spyOn(old, 'restore').mockImplementationOnce(() => {
        throw new Error('Injected restore failure');
      });
      await equivalent(document, await adapter.syncDocument(document));
      expect(ownership(adapter, 5)).not.toBe(old);
      expect(free).toHaveBeenCalledOnce();
      restore.mockRestore();
      free.mockRestore();
      adapter.dispose();
      expect(ownership(adapter, 0)).toBeNull();
      await equivalent(document, await adapter.syncDocument(document));
      ownership(adapter, 5);
    } finally {
      adapter.dispose();
    }
  });

  it.each(['feature', 'measurement'])(
    'keeps diagnostic observer failures isolated from exact %s work',
    async (stage) => {
      const adapter = await createExactKernelAdapter({
        historyCheckpointLimit: 2
      });
      try {
        const document = boxes(5);
        await adapter.syncDocument(document);
        const changed = edit(document, 4, 11);
        await equivalent(
          changed,
          await adapter.syncDocument(changed, (event) => {
            if (event.stage === stage)
              throw new Error('Injected observer failure');
          })
        );
        ownership(adapter, 2);
      } finally {
        adapter.dispose();
      }
    }
  );

  it('frees both owners after an unexpected measurement failure', async () => {
    const adapter = await createExactKernelAdapter({
      historyCheckpointLimit: 2
    });
    const measurable = adapter as unknown as { measureShape: () => unknown };
    try {
      const document = boxes(5);
      await adapter.syncDocument(document);
      const measurement = vi
        .spyOn(measurable, 'measureShape')
        .mockImplementationOnce(() => {
          throw new Error('Injected measurement failure');
        });
      await expect(adapter.syncDocument(edit(document, 4, 11))).rejects.toThrow(
        'Injected measurement failure'
      );
      expect(ownership(adapter, 0)).toBeNull();
      measurement.mockRestore();
      await equivalent(document, await adapter.syncDocument(document));
      ownership(adapter, 2);
    } finally {
      vi.restoreAllMocks();
      adapter.dispose();
    }
  });
});
