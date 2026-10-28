import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createProjectDocument,
  createSavedRevision
} from '@openzcad/document-core';
import { toUserId, type ProjectDocument } from '@openzcad/shared';
import {
  clearUnresolvedConflict,
  conflictFromDocuments,
  hasUnresolvedConflict,
  readUnresolvedConflict,
  rememberUnresolvedConflict,
  resolveProjectConflict,
  type ConflictResolutionHandlers
} from './conflictRecovery';

const owner = toUserId('user_conflict_owner');

function version(document: ProjectDocument, value: number): ProjectDocument {
  return { ...structuredClone(document), version: value };
}

/** Distinct local work for each divergence. */
function edited(
  document: ProjectDocument,
  value: number,
  change: string
): ProjectDocument {
  return { ...version(document, value), name: `${document.name} ${change}` };
}

function handlers(): ConflictResolutionHandlers {
  return {
    useRemoteVersion: vi.fn(async () => undefined),
    keepMyVersion: vi.fn(async () => undefined),
    saveLocalAsCopy: vi.fn(async () => 'proj_local_copy'),
    localCopyExists: vi.fn(async () => true)
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

  it.each(['room', 'account'] as const)(
    'only Keep both creates a project for %s conflicts',
    async (source) => {
      const base = createProjectDocument('Conflict', owner);
      const conflict = conflictFromDocuments(
        edited(base, 4, 'here'),
        edited(base, 5, 'there'),
        source
      );
      const original = structuredClone(conflict);
      const context = {
        role: 'owner' as const,
        lease: null,
        leasesEnforced: false
      };
      for (const resolution of ['use-remote', 'keep-mine'] as const) {
        const host = handlers();
        const outcome = await resolveProjectConflict(
          conflict,
          resolution,
          context,
          host
        );
        expect(host.saveLocalAsCopy).not.toHaveBeenCalled();
        expect(outcome.localCopy).toBe('not-requested');
        if (resolution === 'use-remote') {
          expect(host.useRemoteVersion).toHaveBeenCalledWith(
            original.remoteDocument,
            outcome
          );
          expect(host.keepMyVersion).not.toHaveBeenCalled();
        } else {
          expect(host.keepMyVersion).toHaveBeenCalledWith(
            { document: original.localDocument, expectedRemoteVersion: 5 },
            outcome
          );
          expect(host.useRemoteVersion).not.toHaveBeenCalled();
        }
      }
      const order: string[] = [];
      const host = handlers();
      vi.mocked(host.saveLocalAsCopy).mockImplementation(async (document) => {
        expect(document).toEqual(original.localDocument);
        document.name = 'A copy handler may mutate its private clone';
        order.push('copy');
        return 'proj_local_copy';
      });
      vi.mocked(host.useRemoteVersion).mockImplementation(async (document) => {
        expect(document).toEqual(original.remoteDocument);
        order.push('remote');
      });
      const outcome = await resolveProjectConflict(
        conflict,
        'save-local-copy',
        context,
        host
      );
      expect(order).toEqual(['copy', 'remote']);
      expect(outcome.localCopy).toBe('saved');
      expect(conflict).toEqual(original);
    }
  );

  it('never creates copies across repeated replacements, version changes, and remote sources', async () => {
    const base = createProjectDocument('Conflict', owner);
    const host = handlers();
    for (let version = 4; version < 10; version++) {
      for (const source of ['room', 'account'] as const) {
        for (const resolution of ['use-remote', 'keep-mine'] as const) {
          await resolveProjectConflict(
            conflictFromDocuments(
              edited(base, version, 'here'),
              edited(base, version + 1, 'there'),
              source
            ),
            resolution,
            { role: 'owner', lease: null, leasesEnforced: false },
            host
          );
        }
      }
    }
    expect(host.saveLocalAsCopy).not.toHaveBeenCalled();
  });

  it('does not adopt remote when saving the requested copy fails', async () => {
    const base = createProjectDocument('Conflict', owner);
    const conflict = conflictFromDocuments(
      edited(base, 4, 'here'),
      edited(base, 5, 'there')
    );
    const host = handlers();
    vi.mocked(host.saveLocalAsCopy).mockRejectedValueOnce(
      new Error('disk full')
    );
    const context = {
      role: 'owner' as const,
      lease: null,
      leasesEnforced: false
    };
    await expect(
      resolveProjectConflict(conflict, 'save-local-copy', context, host)
    ).rejects.toThrow('disk full');
    expect(host.useRemoteVersion).not.toHaveBeenCalled();
    await resolveProjectConflict(conflict, 'save-local-copy', context, host);
    expect(host.saveLocalAsCopy).toHaveBeenCalledTimes(2);
    expect(host.useRemoteVersion).toHaveBeenCalledOnce();
  });

  it('reuses the explicit copy after remote adoption fails, including a new remote fence', async () => {
    const base = createProjectDocument('Conflict', owner);
    const local = edited(base, 4, 'here');
    const conflict = conflictFromDocuments(local, edited(base, 5, 'there'));
    const host = handlers();
    vi.mocked(host.useRemoteVersion).mockRejectedValueOnce(
      new Error('remote moved')
    );
    const context = {
      role: 'owner' as const,
      lease: null,
      leasesEnforced: false
    };
    await expect(
      resolveProjectConflict(conflict, 'save-local-copy', context, host)
    ).rejects.toThrow('remote moved');
    const retried = conflictFromDocuments(
      local,
      edited(base, 6, 'there'),
      'account'
    );
    expect(
      await resolveProjectConflict(retried, 'save-local-copy', context, host)
    ).toEqual({ localCopy: 'already-saved' });
    expect(host.localCopyExists).toHaveBeenCalledExactlyOnceWith(
      'proj_local_copy'
    );
    expect(host.saveLocalAsCopy).toHaveBeenCalledOnce();
    await resolveProjectConflict(
      conflictFromDocuments(
        edited(base, 7, 'new local edit'),
        edited(base, 8, 'there')
      ),
      'save-local-copy',
      context,
      host
    );
    expect(host.saveLocalAsCopy).toHaveBeenCalledTimes(2);
  });

  it.each(['room', 'account'] as const)(
    'replaces a deleted retry copy before adopting the %s version',
    async (source) => {
      const base = createProjectDocument('Conflict', owner);
      const conflict = conflictFromDocuments(
        edited(base, 4, 'here'),
        edited(base, 5, 'there'),
        source
      );
      const host = handlers();
      const context = {
        role: 'owner' as const,
        lease: null,
        leasesEnforced: false
      };
      vi.mocked(host.useRemoteVersion).mockRejectedValueOnce(
        new Error('remote moved')
      );
      await expect(
        resolveProjectConflict(conflict, 'save-local-copy', context, host)
      ).rejects.toThrow('remote moved');

      // Decide later, then delete the saved shelf project before retrying.
      vi.mocked(host.localCopyExists).mockResolvedValue(false);
      vi.mocked(host.saveLocalAsCopy).mockRejectedValueOnce(
        new Error('disk full')
      );
      await expect(
        resolveProjectConflict(conflict, 'save-local-copy', context, host)
      ).rejects.toThrow('disk full');
      expect(host.useRemoteVersion).toHaveBeenCalledOnce();
      vi.mocked(host.saveLocalAsCopy).mockResolvedValueOnce(
        'proj_local_replacement'
      );
      await expect(
        resolveProjectConflict(conflict, 'save-local-copy', context, host)
      ).resolves.toEqual({ localCopy: 'saved' });
      expect(host.saveLocalAsCopy).toHaveBeenCalledTimes(3);
      expect(host.useRemoteVersion).toHaveBeenCalledTimes(2);
    }
  );

  it('does not adopt remote when the saved copy cannot be checked', async () => {
    const base = createProjectDocument('Conflict', owner);
    const conflict = conflictFromDocuments(
      edited(base, 4, 'here'),
      edited(base, 5, 'there')
    );
    const host = handlers();
    const context = {
      role: 'owner' as const,
      lease: null,
      leasesEnforced: false
    };
    vi.mocked(host.useRemoteVersion).mockRejectedValueOnce(
      new Error('remote moved')
    );
    await expect(
      resolveProjectConflict(conflict, 'save-local-copy', context, host)
    ).rejects.toThrow('remote moved');
    vi.mocked(host.localCopyExists).mockRejectedValueOnce(
      new Error('storage unavailable')
    );
    await expect(
      resolveProjectConflict(conflict, 'save-local-copy', context, host)
    ).rejects.toThrow('storage unavailable');
    expect(host.saveLocalAsCopy).toHaveBeenCalledOnce();
    expect(host.useRemoteVersion).toHaveBeenCalledOnce();
  });

  it('honors a separate Keep both request after the previous one completed', async () => {
    const base = createProjectDocument('Conflict', owner);
    const conflict = conflictFromDocuments(
      edited(base, 4, 'here'),
      edited(base, 5, 'there')
    );
    const host = handlers();
    const context = {
      role: 'owner' as const,
      lease: null,
      leasesEnforced: false
    };
    await resolveProjectConflict(conflict, 'save-local-copy', context, host);
    await resolveProjectConflict(conflict, 'save-local-copy', context, host);
    expect(host.saveLocalAsCopy).toHaveBeenCalledTimes(2);
  });

  it('honors Keep both even for matching models and legacy automatic recovery records', async () => {
    const base = createProjectDocument('Conflict', owner);
    const host = handlers();
    localStorage.setItem(
      `openzcad-recovery-copies:${encodeURIComponent(base.projectId)}`,
      '["legacy automatic copy"]'
    );
    const local = version(base, 4);
    const remote = createSavedRevision(version(base, 5), 'Before drilling');
    await resolveProjectConflict(
      conflictFromDocuments(local, remote),
      'save-local-copy',
      { role: 'viewer', lease: null },
      host
    );
    expect(host.saveLocalAsCopy).toHaveBeenCalledExactlyOnceWith(local);
    expect(host.useRemoteVersion).toHaveBeenCalledOnce();
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
    expect(recoveryHandlers.saveLocalAsCopy).not.toHaveBeenCalled();
  });
});
