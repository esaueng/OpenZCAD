import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  addPrimitiveFeature,
  appendRevision,
  createCheckpoint,
  createProjectDocument
} from '@openzcad/document-core';
import { CommandManager, commandFactories } from '@openzcad/command-system';
import { toUserId } from '@openzcad/shared';
import {
  loadLocalProject,
  loadLocalSaveState,
  listLocalSaveStateCheckpoints,
  saveLocalSaveStates,
  saveLocalProject
} from './localProjectStore';
import { prepareSaveStateRestore } from './saveStateRestore';

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
    const snapshot = await loadLocalSaveState(
      created.projectId,
      firstSave.checkpoints.at(-1)!.checkpointId
    );
    const restored = await prepareSaveStateRestore(
      manager.document,
      snapshot!,
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
      restored.checkpoints.at(-2)!.checkpointId
    );
    expect(wayBack?.featureOrder).toHaveLength(1);
    expect(wayBack?.checkpoints.at(-1)?.reason).toBe('Before restore');
  });

  it('restores a private member point without publishing local history and keeps both ways back after reload', async () => {
    const owner = toUserId('restore_owner');
    const editor = toUserId('restore_editor');
    const created = createCheckpoint(
      createProjectDocument('Shared', owner),
      'Initial save'
    );
    const manager = new CommandManager(created, editor);
    manager.execute(
      commandFactories.addPrimitive({
        name: 'Box',
        primitiveKind: 'box',
        dimensions: { width: 1, depth: 2, height: 3 }
      })
    );
    const privatePoint = createCheckpoint(
      appendRevision(manager.document, 'Device only'),
      'Device only'
    );
    await saveLocalSaveStates([privatePoint]);
    manager.execute(
      commandFactories.addPrimitive({
        name: 'Later box',
        primitiveKind: 'box',
        dimensions: { width: 2, depth: 3, height: 4 }
      })
    );
    const before = manager.document;
    await saveLocalProject(before);
    const next = await prepareSaveStateRestore(
      before,
      privatePoint,
      'Restored device point',
      true,
      editor
    );
    // Writing the private way back must never replace the live project head.
    expect(await loadLocalProject(created.projectId)).toEqual(before);
    manager.applyDocumentEdit(next, 'Restored device point');
    expect(manager.document.bodyOrder).toHaveLength(1);
    expect(manager.document.checkpoints).toEqual(before.checkpoints);
    expect(manager.document.revisions).toEqual(before.revisions);
    await saveLocalProject(manager.document);
    const points = await listLocalSaveStateCheckpoints(created.projectId);
    const guard = points.find((point) => point.reason === 'Before restore')!;
    const restored = points.find(
      (point) => point.reason === 'Restored device point'
    )!;
    expect(guard).toBeDefined();
    expect(restored).toBeDefined();
    const wayBack = await loadLocalSaveState(
      created.projectId,
      guard.checkpointId
    );
    expect(wayBack?.bodyOrder).toHaveLength(2);
    const restorePoint = await loadLocalSaveState(
      created.projectId,
      restored.checkpointId
    );
    const privateManager = new CommandManager(restorePoint!, editor);
    privateManager.undo();
    expect(privateManager.document.bodyOrder).toHaveLength(2);
    const reloaded = new CommandManager(
      (await loadLocalProject(created.projectId))!,
      editor
    );
    reloaded.undo();
    expect(reloaded.document.bodyOrder).toHaveLength(2);
    reloaded.redo();
    expect(reloaded.document.bodyOrder).toHaveLength(1);
    expect(reloaded.document.checkpoints).toEqual(before.checkpoints);
    expect(reloaded.document.revisions).toEqual([
      ...before.revisions,
      expect.objectContaining({ reason: 'Undo Restored device point' }),
      expect.objectContaining({ reason: 'Redo Restored device point' })
    ]);
  });
});
