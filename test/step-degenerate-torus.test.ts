import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { CommandManager, commandFactories } from '@openzcad/command-system';
import {
  createProjectDocument,
  listFeaturesInOrder
} from '@openzcad/document-core';
import { createExactKernelAdapter } from '@openzcad/kernel-adapter/exact';
import { toUserId } from '@openzcad/shared';

it('imports and roundtrips an exact STEP lemon-torus band without changing the source', async () => {
  // Synthetic fixture shared with Remus; no customer model is checked in.
  const stepText = readFileSync(
    new URL('./fixtures/step/lemon-torus-band.step', import.meta.url),
    'utf8'
  );
  const expectedVolume = Math.PI * (108 - 100 * Math.asin(0.6));
  const adapter = await createExactKernelAdapter();
  try {
    const manager = new CommandManager(
      createProjectDocument('Spindle torus', toUserId('user_torus'))
    );
    manager.execute(
      commandFactories.importStep({
        name: 'Lemon band',
        artifactId: 'artifact_torus',
        sourceName: 'lemon-torus-band.step',
        stepText
      })
    );
    const derived = await adapter.syncDocument(manager.document);
    expect(derived.warnings).toEqual([]);
    const bodies = Object.values(derived.bodyRepresentations);
    expect(bodies).toHaveLength(1);
    expect(bodies[0]?.source).toBe('imported-step');
    expect(
      Math.abs(bodies[0]!.volume - expectedVolume) / expectedVolume
    ).toBeLessThan(0.01);
    expect(listFeaturesInOrder(manager.document)[0]?.data).toMatchObject({
      featureKind: 'imported-step',
      stepText
    });
    const exported = await adapter.exportStep(
      manager.document,
      manager.document.bodyOrder
    );
    expect(exported).toContain('RATIONAL_B_SPLINE_SURFACE');
    const reimport = await adapter.inspectStep(exported);
    expect(reimport).toMatchObject({ solid: true, valid: true });
    expect(
      Math.abs(reimport.volume - expectedVolume) / expectedVolume
    ).toBeLessThan(0.01);
  } finally {
    adapter.dispose();
  }
}, 30_000);
