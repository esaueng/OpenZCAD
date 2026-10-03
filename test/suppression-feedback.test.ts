import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CommandManager, commandFactories } from '@openzcad/command-system';
import {
  createBodyFeatureIds,
  createProjectDocument,
  listFeaturesInOrder
} from '@openzcad/document-core';
import {
  createExactKernelAdapter,
  type ExactKernelAdapter
} from '@openzcad/kernel-adapter/exact';
import {
  FEATURE_SUPPRESSED_METADATA_KEY,
  isFeatureSuppressed,
  toUserId
} from '@openzcad/shared';
import { featuresNeedingRepair } from '../apps/web/src/lib/featureRepair';
import {
  settleSuppressionNotice,
  suppressionRepairSnapshot,
  type SuppressionNotice
} from '../apps/web/src/lib/suppressionFeedback';

function twoIndependentChains() {
  const manager = new CommandManager(
    createProjectDocument('Suppression feedback', toUserId('user_feedback'))
  );
  for (const name of ['First', 'Second']) {
    const ids = createBodyFeatureIds();
    manager.runTransaction(name, [
      commandFactories.addPrimitive({
        name,
        primitiveKind: 'box',
        dimensions: { width: 10, depth: 10, height: 10 },
        ids
      }),
      commandFactories.mirrorBody({
        name: `${name} mirror`,
        targetBodyId: ids.bodyId,
        plane: { origin: { x: -5, y: 0, z: 0 }, normal: { x: 1, y: 0, z: 0 } }
      })
    ]);
  }
  return manager;
}

function toggle(
  manager: CommandManager,
  name: string,
  geometryReady: boolean
): SuppressionNotice {
  const feature = listFeaturesInOrder(manager.document).find(
    (feature) => feature.name === name
  )!;
  const resume = isFeatureSuppressed(feature);
  const before = suppressionRepairSnapshot(manager, geometryReady);
  manager.execute(
    commandFactories.setNodeMetadata({
      nodeId: feature.id,
      metadata: { [FEATURE_SUPPRESSED_METADATA_KEY]: resume ? null : true }
    })
  );
  return {
    manager,
    projectId: manager.document.projectId,
    version: manager.document.version,
    featureId: feature.featureId,
    name,
    resume,
    before
  };
}

describe('suppression feedback snapshot ownership', () => {
  let adapter: ExactKernelAdapter;
  beforeAll(async () => {
    adapter = await createExactKernelAdapter();
  }, 120_000);
  afterAll(() => adapter.dispose());

  it('does not blame the second toggle for two cascades when the first rebuild is dropped', async () => {
    const manager = twoIndependentChains();
    manager.commitDerivedState(await adapter.syncDocument(manager.document));
    const initialGeometry = manager.document.derived.bodyRepresentations;
    const first = toggle(manager, 'First', true);
    // The worker will publish only the newest version. The second click sees
    // geometry from before BOTH toggles, not a settled answer for the first.
    const second = toggle(manager, 'Second', false);
    expect(manager.document.derived.bodyRepresentations).toBe(initialGeometry);
    const latest = await adapter.syncDocument(manager.document);
    expect(
      featuresNeedingRepair(
        listFeaturesInOrder(manager.document),
        latest.bodyRepresentations
      ).size
    ).toBe(2);
    // The old unqualified baseline would claim both failures for Second.
    expect(
      settleSuppressionNotice(
        { ...second, before: first.before },
        manager,
        latest
      )
    ).toEqual({
      state: 'ready',
      message: 'Suppressed Second · 2 later features now need repair'
    });
    expect(settleSuppressionNotice(first, manager, latest)).toEqual({
      state: 'discarded'
    });
    expect(settleSuppressionNotice(second, manager, latest)).toEqual({
      state: 'ready',
      message: 'Suppressed Second'
    });
  });

  it('counts only the second cascade after the first version really settled', async () => {
    const manager = twoIndependentChains();
    manager.commitDerivedState(await adapter.syncDocument(manager.document));
    const first = toggle(manager, 'First', true);
    const firstResult = await adapter.syncDocument(manager.document);
    expect(settleSuppressionNotice(first, manager, firstResult)).toEqual({
      state: 'ready',
      message: 'Suppressed First · 1 later feature now needs repair'
    });
    manager.commitDerivedState(firstResult);
    const second = toggle(manager, 'Second', true);
    expect(second.before?.size).toBe(1);
    const secondResult = await adapter.syncDocument(manager.document);
    expect(settleSuppressionNotice(second, manager, secondResult)).toEqual({
      state: 'ready',
      message: 'Suppressed Second · 1 later feature now needs repair'
    });
  });

  it('reports failed rebuilding and unqualified resuming without a guessed count', async () => {
    const manager = twoIndependentChains();
    manager.commitDerivedState(await adapter.syncDocument(manager.document));
    const paused = toggle(manager, 'First', true);
    expect(settleSuppressionNotice(paused, manager, null)).toEqual({
      state: 'ready',
      message: 'Suppressed First'
    });
    const resumed = toggle(manager, 'First', false);
    expect(settleSuppressionNotice(resumed, manager, null)).toEqual({
      state: 'ready',
      message: 'Resumed First'
    });
  });

  it('discards a remote manager replacement even at the same project and version', () => {
    const manager = twoIndependentChains();
    const notice = toggle(manager, 'First', false);
    const remote = new CommandManager(manager.document);
    expect(settleSuppressionNotice(notice, remote, null)).toEqual({
      state: 'discarded'
    });
  });

  it('discards feedback after Undo advances the same project', () => {
    const manager = twoIndependentChains();
    const notice = toggle(manager, 'First', false);
    manager.undo();
    expect(manager.document.version).toBeGreaterThan(notice.version);
    expect(settleSuppressionNotice(notice, manager, null)).toEqual({
      state: 'discarded'
    });
  });

  it('discards a different project on the same manager', () => {
    const manager = twoIndependentChains();
    const notice = toggle(manager, 'First', false);
    manager.document = createProjectDocument(
      'Replacement',
      toUserId('user_feedback')
    );
    expect(settleSuppressionNotice(notice, manager, null)).toEqual({
      state: 'discarded'
    });
  });

  it('keeps a notice pending until its target version', () => {
    const manager = twoIndependentChains();
    const notice = toggle(manager, 'First', false);
    expect(
      settleSuppressionNotice(
        { ...notice, version: notice.version + 1 },
        manager,
        null
      )
    ).toEqual({
      state: 'pending'
    });
  });
});
