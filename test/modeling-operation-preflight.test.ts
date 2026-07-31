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

  it('fails closed when a dense reflection does not preserve exact volume', async () => {
    const definition = DEMO_DEFINITIONS.find(
      (candidate) => candidate.key === 'heatsink'
    )!;
    const document = await buildDemoDocument(
      definition,
      toUserId('user_preflight'),
      (candidate) => adapter.syncDocument(candidate)
    );
    const sourceBodyId = document.derived.exportableBodyIds[0]!;
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

    expect(derived.warnings).toEqual([
      expect.stringMatching(
        /Feature "Mirror": Mirror output did not preserve exact solid volume/
      )
    ]);
    expect(derived.bodyRepresentations[ids.bodyId]).toBeUndefined();
    expect(document.bodyOrder).not.toContain(ids.bodyId);
  }, 20_000);
});
