import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  addPrimitiveFeature,
  booleanBodies,
  createProjectDocument,
  importStepBody,
  listFeaturesInOrder,
  transformBody,
  updateFeature
} from '@openzcad/document-core';
import { toUserId, type BodyId, type DerivedState } from '@openzcad/shared';
import {
  createExactKernelAdapter,
  type ExactKernelAdapter,
  type RebuildCacheEvent
} from '@openzcad/kernel-adapter/exact';
import type {
  HistoryCheckpointEntry,
  MeasuredBodyCacheEntry
} from '../packages/kernel-adapter/src/exact-history-cache';
import { RemusKernel } from '../packages/kernel-adapter/src/remus-runtime';

function document() {
  return addPrimitiveFeature(
    createProjectDocument('Cache proof', toUserId('test')),
    {
      name: 'Box',
      primitiveKind: 'box',
      dimensions: { width: 10, height: 8, depth: 6 }
    }
  );
}

function state(adapter: ExactKernelAdapter) {
  return adapter as unknown as {
    historyKernel: RemusKernel | null;
    historyCheckpoints: HistoryCheckpointEntry[];
    measuredShapeCache: Map<BodyId, MeasuredBodyCacheEntry>;
    measuredShapeCacheBytes: number;
  };
}

function normalized({ updatedAt: _timestamp, ...derived }: DerivedState) {
  return derived;
}

// Fresh replay allocates different slots and can reorder mesh vertices and
// diagonals. Keep the existing corpus boundary: compare triangle count and
// every published topology/lineage/validation field across different arenas.
// Cache-hit and corruption-recovery tests above still compare buffer bytes.
function acrossArenas(derived: DerivedState) {
  const result = normalized(derived);
  return {
    ...result,
    bodyRepresentations: Object.fromEntries(
      Object.entries(result.bodyRepresentations).map(([id, body]) => [
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

afterEach(() => vi.restoreAllMocks());

describe('H02 unchanged measurement payload safety', () => {
  it('records the completed strict verdict without validating again just to retain it', async () => {
    const adapter = await createExactKernelAdapter();
    try {
      let doc = addPrimitiveFeature(document(), {
        name: 'Overlap',
        primitiveKind: 'box',
        dimensions: { width: 12, height: 8, depth: 6 }
      });
      doc = booleanBodies(doc, {
        name: 'Union',
        operation: 'union',
        targetBodyIds: doc.bodyOrder
      }).document;
      const validation = vi.spyOn(RemusKernel.prototype, 'validateSolid');
      const unionGate = vi.spyOn(RemusKernel.prototype, 'unifyFacesChecked');
      const measurable = adapter as unknown as {
        measureShape: (...args: unknown[]) => unknown;
      };
      const measure = measurable.measureShape;
      let validationsAtMeasureReturn = 0;
      vi.spyOn(measurable, 'measureShape').mockImplementation((...args) => {
        const measured: unknown = Reflect.apply(measure, adapter, args);
        validationsAtMeasureReturn = validation.mock.calls.length;
        return measured;
      });
      expect((await adapter.syncDocument(doc)).warnings).toEqual([]);
      expect(unionGate).toHaveBeenCalled();
      expect(validation.mock.calls).toHaveLength(validationsAtMeasureReturn);
      expect(
        state(adapter)
          .measuredShapeCache.get(doc.bodyOrder.at(-1)!)!
          .witness.solids.every((solid) => solid.strictErrors === 0)
      ).toBe(true);
    } finally {
      adapter.dispose();
    }
  });
  it('keeps published imported lineage separate from retained prefix snapshots', async () => {
    const adapter = await createExactKernelAdapter();
    try {
      const imported = importStepBody(
        createProjectDocument('Lineage ownership', toUserId('test')),
        {
          name: 'Source',
          artifactId: 'source',
          sourceName: 'synthetic-holder.step',
          stepText: readFileSync(
            new URL(
              './fixtures/hammer-holder/synthetic-holder.step',
              import.meta.url
            ),
            'utf8'
          )
        }
      );
      const before = await adapter.syncDocument(imported.document);
      const expected = structuredClone(before);
      const reference = before.bodyRepresentations[
        imported.bodyId
      ]!.topology!.faces.find((face) => face.reference)?.reference;
      expect(reference).toBeDefined();
      reference!.lineageName = 'caller mutation';
      expect(normalized(await adapter.syncDocument(imported.document))).toEqual(
        normalized(expected)
      );
    } finally {
      adapter.dispose();
    }
  });
  it('revalidates strict unions on hits and refuses a changed strict verdict', async () => {
    const events: RebuildCacheEvent[] = [];
    const adapter = await createExactKernelAdapter({
      onRebuildCacheEvent: (event) => events.push(event)
    });
    try {
      let doc = addPrimitiveFeature(document(), {
        name: 'Overlap',
        primitiveKind: 'box',
        dimensions: { width: 12, height: 8, depth: 6 }
      });
      doc = booleanBodies(doc, {
        name: 'Union',
        operation: 'union',
        targetBodyIds: doc.bodyOrder
      }).document;
      const expected = await adapter.syncDocument(doc);
      expect(expected.warnings).toEqual([]);
      const old = state(adapter).historyKernel!;
      const validation = vi.spyOn(old, 'validateSolid').mockReturnValueOnce(1);
      const free = vi.spyOn(old, 'free');
      expect(normalized(await adapter.syncDocument(doc))).toEqual(
        normalized(expected)
      );
      expect(validation).toHaveBeenCalledOnce();
      expect(free).toHaveBeenCalledOnce();
      expect(events.at(-1)).toMatchObject({
        kind: 'full-rebuild',
        reusedMeasurements: 0
      });
    } finally {
      adapter.dispose();
    }
  });

  it('never retains unsuccessful exact measurements', async () => {
    const adapter = await createExactKernelAdapter();
    try {
      const doc = document();
      let injected = false;
      const refused = await adapter.syncDocument(doc, (progress) => {
        if (
          !injected &&
          progress.stage === 'measurement' &&
          progress.status === 'started'
        ) {
          injected = true;
          vi.spyOn(
            RemusKernel.prototype,
            'validateSolidRelaxed'
          ).mockReturnValue(1);
        }
      });
      expect(refused.warnings).toEqual([
        'Body "Box Body" failed exact B-rep validation.'
      ]);
      expect(state(adapter).measuredShapeCache.size).toBe(0);
      expect(normalized(await adapter.syncDocument(doc))).toEqual(
        normalized(refused)
      );
    } finally {
      adapter.dispose();
    }
  });
  it('owns retained buffers and topology across caller mutation and transfer', async () => {
    const adapter = await createExactKernelAdapter();
    try {
      const doc = document();
      const cold = await adapter.syncDocument(doc);
      const expected = structuredClone(cold);
      const body = cold.bodyRepresentations[doc.bodyOrder[0]!]!;
      body.mesh.vertices.fill(999);
      body.topology!.faces[0]!.triangleCount = 999;
      structuredClone(body.mesh.indices, {
        transfer: [body.mesh.indices.buffer]
      });
      const hit = await adapter.syncDocument(doc);
      expect(normalized(hit)).toEqual(normalized(expected));
      const hitBody = hit.bodyRepresentations[doc.bodyOrder[0]!]!;
      structuredClone(hitBody.mesh.vertices, {
        transfer: [hitBody.mesh.vertices.buffer]
      });
      hitBody.topology!.edges.length = 0;
      expect(normalized(await adapter.syncDocument(doc))).toEqual(
        normalized(expected)
      );
    } finally {
      adapter.dispose();
    }
  });

  it.each(['faces', 'edges', 'vertices', 'relaxedErrors', 'throw'] as const)(
    'drops the whole arena on a failed %s witness probe and rebuilds exactly',
    async (probe) => {
      const events: RebuildCacheEvent[] = [];
      const adapter = await createExactKernelAdapter({
        onRebuildCacheEvent: (e) => events.push(e),
        measurementCacheDiagnostics: true
      });
      try {
        const doc = document();
        const expected = await adapter.syncDocument(doc);
        const old = state(adapter).historyKernel!;
        const free = vi.spyOn(old, 'free');
        if (probe === 'relaxedErrors') {
          vi.spyOn(old, 'validateSolidRelaxed').mockReturnValueOnce(1);
        } else {
          const method =
            probe === 'edges'
              ? 'getSolidEdges'
              : probe === 'vertices'
                ? 'getSolidVertices'
                : 'getSolidFaces';
          const original = old[method].bind(old);
          vi.spyOn(old, method).mockImplementationOnce((solid) => {
            if (probe === 'throw') throw new Error('Retired handle');
            const handles = original(solid).slice();
            // Same count, different identity must fail too.
            handles[0] = handles[0]! + 100_000;
            return handles;
          });
        }
        expect(normalized(await adapter.syncDocument(doc))).toEqual(
          normalized(expected)
        );
        expect(free).toHaveBeenCalledOnce();
        expect(state(adapter).historyKernel).not.toBe(old);
        expect(events.at(-1)).toMatchObject({
          kind: 'full-rebuild',
          remeasured: 1,
          reusedMeasurements: 0,
          measurementCache: {
            resetReason: 'measurement-proof',
            hits: 0,
            misses: { 'no-entry': 1 }
          }
        });
        expect(state(adapter).historyKernel!.checkpointCount()).toBe(1);
      } finally {
        adapter.dispose();
      }
    }
  );

  it.each([
    'analysisKey',
    'strict',
    'recognizedImportedFeatures',
    'solidKey',
    'provenanceKey'
  ] as const)(
    'remeasures a changed %s without trusting the payload',
    async (key) => {
      const events: RebuildCacheEvent[] = [];
      const adapter = await createExactKernelAdapter({
        onRebuildCacheEvent: (e) => events.push(e)
      });
      try {
        const doc = document();
        const expected = await adapter.syncDocument(doc);
        const old = state(adapter).historyKernel!;
        const cached = state(adapter).measuredShapeCache.get(
          doc.bodyOrder[0]!
        )!;
        if (key === 'strict' || key === 'recognizedImportedFeatures')
          cached[key] = !cached[key];
        else cached[key] = 'different';
        expect(normalized(await adapter.syncDocument(doc))).toEqual(
          normalized(expected)
        );
        expect(state(adapter).historyKernel).toBe(old);
        expect(events.at(-1)).toMatchObject({
          remeasured: 1,
          reusedMeasurements: 0
        });
      } finally {
        adapter.dispose();
      }
    }
  );

  it.each([
    'table-id',
    'extra-checkpoint',
    'missing-checkpoint',
    'face-count',
    'retired-prefix-solid'
  ])(
    'rebuilds from an empty kernel after %s corruption',
    async (corruption) => {
      const adapter = await createExactKernelAdapter();
      try {
        const doc = document();
        const expected = await adapter.syncDocument(doc);
        const old = state(adapter).historyKernel!;
        const free = vi.spyOn(old, 'free');
        if (corruption === 'table-id')
          state(adapter).historyCheckpoints[0]!.checkpointId = 9;
        if (corruption === 'extra-checkpoint') old.checkpoint();
        if (corruption === 'missing-checkpoint') old.discardCheckpoint(0);
        if (corruption === 'face-count')
          state(adapter).measuredShapeCache.get(
            doc.bodyOrder[0]!
          )!.faceHandleCount += 1;
        if (corruption === 'retired-prefix-solid') {
          state(adapter).historyCheckpoints[0]!.snapshot.shapes.get(
            doc.bodyOrder[0]!
          )!.solids[0] = 1_000_000;
        }
        expect(normalized(await adapter.syncDocument(doc))).toEqual(
          normalized(expected)
        );
        expect(free).toHaveBeenCalledOnce();
        expect(state(adapter).historyKernel).not.toBe(old);
      } finally {
        adapter.dispose();
      }
    }
  );

  it('accounts metadata/witnesses and refuses oversized retention', async () => {
    const doc = document();
    const events: RebuildCacheEvent[] = [];
    const adapter = await createExactKernelAdapter({
      measuredShapeCacheBytes: 1,
      onRebuildCacheEvent: (e) => events.push(e)
    });
    const retained = await createExactKernelAdapter();
    try {
      const expected = await retained.syncDocument(doc);
      const mesh = expected.bodyRepresentations[doc.bodyOrder[0]!]!.mesh;
      expect(state(retained).measuredShapeCacheBytes).toBeGreaterThan(
        mesh.vertices.byteLength + mesh.indices.byteLength
      );
      await adapter.syncDocument(doc);
      expect(normalized(await adapter.syncDocument(doc))).toEqual(
        normalized(expected)
      );
      expect(state(adapter).measuredShapeCacheBytes).toBe(0);
      expect(state(adapter).measuredShapeCache.size).toBe(0);
      expect(events.at(-1)).toMatchObject({
        remeasured: 1,
        reusedMeasurements: 0
      });
    } finally {
      adapter.dispose();
      retained.dispose();
    }
  });

  it('recycles through repeated edits, disposal and a refused build without stale hits', async () => {
    const adapter = await createExactKernelAdapter();
    const fresh = await createExactKernelAdapter({ historyCheckpointLimit: 0 });
    try {
      let doc = addPrimitiveFeature(document(), {
        name: 'Edited box',
        primitiveKind: 'box',
        dimensions: { width: 10, height: 8, depth: 6 }
      });
      await adapter.syncDocument(doc);
      const first = state(adapter).historyKernel!;
      const featureId = listFeaturesInOrder(doc)[1]!.featureId;
      // A dependent transform prevents independent primitive-tail retention.
      doc = transformBody(doc, {
        name: 'Move',
        targetBodyId: doc.bodyOrder[1]!,
        translation: { x: 1, y: 0, z: 0 }
      }).document;
      for (let index = 0; index < 270; index++) {
        doc = updateFeature(doc, {
          featureId,
          data: { dimensions: { width: 10 + (index % 2), height: 8, depth: 6 } }
        });
        const actual = await adapter.syncDocument(doc);
        if (index % 50 === 0)
          expect(acrossArenas(actual)).toEqual(
            acrossArenas(await fresh.syncDocument(doc))
          );
      }
      expect(state(adapter).historyKernel).not.toBe(first);
      const refused = updateFeature(doc, {
        featureId,
        data: { dimensions: { width: -1, height: 8, depth: 6 } }
      });
      expect(acrossArenas(await adapter.syncDocument(refused))).toEqual(
        acrossArenas(await fresh.syncDocument(refused))
      );
      adapter.dispose();
      expect(state(adapter).measuredShapeCache.size).toBe(0);
      expect(state(adapter).measuredShapeCacheBytes).toBe(0);
      expect(acrossArenas(await adapter.syncDocument(doc))).toEqual(
        acrossArenas(await fresh.syncDocument(doc))
      );
    } finally {
      adapter.dispose();
      fresh.dispose();
    }
  });
});

it('the installed Remus pin preserves prefix handles and permanently retires suffix handles', () => {
  const kernel = new RemusKernel();
  try {
    const keep = kernel.makeBox(2, 2, 2);
    const prefixFaces = kernel.getSolidFaces(keep).slice();
    const checkpoint = kernel.checkpoint();
    const stale = kernel.makeBox(1, 1, 1);
    const staleFaces = kernel.getSolidFaces(stale).slice();
    const staleEdges = kernel.getSolidEdges(stale).slice();
    const staleVertices = kernel.getSolidVertices(stale).slice();
    kernel.checkpoint();
    kernel.restore(checkpoint);
    expect(kernel.checkpointCount()).toBe(1);
    expect(kernel.getSolidFaces(keep)).toEqual(prefixFaces);
    for (let i = 0; i < 20; i++) {
      const next = kernel.makeBox(3, 3, 3);
      expect(next).toBeGreaterThan(stale);
      expect(() => kernel.getSolidFaces(stale)).toThrow();
      for (const face of staleFaces)
        expect(() => kernel.getFaceNormal(face)).toThrow();
      for (const edge of staleEdges)
        expect(() => kernel.getEdgeVertices(edge)).toThrow();
      for (const vertex of staleVertices)
        expect(() => kernel.getVertexPosition(vertex)).toThrow();
      kernel.restore(checkpoint);
    }
    kernel.discardCheckpoint(checkpoint);
    expect(kernel.getSolidFaces(keep)).toEqual(prefixFaces);
  } finally {
    kernel.free();
  }
});
