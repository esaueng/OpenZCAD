import { describe, expect, it, beforeAll } from 'vitest';
import {
  addPrimitiveFeature,
  createProjectDocument,
  setNodeMetadata
} from '@openzcad/document-core';
import { toUserId } from '@openzcad/shared';
import {
  createExactKernelAdapter,
  type ExactKernelAdapter
} from '@openzcad/kernel-adapter/exact';

/**
 * `derived.warnings` is a flat list of `Feature "<name>": …` strings. It is the
 * right shape to show a user and the wrong shape to decide anything from: two
 * features may share a name, and the rebuild loop writes the identical prefix
 * whether a feature FAILED to build or was deliberately SKIPPED for being
 * suppressed — the two pushes are ten lines apart in exact-build-loop.ts.
 *
 * A commit gate reading those strings therefore refused an edit whenever some
 * unrelated feature was suppressed under a colliding name. This pins the
 * attribution that lets it tell them apart.
 */
describe('warning attribution', () => {
  let adapter: ExactKernelAdapter;
  beforeAll(async () => {
    adapter = await createExactKernelAdapter();
  }, 120_000);

  it('marks a suppressed feature as suppressed, not as a failure', async () => {
    let document = createProjectDocument('Attribution', toUserId('user_a'));
    document = addPrimitiveFeature(document, {
      name: 'Block',
      primitiveKind: 'box',
      dimensions: { width: 10, height: 10, depth: 10 }
    });
    const featureId = document.featureOrder.at(-1)!;
    const node = Object.values(document.nodes).find(
      (candidate) =>
        candidate.kind === 'feature' && candidate.featureId === featureId
    )!;
    document = setNodeMetadata(document, {
      nodeId: node.id,
      metadata: { suppressed: true }
    });

    const derived = await adapter.syncDocument(document);

    // The user-facing string is unchanged; only the attribution is new.
    expect(derived.warnings).toContain(
      'Feature "Block": Suppressed; skipped during exact rebuild.'
    );
    expect(derived.featureWarnings).toEqual([
      {
        featureId,
        featureName: 'Block',
        message: 'Feature "Block": Suppressed; skipped during exact rebuild.',
        kind: 'suppressed'
      }
    ]);
  }, 120_000);

  it('leaves a clean rebuild with no attribution to make', async () => {
    let document = createProjectDocument('Clean', toUserId('user_a'));
    document = addPrimitiveFeature(document, {
      name: 'Block',
      primitiveKind: 'box',
      dimensions: { width: 10, height: 10, depth: 10 }
    });
    const derived = await adapter.syncDocument(document);
    expect(derived.warnings).toEqual([]);
    expect(derived.featureWarnings ?? []).toEqual([]);
  }, 120_000);
});
