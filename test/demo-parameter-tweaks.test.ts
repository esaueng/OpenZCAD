import {
  repairLegacyBracketDemo,
  repairLegacyBracketSaveState
} from '../apps/web/src/lib/bracketDemoCompatibility';
import { legacyBracket } from './helpers/legacy-bracket';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CommandManager,
  commandFactories,
  replayCommands
} from '@openzcad/command-system';
import {
  createParameterIds,
  createProjectDocument,
  listFeaturesInOrder,
  restoreFromSaveState,
  duplicateProjectDocument,
  repairLegacyBracketModel,
  appendRevision
} from '@openzcad/document-core';
import {
  InMemoryPersistenceService,
  sharedProjectSnapshotDocument
} from '@openzcad/persistence';
import { restoreDuplicateDerivedProjection } from '../apps/web/src/lib/localProjectStore';
import {
  createExactKernelAdapter,
  type ExactKernelAdapter
} from '@openzcad/kernel-adapter/exact';
import { toUserId, type ProjectDocument } from '@openzcad/shared';
import { meshEdgeUse } from './parity/mesh-probe';
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
    ['wall_h', '26'],
    ['boss_r', '14']
  ])(
    'repairs a saved legacy %s=%s bracket without losing its edits or history',
    async (name, expression) => {
      const actor = toUserId(
        name === 'boss_r' ? 'user_legacy_other_actor' : bracket.ownerUserId
      );
      const old = new CommandManager(
        legacyBracket(bracket),
        actor
      ).runTransaction('Saved tweak', [
        commandFactories.setParameter({
          name,
          expression,
          ids: createParameterIds()
        })
      ]);
      delete old.editHistory!.entries.at(-1)!.commandKinds;
      const before = structuredClone(old);
      expect((await adapter.syncDocument(old)).warnings).toHaveLength(1);
      const repaired = repairLegacyBracketDemo(old);
      expect(repaired).not.toBe(old);
      expect(old).toEqual(before);
      expect(repaired.projectId).toBe(old.projectId);
      expect(repaired.featureOrder).toEqual(old.featureOrder);
      expect(repaired.parameterOrder).toEqual(old.parameterOrder);
      expect(repaired.checkpoints).toEqual(old.checkpoints);
      expect(legacyBracket(repaired).commandLog).toEqual(old.commandLog);
      expect(legacyBracket(repaired).editHistory).toEqual(old.editHistory);
      for (const node of Object.values(old.nodes).filter(
        (node) => node.kind === 'parameter'
      )) {
        expect(repaired.nodes[node.id]).toEqual(node);
      }
      const derived = await adapter.syncDocument(repaired);
      expect(derived.warnings).toEqual([]);
      expect(derived.exportableBodyIds).toHaveLength(1);
      expect(
        await adapter.exportStep(repaired, derived.exportableBodyIds)
      ).toContain('ISO-10303-21;');
      const replayed = replayCommands(
        createProjectDocument(repaired.name, repaired.ownerUserId, 'mm'),
        repaired.commandLog
      );
      const cold = await adapter.syncDocument(replayed);
      expect(cold.warnings).toEqual([]);
      expect(
        cold.bodyRepresentations[cold.exportableBodyIds[0]!]!.volume
      ).toBeCloseTo(
        derived.bodyRepresentations[derived.exportableBodyIds[0]!]!.volume,
        6
      );
      expect(repairLegacyBracketDemo(repaired)).toBe(repaired);
      const manager = new CommandManager(repaired, actor);
      expect(manager.undoLabel).toBe('Saved tweak');
      manager.undo();
      expect((await adapter.syncDocument(manager.document)).warnings).toEqual(
        []
      );
      manager.redo();
      expect(manager.document.nodes).toEqual(repaired.nodes);
      expect((await adapter.syncDocument(manager.document)).warnings).toEqual(
        []
      );
    },
    60_000
  );

  it.each([
    ['wall_h', '26'],
    ['boss_r', '14']
  ])(
    'preserves a pending Redo of the saved %s=%s tweak',
    async (name, expression) => {
      const manager = new CommandManager(legacyBracket(bracket));
      manager.runTransaction('Saved tweak', [
        commandFactories.setParameter({
          name,
          expression,
          ids: createParameterIds()
        })
      ]);
      manager.undo();
      const old = structuredClone(manager.document);
      // This is how durable history written before commandKinds is stored.
      delete old.editHistory!.entries.at(-1)!.commandKinds;
      const repaired = repairLegacyBracketDemo(old);
      expect(legacyBracket(repaired).editHistory).toEqual(old.editHistory);
      const restored = new CommandManager(repaired);
      expect(restored.redoLabel).toBe('Saved tweak');
      restored.redo();
      expect((await adapter.syncDocument(restored.document)).warnings).toEqual(
        []
      );
      expect(
        await adapter.exportStep(
          restored.document,
          restored.document.bodyOrder.slice(-1)
        )
      ).toContain('ISO-10303-21;');
    },
    60_000
  );

  it.each([undefined, ['parameter.set']])(
    'abstains from a custom pending Redo even with missing or misleading kinds: %s',
    (kinds) => {
      const manager = new CommandManager(legacyBracket(bracket));
      manager.runTransaction('Custom boss', [
        commandFactories.updateFeature({
          featureId: listFeaturesInOrder(manager.document).find(
            (feature) => feature.name === 'Boss'
          )!.featureId,
          data: { dimensions: { radius: 'boss_r + 1' } }
        })
      ]);
      manager.undo();
      const old = structuredClone(manager.document);
      if (kinds) old.editHistory!.entries.at(-1)!.commandKinds = kinds;
      else delete old.editHistory!.entries.at(-1)!.commandKinds;
      const before = structuredClone(old);
      expect(repairLegacyBracketDemo(old)).toBe(old);
      expect(old).toEqual(before);
    }
  );

  it('preserves custom applied restores without command-kind metadata', () => {
    const old = legacyBracket(bracket);
    const custom = new CommandManager(old).runTransaction('Custom boss', [
      commandFactories.updateFeature({
        featureId: listFeaturesInOrder(old).find(
          (feature) => feature.name === 'Boss'
        )!.featureId,
        data: { dimensions: { radius: 'boss_r + 1' } }
      })
    ]);
    const manager = new CommandManager(old);
    manager.applyDocumentEdit(custom, 'Restore custom');
    manager.applyDocumentEdit(old, 'Restore original');
    const restored = manager.document;
    expect(restored.nodes).toEqual(old.nodes);
    expect(restored.commandLog).toEqual(old.commandLog);
    expect(
      restored.editHistory!.entries.slice(-2).map((entry) => entry.commandKinds)
    ).toEqual([undefined, undefined]);
    const before = structuredClone(restored);
    expect(repairLegacyBracketDemo(restored)).toBe(restored);
    expect(restored).toEqual(before);
    manager.undo();
    expect(manager.document.nodes).toEqual(custom.nodes);
  });

  it.each([
    ['wall_h', '26'],
    ['boss_r', '14']
  ])(
    'repairs an owned legacy %s=%s save before restore and preserves both ways back',
    async (name, expression) => {
      const snapshot = new CommandManager(
        legacyBracket(bracket)
      ).runTransaction('Old named save', [
        commandFactories.setParameter({
          name,
          expression,
          ids: createParameterIds()
        })
      ]);
      const beforeSnapshot = structuredClone(snapshot);
      const manager = new CommandManager(bracket);
      manager.runTransaction('Later width', [
        commandFactories.setParameter({
          name: 'width',
          expression: '81',
          ids: createParameterIds()
        })
      ]);
      const before = structuredClone(manager.document);
      expect(
        repairLegacyBracketSaveState(before, snapshot, [
          toUserId('another_owner')
        ])
      ).toBe(snapshot);
      const repaired = repairLegacyBracketSaveState(before, snapshot, [
        before.ownerUserId
      ]);
      expect(snapshot).toEqual(beforeSnapshot);
      manager.applyDocumentEdit(
        restoreFromSaveState(before, repaired, 'Restored legacy'),
        'Restored legacy'
      );
      const restored = structuredClone(manager.document);
      expect((await adapter.syncDocument(restored)).warnings).toEqual([]);
      expect(
        await adapter.exportStep(restored, restored.bodyOrder.slice(-1))
      ).toContain('ISO-10303-21;');
      manager.undo();
      expect(manager.document.nodes).toEqual(before.nodes);
      expect(manager.document.commandLog).toEqual(before.commandLog);
      manager.redo();
      expect(manager.document.nodes).toEqual(restored.nodes);
      expect((await adapter.syncDocument(manager.document)).warnings).toEqual(
        []
      );
    },
    60_000
  );

  it.each([
    ['wall_h', '26'],
    ['boss_r', '14']
  ])(
    'normalizes %s=%s in shared views, old copies and local/server copies without changing the source',
    async (name, expression) => {
      const old = new CommandManager(legacyBracket(bracket)).runTransaction(
        'Old tweak',
        [
          commandFactories.setParameter({
            name,
            expression,
            ids: createParameterIds()
          })
        ]
      );
      const before = structuredClone(old);
      const shared = sharedProjectSnapshotDocument(old);
      const sharedBefore = structuredClone(shared);
      const view = repairLegacyBracketModel(shared);
      expect(view.version).toBe(shared.version);
      expect(view.revisions).toEqual(shared.revisions);
      expect(view.checkpoints).toEqual(shared.checkpoints);
      expect(view.ownerUserId).toBe(shared.ownerUserId);
      expect(shared).toEqual(sharedBefore);
      const localCopy = duplicateProjectDocument(
        old,
        'Copy',
        toUserId('copy_owner')
      );
      expect(localCopy.projectId).not.toBe(old.projectId);
      expect(localCopy.derived.bodyRepresentations).toEqual({});
      expect(restoreDuplicateDerivedProjection(localCopy, old)).toBe(localCopy);
      const oldCopy = legacyBracket(
        duplicateProjectDocument(bracket, 'Old copy', bracket.ownerUserId)
      );
      const repairedOldCopy = repairLegacyBracketDemo(oldCopy);
      expect(repairedOldCopy).not.toBe(oldCopy);
      const service = new InMemoryPersistenceService();
      const created = await service.createProject(old.ownerUserId, {
        name: 'Legacy copy source',
        units: 'mm',
        document: old
      });
      const saved = await service.saveRevision(old.ownerUserId, {
        projectId: created.document.projectId,
        expectedVersion: created.document.version,
        document: appendRevision(created.document, 'Old point'),
        reason: 'Old point'
      });
      const serverBefore = structuredClone(saved);
      const serverCopy = await service.duplicateProject(old.ownerUserId, {
        projectId: saved.projectId
      });
      const serverBranch = await service.duplicateProject(old.ownerUserId, {
        projectId: saved.projectId,
        revisionId: saved.revisions.at(-1)!.revisionId
      });
      for (const document of [
        view,
        localCopy,
        repairedOldCopy,
        serverCopy.document,
        serverBranch.document
      ]) {
        const derived = await adapter.syncDocument(document);
        expect(derived.warnings).toEqual([]);
        expect(derived.exportableBodyIds).toHaveLength(1);
        expect(
          await adapter.exportStep(document, derived.exportableBodyIds)
        ).toContain('ISO-10303-21;');
      }
      expect(old).toEqual(before);
      expect(
        await service.loadProject(old.ownerUserId, saved.projectId)
      ).toEqual(serverBefore);
    },
    60_000
  );

  it('abstains from custom models and user-edited legacy recipes', () => {
    const old = legacyBracket(bracket);
    const cases = [
      { ...old, projectId: 'proj_custom' as typeof old.projectId },
      new CommandManager(old).runTransaction('Custom boss', [
        commandFactories.updateFeature({
          featureId: listFeaturesInOrder(old).find(
            (node) => node.kind === 'feature' && node.name === 'Boss'
          )!.featureId,
          data: { dimensions: { radius: 'boss_r + 1' } }
        })
      ]),
      new CommandManager(old).runTransaction('Custom placement', [
        commandFactories.updateFeature({
          featureId: listFeaturesInOrder(old).find(
            (node) =>
              node.kind === 'feature' && node.name === 'Place boss on wall'
          )!.featureId,
          name: 'Custom boss placement'
        })
      ])
    ];
    for (const document of [bracket, ...cases])
      expect(repairLegacyBracketDemo(document)).toBe(document);
  });

  it.each([
    ['default', null, null, 24, 32, 10],
    ['short wall', 'wall_h', '26', 20.25, 26, 10],
    ['large boss', 'boss_r', '14', 22.25, 32, 14]
  ] as const)(
    'keeps the %s boss and bore coaxial below two real radius-3 blends',
    async (_, name, expression, height, wallHeight, bossRadius) => {
      const document =
        name === null
          ? bracket
          : new CommandManager(bracket).runTransaction('Tweak', [
              commandFactories.setParameter({
                name,
                expression,
                ids: createParameterIds()
              })
            ]);
      const derived = await adapter.syncDocument(document);
      expect(derived.warnings).toEqual([]);
      expect(derived.exportableBodyIds).toHaveLength(1);
      const bodyId = derived.exportableBodyIds[0]!;
      const body = derived.bodyRepresentations[bodyId]!;
      const cylinders = body
        .topology!.faces.map((face) => face.geometry!)
        .filter((face) => face.surfaceType === 'cylinder');
      const blends = cylinders.filter((face) => face.featureType === 'blend');
      expect(blends).toHaveLength(2);
      for (const blend of blends) {
        expect(blend.blendRadius).toBeCloseTo(3, 6);
        expect(blend.axialLength).toBeCloseTo(80, 6);
        expect(blend.axisStart!.z).toBeCloseTo(8 + wallHeight - 0.5 - 3, 6);
      }
      const boss = cylinders.find((face) => face.radius === bossRadius)!;
      const bore = cylinders.find((face) => face.radius === 4)!;
      expect(boss).toBeDefined();
      expect(bore.featureType).toBe('through-hole');
      for (const cylinder of [boss, bore]) {
        expect(cylinder.axisStart!.x).toBeCloseTo(40, 6);
        expect(cylinder.axisEnd!.x).toBeCloseTo(40, 6);
        expect(cylinder.axisStart!.z).toBeCloseTo(height, 6);
        expect(cylinder.axisEnd!.z).toBeCloseTo(height, 6);
      }
      expect(height - bossRadius).toBeGreaterThan(8);
      expect(
        8 + wallHeight - 0.5 - 3 - (height + bossRadius)
      ).toBeGreaterThanOrEqual(0.25);
      const fillet = Object.values(document.nodes).find(
        (node) => node.kind === 'feature' && node.data.featureKind === 'fillet'
      )!;
      if (fillet.kind !== 'feature' || fillet.data.featureKind !== 'fillet') {
        throw new Error('Missing bracket fillet');
      }
      const source = derived.bodyRepresentations[fillet.data.targetBodyId]!;
      // Two full-length quarter-cylinder rounds must remove this exact
      // volume. Valid/exportable alone would also accept a no-op or a bevel.
      expect(source.volume - body.volume).toBeCloseTo(
        2 * 80 * 3 ** 2 * (1 - Math.PI / 4),
        6
      );
      expect(meshEdgeUse(body.mesh.vertices, body.mesh.indices)).toMatchObject({
        boundaryEdges: 0,
        nonManifoldEdges: 0
      });
      expect(await adapter.exportStep(document, [bodyId])).toContain(
        'ISO-10303-21;'
      );
    },
    60_000
  );

  it.each([
    ['width', '81'],
    ['width', '60'],
    ['width', '120'],
    ['depth', '30'],
    ['depth', '60'],
    // The wall is plate_t thick and carries two fillet_r breaks, so the
    // envelope is 2 * fillet_r < plate_t; and the r = boss_r boss sits at half
    // the wall height when there is room, otherwise moves down to clear
    // the top fillet. These are independent edits, not a Cartesian product.
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
