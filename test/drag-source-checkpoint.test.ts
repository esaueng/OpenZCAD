import { describe, expect, it } from 'vitest';
import {
  addPrimitiveFeature,
  addSketchFeature,
  createProjectDocument,
  directEditBody,
  extrudeSketch
} from '@openzcad/document-core';
import { toUserId, type BodyId, type ProjectDocument } from '@openzcad/shared';
import {
  createExactKernelAdapter,
  type RebuildCacheEvent
} from '@openzcad/kernel-adapter/exact';
import { RemusKernel } from '../packages/kernel-adapter/src/remus-runtime';
import {
  tailCheckpointIndices,
  historyCheckpointIndices
} from '../packages/kernel-adapter/src/exact-history-cache';

describe('tailCheckpointIndices', () => {
  it('ends at the tail and drops later positions', () => {
    // 22 features: the stable sparse positions skip 20, a drag's source.
    const stable = historyCheckpointIndices(22, 32);
    expect(stable.slice(15)).toEqual([15, 17, 19, 21]);
    expect(tailCheckpointIndices(stable, 20, 32).slice(15)).toEqual([
      15, 17, 19, 20
    ]);
    // A complete sync's tail is its last feature.
    expect(tailCheckpointIndices(stable, 21, 32)).toEqual(stable);
    expect(
      tailCheckpointIndices(historyCheckpointIndices(21, 32), 20, 32).slice(15)
    ).toEqual([15, 17, 19, 20]);
    // Dense: positions after the tail go.
    expect(tailCheckpointIndices([0, 1, 2, 3], 2, 32)).toEqual([0, 1, 2]);
    expect(tailCheckpointIndices([], 21, 32)).toEqual([]);
    expect(tailCheckpointIndices([0], -1, 32)).toEqual([0]);
  });

  it('stays within the checkpoint limit', () => {
    // A full schedule gives up its latest position before the tail.
    expect(tailCheckpointIndices([0, 1], 20, 2)).toEqual([0, 20]);
    expect(tailCheckpointIndices([0], 20, 1)).toEqual([20]);
    // Fractional limits count like historyCheckpointIndices: 2.5 allows two.
    expect(tailCheckpointIndices([0, 1], 20, 2.5)).toEqual([0, 20]);
    const full = historyCheckpointIndices(600, 32);
    const drag = tailCheckpointIndices(full, 598, 32);
    expect(drag).toHaveLength(32);
    expect(drag.slice(0, 31)).toEqual(full.slice(0, 31));
    expect(drag.at(-1)).toBe(598);
  });
});

/** Counts calls to `method` on every kernel instance. */
function countCalls(method: 'extrude' | 'tessellateSolidGroupedBinary'): {
  count: () => number;
  restore: () => void;
} {
  const proto = RemusKernel.prototype as unknown as Record<string, unknown>;
  const original = proto[method] as (...args: unknown[]) => unknown;
  let calls = 0;
  proto[method] = function (this: unknown, ...args: unknown[]) {
    calls += 1;
    return original.apply(this, args);
  };
  return {
    count: () => calls,
    restore: () => {
      proto[method] = original;
    }
  };
}

function boxesThenExtrusion(): ProjectDocument {
  let document: ProjectDocument = createProjectDocument(
    'Drag source checkpoint',
    toUserId('drag_checkpoint')
  );
  for (let index = 0; index < 19; index += 1) {
    document = addPrimitiveFeature(document, {
      name: `Box ${index}`,
      primitiveKind: 'box',
      dimensions: { width: 10, height: 8, depth: 6 }
    });
  }
  // Features 19 and 20; a drag's edit is feature 21. The stable checkpoints
  // are at 17, 19 and 21, so the extrusion sits after the last stable one.
  const sketch = addSketchFeature(document, {
    name: 'Profile',
    planeRef: { type: 'canonical', plane: 'XY', offset: 0 },
    objects: [{ objectKind: 'circle', radius: 3, centerX: 40, centerY: 0 }]
  });
  return extrudeSketch(sketch.document, {
    name: 'Extrusion',
    sketchId: sketch.sketchId,
    distance: 4
  }).document;
}

/**
 * Four drag ticks offsetting the extrusion's top face, then the commit.
 * `displaced` syncs another document between the base sync and the drag,
 * so the base's last-feature checkpoint is gone when the drag starts.
 */
async function dragScenario(options: {
  historyCheckpointLimit?: number;
  displaced?: boolean;
}) {
  const document = boxesThenExtrusion();
  const edited = document.bodyOrder.at(-1) as BodyId;
  const events: RebuildCacheEvent[] = [];
  const adapter = await createExactKernelAdapter({
    ...(options.historyCheckpointLimit === undefined
      ? {}
      : { historyCheckpointLimit: options.historyCheckpointLimit }),
    onRebuildCacheEvent: (event) => events.push(event)
  });
  const kernel = () =>
    (adapter as unknown as { historyKernel: RemusKernel | null })
      .historyKernel!;
  const limit = options.historyCheckpointLimit ?? 32;
  const extrusions = countCalls('extrude');
  const tessellations = countCalls('tessellateSolidGroupedBinary');
  try {
    const base = await adapter.syncDocument(document);
    if (options.displaced) {
      await adapter.syncDocument(
        addPrimitiveFeature(document, {
          name: 'Late box',
          primitiveKind: 'box',
          dimensions: { width: 2, height: 2, depth: 2 }
        })
      );
    }
    const top = base.bodyRepresentations[edited]!.topology!.faces.find(
      (face) => (face.geometry?.normal?.z ?? 0) > 0.99
    )!;
    const source = { ...document, derived: base };
    const offsetBy = (offset: number) =>
      directEditBody(source, {
        name: 'Offset',
        targetBodyId: edited,
        operation: {
          kind: 'offset-face',
          faceHash: top.hash,
          ...(top.reference ? { faceReference: top.reference } : {}),
          sourceSurfaceType: 'plane',
          sourceArea: top.geometry!.area,
          sourceCenter: top.geometry!.center,
          sourceNormal: top.geometry!.normal!,
          offset
        }
      }).document;
    const rebuiltExtrusions: number[] = [];
    for (const offset of [1, 2, 2.5, -1]) {
      const before = extrusions.count();
      const preview = await adapter.previewGeometry(offsetBy(offset), {
        deferTopology: true
      });
      expect(preview.warnings).toEqual([]);
      expect(
        preview.bodyRepresentations[edited]!.bbox.max.z -
          base.bodyRepresentations[edited]!.bbox.max.z
      ).toBeCloseTo(offset, 9);
      rebuiltExtrusions.push(extrusions.count() - before);
      expect(kernel().checkpointCount()).toBeLessThanOrEqual(limit);
    }

    // The commit restores the drag's checkpoint and replays only the edit.
    const committed = offsetBy(-1);
    const extrusionsBefore = extrusions.count();
    const tessellationsBefore = tessellations.count();
    const synced = await adapter.syncDocument(committed);
    const commit = {
      event: events.at(-1)!,
      rebuiltExtrusions: extrusions.count() - extrusionsBefore,
      meshed: tessellations.count() - tessellationsBefore
    };
    expect(kernel().checkpointCount()).toBeLessThanOrEqual(limit);
    const fresh = await createExactKernelAdapter({ historyCheckpointLimit: 0 });
    try {
      const expected = await fresh.syncDocument(committed);
      for (const bodyId of committed.bodyOrder) {
        expect(synced.bodyRepresentations[bodyId]!.volume).toBeCloseTo(
          expected.bodyRepresentations[bodyId]!.volume,
          9
        );
        expect(synced.bodyRepresentations[bodyId]!.bbox).toEqual(
          expected.bodyRepresentations[bodyId]!.bbox
        );
      }
      expect(synced.bodyRepresentations[edited]!.topology?.edges).toEqual(
        expected.bodyRepresentations[edited]!.topology?.edges
      );
      expect(synced.warnings).toEqual(expected.warnings);
    } finally {
      fresh.dispose();
    }
    return { rebuiltExtrusions, commit };
  } finally {
    extrusions.restore();
    tessellations.restore();
    adapter.dispose();
  }
}

it('a drag and its commit after a complete sync rebuild nothing but the edit', async () => {
  const { rebuiltExtrusions, commit } = await dragScenario({});
  // The base sync's last-feature checkpoint is the drag's source.
  expect(rebuiltExtrusions).toEqual([0, 0, 0, 0]);
  expect(commit.rebuiltExtrusions).toBe(0);
  // Only the edited extrusion is measured; the 19 boxes keep theirs.
  expect(commit.meshed).toBe(1);
  expect(commit.event).toMatchObject({
    restored: 21,
    replayed: 1,
    remeasured: 1,
    reusedMeasurements: 19
  });
});

it('a drag checkpoints its source when no checkpoint covers it', async () => {
  const { rebuiltExtrusions, commit } = await dragScenario({ displaced: true });
  // The first tick replays the extrusion from the stable checkpoint after
  // the sketch and checkpoints it; every later tick restores that and
  // replays the edit alone, so the edited body keeps its handles.
  expect(rebuiltExtrusions).toEqual([1, 0, 0, 0]);
  expect(commit.rebuiltExtrusions).toBe(0);
  expect(commit.event).toMatchObject({ restored: 21, replayed: 1 });
});

it('drag previews keep the drag checkpoint within a tight checkpoint limit', async () => {
  const { rebuiltExtrusions, commit } = await dragScenario({
    historyCheckpointLimit: 2,
    displaced: true
  });
  expect(rebuiltExtrusions).toEqual([1, 0, 0, 0]);
  expect(commit.rebuiltExtrusions).toBe(0);
});
