import { describe, expect, it, vi } from 'vitest';
import { CommandManager } from '@openzcad/command-system';
import {
  addPrimitiveFeature,
  createProjectDocument,
  listFeaturesInOrder
} from '@openzcad/document-core';
import { toUserId, type ProjectDocument } from '@openzcad/shared';
import {
  deleteDetail,
  deleteFace,
  deleteFaces,
  deleteFeatures,
  type DeletionHost
} from './featureDeletionRun';

function twoBoxes(): ProjectDocument {
  let document = createProjectDocument('Run', toUserId('user_run'));
  for (const name of ['Box A', 'Box B']) {
    document = addPrimitiveFeature(document, {
      name,
      primitiveKind: 'box',
      dimensions: { width: 10, height: 10, depth: 10 }
    });
  }
  return document;
}

function host(manager: CommandManager, base: ProjectDocument, current = true) {
  return {
    manager,
    base,
    isCurrent: () => current,
    runTransaction: vi.fn(),
    executeTransaction: vi.fn((_label: string, commands: unknown[]) => {
      manager.runTransaction('Delete', commands as never);
      return true;
    }),
    setStatus: vi.fn<(message: string) => void>(),
    announce: vi.fn(),
    healed: vi.fn(),
    offerDetailCascade: vi.fn()
  } satisfies DeletionHost;
}

describe('delete gestures after the deletion module loads', () => {
  it('refuses every gesture once its document has moved, saying which pick to redo', () => {
    const document = twoBoxes();
    const manager = new CommandManager(document);
    const feature = listFeaturesInOrder(document)[0]!;
    const face = {
      bodyId: document.bodyOrder[0]!,
      kind: 'face' as const,
      hash: 1
    };
    const replaced = host(manager, document, false);
    deleteFace(replaced, face, 'orphan');
    deleteFaces(replaced, [face, { ...face, hash: 2 }]);
    deleteDetail(replaced, feature, feature.name, 0, vi.fn());
    deleteFeatures(
      replaced,
      [feature.featureId],
      'Deleted',
      undefined,
      vi.fn()
    );
    expect(replaced.setStatus.mock.calls.map(([message]) => message)).toEqual([
      'The model changed. Select the face again before deleting it.',
      'The model changed. Select the faces again before deleting them.',
      'The model changed. Select the feature again before deleting it.',
      'The model changed. Select the features again before deleting them.'
    ]);

    const moved = host(manager, { ...document, version: document.version - 1 });
    deleteFeatures(moved, [feature.featureId], 'Deleted', undefined, vi.fn());
    expect(moved.setStatus).toHaveBeenCalledOnce();
    for (const run of [replaced, moved]) {
      expect(run.runTransaction).not.toHaveBeenCalled();
      expect(run.executeTransaction).not.toHaveBeenCalled();
    }
  });

  it('deletes steps with no detail among them as one plain transaction', () => {
    const document = twoBoxes();
    const manager = new CommandManager(document);
    const [first, second] = listFeaturesInOrder(document);
    const finish = vi.fn();
    const run = host(manager, document);
    deleteFeatures(
      run,
      [first!.featureId, second!.featureId],
      'Deleted 2 features',
      undefined,
      finish
    );
    expect(run.runTransaction).not.toHaveBeenCalled();
    expect(run.executeTransaction).toHaveBeenCalledOnce();
    expect(finish).toHaveBeenCalledOnce();
    expect(listFeaturesInOrder(manager.document)).toHaveLength(0);
  });
});
