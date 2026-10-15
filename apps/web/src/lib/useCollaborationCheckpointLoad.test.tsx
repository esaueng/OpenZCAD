import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createProjectDocument } from '@openzcad/document-core';
import { toUserId } from '@openzcad/shared';
import {
  loadLocalProject,
  loadLocalSaveState,
  saveLocalProject
} from './localProjectStore';
import * as localStore from './localProjectStore';
import { setup, box, rejectedSave } from './collaborationCheckpointTestHarness';
import {
  CheckpointSaveError,
  preserveFailedCheckpoint
} from './collaborationCheckpointFallback';
import { STALE_CHUNK_MESSAGE } from './staleChunk';

// Leave the rejected module mocked for this file's entire lifetime. A held
// module that later succeeds belongs in its own isolated test environment.
const { chunkError, failCheckpointLoad } = vi.hoisted(() => {
  const chunkError = new Error('Checkpoint action chunk unavailable.');
  return {
    chunkError,
    failCheckpointLoad: vi.fn(() => {
      throw chunkError;
    })
  };
});
vi.mock('./collaborationCheckpoint', () => failCheckpointLoad());
beforeEach(() => {
  failCheckpointLoad.mockClear();
});

function originalCause(error: Error): unknown {
  let cause: unknown = error;
  while (cause instanceof Error && cause.cause !== undefined) {
    cause = cause.cause;
  }
  return cause;
}

describe('named saves when the checkpoint action cannot load', () => {
  it('keeps the device durability confirmation with native chunk-load guidance', async () => {
    const clicked = createProjectDocument(
      'Missing native module',
      toUserId('owner')
    );
    const hook = setup(clicked);
    const primary = new TypeError(
      'Failed to fetch dynamically imported module: https://app.test/assets/checkpoint-old.js'
    );
    const error = await rejectedSave(
      preserveFailedCheckpoint(
        primary,
        clicked,
        'Offline milestone',
        hook.options,
        () => true
      )
    );
    expect(error.cause).toBe(primary);
    expect(error.message).toBe(
      `${STALE_CHUNK_MESSAGE} The named save is stored on this device.`
    );
    const checkpoint = (
      await localStore.listLocalSaveStateCheckpoints(clicked.projectId)
    ).find((point) => point.reason === 'Offline milestone')!;
    expect(hook.read()).toBe(clicked);
    expect(hook.apply).not.toHaveBeenCalled();
    expect(
      await loadLocalSaveState(clicked.projectId, checkpoint.checkpointId)
    ).not.toBeNull();
    expect(fetch).not.toHaveBeenCalled();
    hook.unmount();
  });

  it('durably names the clicked snapshot while retaining buffered edits and the newer stored project head', async () => {
    const clicked = box(
      createProjectDocument('Offline named save', toUserId('owner')),
      'Clicked box'
    );
    const later = box(clicked, 'Buffered box');
    await saveLocalProject(later);
    const hook = setup(clicked);
    const saving = hook.result.current.saveCheckpoint(
      clicked,
      '  Offline milestone  ',
      hook.options
    );
    hook.edit(later);
    const error = await rejectedSave(saving);
    expect(failCheckpointLoad).toHaveBeenCalledOnce();
    // Vitest may wrap a rejected module factory. Its original cause must
    // survive regardless of that framework-owned wrapper's presence.
    expect(originalCause(error)).toBe(chunkError);
    expect(error.message).toContain((error.cause as Error).message);
    expect(error.message).toContain('The named save is stored on this device.');
    const local = (
      await localStore.listLocalSaveStateCheckpoints(clicked.projectId)
    ).find((point) => point.reason === 'Offline milestone')!;
    expect(hook.apply).not.toHaveBeenCalled();
    expect(local.reason).toBe('Offline milestone');
    expect(local.documentVersion).toBe(clicked.version);
    const stored = await loadLocalSaveState(
      clicked.projectId,
      local.checkpointId
    );
    expect(stored?.nodes).toEqual(clicked.nodes);
    expect(stored?.revisions.at(-1)?.revisionId).toBe(local.revisionId);
    expect(hook.read().nodes).toEqual(later.nodes);
    expect((await loadLocalProject(clicked.projectId))?.nodes).toEqual(
      later.nodes
    );
    expect(hook.result.current.roomVersion).toBe(clicked.version);
    expect(fetch).not.toHaveBeenCalled();
    expect(
      hook.socket.sent.filter((frame) => frame.type === 'document').at(-1)
        ?.document?.nodes
    ).toEqual(later.nodes);
    hook.unmount();
  });

  it.each(['navigation', 'account', 'disabled', 'project'] as const)(
    'stores the captured name without applying it after %s changes',
    async (departure) => {
      const clicked = box(
        createProjectDocument('Departing named save', toUserId('owner')),
        'Clicked box'
      );
      const hook = setup(clicked);
      const saving = hook.result.current.saveCheckpoint(
        clicked,
        'Departed milestone',
        hook.options
      );
      hook.depart(departure);
      const next = hook.read();
      const error = await rejectedSave(saving);
      expect(failCheckpointLoad).toHaveBeenCalledOnce();
      expect(error.message).toContain(
        'The named save is stored on this device.'
      );
      expect(hook.apply).not.toHaveBeenCalled();
      expect(hook.read()).toBe(next);
      const ids = await localStore.listLocalSaveStateIds(clicked.projectId);
      const saveStates = await Promise.all(
        Array.from(ids, (id) => loadLocalSaveState(clicked.projectId, id))
      );
      const local = saveStates.find(
        (state) => state?.checkpoints.at(-1)?.reason === 'Departed milestone'
      );
      expect(local?.nodes).toEqual(clicked.nodes);
      expect(fetch).not.toHaveBeenCalled();
      hook.unmount();
    }
  );

  it('preserves the module-load error when device storage also fails', async () => {
    const clicked = createProjectDocument('Full device', toUserId('owner'));
    const storage = vi
      .spyOn(localStore, 'saveLocalSaveStates')
      .mockRejectedValue(new Error('Device quota exceeded.'));
    const hook = setup(clicked);
    const error = await rejectedSave(
      hook.result.current.saveCheckpoint(clicked, 'Not stored', hook.options)
    );
    expect(failCheckpointLoad).toHaveBeenCalledOnce();
    expect(originalCause(error)).toBe(chunkError);
    expect(error.message).toContain((error.cause as Error).message);
    expect(error.message).toContain(
      'The named save could not be stored on this device.'
    );
    expect(error).toBeInstanceOf(CheckpointSaveError);
    expect(error).toMatchObject({ roomStored: false, deviceStored: false });
    expect(error.message).not.toContain('Device quota exceeded.');
    expect(storage).toHaveBeenCalledOnce();
    expect(hook.apply).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    hook.unmount();
  });
});
