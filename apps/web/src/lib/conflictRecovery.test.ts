import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createProjectDocument } from '@openzcad/document-core';
import { toUserId, type ProjectDocument } from '@openzcad/shared';
import {
  clearUnresolvedConflict,
  conflictFromDocuments,
  hasUnresolvedConflict,
  readUnresolvedConflict,
  recoveryCopyName,
  rememberUnresolvedConflict,
  resolveProjectConflict,
  type ConflictResolutionHandlers
} from './conflictRecovery';

const owner = toUserId('user_conflict_owner');

function version(document: ProjectDocument, value: number): ProjectDocument {
  return { ...structuredClone(document), version: value };
}

function handlers(): ConflictResolutionHandlers {
  return {
    writeRecoveryCopy: vi.fn(async () => undefined),
    useRemoteVersion: vi.fn(async () => undefined),
    keepMyVersion: vi.fn(async () => undefined),
    saveLocalAsCopy: vi.fn(async () => undefined)
  };
}

beforeEach(() => localStorage.clear());

describe('collaboration conflict recovery', () => {
  it('retains a small unresolved marker across dialog close/reload boundaries', () => {
    const marker = {
      projectId: 'project_reload',
      source: 'room' as const,
      localVersion: 7,
      remoteVersion: 8,
      detectedAt: 1234
    };
    rememberUnresolvedConflict(marker);

    expect(readUnresolvedConflict(marker.projectId, 'room')).toEqual(marker);
    clearUnresolvedConflict(marker.projectId, 'room');
    expect(readUnresolvedConflict(marker.projectId, 'room')).toBeNull();
  });

  it('keeps room and account markers for one project apart', () => {
    const projectId = 'project_two_lines';
    rememberUnresolvedConflict({
      projectId,
      source: 'room',
      localVersion: 39,
      remoteVersion: 44,
      detectedAt: 1
    });
    rememberUnresolvedConflict({
      projectId,
      source: 'account',
      localVersion: 44,
      remoteVersion: 39,
      detectedAt: 2
    });

    expect(readUnresolvedConflict(projectId, 'room')).toMatchObject({
      localVersion: 39,
      remoteVersion: 44
    });
    expect(readUnresolvedConflict(projectId, 'account')).toMatchObject({
      localVersion: 44,
      remoteVersion: 39
    });
    expect(hasUnresolvedConflict(projectId)).toBe(true);
    clearUnresolvedConflict(projectId, 'room');
    expect(readUnresolvedConflict(projectId, 'room')).toBeNull();
    expect(readUnresolvedConflict(projectId, 'account')).not.toBeNull();
    clearUnresolvedConflict(projectId, 'account');
    expect(hasUnresolvedConflict(projectId)).toBe(false);
  });

  it('still reads and clears a marker written before markers had a source', () => {
    const projectId = 'project_legacy';
    localStorage.setItem(
      `openzcad-unresolved-project-conflict:${encodeURIComponent(projectId)}`,
      JSON.stringify({
        projectId,
        localVersion: 3,
        remoteVersion: 4,
        detectedAt: 99
      })
    );

    expect(readUnresolvedConflict(projectId, 'room')).toMatchObject({
      localVersion: 3,
      remoteVersion: 4
    });
    expect(hasUnresolvedConflict(projectId)).toBe(true);
    clearUnresolvedConflict(projectId, 'room');
    expect(hasUnresolvedConflict(projectId)).toBe(false);
  });

  it.each(['use-remote', 'keep-mine', 'save-local-copy'] as const)(
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
        useRemoteVersion: vi.fn(async () => {
          calls.push('room');
        }),
        keepMyVersion: vi.fn(async () => {
          calls.push('mine');
        }),
        saveLocalAsCopy: vi.fn(async () => {
          calls.push('copy');
        })
      };

      await resolveProjectConflict(
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
        resolution === 'use-remote'
          ? ['room']
          : resolution === 'keep-mine'
            ? ['mine']
            : ['copy', 'room']
      );
    }
  );

  it('preserves the side the user is not keeping', async () => {
    const base = createProjectDocument('Conflict', owner);
    const context = {
      role: 'owner' as const,
      lease: {
        projectId: base.projectId,
        leaseId: 'lease_active',
        clientId: 'client',
        userId: owner,
        expiresAt: 20_000
      },
      now: 10_000
    };

    const useRemote = handlers();
    await resolveProjectConflict(
      conflictFromDocuments(version(base, 4), version(base, 5)),
      'use-remote',
      context,
      useRemote
    );
    expect(useRemote.writeRecoveryCopy).toHaveBeenCalledWith(
      expect.objectContaining({ version: 4 })
    );

    localStorage.clear();
    const keepMine = handlers();
    await resolveProjectConflict(
      conflictFromDocuments(version(base, 4), version(base, 5)),
      'keep-mine',
      context,
      keepMine
    );
    expect(keepMine.writeRecoveryCopy).toHaveBeenCalledWith(
      expect.objectContaining({ version: 5 })
    );
  });

  it('writes one recovery copy per divergence, not one per attempt', async () => {
    const base = createProjectDocument('Conflict', owner);
    const context = {
      role: 'owner' as const,
      lease: null,
      leasesEnforced: false
    };
    const failing: ConflictResolutionHandlers = {
      ...handlers(),
      useRemoteVersion: vi.fn(async () => {
        throw new Error('the room moved');
      })
    };

    const first = conflictFromDocuments(version(base, 4), version(base, 5));
    await expect(
      resolveProjectConflict(first, 'use-remote', context, failing)
    ).rejects.toThrow('the room moved');
    expect(failing.writeRecoveryCopy).toHaveBeenCalledTimes(1);

    // The same divergence, re-raised by the next inbound frame and retried:
    // the local document is already preserved, so no second copy.
    const retried = conflictFromDocuments(version(base, 4), version(base, 5));
    await expect(
      resolveProjectConflict(retried, 'use-remote', context, failing)
    ).rejects.toThrow('the room moved');
    expect(failing.writeRecoveryCopy).toHaveBeenCalledTimes(1);

    // Switching to discard the OTHER side preserves that side once.
    await resolveProjectConflict(retried, 'keep-mine', context, failing);
    expect(failing.writeRecoveryCopy).toHaveBeenCalledTimes(2);
    expect(failing.writeRecoveryCopy).toHaveBeenLastCalledWith(
      expect.objectContaining({ version: 5 })
    );

    // A NEW divergence starts a new preservation record.
    const moved = conflictFromDocuments(version(base, 4), version(base, 6));
    await expect(
      resolveProjectConflict(moved, 'use-remote', context, failing)
    ).rejects.toThrow('the room moved');
    expect(failing.writeRecoveryCopy).toHaveBeenCalledTimes(3);
  });

  it('never nests recovery labels in project names', () => {
    expect(recoveryCopyName('Mellow Puffin', 'Recovery')).toBe(
      'Mellow Puffin (Recovery)'
    );
    expect(recoveryCopyName('Mellow Puffin (Recovery)', 'Recovery')).toBe(
      'Mellow Puffin (Recovery)'
    );
    expect(
      recoveryCopyName('Mellow Puffin (Recovery) (Recovery)', 'Recovery')
    ).toBe('Mellow Puffin (Recovery)');
    expect(recoveryCopyName('Mellow Puffin (Local copy)', 'Recovery')).toBe(
      'Mellow Puffin (Recovery)'
    );
    // A name that is nothing but the label survives rather than vanishing.
    expect(recoveryCopyName('(Recovery)', 'Recovery')).toBe(
      '(Recovery) (Recovery)'
    );
  });

  it('requires the exact room version and an active lease before keep mine', async () => {
    const base = createProjectDocument('Conflict', owner);
    const conflict = conflictFromDocuments(version(base, 2), version(base, 3));
    const recoveryHandlers = handlers();

    await expect(
      resolveProjectConflict(
        { ...conflict, expectedRemoteVersion: 2 },
        'keep-mine',
        { role: 'owner', lease: null },
        recoveryHandlers
      )
    ).rejects.toMatchObject({ code: 'REMOTE_VERSION_MISMATCH' });
    await expect(
      resolveProjectConflict(
        conflict,
        'keep-mine',
        { role: 'viewer', lease: null },
        recoveryHandlers
      )
    ).rejects.toMatchObject({ code: 'VIEWER_FORBIDDEN' });
    await expect(
      resolveProjectConflict(
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
