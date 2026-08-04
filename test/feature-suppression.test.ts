import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CommandManager,
  commandFactories,
  replayCommands
} from '@openzcad/command-system';
import {
  createProjectDocument,
  listFeaturesInOrder
} from '@openzcad/document-core';
import { createCadDocumentDigest } from '@openzcad/ai-contracts';
import {
  FEATURE_ROLLBACK_SUPPRESSED_METADATA_KEY,
  FEATURE_SUPPRESSED_METADATA_KEY,
  isFeatureManuallySuppressed,
  isFeatureRollbackSuppressed,
  isFeatureSuppressed,
  toUserId
} from '@openzcad/shared';
import {
  createExactKernelAdapter,
  type ExactKernelAdapter
} from '@openzcad/kernel-adapter/exact';

function addBox(manager: CommandManager, name: string) {
  manager.execute(
    commandFactories.addPrimitive({
      name,
      primitiveKind: 'box',
      dimensions: { width: 10, height: 10, depth: 10 }
    })
  );
}

describe('feature suppression', { timeout: 30_000 }, () => {
  let kernel: ExactKernelAdapter;

  beforeAll(async () => {
    kernel = await createExactKernelAdapter();
  });

  afterAll(() => {
    kernel.dispose();
  });

  it('skips a suppressed feature visibly and replays undo/redo', async () => {
    const base = createProjectDocument(
      'Suppression replay',
      toUserId('user_suppression')
    );
    const manager = new CommandManager(base);
    addBox(manager, 'Paused box');
    const feature = listFeaturesInOrder(manager.document)[0]!;

    manager.execute(
      commandFactories.setNodeMetadata(
        {
          nodeId: feature.id,
          metadata: { [FEATURE_SUPPRESSED_METADATA_KEY]: true }
        },
        'Suppress Paused box'
      )
    );

    expect(isFeatureSuppressed(listFeaturesInOrder(manager.document)[0]!)).toBe(
      true
    );
    const derived = await kernel.syncDocument(manager.document);
    expect(Object.keys(derived.bodyRepresentations)).toHaveLength(0);
    expect(derived.warnings).toContain(
      'Feature "Paused box": Suppressed; skipped during exact rebuild.'
    );

    const replayed = replayCommands(base, manager.document.commandLog);
    expect(isFeatureSuppressed(listFeaturesInOrder(replayed)[0]!)).toBe(true);

    manager.execute(
      commandFactories.setNodeMetadata(
        {
          nodeId: feature.id,
          metadata: { [FEATURE_SUPPRESSED_METADATA_KEY]: null }
        },
        'Resume Paused box'
      )
    );
    expect(isFeatureSuppressed(listFeaturesInOrder(manager.document)[0]!)).toBe(
      false
    );
    expect(
      Object.keys(
        (await kernel.syncDocument(manager.document)).bodyRepresentations
      )
    ).toHaveLength(1);

    manager.undo();
    expect(isFeatureSuppressed(listFeaturesInOrder(manager.document)[0]!)).toBe(
      true
    );
    manager.redo();
    expect(isFeatureSuppressed(listFeaturesInOrder(manager.document)[0]!)).toBe(
      false
    );
  });

  it('moves a rollback marker as one undoable transaction without erasing a manual pause', () => {
    const manager = new CommandManager(
      createProjectDocument('Rollback', toUserId('user_rollback'))
    );
    addBox(manager, 'A');
    addBox(manager, 'B');
    addBox(manager, 'C');
    let features = listFeaturesInOrder(manager.document);

    manager.execute(
      commandFactories.setNodeMetadata({
        nodeId: features[1]!.id,
        metadata: { [FEATURE_SUPPRESSED_METADATA_KEY]: true }
      })
    );
    manager.runTransaction(
      'Roll back after A',
      features.slice(1).map((feature) =>
        commandFactories.setNodeMetadata({
          nodeId: feature.id,
          metadata: { [FEATURE_ROLLBACK_SUPPRESSED_METADATA_KEY]: true }
        })
      )
    );

    features = listFeaturesInOrder(manager.document);
    expect(features.map(isFeatureSuppressed)).toEqual([false, true, true]);
    expect(isFeatureManuallySuppressed(features[1]!)).toBe(true);
    expect(isFeatureRollbackSuppressed(features[1]!)).toBe(true);

    manager.undo();
    features = listFeaturesInOrder(manager.document);
    expect(features.map(isFeatureRollbackSuppressed)).toEqual([
      false,
      false,
      false
    ]);
    expect(features.map(isFeatureManuallySuppressed)).toEqual([
      false,
      true,
      false
    ]);
    expect(manager.document.revisions.at(-1)?.reason).toBe(
      'Undo Roll back after A'
    );

    manager.redo();
    features = listFeaturesInOrder(manager.document);
    expect(features.map(isFeatureRollbackSuppressed)).toEqual([
      false,
      true,
      true
    ]);
  });

  it('includes effective suppression in the AI digest', () => {
    const manager = new CommandManager(
      createProjectDocument('Digest', toUserId('user_digest_suppression'))
    );
    addBox(manager, 'Visible box');
    addBox(manager, 'Rolled-back box');
    const feature = listFeaturesInOrder(manager.document)[1]!;
    manager.execute(
      commandFactories.setNodeMetadata({
        nodeId: feature.id,
        metadata: { [FEATURE_ROLLBACK_SUPPRESSED_METADATA_KEY]: true }
      })
    );

    expect(
      createCadDocumentDigest(manager.document).features.map((candidate) => ({
        name: candidate.name,
        suppressed: candidate.suppressed
      }))
    ).toEqual([
      { name: 'Visible box', suppressed: false },
      { name: 'Rolled-back box', suppressed: true }
    ]);
  });
});
