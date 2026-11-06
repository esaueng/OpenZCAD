import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CommandManager, commandFactories } from '@openzcad/command-system';
import {
  addPrimitiveFeature,
  createProjectDocument,
  listFeaturesInOrder
} from '@openzcad/document-core';
import {
  createExactKernelAdapter,
  type ExactKernelAdapter
} from '@openzcad/kernel-adapter/exact';
import { toUserId, type ProjectDocument } from '@openzcad/shared';
import type { DirectEditFixture } from '../apps/web/src/lib/directEditFixture';
import { buildRefusalReproduction } from '../apps/web/src/lib/refusalReproduction';
import { replayFixture } from './direct-edit-corpus/replay';
import { filletedSphereBoss } from './support/sphere-boss-seam-fillet';

/**
 * WS3: a "Save reproduction" bundle built from a real refusal must replay
 * through the corpus to the SAME refusal — same sentence, same kernel
 * classification — after sanitizing, trimming and a JSON round trip.
 */
const KERNEL = {
  adapter: 'remus' as const,
  packageVersion: 'test',
  sourceCommit: 'test'
};
const CAPTURED_AT = '2026-11-05T00:00:00.000Z';
const PRIVATE_FEATURE = 'Acme bracket resize';
const PRIVATE_LATER = 'Acme later block';

let adapter: ExactKernelAdapter;
beforeAll(async () => {
  adapter = await createExactKernelAdapter();
}, 120_000);
afterAll(() => {
  adapter.dispose();
});

async function refusedCandidate(
  build: (manager: CommandManager) => ProjectDocument,
  manager: CommandManager,
  featureName: string
) {
  const candidate = build(manager);
  const derived = await adapter.syncDocument(candidate);
  const warning = derived.featureWarnings?.find(
    (entry) => entry.featureName === featureName
  );
  expect(warning, JSON.stringify(derived.warnings)).toBeDefined();
  return { candidate, warning: warning! };
}

function roundTrip(fixture: DirectEditFixture): DirectEditFixture {
  return JSON.parse(JSON.stringify(fixture)) as DirectEditFixture;
}

describe('saved refusal reproductions replay through the corpus', () => {
  it('reproduces the sphere-boss direct resize refusal', async () => {
    // The seam-filleted boss: the plain boss on a sphere resizes since Remus
    // #1558, but a wall meeting the freeform fillet band still refuses typed.
    const { manager, bodyId, wall } = await filletedSphereBoss(adapter);
    expect(wall).toBeDefined();
    const { candidate, warning } = await refusedCandidate(
      (m) =>
        m.runTransaction('Resize', [
          commandFactories.directEditBody({
            name: PRIVATE_FEATURE,
            targetBodyId: bodyId,
            operation: {
              kind: 'resize-cylindrical-face',
              faceHash: wall!.hash,
              ...(wall!.reference ? { faceReference: wall!.reference } : {}),
              sourceRadius: 6,
              sourceAxisStart: wall!.geometry!.axisStart!,
              sourceAxisEnd: wall!.geometry!.axisEnd!,
              concavity: 'boss',
              radius: 7
            }
          }),
          // A later feature the reproduction must trim away.
          commandFactories.addPrimitive({
            name: PRIVATE_LATER,
            primitiveKind: 'box',
            dimensions: { width: 5, depth: 5, height: 5 }
          })
        ]),
      manager,
      PRIVATE_FEATURE
    );
    expect(warning.kind).toBe('build-failed');
    // Typed since the pin carries resizeCylindricalFaceDetailed (#1265).
    expect(warning.kernelRefusal).toMatchObject({
      family: 'direct-edit',
      category: 'unsupported',
      code: 'unsupported_move_face'
    });

    const fixture = roundTrip(
      buildRefusalReproduction({
        document: candidate,
        warning,
        kernel: KERNEL,
        capturedAt: CAPTURED_AT
      })
    );
    expect(fixture.edit).toMatchObject({
      op: 'feature-build',
      featureId: warning.featureId,
      featureKind: 'direct-edit',
      operationKind: 'resize-cylindrical-face'
    });
    expect(fixture.document).not.toBeNull();
    const ordered = listFeaturesInOrder(fixture.document!);
    expect(ordered.at(-1)?.featureId).toBe(warning.featureId);
    expect(ordered).toHaveLength(listFeaturesInOrder(candidate).length - 1);

    const serialized = JSON.stringify(fixture);
    for (const secret of [
      PRIVATE_FEATURE,
      PRIVATE_LATER,
      'Sphere cylinder union',
      'user_union_test',
      candidate.projectId
    ]) {
      expect(serialized).not.toContain(secret);
    }

    const result = await replayFixture(adapter, fixture);
    expect(result.outcome).toBe('refused');
    expect(result.message).toBe(fixture.observed.message);
    expect(result.message).toBe(
      "This face meets a fillet or freeform surface, which resizing and moving faces can't follow yet."
    );
    expect(result.warningKind).toBe(warning.kind);
    expect(result.kernelRefusal).toEqual(warning.kernelRefusal);
    expect(fixture.observed.kernelRefusal).toEqual(warning.kernelRefusal);
  }, 120_000);

  it('reproduces a refused boolean', async () => {
    let document = createProjectDocument(
      'Private boolean project',
      toUserId('user_private_boolean')
    );
    for (const name of ['Left block', 'Right block']) {
      document = addPrimitiveFeature(document, {
        name,
        primitiveKind: 'box',
        dimensions: { width: 10, depth: 10, height: 10 }
      });
    }
    const [a, b] = document.bodyOrder as [
      (typeof document.bodyOrder)[number],
      (typeof document.bodyOrder)[number]
    ];
    const manager = new CommandManager(document);
    const { candidate, warning } = await refusedCandidate(
      (m) =>
        m.runTransaction('Cut', [
          commandFactories.booleanBodies({
            name: 'Acme identical cut',
            operation: 'subtract',
            targetBodyIds: [a, b]
          })
        ]),
      manager,
      'Acme identical cut'
    );

    const fixture = roundTrip(
      buildRefusalReproduction({
        document: candidate,
        warning,
        kernel: KERNEL,
        capturedAt: CAPTURED_AT
      })
    );
    expect(fixture.edit.featureKind).toBe('boolean');
    expect(warning.kernelRefusal).toMatchObject({
      family: 'boolean',
      operation: 'cut'
    });
    // The kernel's sentence names both operand bodies; neither name survives.
    expect(warning.message).toContain('Left block');
    const serialized = JSON.stringify(fixture);
    for (const secret of [
      'Acme identical cut',
      'Private boolean project',
      'user_private_boolean',
      'Left block',
      'Right block'
    ]) {
      expect(serialized).not.toContain(secret);
    }

    const result = await replayFixture(adapter, fixture);
    expect(result.outcome).toBe('refused');
    expect(result.message).toBe(fixture.observed.message);
    expect(result.kernelRefusal).toEqual(warning.kernelRefusal);
  }, 120_000);
});
