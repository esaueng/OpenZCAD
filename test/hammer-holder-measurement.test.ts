/** Opt-in browser-adapter acceptance for the private source; no STEP in Git. */
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { createProjectDocument, importStepBody, setParameter } from '@openzcad/document-core';
import { toUserId } from '@openzcad/shared';
import { createExactKernelAdapter, type RebuildCacheEvent } from '@openzcad/kernel-adapter/exact';

const sourcePath = process.env.OPENZCAD_HAMMER_STEP;
it.skipIf(!sourcePath)(
  'finishes complete hammer source measurement without background trial edits',
  async () => {
    const events: RebuildCacheEvent[] = [];
    const adapter = await createExactKernelAdapter({
      onRebuildCacheEvent: (event) => events.push(event)
    });
    try {
      const imported = importStepBody(
        createProjectDocument('Source measurement', toUserId('local')),
        {
          name: 'Source',
          artifactId: 'source',
          sourceName: 'source.step',
          stepText: readFileSync(sourcePath!, 'utf8')
        }
      );
      const derived = await adapter.syncDocument(imported.document);
      expect(derived.warnings).toEqual([]);
      expect(derived.exportableBodyIds).toEqual([imported.bodyId]);
      const body = derived.bodyRepresentations[imported.bodyId]!;
      expect(body.mesh.indices.length).toBeGreaterThan(0);
      expect(body.volume).toBeGreaterThan(0);
      expect(body.topology?.opposingPlanarFacePairs ?? []).toEqual([]);
      expect(body.massProperties).toBeUndefined();
      expect(body.topology?.faces.filter(face => face.geometry?.surfaceType === 'cylinder' && Math.abs((face.geometry.radius ?? 0) - 2.5) < 1e-7)).toHaveLength(2);
      const changed = setParameter(imported.document, { name: 'opening_width', expression: '50' });
      const cached = await adapter.syncDocument(changed);
      expect(events.at(-1)).toMatchObject({
        kind: 'prefix-restore', restored: 1, replayed: 0,
        remeasured: 0, reusedMeasurements: 1
      });
      expect(cached.bodyRepresentations).toEqual(derived.bodyRepresentations);
      expect(cached.warnings).toEqual([]);
    } finally {
      adapter.dispose();
    }
  },
  120_000
);
