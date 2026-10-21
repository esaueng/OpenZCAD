import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  addDatumAxis,
  addPrimitiveFeature,
  booleanBodies,
  createProjectDocument,
  filletEdges,
  listFeaturesInOrder,
  patternBody,
  transformBody,
  updateFeature,
  withoutDerivedProjection
} from '@openzcad/document-core';
import type {
  ExactKernelAdapter,
  ExactKernelAdapterOptions,
  RebuildCacheEvent
} from '@openzcad/kernel-adapter/exact';
import {
  toUserId,
  type BodyId,
  type DerivedState,
  type ProjectDocument
} from '@openzcad/shared';
import {
  createExactKernelAdapter,
  sameStructure
} from './perf/h02-session-exact';
import {
  captureExactArenas,
  compareExactArenas
} from './support/exact-arena-equivalence';
import * as evolution from '../packages/kernel-adapter/src/exact-boolean-evolution';
import { RemusKernel } from '../packages/kernel-adapter/src/remus-runtime';
import type { HistoryCheckpointEntry } from '../packages/kernel-adapter/src/exact-history-cache';
import { IdleLineageViewBuilder } from '../packages/kernel-adapter/src/exact-idle-lineage-view';

interface Equivalence {
  rawEquivalent: boolean;
  publicationEquivalent: boolean;
  publicationDifferences: {
    root: string[];
    bodies: { bodyIndex: number; count: number; paths: string[] }[];
  };
  bodies: number;
  serializedBytes: number;
  faces: number;
  warnings: number;
}

interface Probe {
  compareFresh(): Promise<Equivalence>;
}

interface Harness {
  adapter: ExactKernelAdapter;
  probe: Probe;
  events: RebuildCacheEvent[];
}

function cacheState(adapter: ExactKernelAdapter) {
  return adapter as unknown as {
    historyKernel: RemusKernel | null;
    historyCheckpoints: HistoryCheckpointEntry[];
    historyCheckpointOwners: Map<number, HistoryCheckpointEntry>;
    historyLineageMetadataBytes: number;
    measuredShapeCache: Map<BodyId, { bytes: number }>;
    measuredShapeCacheBytes: number;
  };
}

function assertLineageOwners(adapter: ExactKernelAdapter) {
  const state = cacheState(adapter);
  expect(state.historyLineageMetadataBytes).toBe(
    state.historyCheckpoints.reduce(
      (bytes, entry) => bytes + (entry.lineageMetadataBytes ?? 0),
      0
    )
  );
  expect(state.historyLineageMetadataBytes).toBeLessThanOrEqual(
    128 * 1024 * 1024
  );
  for (const entry of state.historyCheckpoints) {
    expect(state.historyCheckpointOwners.get(entry.checkpointId)).toBe(entry);
    const primaryBytes = new TextEncoder().encode(
      entry.lineageProbeKey ?? ''
    ).byteLength;
    expect(entry.lineageMetadataBytes ?? 0).toBeGreaterThanOrEqual(
      primaryBytes + (entry.idleLineageView?.estimatedBytes ?? 0)
    );
    const view = entry.idleLineageView;
    if (!view) continue;
    expect(view.estimatedBytes).toBeGreaterThan(0);
    expect(view.digests).toHaveLength(entry.featureIndex + 1);
    expect(view.state.diverged).toBe(true);
    for (const [bodyId, lineage] of view.state.lineages) {
      const shape = entry.snapshot.shapes.get(bodyId);
      expect(shape).toBeDefined();
      if (!lineage) continue;
      const faces = new Set(
        shape!.solids.flatMap((solid) =>
          Array.from(state.historyKernel!.getSolidFaces(solid))
        )
      );
      const edges = new Set(
        shape!.solids.flatMap((solid) =>
          Array.from(state.historyKernel!.getSolidEdges(solid))
        )
      );
      for (const face of lineage.faceReferences.keys())
        expect(faces.has(face)).toBe(true);
      for (const edge of lineage.edgeReferences.keys())
        expect(edges.has(edge)).toBe(true);
    }
  }
}

async function harness(
  options: ExactKernelAdapterOptions = {}
): Promise<Harness> {
  const events: RebuildCacheEvent[] = [];
  const adapter = await createExactKernelAdapter({
    ...options,
    onRebuildCacheEvent: (event) => events.push(event)
  });
  return {
    adapter,
    events,
    probe: (globalThis as unknown as { __h02Session: Probe }).__h02Session
  };
}

function fusedPlateDocument(
  document = createProjectDocument(
    'Lineage mode qualification',
    toUserId('test')
  )
) {
  let next = addPrimitiveFeature(document, {
    name: 'Plate',
    primitiveKind: 'box',
    dimensions: { width: 40, height: 24, depth: 10 }
  });
  const plate = next.bodyOrder.at(-1)!;
  next = addPrimitiveFeature(next, {
    name: 'Post',
    primitiveKind: 'box',
    dimensions: { width: 12, height: 24, depth: 30 }
  });
  return booleanBodies(next, {
    name: 'Fuse',
    operation: 'union',
    targetBodyIds: [plate, next.bodyOrder.at(-1)!]
  });
}

function withoutTimestamp({ updatedAt: _time, ...derived }: DerivedState) {
  return derived;
}

/**
 * Compare the first response as well as a repeat, then use the unchanged H02
 * oracle against cache-disabled fresh geometry. No published fields are
 * removed beyond the oracle's established cross-arena normalization.
 */
async function qualify(
  { adapter, probe }: Harness,
  document: ProjectDocument,
  demand?: readonly BodyId[],
  context = 'Mode qualification'
) {
  const options = demand === undefined ? undefined : { lineageDemand: demand };
  const sync = () =>
    adapter.syncDocument(document, undefined, undefined, undefined, options);
  const first = await captureExactArenas(adapter, document, sync);
  const repeated = await captureExactArenas(adapter, document, sync);
  expect(compareExactArenas(first.bodies, repeated.bodies).equivalent).toBe(
    true
  );
  expect(
    sameStructure(
      withoutTimestamp(first.result),
      withoutTimestamp(repeated.result)
    ),
    'The first mode-specific response must equal its repeat in the same arena'
  ).toBe(true);
  const fresh = await probe.compareFresh();
  expect(
    fresh.rawEquivalent,
    `${context}: every raw B-rep byte must match fresh`
  ).toBe(true);
  expect(
    fresh.publicationEquivalent,
    `${context}: every publication field under the unchanged oracle must match fresh`
  ).toBe(true);
  expect(fresh.publicationDifferences).toEqual({ root: [], bodies: [] });
  expect(fresh.bodies).toBe(document.bodyOrder.length);
  expect(fresh.faces).toBeGreaterThan(0);
  expect(fresh.serializedBytes).toBeGreaterThan(0);
  expect(fresh.warnings).toBe(0);
  return first.result;
}

afterEach(() => vi.restoreAllMocks());

describe('H02 mode-specific cached lineage', { timeout: 120_000 }, () => {
  it('matches fresh after eager-to-idle transitions without probing idle requests', async () => {
    const { document } = fusedPlateDocument();
    const subject = await harness();
    const probe = vi.spyOn(evolution, 'probeBooleanEntityEvolution');
    try {
      await qualify(subject, document, []);
      expect(probe).not.toHaveBeenCalled();
      await qualify(subject, document);
      expect(probe).toHaveBeenCalled();
      probe.mockClear();
      await qualify(subject, document, []);
      expect(probe).not.toHaveBeenCalled();
      await qualify(subject, document);
      subject.adapter.dispose();
      await qualify(subject, document, []);
    } finally {
      subject.adapter.dispose();
    }
  });

  it('charges finalized lineage metadata to its live checkpoint and clears it on disposal', async () => {
    const { document } = fusedPlateDocument();
    const subject = await harness();
    try {
      await qualify(subject, document);
      expect(
        cacheState(subject.adapter).historyCheckpoints.some(
          (entry) => entry.idleLineageView !== undefined
        )
      ).toBe(true);
      expect(
        cacheState(subject.adapter).historyLineageMetadataBytes
      ).toBeGreaterThan(0);
      assertLineageOwners(subject.adapter);
      await qualify(subject, document, []);
      assertLineageOwners(subject.adapter);
      subject.adapter.dispose();
      expect(cacheState(subject.adapter).historyLineageMetadataBytes).toBe(0);
      expect(cacheState(subject.adapter).historyCheckpointOwners.size).toBe(0);
      await qualify(subject, document, []);
      assertLineageOwners(subject.adapter);
    } finally {
      subject.adapter.dispose();
    }
  });

  it.each([
    { historyCheckpointLimit: 0 },
    { historyCheckpointEstimatedBytes: 0 }
  ])(
    'does not build alternate views when retention is disabled by %o',
    async (options) => {
      const { document } = fusedPlateDocument();
      const subject = await harness(options);
      const tracker = vi.spyOn(IdleLineageViewBuilder.prototype, 'begin');
      const probe = vi.spyOn(evolution, 'probeBooleanEntityEvolution');
      try {
        await qualify(subject, document);
        probe.mockClear();
        await qualify(subject, document, []);
        expect(probe).not.toHaveBeenCalled();
        expect(tracker).not.toHaveBeenCalled();
        expect(cacheState(subject.adapter).historyCheckpoints).toHaveLength(0);
        expect(cacheState(subject.adapter).historyLineageMetadataBytes).toBe(0);
        subject.adapter.dispose();
        expect(cacheState(subject.adapter).historyLineageMetadataBytes).toBe(0);
      } finally {
        subject.adapter.dispose();
      }
    }
  );

  it('keeps two independent boolean results distinct under partial-demand swaps', async () => {
    const first = fusedPlateDocument();
    const second = fusedPlateDocument(first.document);
    const subject = await harness();
    try {
      for (const demand of [
        undefined,
        [first.bodyId],
        [second.bodyId],
        [first.bodyId, second.bodyId],
        [],
        [second.bodyId],
        []
      ])
        await qualify(subject, second.document, demand);
    } finally {
      subject.adapter.dispose();
    }
  });

  it('publishes fresh lineage on an eleven-feature preview release without replay or idle probes', async () => {
    let { document } = fusedPlateDocument();
    for (let index = 0; index < 4; index++) {
      document = addPrimitiveFeature(document, {
        name: `Tag ${index}`,
        primitiveKind: 'box',
        dimensions: { width: 4, height: 4, depth: 4 }
      });
      document = transformBody(document, {
        name: `Move tag ${index}`,
        targetBodyId: document.bodyOrder.at(-1)!,
        translation: { x: 60 + index * 6, y: 0, z: 0 }
      }).document;
    }
    const last = listFeaturesInOrder(document).at(-1)!;
    if (last.data.featureKind !== 'transform')
      throw new Error('Missing tail move');
    const dragged = updateFeature(document, {
      featureId: last.featureId,
      data: {
        transform: {
          ...last.data.transform,
          translation: { x: 90, y: 0, z: 0 }
        }
      }
    });
    const subject = await harness();
    const probe = vi.spyOn(evolution, 'probeBooleanEntityEvolution');
    try {
      await subject.adapter.syncDocument(
        document,
        undefined,
        undefined,
        undefined,
        { lineageDemand: [] }
      );
      await subject.adapter.previewGeometry(dragged);
      probe.mockClear();
      const releaseEvent = subject.events.length;
      await qualify(subject, dragged, []);
      expect(subject.events[releaseEvent]).toMatchObject({
        restored: 11,
        replayed: 0
      });
      expect(probe).not.toHaveBeenCalled();
    } finally {
      subject.adapter.dispose();
    }
  });

  it('carries the requested mode through rigid transforms and ancestor booleans', async () => {
    const fused = fusedPlateDocument();
    let document = transformBody(fused.document, {
      name: 'Move fused body',
      targetBodyId: fused.bodyId,
      translation: { x: 3, y: 0, z: 0 }
    }).document;
    document = addPrimitiveFeature(document, {
      name: 'Later operand',
      primitiveKind: 'box',
      dimensions: { width: 8, height: 8, depth: 8 }
    });
    const descendant = booleanBodies(document, {
      name: 'Subtract later operand',
      operation: 'subtract',
      targetBodyIds: [fused.bodyId, document.bodyOrder.at(-1)!]
    });
    document = transformBody(descendant.document, {
      name: 'Move descendant',
      targetBodyId: descendant.bodyId,
      translation: { x: 0, y: 4, z: 0 },
      rotationDeg: { x: 0, y: 0, z: 90 }
    }).document;
    const subject = await harness();
    try {
      for (const demand of [
        undefined,
        [],
        [descendant.bodyId],
        [],
        [fused.bodyId],
        []
      ])
        await qualify(subject, document, demand);
    } finally {
      subject.adapter.dispose();
    }
  });

  it('resolves persisted boolean edge consumers after switching publication modes', async () => {
    const { document, bodyId } = fusedPlateDocument();
    const subject = await harness();
    try {
      await qualify(subject, document);
      await qualify(subject, document, []);
      const demanded = await qualify(subject, document, [bodyId]);
      const edge = demanded.bodyRepresentations[bodyId]!.topology!.edges.find(
        (candidate) =>
          candidate.reference?.lineageName.startsWith('boolean.edge.')
      );
      expect(edge?.reference).toBeDefined();
      const rounded = filletEdges(document, {
        name: 'Persisted round',
        targetBodyId: bodyId,
        edgeHashes: [edge!.hash],
        edgeReferences: [edge!.reference!],
        size: 1
      }).document;
      const feature = listFeaturesInOrder(rounded).at(-1)!;
      expect(feature.data.featureKind).toBe('fillet');
      const persisted = JSON.parse(
        JSON.stringify(withoutDerivedProjection(rounded))
      ) as ProjectDocument;
      await qualify(subject, persisted, []);
      await qualify(subject, persisted);
      subject.adapter.dispose();
      await qualify(subject, persisted, []);
    } finally {
      subject.adapter.dispose();
    }
  });

  it('replays an unsupported lineage-view tail instead of publishing an eager pattern as idle', async () => {
    const fused = fusedPlateDocument();
    const patterned = patternBody(fused.document, {
      name: 'Pattern of fused body',
      targetBodyId: fused.bodyId,
      patternKind: 'linear',
      count: 2,
      axis: 'x',
      spacing: 60
    });
    const subject = await harness();
    try {
      const coldIdle = await harness();
      try {
        await qualify(
          coldIdle,
          patterned.document,
          [],
          'Pattern cold idle control'
        );
      } finally {
        coldIdle.adapter.dispose();
      }
      for (const [phase, demand] of [
        undefined,
        [],
        [patterned.bodyId],
        [],
        undefined
      ].entries()) {
        const requestedEvent = subject.events.length;
        await qualify(
          subject,
          patterned.document,
          demand,
          `Pattern phase ${phase}`
        );
        if (phase === 1)
          expect(subject.events[requestedEvent]).toMatchObject({
            kind: 'full-rebuild',
            restored: 0,
            replayed: listFeaturesInOrder(patterned.document).length,
            measurementCache: { resetReason: null }
          });
      }
    } finally {
      subject.adapter.dispose();
    }
  });

  it('rebuilds a reference-bound axis rotation in a fresh arena when lineage mode changes', async () => {
    // The datum precedes the boolean so only the axis-bound Move is the
    // unaudited suffix. A generic transform whitelist must not admit it.
    const axis = addDatumAxis(
      createProjectDocument('Axis-mode qualification', toUserId('test')),
      {
        name: 'Turn axis',
        definition: {
          kind: 'two-point',
          points: [
            { type: 'point', point: { x: 10, y: 0, z: 0 } },
            { type: 'point', point: { x: 10, y: 0, z: 1 } }
          ]
        }
      }
    );
    const fused = fusedPlateDocument(axis.document);
    const turned = transformBody(fused.document, {
      name: 'Turn about datum',
      targetBodyId: fused.bodyId,
      translation: { x: 0, y: 0, z: 5 },
      axisRotation: {
        axis: { type: 'datum-axis', datumFeatureId: axis.featureId },
        angleDeg: 90
      }
    });
    const subject = await harness();
    try {
      const coldIdle = await harness();
      try {
        await qualify(coldIdle, turned.document, [], 'Axis cold idle control');
      } finally {
        coldIdle.adapter.dispose();
      }
      for (const [phase, demand] of [
        undefined,
        [],
        undefined,
        [],
        [turned.bodyId]
      ].entries()) {
        const requestedEvent = subject.events.length;
        await qualify(subject, turned.document, demand, `Axis phase ${phase}`);
        if (phase === 1)
          expect(subject.events[requestedEvent]).toMatchObject({
            kind: 'full-rebuild',
            restored: 0,
            replayed: listFeaturesInOrder(turned.document).length,
            measurementCache: { resetReason: null }
          });
      }
    } finally {
      subject.adapter.dispose();
    }
  });

  it.each(['throws', 'disagrees'] as const)(
    'keeps declined evolution evidence mode-specific when its probe %s',
    async (failure) => {
      const { document, bodyId } = fusedPlateDocument();
      const original = RemusKernel.prototype.fuseWithEntityEvolution;
      const fault = vi
        .spyOn(RemusKernel.prototype, 'fuseWithEntityEvolution')
        .mockImplementation(function (this: RemusKernel, left, right) {
          if (failure === 'throws')
            throw new Error('Injected evolution failure');
          const payload = JSON.parse(
            original.call(this, left, right)
          ) as Record<string, unknown>;
          // Keep the payload but deliberately make it describe another solid.
          // The plain boolean geometry must still be the one that ships.
          payload.solid = this.makeBox(1, 1, 1);
          return JSON.stringify(payload);
        });
      const subject = await harness();
      try {
        const eager = await qualify(subject, document);
        expect(fault).toHaveBeenCalled();
        expect(
          eager.bodyRepresentations[bodyId]!.topology!.lineageDiagnostics!.some(
            (entry) =>
              entry.message.includes(
                failure === 'throws'
                  ? 'Injected evolution failure'
                  : 'did not reproduce the body'
              )
          )
        ).toBe(true);
        for (const demand of [[], [bodyId], [], undefined]) {
          const result = await qualify(subject, document, demand);
          expect(
            result.bodyRepresentations[bodyId]!.topology!.edges.some((edge) =>
              edge.reference?.lineageName.startsWith('boolean.edge.')
            )
          ).toBe(false);
        }
      } finally {
        subject.adapter.dispose();
        fault.mockRestore();
      }
    }
  );

  it('drops evicted lineage views and measurements under the existing cache budgets', async () => {
    const fused = fusedPlateDocument();
    let document = fused.document;
    const bodyId = fused.bodyId;
    for (let index = 0; index < 6; index++)
      document = addPrimitiveFeature(document, {
        name: `Pressure tag ${index}`,
        primitiveKind: 'box',
        dimensions: { width: 4, height: 4, depth: 4 }
      });
    const calibration = await harness();
    let budget: number;
    try {
      const modes = [];
      for (const demand of [undefined, []]) {
        await calibration.adapter.syncDocument(
          document,
          undefined,
          undefined,
          undefined,
          demand === undefined ? undefined : { lineageDemand: demand }
        );
        const sizes = [
          ...cacheState(calibration.adapter).measuredShapeCache.values()
        ].map((entry) => entry.bytes);
        expect(sizes).toHaveLength(document.bodyOrder.length);
        modes.push(sizes);
      }
      // Eager lineage is larger than idle lineage. Calibrate both modes so
      // neither can fit its entire working set, while every entry still fits.
      const total = Math.min(
        ...modes.map((sizes) => sizes.reduce((sum, bytes) => sum + bytes, 0))
      );
      const largest = Math.max(...modes.flat());
      budget = largest + Math.floor((total - largest) / 2);
      expect(budget).toBeGreaterThan(largest);
      expect(budget).toBeLessThan(total);
    } finally {
      calibration.adapter.dispose();
    }
    const subject = await harness({
      historyCheckpointLimit: 2,
      measuredShapeCacheBytes: budget
    });
    try {
      for (const demand of [undefined, [], [bodyId], [], undefined, []]) {
        await qualify(subject, document, demand);
        const state = cacheState(subject.adapter);
        assertLineageOwners(subject.adapter);
        expect(state.historyCheckpoints.length).toBeLessThanOrEqual(2);
        expect(state.historyCheckpointOwners.size).toBe(
          state.historyCheckpoints.length
        );
        expect(
          state.historyCheckpoints.every(
            (entry) =>
              state.historyCheckpointOwners.get(entry.checkpointId) === entry
          )
        ).toBe(true);
        expect(state.measuredShapeCache.size).toBeLessThan(
          document.bodyOrder.length
        );
        expect(state.measuredShapeCacheBytes).toBe(
          [...state.measuredShapeCache.values()].reduce(
            (sum, entry) => sum + entry.bytes,
            0
          )
        );
        expect(state.measuredShapeCacheBytes).toBeLessThanOrEqual(budget);
      }
      subject.adapter.dispose();
      expect(cacheState(subject.adapter).historyCheckpointOwners.size).toBe(0);
      expect(cacheState(subject.adapter).measuredShapeCacheBytes).toBe(0);
      expect(cacheState(subject.adapter).historyLineageMetadataBytes).toBe(0);
      await qualify(subject, document, []);
    } finally {
      subject.adapter.dispose();
    }
  });

  it('keeps mode-specific lineage exact across real replay-budget recycling and restart', async () => {
    const fused = fusedPlateDocument();
    let document = transformBody(fused.document, {
      name: 'First dependent move',
      targetBodyId: fused.bodyId,
      translation: { x: 1, y: 0, z: 0 }
    }).document;
    const editedOperand = listFeaturesInOrder(fused.document)[1]!;
    document = transformBody(document, {
      name: 'Second dependent move',
      targetBodyId: fused.bodyId,
      translation: { x: 0, y: 2, z: 0 }
    }).document;
    const subject = await harness();
    try {
      await qualify(subject, document);
      await qualify(subject, document, []);
      const originalKernel = (
        subject.adapter as unknown as { historyKernel: RemusKernel }
      ).historyKernel;
      for (let edit = 0; edit < 270; edit++) {
        document = updateFeature(document, {
          featureId: editedOperand.featureId,
          data: {
            dimensions: { width: 12 + (edit % 2), height: 24, depth: 30 }
          }
        });
        const demand = edit % 2 ? undefined : [];
        const result = await subject.adapter.syncDocument(
          document,
          undefined,
          undefined,
          undefined,
          demand === undefined ? undefined : { lineageDemand: demand }
        );
        expect(result.warnings).toEqual([]);
        if (edit % 50 === 0) {
          await qualify(subject, document, demand);
          assertLineageOwners(subject.adapter);
        }
      }
      expect(
        subject.events.some((event) => event.recycleReason === 'replay-budget')
      ).toBe(true);
      expect(
        (subject.adapter as unknown as { historyKernel: RemusKernel })
          .historyKernel
      ).not.toBe(originalKernel);
      await qualify(subject, document, []);
      await qualify(subject, document);
      assertLineageOwners(subject.adapter);
      subject.adapter.dispose();
      expect(cacheState(subject.adapter).historyLineageMetadataBytes).toBe(0);
      await qualify(subject, document, []);
    } finally {
      subject.adapter.dispose();
    }
  });
});
