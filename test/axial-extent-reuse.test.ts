import { afterEach, describe, expect, it, vi } from 'vitest';
import { listFeaturesInOrder, updateFeature } from '@openzcad/document-core';
import {
  createExactKernelAdapter,
  type RebuildCacheEvent
} from '@openzcad/kernel-adapter/exact';
import type { DerivedState, ProjectDocument } from '@openzcad/shared';
import { RemusKernel } from '../packages/kernel-adapter/src/remus-runtime';
import { isBuildCancelled } from '../packages/kernel-adapter/src/exact-cancellation';
import {
  longFilletedUnion as longUnion,
  unionEndFace
} from './support/filleted-union';
import { planFaceOffset } from '../apps/web/src/lib/interaction/faceOffsetPlan';

function physical(derived: DerivedState) {
  const rounded = (value: unknown): unknown => {
    if (typeof value === 'number') return Math.round(value * 1e7) / 1e7;
    if (Array.isArray(value)) return value.map(rounded);
    if (value && typeof value === 'object')
      return Object.fromEntries(
        Object.entries(value).map(([key, entry]) => [key, rounded(entry)])
      );
    return value;
  };
  return {
    warnings: derived.warnings,
    featureWarnings: derived.featureWarnings,
    exportable: derived.exportableBodyIds,
    bodies: Object.entries(derived.bodyRepresentations).map(([id, b]) => ({
      id,
      volume: rounded(b.volume),
      bbox: rounded(b.bbox),
      faces: b.topology?.faces
        .map((f) => [f.hash, f.reference ?? null])
        .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
      edges: b.topology?.edges
        .map((e) => [e.hash, e.reference ?? null])
        .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
    }))
  };
}

async function fresh(document: ProjectDocument, idle = false) {
  const started = performance.now();
  const adapter = await createExactKernelAdapter({ historyCheckpointLimit: 0 });
  try {
    return physical(
      await adapter.syncDocument(
        document,
        undefined,
        undefined,
        undefined,
        idle ? { lineageDemand: [] } : undefined
      )
    );
  } finally {
    adapter.dispose();
    if (process.env.AXIAL_REUSE_TIMINGS === '1')
      console.info('axial cold replay', {
        idle,
        ms: performance.now() - started
      });
  }
}

function widthEdit(document: ProjectDocument, delta: number) {
  const bodyId = document.derived.exportableBodyIds.at(-1)!;
  const face = unionEndFace(document.derived.bodyRepresentations[bodyId]!);
  const plan = planFaceOffset({
    document,
    bodyId,
    face,
    faceHash: face.hash,
    offset: delta
  });
  expect(plan?.kind).toBe('primitive-dimension');
  return plan!.command.apply(document);
}

describe('qualified axial history reuse', { timeout: 300_000 }, () => {
  afterEach(() => vi.restoreAllMocks());

  // Multiple cold full-history oracle replays exceed 120 s on the new kernel
  // under CI contention; this verifies equivalence, not a latency budget.
  it('preserves geometry, references and idle lineage through successive width edits', async () => {
    const events: RebuildCacheEvent[] = [];
    const adapter = await createExactKernelAdapter({
      onRebuildCacheEvent: (e) => events.push(e)
    });
    try {
      let { document } = await longUnion(adapter);
      const original = document;
      const fillets = vi.spyOn(RemusKernel.prototype, 'filletWithEvolution');
      for (const delta of [2.75, -1.25, 4.5, -2]) {
        const next = widthEdit(document, delta);
        fillets.mockClear();
        const started = performance.now();
        const derived = await adapter.syncDocument(next);
        if (process.env.AXIAL_REUSE_TIMINGS === '1')
          console.info('axial cached width edit', {
            delta,
            ms: performance.now() - started
          });
        expect(fillets).not.toHaveBeenCalled();
        expect(events.at(-1)).toMatchObject({
          reusedAxialFeatures: next.featureOrder.length - 1,
          replayed: 1
        });
        expect(physical(derived)).toEqual(await fresh(next));
        fillets.mockClear();
        const idle = await adapter.syncDocument(
          next,
          undefined,
          undefined,
          undefined,
          { lineageDemand: [] }
        );
        expect(fillets).not.toHaveBeenCalled();
        expect(events.at(-1)).toMatchObject({
          restored: next.featureOrder.length - 1,
          replayed: 1
        });
        expect(physical(idle)).toEqual(await fresh(next, true));
        document = { ...next, derived };
      }
      const undone = await adapter.syncDocument(original);
      expect(events.at(-1)?.reusedAxialFeatures).toBeGreaterThan(0);
      expect(physical(undone)).toEqual(await fresh(original));
    } finally {
      adapter.dispose();
    }
  }, 600_000);

  it('replays when a contraction reaches the non-invariant region', async () => {
    const events: RebuildCacheEvent[] = [];
    const adapter = await createExactKernelAdapter({
      onRebuildCacheEvent: (e) => events.push(e)
    });
    try {
      const { document } = await longUnion(adapter);
      const next = widthEdit(document, -20);
      const derived = await adapter.syncDocument(next);
      expect(events.at(-1)?.reusedAxialFeatures).toBeUndefined();
      expect(events.at(-1)!.replayed).toBeGreaterThan(1);
      expect(physical(derived)).toEqual(await fresh(next));
    } finally {
      adapter.dispose();
    }
  });

  // This case also includes several independent cold-history oracles.
  it('retains a checked prefix through a resting preview, release and cancel', async () => {
    const events: RebuildCacheEvent[] = [];
    const adapter = await createExactKernelAdapter({
      onRebuildCacheEvent: (event) => events.push(event)
    });
    try {
      const { document } = await longUnion(adapter);
      const next = widthEdit(document, 2.25);
      const fillets = vi.spyOn(RemusKernel.prototype, 'filletWithEvolution');
      const preview = await adapter.previewGeometry(next, {
        deferTopology: true
      });
      expect(preview.analysis).toBe('pending');
      // Geometry-only replies publish no complete rebuild cache event.
      // The native spy and the following checked restore prove prefix reuse.
      expect(fillets).not.toHaveBeenCalled();
      const derived = await adapter.syncDocument(next);
      expect(events.at(-1)).toMatchObject({
        restored: next.featureOrder.length - 1,
        replayed: 1
      });
      expect(fillets).not.toHaveBeenCalled();
      expect(physical(derived)).toEqual(await fresh(next));
      fillets.mockClear();
      const idle = await adapter.syncDocument(
        next,
        undefined,
        undefined,
        undefined,
        { lineageDemand: [] }
      );
      expect(fillets).not.toHaveBeenCalled();
      expect(physical(idle)).toEqual(await fresh(next, true));
      const later = widthEdit({ ...next, derived }, 1);
      await adapter.previewGeometry(later, { deferTopology: true });
      fillets.mockClear();
      const cancelled = await adapter.syncDocument(document);
      expect(events.at(-1)?.reusedAxialFeatures).toBe(
        document.featureOrder.length - 1
      );
      expect(fillets).not.toHaveBeenCalled();
      expect(physical(cancelled)).toEqual(await fresh(document));
    } finally {
      adapter.dispose();
    }
  }, 300_000);

  it('keeps the checked source when an in-flight resting preview is cancelled', async () => {
    const events: RebuildCacheEvent[] = [];
    const adapter = await createExactKernelAdapter({
      onRebuildCacheEvent: (event) => events.push(event)
    });
    try {
      const { document } = await longUnion(adapter);
      const next = widthEdit(document, 2);
      let cancelled = false;
      const native = RemusKernel.prototype.moveFacesJournaled;
      const journal = vi
        .spyOn(RemusKernel.prototype, 'moveFacesJournaled')
        .mockImplementationOnce(function (this: RemusKernel, ...args) {
          const result = native.apply(this, args);
          cancelled = true;
          return result;
        });
      const outcome = await adapter
        .previewGeometry(next, {
          deferTopology: true,
          cancellation: { isCancelled: () => cancelled }
        })
        .catch((error: unknown) => isBuildCancelled(error));
      expect(outcome).toBe(true);
      journal.mockRestore();
      const fillets = vi.spyOn(RemusKernel.prototype, 'filletWithEvolution');
      const result = await adapter.syncDocument(next);
      expect(events.at(-1)?.reusedAxialFeatures).toBe(
        next.featureOrder.length - 1
      );
      expect(fillets).not.toHaveBeenCalled();
      expect(physical(result)).toEqual(await fresh(next));
    } finally {
      adapter.dispose();
    }
  });

  it('does not promote a display-only initial history into a checked prefix', async () => {
    const authoring = await createExactKernelAdapter();
    const model = await longUnion(authoring).finally(() => authoring.dispose());
    const events: RebuildCacheEvent[] = [];
    const adapter = await createExactKernelAdapter({
      onRebuildCacheEvent: (event) => events.push(event)
    });
    try {
      await adapter.previewGeometry(model.document, { deferTopology: true });
      const next = widthEdit(model.document, 2);
      const fillets = vi.spyOn(RemusKernel.prototype, 'filletWithEvolution');
      const result = await adapter.syncDocument(next);
      expect(fillets).toHaveBeenCalled();
      expect(events.at(-1)?.reusedAxialFeatures).toBeUndefined();
      expect(physical(result)).toEqual(await fresh(next));
    } finally {
      adapter.dispose();
    }
  });

  it('does not skip a simultaneous radius change', async () => {
    const events: RebuildCacheEvent[] = [];
    const adapter = await createExactKernelAdapter({
      onRebuildCacheEvent: (e) => events.push(e)
    });
    try {
      const { document } = await longUnion(adapter);
      const fillet = listFeaturesInOrder(document).find(
        (f) => f.data.featureKind === 'fillet'
      )!;
      const next = updateFeature(widthEdit(document, 3), {
        featureId: fillet.featureId,
        data: { radius: 4 }
      });
      const derived = await adapter.syncDocument(next);
      expect(events.at(-1)?.reusedAxialFeatures).toBeUndefined();
      expect(events.at(-1)!.replayed).toBeGreaterThan(1);
      expect(physical(derived)).toEqual(await fresh(next));
    } finally {
      adapter.dispose();
    }
  });

  it('rolls back an unavailable native construction map before ordinary replay', async () => {
    const events: RebuildCacheEvent[] = [];
    const adapter = await createExactKernelAdapter({
      onRebuildCacheEvent: (e) => events.push(e)
    });
    try {
      const { document } = await longUnion(adapter);
      const next = widthEdit(document, 2);
      const journal = vi
        .spyOn(RemusKernel.prototype, 'moveFacesJournaled')
        .mockImplementationOnce(() => {
          throw new Error('injected missing journal');
        });
      const derived = await adapter.syncDocument(next);
      expect(journal).toHaveBeenCalled();
      expect(events.at(-1)?.reusedAxialFeatures).toBeUndefined();
      expect(physical(derived)).toEqual(await fresh(next));
      journal.mockRestore();
      const later = widthEdit({ ...next, derived }, 1);
      const result = await adapter.syncDocument(later);
      expect(events.at(-1)?.reusedAxialFeatures).toBeGreaterThan(0);
      expect(physical(result)).toEqual(await fresh(later));
    } finally {
      adapter.dispose();
    }
  });
  it('keeps expression widths on ordinary replay', async () => {
    const events: RebuildCacheEvent[] = [];
    const adapter = await createExactKernelAdapter({
      onRebuildCacheEvent: (e) => events.push(e)
    });
    try {
      const model = await longUnion(adapter);
      const root = listFeaturesInOrder(model.document)[0]!;
      if (root.data.featureKind !== 'primitive')
        throw new Error('fixture root');
      const expression = updateFeature(model.document, {
        featureId: root.featureId,
        data: {
          dimensions: { ...root.data.dimensions, width: '30 + 0' }
        }
      });
      const initial = await adapter.syncDocument(expression);
      const next = widthEdit({ ...expression, derived: initial }, 2);
      const result = await adapter.syncDocument(next);
      expect(events.at(-1)?.reusedAxialFeatures).toBeUndefined();
      expect(physical(result)).toEqual(await fresh(next));
    } finally {
      adapter.dispose();
    }
  });

  it('does not reuse width-sensitive legacy edge hashes', async () => {
    const authoring = await createExactKernelAdapter();
    const model = await longUnion(authoring).finally(() => authoring.dispose());
    const fillet = listFeaturesInOrder(model.document).find(
      (f) => f.data.featureKind === 'fillet'
    )!;
    const legacy = structuredClone(model.document);
    const legacyFillet = listFeaturesInOrder(legacy).find(
      (f) => f.featureId === fillet.featureId
    )!;
    if (legacyFillet.data.featureKind !== 'fillet')
      throw new Error('fixture fillet');
    delete legacyFillet.data.edgeReferences;
    const events: RebuildCacheEvent[] = [];
    const adapter = await createExactKernelAdapter({
      onRebuildCacheEvent: (e) => events.push(e)
    });
    try {
      const initial = await adapter.syncDocument(legacy);
      const next = widthEdit({ ...legacy, derived: initial }, 2);
      const result = await adapter.syncDocument(next);
      expect(events.at(-1)?.reusedAxialFeatures).toBeUndefined();
      expect(physical(result)).toEqual(await fresh(next));
    } finally {
      adapter.dispose();
    }
  });

  it('rolls back a cancelled local update and keeps the next build usable', async () => {
    const adapter = await createExactKernelAdapter();
    try {
      const { document } = await longUnion(adapter);
      const next = widthEdit(document, 2);
      let cancelled = false;
      const native = RemusKernel.prototype.moveFacesJournaled;
      const journal = vi
        .spyOn(RemusKernel.prototype, 'moveFacesJournaled')
        .mockImplementationOnce(function (this: RemusKernel, ...args) {
          const result = native.apply(this, args);
          cancelled = true;
          return result;
        });
      const outcome = await adapter
        .syncDocument(next, undefined, undefined, undefined, {
          cancellation: { isCancelled: () => cancelled }
        })
        .catch((error: unknown) => isBuildCancelled(error));
      expect(outcome).toBe(true);
      expect(journal).toHaveBeenCalled();
      journal.mockRestore();
      const result = await adapter.syncDocument(next);
      expect(physical(result)).toEqual(await fresh(next));
    } finally {
      adapter.dispose();
    }
  });
});
