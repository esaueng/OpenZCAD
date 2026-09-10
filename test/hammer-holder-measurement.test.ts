/** Opt-in browser-adapter acceptance for the private source; no STEP in Git. */
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { createProjectDocument, importStepBody } from '@openzcad/document-core';
import { toUserId } from '@openzcad/shared';
import { createExactKernelAdapter } from '@openzcad/kernel-adapter/exact';

const sourcePath = process.env.OPENZCAD_HAMMER_STEP;
it.skipIf(!sourcePath)(
  'finishes complete hammer source measurement without background trial edits',
  async () => {
    const adapter = await createExactKernelAdapter();
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
    } finally {
      adapter.dispose();
    }
  },
  120_000
);
