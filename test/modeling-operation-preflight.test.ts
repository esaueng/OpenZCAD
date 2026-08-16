import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CommandManager, commandFactories } from '@openzcad/command-system';
import { createBodyFeatureIds } from '@openzcad/document-core';
import {
  createExactKernelAdapter,
  type ExactKernelAdapter
} from '@openzcad/kernel-adapter/exact';
import { toUserId } from '@openzcad/shared';
import { buildDemoDocument, DEMO_DEFINITIONS } from '../apps/web/src/lib/demos';

describe('modeling operation exact preflight', () => {
  let adapter: ExactKernelAdapter;

  beforeAll(async () => {
    adapter = await createExactKernelAdapter();
  });

  afterAll(() => adapter.dispose());

  it('reflects a dense filleted body at exactly preserved volume', async () => {
    // This used to assert the opposite: that mirroring the heat sink tripped
    // the exact-volume preflight and the body was refused. The preflight was
    // right to exist and wrong about this body. A reflection is a rigid
    // transform, so it CANNOT change volume; what changed was the measurement.
    // Remus's `volume()` integrates a tessellation, and the old
    // triangulation ran in a parameter box mixing an angle with a length, so
    // a cylindrical band and its mirror image were meshed differently and read
    // differently. The tessellation fix made the measurement reflection-
    // equivariant, and the preflight now passes because the mirror is — and
    // always was — exact.
    //
    // Three independent things say this is a real fix and not a check that
    // stopped firing:
    //
    //   1. Source and mirror agree to 7.3e-12 mm3 on a ~63328 mm3 body. That
    //      is 1.1e-16 relative, the last bits of a double, against a gate set
    //      at 1e-9 relative. There is no tolerance being scraped past.
    //   2. Both land on the closed form below, computed from the demo's own
    //      construction, to 2.5e-6 relative — and that residue shrinks with
    //      the deflection (4.9e-6 -> 9.0e-7 -> 1.8e-7 -> 4.5e-8 on the same
    //      filleted plate), so it is mesh density, not geometry.
    //   3. The bounding box is the exact reflection and the face count is
    //      unchanged.
    const definition = DEMO_DEFINITIONS.find(
      (candidate) => candidate.key === 'heatsink'
    )!;
    const document = await buildDemoDocument(
      definition,
      toUserId('user_preflight'),
      (candidate) => adapter.syncDocument(candidate)
    );
    const sourceBodyId = document.derived.exportableBodyIds[0]!;
    const sourceBody = document.derived.bodyRepresentations[sourceBodyId]!;

    // 90x60x6 base, eight 3x60x22 fins seated 0.5 mm into it, four r2.5
    // fillets down the 6 mm base corners.
    const closedForm =
      90 * 60 * 6 +
      8 * (3 * 60 * 22) -
      8 * (3 * 60 * 0.5) -
      4 * (1 - Math.PI / 4) * 2.5 ** 2 * 6;
    expect(closedForm).toBeCloseTo(63327.809724509614, 9);
    expect(Math.abs(sourceBody.volume - closedForm) / closedForm).toBeLessThan(
      1e-5
    );

    const ids = createBodyFeatureIds();
    const command = commandFactories.mirrorBody({
      name: 'Mirror',
      targetBodyId: sourceBodyId,
      plane: {
        origin: { x: 0, y: 0, z: 0 },
        normal: { x: 1, y: 0, z: 0 }
      },
      ids
    });
    const candidate = new CommandManager(document).runTransaction(
      'Mirror preflight',
      [command]
    );
    const derived = await adapter.syncDocument(candidate);

    expect(derived.warnings).toEqual([]);
    const mirrored = derived.bodyRepresentations[ids.bodyId];
    expect(mirrored).toBeDefined();
    // The preflight's own gate is |dv| <= max(tol^3, |v| * 1e-9); assert two
    // orders tighter than that so a regression cannot hide inside it.
    expect(Math.abs(mirrored!.volume - sourceBody.volume)).toBeLessThan(
      sourceBody.volume * 1e-11
    );
    expect(Math.abs(mirrored!.volume - closedForm) / closedForm).toBeLessThan(
      1e-5
    );
    expect(mirrored!.faceCount).toBe(sourceBody.faceCount);
    // x reflects about the plane, y and z are untouched.
    expect(mirrored!.bbox.min.x).toBeCloseTo(-sourceBody.bbox.max.x, 9);
    expect(mirrored!.bbox.max.x).toBeCloseTo(-sourceBody.bbox.min.x, 9);
    expect(mirrored!.bbox.min.y).toBeCloseTo(sourceBody.bbox.min.y, 9);
    expect(mirrored!.bbox.max.y).toBeCloseTo(sourceBody.bbox.max.y, 9);
    expect(mirrored!.bbox.min.z).toBeCloseTo(sourceBody.bbox.min.z, 9);
    expect(mirrored!.bbox.max.z).toBeCloseTo(sourceBody.bbox.max.z, 9);
  }, 20_000);
});
