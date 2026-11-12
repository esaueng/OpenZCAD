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
  historyCheckpointIndices,
  withTerminalResultCheckpoint
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

describe('withTerminalResultCheckpoint', () => {
  it("adds a complete edit build's result after its source", () => {
    expect(withTerminalResultCheckpoint([0, 1, 2], 3, 32)).toEqual([
      0, 1, 2, 3
    ]);
    const dense = tailCheckpointIndices(
      historyCheckpointIndices(10, 32),
      8,
      32
    );
    expect(withTerminalResultCheckpoint(dense, 9, 32)).toEqual(
      historyCheckpointIndices(10, 32)
    );
  });

  it('never displaces the source, blocks its restore, or exceeds the limit', () => {
    // A full schedule keeps the source the next value of the edit restores.
    expect(withTerminalResultCheckpoint([0, 1], 21, 2)).toEqual([0, 1]);
    expect(withTerminalResultCheckpoint([0, 1], 21, 2.5)).toEqual([0, 1]);
    const full = tailCheckpointIndices(
      historyCheckpointIndices(600, 32),
      598,
      32
    );
    expect(withTerminalResultCheckpoint(full, 599, 32)).toEqual(full);
    // 22 features: an appended edit's schedule drops the source (20), which
    // must then stay the last checkpoint so that edit restores it.
    const sparse = tailCheckpointIndices(
      historyCheckpointIndices(22, 32),
      20,
      32
    );
    expect(historyCheckpointIndices(23, 32)).not.toContain(20);
    expect(withTerminalResultCheckpoint(sparse, 21, 32)).toEqual(sparse);
    // Nothing to add: no caching, or the result is already the tail.
    expect(withTerminalResultCheckpoint([], 3, 32)).toEqual([]);
    expect(withTerminalResultCheckpoint([0, 1, 3], 3, 32)).toEqual([0, 1, 3]);
  });
});

type CountedMethod =
  | 'extrude'
  | 'tessellateSolidGroupedBinary'
  | 'moveFaces'
  | 'moveFacesJournaled'
  | 'moveFacesJournaledWithQuality'
  | 'moveFacesPreparedJournaled'
  | 'moveFacesPreparedJournaledWithQuality';

/** Counts calls to any of `methods` on every kernel instance. */
function countCalls(...methods: CountedMethod[]): {
  count: () => number;
  restore: () => void;
} {
  const proto = RemusKernel.prototype as unknown as Record<string, unknown>;
  let calls = 0;
  const originals = methods
    .filter((method) => typeof proto[method] === 'function')
    .map((method) => {
      const original = proto[method] as (...args: unknown[]) => unknown;
      proto[method] = function (this: unknown, ...args: unknown[]) {
        calls += 1;
        return original.apply(this, args);
      };
      return [method, original] as const;
    });
  return {
    count: () => calls,
    restore: () => {
      for (const [method, original] of originals) proto[method] = original;
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
  const moves = countCalls(
    'moveFaces',
    'moveFacesJournaled',
    'moveFacesJournaledWithQuality',
    'moveFacesPreparedJournaled',
    'moveFacesPreparedJournaledWithQuality'
  );
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
    // Apply must retain the same checked source. Otherwise the next value
    // replays the extrusion (or an expensive shoulder fillet in a real part)
    // once for display and again for the complete commit.
    const beforeNextPreview = extrusions.count();
    const nextPreview = await adapter.previewGeometry(offsetBy(1.5), {
      deferTopology: true
    });
    expect(nextPreview.warnings).toEqual([]);
    const nextPreviewReplays = extrusions.count() - beforeNextPreview;
    const beforeNextCommit = extrusions.count();
    const nextDocument = offsetBy(1.5);
    const nextComplete = await adapter.syncDocument(nextDocument);
    expect(nextComplete.warnings).toEqual([]);
    const nextCommitReplays = extrusions.count() - beforeNextCommit;
    expect(kernel().checkpointCount()).toBeLessThanOrEqual(limit);
    // The broadcast that follows a commit syncs the same document again.
    await adapter.syncDocument(nextDocument);
    const followUpReplayed = events.at(-1)!.replayed;
    // A new drag on the committed result appends another edit; its first
    // frame needs the committed edit's result, not its source.
    const settled = { ...nextDocument, derived: nextComplete };
    const newTop = nextComplete.bodyRepresentations[
      edited
    ]!.topology!.faces.find((face) => (face.geometry?.normal?.z ?? 0) > 0.99)!;
    const movesBeforeAppend = moves.count();
    const extrusionsBeforeAppend = extrusions.count();
    const appended = await adapter.previewGeometry(
      directEditBody(settled, {
        name: 'Offset again',
        targetBodyId: edited,
        operation: {
          kind: 'offset-face',
          faceHash: newTop.hash,
          ...(newTop.reference ? { faceReference: newTop.reference } : {}),
          sourceSurfaceType: 'plane',
          sourceArea: newTop.geometry!.area,
          sourceCenter: newTop.geometry!.center,
          sourceNormal: newTop.geometry!.normal!,
          offset: 0.5
        }
      }).document,
      { deferTopology: true }
    );
    expect(appended.warnings).toEqual([]);
    const appendedPreview = {
      moves: moves.count() - movesBeforeAppend,
      extrusions: extrusions.count() - extrusionsBeforeAppend
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
    return {
      rebuiltExtrusions,
      commit,
      nextPreviewReplays,
      nextCommitReplays,
      followUpReplayed,
      appendedPreview
    };
  } finally {
    extrusions.restore();
    tessellations.restore();
    moves.restore();
    adapter.dispose();
  }
}

it('a drag and its commit after a complete sync rebuild nothing but the edit', async () => {
  const {
    rebuiltExtrusions,
    commit,
    nextPreviewReplays,
    nextCommitReplays,
    followUpReplayed,
    appendedPreview
  } = await dragScenario({});
  // 22 features is a sparse schedule that drops the source once an edit is
  // appended, so no result checkpoint is taken: the follow-up sync replays
  // the edit and the next drag still restores the source, as before.
  expect(followUpReplayed).toBe(1);
  expect(appendedPreview.extrusions).toBe(0);
  // The base sync's last-feature checkpoint is the drag's source.
  expect(rebuiltExtrusions).toEqual([0, 0, 0, 0]);
  expect(commit.rebuiltExtrusions).toBe(0);
  expect(nextPreviewReplays).toBe(0);
  expect(nextCommitReplays).toBe(0);
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
  const { rebuiltExtrusions, commit, nextPreviewReplays, nextCommitReplays } =
    await dragScenario({ historyCheckpointLimit: 2, displaced: true });
  expect(rebuiltExtrusions).toEqual([1, 0, 0, 0]);
  expect(commit.rebuiltExtrusions).toBe(0);
  expect(nextPreviewReplays).toBe(0);
  expect(nextCommitReplays).toBe(0);
});

it('a checked sync keeps a terminal face edit result for the next sync and drag', async () => {
  const events: RebuildCacheEvent[] = [];
  const adapter = await createExactKernelAdapter({
    onRebuildCacheEvent: (event) => events.push(event)
  });
  const moves = countCalls(
    'moveFaces',
    'moveFacesJournaled',
    'moveFacesJournaledWithQuality',
    'moveFacesPreparedJournaled',
    'moveFacesPreparedJournaledWithQuality'
  );
  try {
    const document = addPrimitiveFeature(
      createProjectDocument('Terminal result', toUserId('drag_checkpoint')),
      {
        name: 'Block',
        primitiveKind: 'box',
        dimensions: { width: 20, height: 10, depth: 8 }
      }
    );
    const bodyId = document.bodyOrder[0]!;
    const offsetTop = (source: ProjectDocument, offset: number) => {
      const top = source.derived.bodyRepresentations[
        bodyId
      ]!.topology!.faces.find(
        (face) => (face.geometry?.normal?.z ?? 0) > 0.99
      )!;
      return directEditBody(source, {
        name: 'Offset',
        targetBodyId: bodyId,
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
    };
    const base = { ...document, derived: await adapter.syncDocument(document) };
    const first = offsetTop(base, 2);
    await adapter.previewGeometry(first, { deferTopology: true });
    const committed = await adapter.syncDocument(first);
    expect(committed.warnings).toEqual([]);
    // The commit replays and validates the edit itself...
    expect(events.at(-1)).toMatchObject({ restored: 1, replayed: 1 });
    // ...and the broadcast of the same document restores that checked result.
    const movesBeforeBroadcast = moves.count();
    const broadcast = await adapter.syncDocument(first);
    expect(events.at(-1)).toMatchObject({ restored: 2, replayed: 0 });
    expect(moves.count()).toBe(movesBeforeBroadcast);

    // The next drag appends an edit: its first frame moves only its own face.
    const second = offsetTop({ ...first, derived: broadcast }, 1);
    const movesBeforeDrag = moves.count();
    const frame = await adapter.previewGeometry(second, {
      deferTopology: true
    });
    expect(frame.warnings).toEqual([]);
    expect(moves.count() - movesBeforeDrag).toBe(1);
    const secondCommitted = await adapter.syncDocument(second);
    expect(events.at(-1)).toMatchObject({ restored: 2, replayed: 1 });

    // Every restored result agrees with a cold exact build.
    const fresh = await createExactKernelAdapter({ historyCheckpointLimit: 0 });
    try {
      for (const [doc, derived] of [
        [first, broadcast],
        [second, secondCommitted]
      ] as const) {
        const expected = await fresh.syncDocument(doc);
        expect(derived.bodyRepresentations[bodyId]!.volume).toBeCloseTo(
          expected.bodyRepresentations[bodyId]!.volume,
          9
        );
        expect(derived.bodyRepresentations[bodyId]!.bbox).toEqual(
          expected.bodyRepresentations[bodyId]!.bbox
        );
        expect(derived.bodyRepresentations[bodyId]!.topology?.edges).toEqual(
          expected.bodyRepresentations[bodyId]!.topology?.edges
        );
      }
    } finally {
      fresh.dispose();
    }
  } finally {
    moves.restore();
    adapter.dispose();
  }
});
