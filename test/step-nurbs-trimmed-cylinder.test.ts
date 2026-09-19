import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { CommandManager, commandFactories } from '@openzcad/command-system';
import {
  createProjectDocument,
  listFeaturesInOrder
} from '@openzcad/document-core';
import { createExactKernelAdapter } from '@openzcad/kernel-adapter/exact';
import { toUserId } from '@openzcad/shared';

it('renders an imported cylinder with a curved NURBS trim without bridging its wall', async () => {
  // Synthetic half-cylinder: radius 4, top z=10, bottom z=x/4. The exact
  // rational lower rim has varying height; no private model is published.
  const stepText = readFileSync(
    new URL('./fixtures/step/nurbs-trimmed-cylinder.step', import.meta.url),
    'utf8'
  );
  const adapter = await createExactKernelAdapter();
  try {
    const manager = new CommandManager(
      createProjectDocument('Trimmed cylinder', toUserId('user_test'))
    );
    manager.execute(
      commandFactories.importStep({
        name: 'Sector',
        artifactId: 'artifact_sector',
        sourceName: 'nurbs-trimmed-cylinder.step',
        stepText
      })
    );
    const derived = await adapter.syncDocument(manager.document);
    expect(derived.warnings).toEqual([]);
    const bodies = Object.values(derived.bodyRepresentations);
    expect(bodies).toHaveLength(1);
    const body = bodies[0]!;
    const wall = body.topology?.faces.find(
      (face) => face.geometry?.surfaceType === 'cylinder'
    );
    expect(wall).toBeDefined();
    expect(wall!.triangleCount).toBeGreaterThan(0);
    const { vertices, indices } = body.mesh;
    let worst = 0;
    for (
      let i = wall!.triangleStart * 3;
      i < (wall!.triangleStart + wall!.triangleCount) * 3;
      i += 3
    ) {
      const points = [0, 1, 2].map((j) => [
        vertices[indices[i + j]! * 3]!,
        vertices[indices[i + j]! * 3 + 1]!
      ]);
      for (const weights of [
        [1 / 3, 1 / 3, 1 / 3],
        [0.5, 0.5, 0],
        [0, 0.5, 0.5],
        [0.5, 0, 0.5]
      ]) {
        const x = points.reduce((sum, p, j) => sum + p[0]! * weights[j]!, 0);
        const y = points.reduce((sum, p, j) => sum + p[1]! * weights[j]!, 0);
        worst = Math.max(worst, Math.abs(Math.hypot(x, y) - 4));
      }
    }
    // App display tolerance is 10 mm * 2e-4 = 0.002 mm. The old kernel
    // bridged the lower rim with chords deviating by about 0.028 mm.
    expect(worst).toBeLessThan(0.002);
    expect(listFeaturesInOrder(manager.document)[0]?.data).toMatchObject({
      stepText
    });
    const expectedVolume = 80 * Math.PI - 32 / 3;
    expect(body.volume).toBeCloseTo(expectedVolume, 1);
    const exported = await adapter.exportStep(
      manager.document,
      manager.document.bodyOrder
    );
    expect(exported).toContain('CYLINDRICAL_SURFACE');
    expect(exported).toContain('B_SPLINE_CURVE');
    const roundtrip = await adapter.inspectStep(exported);
    expect(roundtrip).toMatchObject({ solid: true, valid: true });
    expect(roundtrip.volume).toBeCloseTo(expectedVolume, 1);
  } finally {
    adapter.dispose();
  }
}, 30_000);
