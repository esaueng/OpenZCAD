import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createProjectDocument } from '@openzcad/document-core';
import { toUserId, type ProjectDocument } from '@openzcad/shared';
import {
  clearUnresolvedConflict,
  conflictFromDocuments,
  readUnresolvedConflict,
  rememberUnresolvedConflict,
  resolveCollaborationConflict,
  type ConflictResolutionHandlers
} from './conflictRecovery';

const owner = toUserId('user_conflict_owner');

function version(document: ProjectDocument, value: number): ProjectDocument {
  return { ...structuredClone(document), version: value };
}

function handlers(): ConflictResolutionHandlers {
  return {
    writeRecoveryCopy: vi.fn(async () => undefined),
    useRoomVersion: vi.fn(async () => undefined),
    keepMyVersion: vi.fn(async () => undefined),
    saveLocalAsCopy: vi.fn(async () => undefined)
  };
}

beforeEach(() => localStorage.clear());

describe('collaboration conflict recovery', () => {
  it('retains a small unresolved marker across dialog close/reload boundaries', () => {
    const marker = {
      projectId: 'project_reload',
      localVersion: 7,
      roomVersion: 8,
      detectedAt: 1234
    };
    rememberUnresolvedConflict(marker);

    expect(readUnresolvedConflict(marker.projectId)).toEqual(marker);
    clearUnresolvedConflict(marker.projectId);
    expect(readUnresolvedConflict(marker.projectId)).toBeNull();
  });

  it.each(['use-room', 'keep-mine', 'save-local-copy'] as const)(
    'writes a recovery copy before %s mutates either document',
    async (resolution) => {
      const base = createProjectDocument('Conflict', owner);
      const conflict = conflictFromDocuments(
        version(base, 4),
        version(base, 5)
      );
      const calls: string[] = [];
      const recoveryHandlers: ConflictResolutionHandlers = {
        writeRecoveryCopy: vi.fn(async () => {
          calls.push('recovery');
        }),
        useRoomVersion: vi.fn(async () => {
          calls.push('room');
        }),
        keepMyVersion: vi.fn(async () => {
          calls.push('mine');
        }),
        saveLocalAsCopy: vi.fn(async () => {
          calls.push('copy');
        })
      };

      await resolveCollaborationConflict(
        conflict,
        resolution,
        {
          role: 'owner',
          lease: {
            projectId: base.projectId,
            leaseId: 'lease_active',
            clientId: 'client',
            userId: owner,
            expiresAt: 20_000
          },
          now: 10_000
        },
        recoveryHandlers
      );

      expect(calls[0]).toBe('recovery');
      expect(calls.slice(1)).toEqual(
        resolution === 'use-room'
          ? ['room']
          : resolution === 'keep-mine'
            ? ['mine']
            : ['copy', 'room']
      );
    }
  );

  it('requires the exact room version and an active lease before keep mine', async () => {
    const base = createProjectDocument('Conflict', owner);
    const conflict = conflictFromDocuments(version(base, 2), version(base, 3));
    const recoveryHandlers = handlers();

    await expect(
      resolveCollaborationConflict(
        { ...conflict, expectedRoomVersion: 2 },
        'keep-mine',
        { role: 'owner', lease: null },
        recoveryHandlers
      )
    ).rejects.toMatchObject({ code: 'ROOM_VERSION_MISMATCH' });
    await expect(
      resolveCollaborationConflict(
        conflict,
        'keep-mine',
        { role: 'viewer', lease: null },
        recoveryHandlers
      )
    ).rejects.toMatchObject({ code: 'VIEWER_FORBIDDEN' });
    await expect(
      resolveCollaborationConflict(
        conflict,
        'keep-mine',
        {
          role: 'editor',
          lease: {
            projectId: base.projectId,
            leaseId: 'expired',
            clientId: 'client',
            userId: owner,
            expiresAt: 10
          },
          now: 10
        },
        recoveryHandlers
      )
    ).rejects.toMatchObject({ code: 'LEASE_REQUIRED' });
    expect(recoveryHandlers.writeRecoveryCopy).not.toHaveBeenCalled();
  });
});
