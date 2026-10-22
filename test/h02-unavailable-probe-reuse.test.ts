/** Public review regression; no private fixture or source is read. */
import { afterEach, expect, it, vi } from 'vitest';
import {
  addPrimitiveFeature,
  booleanBodies,
  createProjectDocument,
  listFeaturesInOrder
} from '@openzcad/document-core';
import { toUserId, type BodyId, type DerivedState } from '@openzcad/shared';
import {
  createExactKernelAdapter,
  type RebuildCacheEvent
} from '@openzcad/kernel-adapter/exact';
import { sameStructure } from './perf/h02-session-exact';
import {
  captureExactArenas,
  compareExactArenas
} from './support/exact-arena-equivalence';
import * as evolution from '../packages/kernel-adapter/src/exact-boolean-evolution';
import type { HistoryCheckpointEntry } from '../packages/kernel-adapter/src/exact-history-cache';
import {
  captureFirstPublication,
  compareCapturedFirstWithFresh
} from './support/h02-first-publication';

function multiOperandUnion() {
  let document = createProjectDocument('Unavailable probe', toUserId('test'));
  for (const dimensions of [
    { width: 40, height: 24, depth: 10 },
    { width: 12, height: 24, depth: 30 },
    { width: 40, height: 12, depth: 20 }
  ])
    document = addPrimitiveFeature(document, {
      name: 'Operand',
      primitiveKind: 'box',
      dimensions
    });
  return booleanBodies(document, {
    name: 'Three operand union',
    operation: 'union',
    targetBodyIds: [...document.bodyOrder]
  }).document;
}

function coaxialCut() {
  let document = createProjectDocument('Unavailable probe', toUserId('test'));
  for (const radius of [10, 5])
    document = addPrimitiveFeature(document, {
      name: 'Cylinder',
      primitiveKind: 'cylinder',
      dimensions: { radius, height: 20 }
    });
  return booleanBodies(document, {
    name: 'Coaxial cut',
    operation: 'subtract',
    targetBodyIds: [...document.bodyOrder]
  }).document;
}

const cases = [
  {
    name: 'multi-operand union',
    create: multiOperandUnion,
    declineReason: 'entity-evolution entry points are pairwise'
  },
  {
    name: 'coaxial cut',
    create: coaxialCut,
    declineReason: 'exact coaxial cylinder path'
  }
];

function withoutTimestamp({ updatedAt: _timestamp, ...value }: DerivedState) {
  return value;
}

async function harness(document = multiOperandUnion()) {
  const events: RebuildCacheEvent[] = [];
  const adapterOptions = { measurementCacheDiagnostics: true };
  const adapter = await createExactKernelAdapter({
    ...adapterOptions,
    onRebuildCacheEvent: (event) => events.push(event)
  });
  const state = adapter as unknown as {
    historyCheckpoints: HistoryCheckpointEntry[];
    historyLineageMetadataBytes: number;
  };
  const qualify = async (idle: boolean) => {
    const options = idle ? { lineageDemand: [] as BodyId[] } : undefined;
    const sync = () =>
      adapter.syncDocument(document, undefined, undefined, undefined, options);
    const eventIndex = events.length;
    const first = await captureFirstPublication(adapter, document, sync);
    const event = events[eventIndex]!;
    expect(events).toHaveLength(eventIndex + 1);
    const instrumentation = (
      globalThis as unknown as { __h02Session?: unknown }
    ).__h02Session;
    const fresh = await compareCapturedFirstWithFresh(first, document, {
      adapterOptions,
      syncOptions: options
    });
    expect(events).toHaveLength(eventIndex + 1);
    expect(
      (globalThis as unknown as { __h02Session?: unknown }).__h02Session
    ).toBe(instrumentation);
    expect(fresh.rawEquivalent).toBe(true);
    expect(fresh.publicationEquivalent).toBe(true);
    expect(fresh.publicationDifferences).toEqual({ root: [], bodies: [] });
    expect(fresh.bodies).toBe(document.bodyOrder.length);
    expect(fresh.faces).toBeGreaterThan(0);
    expect(fresh.serializedBytes).toBeGreaterThan(0);
    expect(fresh.warnings).toBe(0);
    const repeated = await captureExactArenas(adapter, document, sync);
    expect(events).toHaveLength(eventIndex + 2);
    expect(compareExactArenas(first.bodies, repeated.bodies).equivalent).toBe(
      true
    );
    expect(
      sameStructure(
        withoutTimestamp(first.result),
        withoutTimestamp(repeated.result)
      )
    ).toBe(true);
    return event;
  };
  return { document, adapter, state, qualify };
}

afterEach(() => vi.restoreAllMocks());

it.each(cases)(
  'restores an eager $name checkpoint for idle when no probe exists',
  async ({ create, declineReason }) => {
    const calls = vi.spyOn(evolution, 'probeBooleanEntityEvolution');
    const subject = await harness(create());
    try {
      await subject.qualify(false);
      const tail = subject.state.historyCheckpoints.at(-1)!;
      const view = tail.idleLineageView;
      expect(view?.state.diverged).toBe(false);
      expect(view?.state.lineages.size).toBe(tail.snapshot.shapes.size);
      for (const [id, lineage] of view!.state.lineages)
        expect(lineage).toBe(tail.snapshot.shapes.get(id)?.lineage);
      expect(tail.lineageMetadataBytes).toBe(
        new TextEncoder().encode(tail.lineageProbeKey).byteLength +
          view!.estimatedBytes
      );
      expect(subject.state.historyLineageMetadataBytes).toBe(
        subject.state.historyCheckpoints.reduce(
          (bytes, entry) => bytes + (entry.lineageMetadataBytes ?? 0),
          0
        )
      );
      expect(subject.state.historyLineageMetadataBytes).toBeLessThanOrEqual(
        128 * 1024 * 1024
      );
      expect(
        tail.snapshot.shapes
          .get(subject.document.bodyOrder.at(-1)!)
          ?.lineage?.diagnostics.some((entry) =>
            entry.message.includes(declineReason)
          )
      ).toBe(true);
      const event = await subject.qualify(true);
      expect(calls).not.toHaveBeenCalled();
      expect(event).toMatchObject({
        kind: 'prefix-restore',
        restored: listFeaturesInOrder(subject.document).length,
        replayed: 0
      });
    } finally {
      subject.adapter.dispose();
    }
  }
);

it.each(cases)(
  'keeps cold-idle $name to eager conservative when no eager view was proven',
  async ({ create }) => {
    const calls = vi.spyOn(evolution, 'probeBooleanEntityEvolution');
    const subject = await harness(create());
    try {
      await subject.qualify(true);
      const event = await subject.qualify(false);
      expect(calls).not.toHaveBeenCalled();
      expect(event).toMatchObject({
        kind: 'prefix-restore',
        restored: listFeaturesInOrder(subject.document).length - 1,
        replayed: 1
      });
    } finally {
      subject.adapter.dispose();
    }
  }
);
