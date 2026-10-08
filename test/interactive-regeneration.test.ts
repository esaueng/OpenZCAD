import { describe, expect, it } from 'vitest';
import {
  addPrimitiveFeature,
  booleanBodies,
  createProjectDocument,
  listFeaturesInOrder,
  setParameter,
  transformBody,
  updateFeature
} from '@openzcad/document-core';
import {
  createExactKernelAdapter,
  type RebuildCacheEvent
} from '@openzcad/kernel-adapter/exact';
import { toUserId, type DerivedState } from '@openzcad/shared';
import { kernelRefusalCategoryOf } from '../packages/kernel-adapter/src/kernel-refusal';
import type { RemusKernel } from '../packages/kernel-adapter/src/remus-runtime';
import { syncReadMemoFor } from '../packages/kernel-adapter/src/exact-sync-memo';

function boxes(count: number) {
  let document = createProjectDocument(
    'Interactive regeneration',
    toUserId('regen-test')
  );
  for (let index = 0; index < count; index++) {
    document = addPrimitiveFeature(document, {
      name: `Box ${index}`,
      primitiveKind: 'box',
      dimensions: { width: 10, height: 8, depth: 6 }
    });
  }
  return document;
}

function normalized({ updatedAt: _updatedAt, ...derived }: DerivedState) {
  // Compare all published topology, witnesses, references and actual mesh
  // coordinates, including normals and grouping; only the timestamp is volatile.
  return derived;
}

describe('interactive regeneration', { timeout: 120_000 }, () => {
  it('closes synchronous memo scopes before another adapter runs during a yield', async () => {
    const adapter = await createExactKernelAdapter();
    const other = await createExactKernelAdapter();
    const fresh = await createExactKernelAdapter({ historyCheckpointLimit: 0 });
    try {
      const base = boxes(3);
      const otherDocument = boxes(2);
      await adapter.syncDocument(base);
      const kernel = (adapter as unknown as { historyKernel: RemusKernel })
        .historyKernel;
      const edited = updateFeature(base, {
        featureId: listFeaturesInOrder(base)[0]!.featureId,
        data: { dimensions: { width: 12, height: 8, depth: 6 } }
      });
      let ranOther = false;
      let scopedFeature = false;
      const actual = await adapter.syncDocument(
        edited,
        (progress) => {
          if (progress.stage === 'feature' && progress.status === 'completed') {
            expect(syncReadMemoFor(kernel)).not.toBeNull();
            scopedFeature = true;
          }
        },
        undefined,
        undefined,
        {
          yieldControl: async () => {
            expect(syncReadMemoFor(kernel)).toBeNull();
            if (ranOther) return;
            ranOther = true;
            expect(normalized(await other.syncDocument(otherDocument))).toEqual(
              normalized(await fresh.syncDocument(otherDocument))
            );
            expect(syncReadMemoFor(kernel)).toBeNull();
          }
        }
      );
      expect(ranOther && scopedFeature).toBe(true);
      expect(normalized(actual)).toEqual(
        normalized(await fresh.syncDocument(edited))
      );
      expect(syncReadMemoFor(kernel)).toBeNull();
    } finally {
      adapter.dispose();
      other.dispose();
      fresh.dispose();
    }
  });

  it('keeps one history owner across a yielded sync, another sync, export and mass preparation', async () => {
    const adapter = await createExactKernelAdapter();
    const fresh = await createExactKernelAdapter({ historyCheckpointLimit: 0 });
    let release!: () => void;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered!: () => void;
    const waiting = new Promise<void>((resolve) => {
      entered = resolve;
    });
    try {
      const base = boxes(3);
      await adapter.syncDocument(base);
      const edit = (width: number) =>
        updateFeature(base, {
          featureId: listFeaturesInOrder(base)[0]!.featureId,
          data: { dimensions: { width, height: 8, depth: 6 } }
        });
      let held = false;
      const firstDocument = edit(12);
      const first = adapter.syncDocument(
        firstDocument,
        undefined,
        undefined,
        undefined,
        {
          yieldControl: () => {
            if (held) return;
            held = true;
            entered();
            return hold;
          }
        }
      );
      await waiting;
      const secondDocument = edit(14);
      let secondStarted = false;
      const second = adapter.syncDocument(secondDocument, () => {
        secondStarted = true;
      });
      const step = adapter.exportStep(secondDocument, [base.bodyOrder[0]!]);
      const mass = adapter.prepareMassPropertiesForDocument(secondDocument);
      const results = Promise.allSettled([first, second, step, mass]);
      await new Promise((resolve) => setTimeout(resolve, 0));
      const overlapped = secondStarted;
      release();
      const settled = await results;
      expect(overlapped).toBe(false);
      expect(settled.every((result) => result.status === 'fulfilled')).toBe(
        true
      );
      expect(normalized(await first)).toEqual(
        normalized(await fresh.syncDocument(firstDocument))
      );
      expect(normalized(await second)).toEqual(
        normalized(await fresh.syncDocument(secondDocument))
      );
      expect(await step).toContain('MANIFOLD_SOLID_BREP');
      // An export can enter ownership after loading the translator and retire
      // the queued mass epoch. Reprepare it as the Inspector does after export.
      const epoch =
        await adapter.prepareMassPropertiesForDocument(secondDocument);
      const properties = adapter.readCurrentMassProperties({
        projectId: secondDocument.projectId,
        version: secondDocument.version,
        bodyId: base.bodyOrder[0]!,
        epoch
      });
      expect(properties.status).toBe('ready');
    } finally {
      release();
      adapter.dispose();
      fresh.dispose();
    }
  });

  it('retains independent roots while a changed parameter rebuilds the boolean dependency', async () => {
    const events: RebuildCacheEvent[] = [];
    const adapter = await createExactKernelAdapter({
      onRebuildCacheEvent: (e) => events.push(e)
    });
    const fresh = await createExactKernelAdapter({ historyCheckpointLimit: 0 });
    try {
      let document = setParameter(boxes(30), {
        name: 'width',
        expression: '10'
      });
      document = updateFeature(document, {
        featureId: listFeaturesInOrder(document)[0]!.featureId,
        data: { dimensions: { width: 'width', height: 8, depth: 6 } }
      });
      document = transformBody(document, {
        name: 'Place tool',
        targetBodyId: document.bodyOrder[1]!,
        translation: { x: 5, y: 0, z: 0 }
      }).document;
      document = booleanBodies(document, {
        name: 'Union',
        operation: 'union',
        targetBodyIds: [document.bodyOrder[0]!, document.bodyOrder[1]!]
      }).document;
      await adapter.syncDocument(document);
      for (const width of ['12', '10', '14', '10']) {
        const edited = setParameter(document, {
          name: 'width',
          expression: width
        });
        const actual = await adapter.syncDocument(edited);
        expect(actual.warnings).toEqual([]);
        expect(events.at(-1)).toMatchObject({
          kind: 'independent-reuse',
          replayed: 3,
          reusedPrimitives: 29,
          remeasured: 3,
          reusedMeasurements: 28
        });
        expect(
          actual.bodyRepresentations[edited.bodyOrder.at(-1)!]!.volume
        ).toBeCloseTo(15 * 8 * 6, 7);
        expect(normalized(actual)).toEqual(
          normalized(await fresh.syncDocument(edited))
        );
      }
      // Export restores checkpoints and retires tail handles. The subsequent
      // reuse must honor that restore rather than serving retired primitives.
      const step = await adapter.exportStep(document, [
        document.bodyOrder.at(-1)!
      ]);
      expect(step).toContain('MANIFOLD_SOLID_BREP');
      expect(normalized(await adapter.syncDocument(document))).toEqual(
        normalized(await fresh.syncDocument(document))
      );
    } finally {
      adapter.dispose();
      fresh.dispose();
    }
  });

  it.each(['history', 'measurement', 'final-body'] as const)(
    'observes an incoming task during %s and never publishes the obsolete build',
    async (stage) => {
      const events: RebuildCacheEvent[] = [];
      const adapter = await createExactKernelAdapter({
        onRebuildCacheEvent: (e) => events.push(e)
      });
      const fresh = await createExactKernelAdapter({
        historyCheckpointLimit: 0
      });
      try {
        const document = boxes(stage === 'final-body' ? 1 : 30);
        let cancelled = false;
        let completed = 0;
        let armed = false;
        let rejection: unknown;
        try {
          await adapter.syncDocument(
            document,
            (progress) => {
              if (
                progress.stage === 'feature' &&
                progress.status === 'completed'
              )
                completed++;
              const trigger =
                stage === 'history'
                  ? progress.stage === 'feature'
                  : progress.stage === 'measurement';
              if (!armed && trigger && progress.status === 'completed') {
                armed = true;
                setTimeout(() => {
                  cancelled = true;
                }, 0);
              }
            },
            undefined,
            undefined,
            {
              cancellation: { isCancelled: () => cancelled },
              yieldControl: () =>
                armed
                  ? new Promise((resolve) => setTimeout(resolve, 0))
                  : undefined
            }
          );
        } catch (error) {
          rejection = error;
        }
        expect(kernelRefusalCategoryOf(rejection)).toBe('cancelled');
        expect(events).toEqual([]);
        if (stage === 'history') expect(completed).toBe(1);
        expect(adapter.currentMassPropertiesEpoch()).toBeNull();
        const latest = updateFeature(document, {
          featureId: listFeaturesInOrder(document)[0]!.featureId,
          data: { dimensions: { width: 17, height: 8, depth: 6 } }
        });
        const actual = await adapter.syncDocument(latest);
        expect(actual.warnings).toEqual([]);
        expect(normalized(actual)).toEqual(
          normalized(await fresh.syncDocument(latest))
        );
      } finally {
        adapter.dispose();
        fresh.dispose();
      }
    }
  );

  it('charges cancelled replay work and recycles before the next successful build', async () => {
    const events: RebuildCacheEvent[] = [];
    const adapter = await createExactKernelAdapter({
      onRebuildCacheEvent: (event) => events.push(event)
    });
    const fresh = await createExactKernelAdapter({ historyCheckpointLimit: 0 });
    try {
      const base = boxes(2);
      await adapter.syncDocument(base);
      events.length = 0;
      let document = base;
      for (let index = 0; index < 512; index++) {
        document = updateFeature(base, {
          featureId: listFeaturesInOrder(base)[0]!.featureId,
          data: { dimensions: { width: 11 + (index % 2), height: 8, depth: 6 } }
        });
        let cancelled = false;
        await expect(
          adapter.syncDocument(
            document,
            (progress) => {
              if (
                progress.stage === 'feature' &&
                progress.status === 'completed'
              )
                cancelled = true;
            },
            undefined,
            undefined,
            { cancellation: { isCancelled: () => cancelled } }
          )
        ).rejects.toSatisfy(
          (error: unknown) => kernelRefusalCategoryOf(error) === 'cancelled'
        );
      }
      expect(events).toEqual([]);
      expect(adapter.currentMassPropertiesEpoch()).toBeNull();
      const latest = await adapter.syncDocument(document);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        kind: 'full-rebuild',
        recycleReason: 'replay-budget',
        replayed: 2
      });
      expect(normalized(latest)).toEqual(
        normalized(await fresh.syncDocument(document))
      );
    } finally {
      adapter.dispose();
      fresh.dispose();
    }
  });
});
