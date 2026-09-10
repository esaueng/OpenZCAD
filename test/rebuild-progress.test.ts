import { expect, it } from 'vitest';
import {
  addPrimitiveFeature,
  addSketchFeature,
  extrudeSketch,
  importStepBody,
  createProjectDocument
} from '@openzcad/document-core';
import { toUserId } from '@openzcad/shared';
import {
  createExactKernelAdapter,
  type RebuildProgress
} from '@openzcad/kernel-adapter/exact';

it('reports ordered real work and leaves geometry identical when observers throw', async () => {
  const document = addPrimitiveFeature(
    createProjectDocument('Progress', toUserId('test')),
    {
      name: 'Box',
      primitiveKind: 'box',
      dimensions: { width: 10, height: 20, depth: 30 }
    }
  );
  const adapter = await createExactKernelAdapter();
  const events: RebuildProgress[] = [];
  try {
    const first = await adapter.syncDocument(document, (event) =>
      events.push(event)
    );
    expect([
      ...new Set(
        events.filter((e) => e.status === 'started').map((e) => e.stage)
      )
    ]).toEqual(['sources', 'history', 'feature', 'checkpoint', 'measurement']);
    for (const event of events.filter((e) => e.status === 'completed')) {
      expect(event.durationMs).toBeGreaterThanOrEqual(0);
      expect(Number.isFinite(event.durationMs)).toBe(true);
    }
    expect(events.find((e) => e.stage === 'feature')).toMatchObject({
      name: 'Box',
      index: 1,
      total: 1
    });
    const second = await adapter.syncDocument(document, () => {
      throw new Error('observer failed');
    });
    expect(second.bodyRepresentations).toEqual(first.bodyRepresentations);
    expect(second.warnings).toEqual(first.warnings);
  } finally {
    adapter.dispose();
  }
});

it('renders a complex imported prism without speculative edits or optional moments', async () => {
  const adapter = await createExactKernelAdapter();
  try {
    const sketch = addSketchFeature(
      createProjectDocument('Complex prism', toUserId('test')),
      {
        name: 'Profile',
        planeRef: { type: 'canonical', plane: 'XY', offset: 0 },
        objects: [
          {
            objectKind: 'polygon',
            sides: 64,
            radius: 10,
            centerX: 0,
            centerY: 0
          }
        ]
      }
    );
    const native = extrudeSketch(sketch.document, {
      name: 'Prism',
      sketchId: sketch.sketchId,
      distance: 5
    });
    const stepText = await adapter.exportStep(native.document, [native.bodyId]);
    const imported = importStepBody(
      createProjectDocument('Import', toUserId('test')),
      {
        name: 'Imported prism',
        artifactId: 'prism',
        sourceName: 'prism.step',
        stepText
      }
    );
    const derived = await adapter.syncDocument(imported.document);
    const body = derived.bodyRepresentations[imported.bodyId]!;
    expect(derived.warnings).toEqual([]);
    expect(derived.exportableBodyIds).toEqual([imported.bodyId]);
    expect(body.topology?.faces).toHaveLength(66);
    expect(body.topology?.opposingPlanarFacePairs ?? []).toEqual([]);
    expect(body.massProperties).toBeUndefined();
    expect(body.volume).toBeCloseTo(
      (64 / 2) * 100 * Math.sin((2 * Math.PI) / 64) * 5,
      4
    );
    expect(body.mesh.indices.length).toBeGreaterThan(0);
  } finally {
    adapter.dispose();
  }
});
