import { describe, expect, it } from 'vitest';
import {
  addPrimitiveFeature,
  addSketchFeature,
  createProjectDocument,
  directEditBody,
  extrudeSketch
} from '@openzcad/document-core';
import { toUserId, type BodyId, type ProjectDocument } from '@openzcad/shared';
import { createExactKernelAdapter } from '@openzcad/kernel-adapter/exact';
import { RemusKernel } from '../packages/kernel-adapter/src/remus-runtime';
import {
  dragPreviewCheckpointIndices,
  historyCheckpointIndices
} from '../packages/kernel-adapter/src/exact-history-cache';

describe('dragPreviewCheckpointIndices', () => {
  it('ends at the feature before the edit and drops later positions', () => {
    // 22 features: the stable sparse positions skip 20, the edit's source.
    const stable = historyCheckpointIndices(22, 32);
    expect(stable.slice(15)).toEqual([15, 17, 19, 21]);
    expect(dragPreviewCheckpointIndices(stable, 21, 32).slice(15)).toEqual([
      15, 17, 19, 20
    ]);
    // Dense: the edit's own position goes, its source is already there.
    expect(dragPreviewCheckpointIndices([0, 1, 2, 3], 3, 32)).toEqual([
      0, 1, 2
    ]);
    expect(dragPreviewCheckpointIndices([], 21, 32)).toEqual([]);
    expect(dragPreviewCheckpointIndices([0], 0, 32)).toEqual([0]);
  });

  it('stays within the checkpoint limit', () => {
    // A full schedule gives up its latest position before the source.
    expect(dragPreviewCheckpointIndices([0, 1], 21, 2)).toEqual([0, 20]);
    expect(dragPreviewCheckpointIndices([0], 21, 1)).toEqual([20]);
    // Fractional limits count like historyCheckpointIndices: 2.5 allows two.
    expect(dragPreviewCheckpointIndices([0, 1], 21, 2.5)).toEqual([0, 20]);
    const full = historyCheckpointIndices(600, 32);
    const drag = dragPreviewCheckpointIndices(full, 599, 32);
    expect(drag).toHaveLength(32);
    expect(drag.slice(0, 31)).toEqual(full.slice(0, 31));
    expect(drag.at(-1)).toBe(598);
  });
});

/** Counts `extrude` calls on every kernel instance. */
function countExtrusions(): { count: () => number; restore: () => void } {
  const proto = RemusKernel.prototype as unknown as Record<string, unknown>;
  const original = proto.extrude as (...args: unknown[]) => unknown;
  let calls = 0;
  proto.extrude = function (this: unknown, ...args: unknown[]) {
    calls += 1;
    return original.apply(this, args);
  };
  return {
    count: () => calls,
    restore: () => {
      proto.extrude = original;
    }
  };
}

async function dragScenario(historyCheckpointLimit?: number) {
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
  // Features 19 and 20, then the edit at 21. The stable checkpoints are at
  // 17, 19 and 21, so the extrusion the drag edits sits after the last one.
  const sketch = addSketchFeature(document, {
    name: 'Profile',
    planeRef: { type: 'canonical', plane: 'XY', offset: 0 },
    objects: [{ objectKind: 'circle', radius: 3, centerX: 40, centerY: 0 }]
  });
  document = extrudeSketch(sketch.document, {
    name: 'Extrusion',
    sketchId: sketch.sketchId,
    distance: 4
  }).document;
  const edited = document.bodyOrder.at(-1) as BodyId;
  const adapter = await createExactKernelAdapter(
    historyCheckpointLimit === undefined ? {} : { historyCheckpointLimit }
  );
  const kernel = () =>
    (adapter as unknown as { historyKernel: RemusKernel | null })
      .historyKernel!;
  const extrusions = countExtrusions();
  try {
    const base = await adapter.syncDocument(document);
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
      expect(kernel().checkpointCount()).toBeLessThanOrEqual(
        historyCheckpointLimit ?? 32
      );
    }
    // The first tick replays the extrusion from the stable checkpoint after
    // the sketch and checkpoints it; every later tick restores that and
    // replays the edit alone, so the edited body keeps its handles.
    expect(rebuiltExtrusions).toEqual([1, 0, 0, 0]);

    // The commit drops the drag checkpoint and matches a fresh rebuild.
    const committed = offsetBy(-1);
    const synced = await adapter.syncDocument(committed);
    const fresh = await createExactKernelAdapter({ historyCheckpointLimit: 0 });
    try {
      const expected = await fresh.syncDocument(committed);
      expect(synced.bodyRepresentations[edited]!.volume).toBeCloseTo(
        expected.bodyRepresentations[edited]!.volume,
        9
      );
      expect(synced.bodyRepresentations[edited]!.bbox).toEqual(
        expected.bodyRepresentations[edited]!.bbox
      );
      expect(synced.warnings).toEqual(expected.warnings);
    } finally {
      fresh.dispose();
    }
  } finally {
    extrusions.restore();
    adapter.dispose();
  }
}

it('drag previews past the dense checkpoints replay only the dragged edit', async () => {
  await dragScenario();
});

it('drag previews keep the drag checkpoint within a tight checkpoint limit', async () => {
  await dragScenario(2);
});
