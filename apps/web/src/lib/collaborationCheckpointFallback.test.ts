import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  addPrimitiveFeature,
  createProjectDocument,
  createSavedRevision
} from '@openzcad/document-core';
import { toProjectId, toUserId } from '@openzcad/shared';
import { LocalProjectAutosave } from './localProjectAutosave';
import * as localStore from './localProjectStore';
import * as fallback from './collaborationCheckpointFallback';

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory();
});
afterEach(() => vi.restoreAllMocks());

describe('named-save failure durability', () => {
  it.each([
    [false, false],
    [false, true],
    [true, false],
    [true, true]
  ])(
    'reports room storage %s and device storage %s without replacing the primary failure',
    async (roomStored, deviceStored) => {
      const clicked = createProjectDocument('Clicked', toUserId('owner'));
      const authoritative = roomStored
        ? createSavedRevision(clicked, 'Named state')
        : null;
      const primary = new Error('The HTTP acknowledgement was lost.');
      if (!deviceStored)
        vi.spyOn(localStore, 'saveLocalSaveStates').mockRejectedValue(
          new Error('Device quota exceeded.')
        );
      const applyDocument = vi.fn();
      const error = await fallback
        .preserveFailedCheckpoint(
          primary,
          clicked,
          'Named state',
          {
            isCurrent: () => false,
            readDocument: () => clicked,
            applyDocument
          },
          () => false,
          authoritative,
          false
        )
        .catch((error: unknown) => error);
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).cause).toBe(primary);
      expect(error).toHaveProperty('roomStored', roomStored);
      expect(error).toHaveProperty('deviceStored', deviceStored);
      expect((error as Error).message).toContain(primary.message);
      expect((error as Error).message).toContain(
        deviceStored
          ? 'The named save is stored on this device.'
          : 'The named save could not be stored on this device.'
      );
      expect((error as Error).message.includes('stored in the room')).toBe(
        roomStored
      );
      expect(applyDocument).not.toHaveBeenCalled();
    }
  );
});

describe('named-save failure badge', () => {
  const primary = new Error('The room did not reply.');
  const room = createSavedRevision(
    createProjectDocument('Room document', toUserId('owner')),
    'Named state'
  );

  it('distinguishes a room-only revision from an unconfirmed unstored name', () => {
    expect(
      fallback.failedCheckpointSaveState(
        new fallback.CheckpointSaveError(primary, room, false),
        'saving',
        false
      )
    ).toBe('room-only');
    expect(
      fallback.failedCheckpointSaveState(
        new fallback.CheckpointSaveError(primary, null, false),
        'saving',
        false
      )
    ).toBe('checkpoint-failed');
  });

  it.each([false, true])(
    'keeps device-only feedback when the captured name is stored (room %s)',
    (roomStored) => {
      expect(
        fallback.failedCheckpointSaveState(
          new fallback.CheckpointSaveError(
            primary,
            roomStored ? room : null,
            true
          ),
          'saving',
          false
        )
      ).toBe('local');
    }
  );

  it.each([false, true])(
    'does not release current head durability evidence for a named snapshot (device %s)',
    (deviceStored) => {
      const error = new fallback.CheckpointSaveError(
        primary,
        room,
        deviceStored
      );
      expect(fallback.failedCheckpointSaveState(error, 'saving', true)).toBe(
        'saving'
      );
      expect(
        fallback.failedCheckpointSaveState(error, 'device-failed', true)
      ).toBe('device-failed');
      expect(
        fallback.failedCheckpointSaveState(error, 'device-failed', false)
      ).toBe('device-failed');
    }
  );

  it('never infers device or room storage from an untyped error message', () => {
    expect(
      fallback.failedCheckpointSaveState(
        new Error('The named save is stored on this device.'),
        'saving',
        false
      )
    ).toBe('checkpoint-failed');
  });
});

describe('room proof and current device-head failure', () => {
  const room = createSavedRevision(
    createProjectDocument('Room document', toUserId('owner')),
    'Named state'
  );
  const error = new fallback.CheckpointSaveError(
    new Error('Device quota exceeded.'),
    room,
    false
  );

  it('presents exact room coverage without clearing the failed autosave queue', async () => {
    const autosave = new LocalProjectAutosave({
      write: () => Promise.reject(new Error('Device quota exceeded.')),
      onSaved: vi.fn(),
      onError: vi.fn(),
      onDirtyChange: vi.fn()
    });
    autosave.enqueue(room);
    await expect(autosave.flush()).rejects.toThrow('Local autosave failed.');
    expect(autosave.dirty).toBe(true);
    expect(
      fallback.failedCheckpointSaveState(
        error,
        'device-failed',
        autosave.dirty,
        {
          ...room,
          derived: { ...room.derived, warnings: ['New derived warning'] }
        }
      )
    ).toBe('room-only');
    expect(autosave.dirty).toBe(true);
  });

  it.each(['version', 'graph', 'name', 'owner', 'project'] as const)(
    'keeps tab-only head feedback when %s differs from the authoritative snapshot',
    (difference) => {
      let live = structuredClone(room);
      if (difference === 'version') live.version += 1;
      if (difference === 'graph')
        live = {
          ...addPrimitiveFeature(live, {
            name: 'Buffered box',
            primitiveKind: 'box',
            dimensions: { width: 10, depth: 10, height: 10 }
          }),
          version: room.version
        };
      if (difference === 'name')
        live = createSavedRevision(live, 'New local note');
      if (difference === 'owner') live.ownerUserId = toUserId('other-owner');
      if (difference === 'project')
        live.projectId = toProjectId('other-project');
      expect(
        fallback.failedCheckpointSaveState(error, 'device-failed', true, live)
      ).toBe('device-failed');
    }
  );

  it('uses both room and device proof only for the exact clean current head', () => {
    const stored = new fallback.CheckpointSaveError(error, room, true);
    expect(
      fallback.failedCheckpointSaveState(stored, 'saving', false, room)
    ).toBe('synced');
    expect(
      fallback.failedCheckpointSaveState(stored, 'saving', true, room)
    ).toBe('saving');
    expect(
      fallback.failedCheckpointSaveState(stored, 'device-failed', true, room)
    ).toBe('room-only');
    expect(
      fallback.failedCheckpointSaveState(stored, 'saving', false, {
        ...room,
        version: room.version + 1
      })
    ).toBe('local');
  });
});
