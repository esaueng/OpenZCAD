import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CommandManager, commandFactories } from '@openzcad/command-system';
import { createParameterIds } from '@openzcad/document-core';
import {
  createExactKernelAdapter,
  type ExactKernelAdapter
} from '@openzcad/kernel-adapter/exact';
import { toUserId, type ProjectDocument } from '@openzcad/shared';
import {
  buildDemoDocument,
  buildDemoSeed,
  DEMO_DEFINITIONS
} from '../apps/web/src/lib/demos';

/**
 * Tweak mode exposes every demo parameter, so every one of them has to rebuild
 * the demo over a sensible range. ZCAD-001: the bracket's Rev C fillet was
 * seeded by edge hash alone, and a hash encodes position, so `width` 80 → 81
 * was refused with "A selected edge no longer exists".
 */
describe('demo parameter tweaks', () => {
  let adapter: ExactKernelAdapter;
  let bracket: ProjectDocument;

  beforeAll(async () => {
    adapter = await createExactKernelAdapter();
    const definition = DEMO_DEFINITIONS.find(
      (candidate) => candidate.key === 'bracket'
    )!;
    bracket = await buildDemoDocument(
      definition,
      toUserId('user_demo_tweaks'),
      (candidate) => adapter.syncDocument(candidate)
    );
  }, 120_000);

  afterAll(() => adapter.dispose());

  it('seeds the bracket edge break with lineage references', () => {
    const fillet = Object.values(bracket.nodes).find(
      (node) => node.kind === 'feature' && node.featureKind === 'fillet'
    );
    expect(
      fillet?.kind === 'feature' && fillet.data.featureKind === 'fillet'
    ).toBe(true);
    if (fillet?.kind !== 'feature' || fillet.data.featureKind !== 'fillet') {
      return;
    }
    expect(fillet.data.edgeReferences).toHaveLength(
      fillet.data.edgeHashes.length
    );
  });

  it('seeds one restorable save state per checkpoint under the demo identity', async () => {
    const definition = DEMO_DEFINITIONS.find(
      (candidate) => candidate.key === 'bracket'
    )!;
    const seed = await buildDemoSeed(
      definition,
      toUserId('user_demo_tweaks'),
      (candidate) => adapter.syncDocument(candidate)
    );
    expect(
      seed.saveStates.map((state) => state.checkpoints.at(-1)?.reason)
    ).toEqual(seed.document.checkpoints.map((checkpoint) => checkpoint.reason));
    for (const state of seed.saveStates) {
      expect(state.projectId).toBe(definition.projectId);
      expect(state.checkpoints.at(-1)?.documentVersion).toBe(state.version);
    }
  }, 120_000);

  it.each([
    ['width', '81'],
    ['width', '60'],
    ['width', '120'],
    ['depth', '30'],
    ['depth', '60'],
    // The wall is plate_t thick and carries two fillet_r breaks, so the
    // envelope is 2 * fillet_r < plate_t; and the r = boss_r boss sits at half
    // the wall height, so wall_h > 2 * boss_r keeps it inside the wall.
    ['plate_t', '7'],
    ['plate_t', '12'],
    ['wall_h', '26'],
    ['wall_h', '50'],
    ['boss_r', '8'],
    ['boss_r', '14'],
    ['hole_r', '2'],
    ['hole_r', '6'],
    ['mount_r', '2'],
    ['mount_r', '5'],
    ['mount_inset', '10'],
    ['mount_inset', '24'],
    ['fillet_r', '1'],
    ['fillet_r', '3.5']
  ])(
    'rebuilds the bracket with %s = %s',
    async (name, expression) => {
      const tweaked = new CommandManager(bracket).runTransaction('Tweak', [
        commandFactories.setParameter({
          name,
          expression,
          ids: createParameterIds()
        })
      ]);
      const derived = await adapter.syncDocument(tweaked);
      expect(derived.warnings).toEqual([]);
      expect(derived.exportableBodyIds).toHaveLength(1);
    },
    60_000
  );
});
