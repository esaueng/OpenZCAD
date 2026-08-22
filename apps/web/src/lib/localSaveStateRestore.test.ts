import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  addPrimitiveFeature,
  appendRevision,
  createCheckpoint,
  createProjectDocument,
  restoreFromSaveState
} from '@openzcad/document-core';
import { CommandManager } from '@openzcad/command-system';
import { toUserId } from '@openzcad/shared';
import {
  loadLocalProject,
  loadLocalSaveState,
  saveLocalProject
} from './localProjectStore';

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory();
});

/**
 * The restore gesture end to end: document algebra, the command manager, and
 * the device store together. Each is covered on its own elsewhere; what only
 * shows up here is whether a restore is still a restore after the tab is
 * closed — and whether the way back outlives the in-memory undo stack, which
 * is the reason the pre-restore checkpoint is written at all.
 */
describe('a restore, all the way through the device store', () => {
  it('survives a reload and can be walked back from disk', async () => {
    const created = createProjectDocument('Bracket', toUserId('user-1'));
    const firstSave = createCheckpoint(created, 'First save');
    await saveLocalProject(firstSave);

    const manager = new CommandManager(firstSave);
    const boxed = createCheckpoint(
      appendRevision(
        addPrimitiveFeature(manager.document, {
          name: 'Box',
          primitiveKind: 'box',
          dimensions: { width: 10, depth: 10, height: 10 }
        }),
        'Added box'
      ),
      'Second save'
    );
    manager.document = boxed;
    await saveLocalProject(boxed);

    // The restore gesture as App performs it.
    const guarded = createCheckpoint(
      appendRevision(manager.document, 'Before restore'),
      'Before restore'
    );
    await saveLocalProject(guarded);
    const snapshot = await loadLocalSaveState(
      created.projectId,
      firstSave.checkpoints.at(-1)!.checkpointId
    );
    const restored = createCheckpoint(
      restoreFromSaveState(guarded, snapshot!, 'Restored'),
      'Restored'
    );
    manager.applyDocumentEdit(restored, 'Restored');
    await saveLocalProject(manager.document);

    // Reload: the stored document is the restored one.
    const reopened = await loadLocalProject(created.projectId);
    expect(reopened?.featureOrder).toEqual([]);

    // And the pre-restore model is still reachable from disk, which is the
    // guarantee the undo stack cannot make across a reload.
    const wayBack = await loadLocalSaveState(
      created.projectId,
      guarded.checkpoints.at(-1)!.checkpointId
    );
    expect(wayBack?.featureOrder).toHaveLength(1);
    expect(wayBack?.checkpoints.at(-1)?.reason).toBe('Before restore');
  });
});
