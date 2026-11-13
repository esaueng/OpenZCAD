import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CommandManager,
  commandFactories,
  replayCommands,
  type AnyCommand
} from '@openzcad/command-system';
import {
  addPrimitiveFeature,
  attachDerivedState,
  createBodyFeatureIds,
  createProjectDocument,
  listFeaturesInOrder,
  updateFeature
} from '@openzcad/document-core';
import {
  createExactKernelAdapter,
  type ExactKernelAdapter
} from '@openzcad/kernel-adapter/exact';
import {
  FEATURE_ROLLBACK_SUPPRESSED_METADATA_KEY,
  toUserId,
  type BodyId,
  type DerivedState,
  type EdgeTopology,
  type FeatureId,
  type ProjectDocument
} from '@openzcad/shared';
import { newExactWarnings } from '../apps/web/src/lib/exactWarnings';

/**
 * ADR-025. Body identity is per state: a fillet mints a new result body and
 * consumes its input. Two features that both replace the same input fork the
 * history, and both branches build, so two overlapping solids of one part
 * appear. A stored fork keeps building exactly as it did and is reported on
 * the later branch; a new one is refused where it would be created.
 */
describe('forked history', () => {
  let adapter: ExactKernelAdapter;

  beforeAll(async () => {
    adapter = await createExactKernelAdapter();
  }, 120_000);
  afterAll(() => adapter.dispose());

  const blank = () =>
    createProjectDocument(
      'Forked history',
      toUserId('user_history_fork'),
      'mm'
    );

  async function synced(document: ProjectDocument) {
    const derived = await adapter.syncDocument(document);
    return { document: attachDerivedState(document, derived), derived };
  }

  const forkWarnings = (derived: DerivedState) =>
    (derived.featureWarnings ?? []).filter(
      (entry) => entry.kind === 'history-fork'
    );

  const live = (derived: DerivedState) =>
    Object.values(derived.bodyRepresentations)
      .filter((body) => !body.consumed)
      .map((body) => body.bodyId)
      .sort();

  /** Two straight edges of the block that share no vertex. */
  function twoEdges(derived: DerivedState, bodyId: BodyId) {
    const edges = derived.bodyRepresentations[bodyId]!.topology!.edges.filter(
      (edge) => edge.displayRole !== 'seam'
    );
    const ends = (edge: EdgeTopology) => [
      edge.points.slice(0, 3).join(','),
      edge.points.slice(-3).join(',')
    ];
    const first = edges[0]!;
    const second = edges.find(
      (edge) => !ends(edge).some((end) => ends(first).includes(end))
    )!;
    expect(second).toBeDefined();
    return [first, second] as const;
  }

  const edgeInput = (edge: EdgeTopology) => ({
    edgeHashes: [edge.hash],
    ...(edge.reference ? { edgeReferences: [edge.reference] } : {})
  });

  /** A block and a 2 mm fillet that replaces it. */
  async function filleted() {
    const manager = new CommandManager(blank());
    const block = createBodyFeatureIds();
    manager.execute(
      commandFactories.addPrimitive({
        name: 'Block',
        bodyName: 'Block',
        primitiveKind: 'box',
        dimensions: { width: 20, height: 20, depth: 20 },
        ids: block
      })
    );
    const { derived } = await synced(manager.document);
    const [rounded, bevelled] = twoEdges(derived, block.bodyId);
    const fillet = createBodyFeatureIds();
    manager.execute(
      commandFactories.filletEdges({
        name: 'Fillet 1',
        targetBodyId: block.bodyId,
        ...edgeInput(rounded),
        size: 2,
        ids: fillet
      })
    );
    const chamfer = (targetBodyId: BodyId, ids = createBodyFeatureIds()) =>
      commandFactories.chamferEdges({
        name: 'Chamfer 1',
        targetBodyId,
        ...edgeInput(bevelled),
        size: 1,
        ids
      });
    return { manager, block, fillet, chamfer, bevelled };
  }

  const featureNode = (document: ProjectDocument, featureId: FeatureId) =>
    listFeaturesInOrder(document).find(
      (feature) => feature.featureId === featureId
    )!;

  describe('creating a feature', () => {
    it('refuses a feature on a body an earlier step already replaced', async () => {
      const { manager, block, chamfer } = await filleted();
      const before = manager.document;
      const refusal =
        '“Chamfer 1” would build on an earlier state of “Block” that “Fillet 1” already replaced, which branches the history. Use the body as it is now, or roll History back to before “Fillet 1” to add the step there.';
      expect(() => manager.execute(chamfer(block.bodyId))).toThrow(refusal);
      // The assistant and every multi-step gesture commit through here.
      expect(() =>
        manager.runTransaction('Preflight AI patch', [chamfer(block.bodyId)])
      ).toThrow(refusal);
      expect(manager.document).toBe(before);
    });

    it('accepts the same feature on the chain tip', async () => {
      const { manager, fillet, bevelled } = await filleted();
      const tip = await synced(manager.document);
      // The same straight edge, picked again on the filleted body.
      const edge = tip.derived.bodyRepresentations[
        fillet.bodyId
      ]!.topology!.edges.find((candidate) => candidate.hash === bevelled.hash)!;
      manager.execute(
        commandFactories.chamferEdges({
          name: 'Chamfer 1',
          targetBodyId: fillet.bodyId,
          ...edgeInput(edge),
          size: 1
        })
      );
      const { derived } = await synced(manager.document);
      expect(derived.warnings).toEqual([]);
    });

    it('refuses retargeting an existing feature onto a replaced body', async () => {
      const { manager, block, fillet, chamfer } = await filleted();
      const ids = createBodyFeatureIds();
      manager.execute(chamfer(fillet.bodyId, ids));
      expect(() =>
        manager.execute(
          commandFactories.updateFeature({
            featureId: ids.featureId,
            data: { targetBodyId: block.bodyId }
          })
        )
      ).toThrow(/already replaced, which branches the history/);
    });

    it('accepts a feature added while rolled back, at the marker before the paused step', async () => {
      const { manager, block, fillet, chamfer } = await filleted();
      manager.execute(
        commandFactories.setNodeMetadata({
          nodeId: featureNode(manager.document, fillet.featureId).id,
          metadata: { [FEATURE_ROLLBACK_SUPPRESSED_METADATA_KEY]: true }
        })
      );
      // Rolled back to the block, the block is the chain tip.
      const rolledBack = await synced(manager.document);
      expect(live(rolledBack.derived)).toEqual([block.bodyId]);
      const ids = createBodyFeatureIds();
      manager.execute(chamfer(block.bodyId, ids));
      expect(
        listFeaturesInOrder(manager.document).map((feature) => feature.name)
      ).toEqual(['Block', 'Chamfer 1', 'Fillet 1']);
      const { derived } = await synced(manager.document);
      expect(derived.warnings.filter((w) => !/Suppressed/.test(w))).toEqual([]);
      expect(live(derived)).toEqual([ids.bodyId]);
    });
  });

  describe('a stored forked history', () => {
    /** The log a client predating the guard could write. */
    async function forkedLog() {
      const { manager, block, fillet, chamfer } = await filleted();
      const ids = createBodyFeatureIds();
      const branch: AnyCommand = chamfer(block.bodyId, ids);
      const log = [...manager.document.commandLog, branch.serialize()];
      return { log, block, fillet, chamfer: ids };
    }

    it('replays, builds both branches as before, and reports the later one', async () => {
      const { log, block, fillet, chamfer } = await forkedLog();
      const replayed = replayCommands(blank(), log);
      expect(
        listFeaturesInOrder(replayed).map((feature) => feature.name)
      ).toEqual(['Block', 'Fillet 1', 'Chamfer 1']);
      const { derived } = await synced(replayed);

      // Geometry is untouched: the block is consumed, and both branches —
      // each a block with one edge treated — are on screen.
      expect(live(derived)).toEqual([fillet.bodyId, chamfer.bodyId].sort());
      expect(derived.bodyRepresentations[block.bodyId]!.consumed).toBe(true);
      const blockVolume = 20 * 20 * 20;
      expect(derived.bodyRepresentations[fillet.bodyId]!.volume).toBeCloseTo(
        blockVolume - (4 - Math.PI) * 20,
        3
      );
      expect(derived.bodyRepresentations[chamfer.bodyId]!.volume).toBeCloseTo(
        blockVolume - 0.5 * 20,
        3
      );

      const message =
        'Feature "Chamfer 1": Builds on an earlier state of “Block” that “Fillet 1” already replaced; this branches the history.';
      expect(derived.warnings).toEqual([message]);
      expect(forkWarnings(derived)).toEqual([
        {
          featureId: chamfer.featureId,
          featureName: 'Chamfer 1',
          message,
          kind: 'history-fork'
        }
      ]);
    });

    it('keeps accepting edits that do not add a fork, and the report never blocks a commit', async () => {
      const { log, fillet } = await forkedLog();
      const manager = new CommandManager(replayCommands(blank(), log));
      const base = await synced(manager.document);
      manager.execute(
        commandFactories.updateFeature({
          featureId: fillet.featureId,
          data: { radius: 3 }
        })
      );
      const edited = await synced(manager.document);
      expect(forkWarnings(edited.derived)).toHaveLength(1);
      expect(newExactWarnings(base.document, edited.derived)).toEqual([]);
    });

    it('reports the fork once from a cached prefix, as from a full rebuild', async () => {
      const { log } = await forkedLog();
      const replayed = replayCommands(blank(), log);
      const first = await synced(replayed);
      // Same adapter: a step added after the fork restores the cached
      // prefix, fork included, and builds only the new step.
      const extended = addPrimitiveFeature(first.document, {
        name: 'Later',
        primitiveKind: 'box',
        dimensions: { width: 1, height: 1, depth: 1 }
      });
      const again = await synced(extended);
      expect(again.derived.warnings).toEqual(first.derived.warnings);
      expect(forkWarnings(again.derived)).toEqual(forkWarnings(first.derived));
      const unchanged = await synced(again.document);
      expect(unchanged.derived.warnings).toEqual(first.derived.warnings);
    });
  });

  it('does not report a chain through a failed step, whose result is the tip', async () => {
    const { manager, block, fillet, chamfer } = await filleted();
    // The 60 mm radius cannot fit the 20 mm block: Fillet 1 fails and passes
    // the block through under its result id (ADR-017, November 2026).
    manager.document = updateFeature(manager.document, {
      featureId: fillet.featureId,
      data: { radius: 60 }
    });
    const failed = await synced(manager.document);
    // The only live body — what every body picker offers — is the tip.
    expect(live(failed.derived)).toEqual([fillet.bodyId]);
    expect(failed.derived.bodyRepresentations[block.bodyId]!.consumed).toBe(
      true
    );
    const ids = createBodyFeatureIds();
    manager.execute(chamfer(fillet.bodyId, ids));
    const { derived } = await synced(manager.document);
    expect(forkWarnings(derived)).toEqual([]);
    expect(
      (derived.featureWarnings ?? []).map((entry) => [
        entry.featureName,
        entry.kind
      ])
    ).toEqual([['Fillet 1', 'build-failed']]);
    expect(live(derived)).toEqual([ids.bodyId]);
  });
});
