import { describe, expect, it, beforeAll, vi } from 'vitest';
import {
  addPrimitiveFeature,
  createProjectDocument,
  setNodeMetadata
} from '@openzcad/document-core';
import { CommandManager, commandFactories } from '@openzcad/command-system';
import { RemusKernel } from '../packages/kernel-adapter/src/remus-runtime';
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
let adapter: ExactKernelAdapter;
beforeAll(async () => {
  adapter = await createExactKernelAdapter();
}, 120_000);

describe('warning attribution', () => {

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

/**
 * The classification, pinned at the two ends that matter.
 *
 * A warning that accompanies a real body is an ADVISORY and must not refuse a
 * commit; one that accompanies the wrong body is a REFUSAL and must. That
 * distinction cannot be derived from whether a shape was produced — the commit
 * gate rebuilds a throwaway candidate, so every builder that does not throw
 * sets a shape by construction. It is a judgement about the result, which is
 * why it is recorded at the kernel rather than inferred at the gate.
 */
describe('what a builder warning means', () => {
  it('calls a union that dropped an operand a refusal', async () => {
    // The tangent-boss case: the fuse returns a solid that is simply the
    // plate, silently losing the boss above z=8. A body exists and is
    // exportable; it is not the body the user asked for.
    let document = createProjectDocument('Tangent', toUserId('user_a'));
    document = addPrimitiveFeature(document, {
      name: 'Plate',
      primitiveKind: 'box',
      dimensions: { width: 60, height: 40, depth: 8 }
    });
    const plateId = document.bodyOrder.at(-1)!;
    document = addPrimitiveFeature(document, {
      name: 'Boss',
      primitiveKind: 'cylinder',
      dimensions: { radius: 10, height: 16 }
    });
    const bossId = document.bodyOrder.at(-1)!;
    const manager = new CommandManager(document);
    manager.execute(
      commandFactories.booleanBodies({
        name: 'Weld',
        operation: 'union',
        targetBodyIds: [plateId, bossId]
      })
    );

    // Fault injection reproduces the kernel answer deterministically: the
    // fuse reports success and hands back its plate operand unchanged.
    const fuse = vi
      .spyOn(RemusKernel.prototype, 'fuseAll')
      .mockImplementation((solids) => solids[0]!);
    let derived;
    try {
      derived = await adapter.syncDocument(manager.document);
    } finally {
      fuse.mockRestore();
    }

    // Matched by its own text, not merely by feature: this union raises TWO
    // warnings, and asserting on whichever came first would pass whatever
    // either one was classified as.
    const dropped = derived.featureWarnings?.find((entry) =>
      entry.message.includes('Union dropped geometry from operand')
    );
    expect(dropped?.kind).toBe('refusal');
    // Pinned as the diagnostic a refused commit shows, in
    // apps/web/src/hooks/useValidatedFeatureCommit.test.tsx.
    expect(dropped?.message).toContain('move the operand slightly off');
  }, 120_000);

  it('leaves a body-level warning unattributed, so no feature is refused for it', async () => {
    // `Body "<name>" …` warnings describe a body's measured state or the file
    // it was imported from — including invalidity a STEP import deliberately
    // admits. They are not attributed to a feature, and the gate's name match
    // looks for `Feature "`, so neither route can refuse a commit for them.
    const derived = await adapter.syncDocument(
      addPrimitiveFeature(
        createProjectDocument('Plain', toUserId('user_a')),
        {
          name: 'Block',
          primitiveKind: 'box',
          dimensions: { width: 10, height: 10, depth: 10 }
        }
      )
    );
    for (const entry of derived.featureWarnings ?? []) {
      expect(entry.message.startsWith('Feature "')).toBe(true);
    }
  }, 120_000);
});
