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

/**
 * A distinct model at the given version. Recovery copies are keyed on what
 * a rebuild reads, so two versions of unchanged content are one thing to
 * preserve; a test that expects a copy has to change the model.
 */
function edited(
  document: ProjectDocument,
  value: number,
  change: string
): ProjectDocument {
  return { ...version(document, value), name: `${document.name} ${change}` };
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
        edited(base, 4, 'here'),
        edited(base, 5, 'there')
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
      conflictFromDocuments(edited(base, 4, 'here'), edited(base, 5, 'there')),
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
      conflictFromDocuments(edited(base, 4, 'here'), edited(base, 5, 'there')),
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

    const here = edited(base, 4, 'here');
    const there = edited(base, 5, 'there');
    const first = conflictFromDocuments(here, there);
    await expect(
      resolveProjectConflict(first, 'use-remote', context, failing)
    ).rejects.toThrow('the room moved');
    expect(failing.writeRecoveryCopy).toHaveBeenCalledTimes(1);

    // The same divergence, re-raised by the next inbound frame and retried:
    // the local document is already preserved, so no second copy.
    const retried = conflictFromDocuments(here, there);
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

    // A NEW divergence citing the SAME local document does not copy it again:
    // the copy on disk is of this exact state, whatever the room moved to.
    const moved = conflictFromDocuments(here, edited(base, 6, 'there'));
    await expect(
      resolveProjectConflict(moved, 'use-remote', context, failing)
    ).rejects.toThrow('the room moved');
    expect(failing.writeRecoveryCopy).toHaveBeenCalledTimes(2);

    // A local document not yet preserved is.
    const newer = conflictFromDocuments(
      edited(base, 7, 'newer'),
      edited(base, 6, 'there')
    );
    await expect(
      resolveProjectConflict(newer, 'use-remote', context, failing)
    ).rejects.toThrow('the room moved');
    expect(failing.writeRecoveryCopy).toHaveBeenCalledTimes(3);
    expect(failing.writeRecoveryCopy).toHaveBeenLastCalledWith(
      expect.objectContaining({ version: 7 })
    );
  });

  // The room and the account are separate version lines that raise the same
  // divergence with the roles swapped — 9-vs-27 in one, 27-vs-9 in the other.
  // A record scoped to the version pair copied the losing side again on every
  // hop between them, which is how one project grew nine recovery projects in
  // a minute.
  it('copies a document once across both remotes and every version pair', async () => {
    const base = createProjectDocument('Conflict', owner);
    const context = {
      role: 'owner' as const,
      lease: null,
      leasesEnforced: false
    };
    const device = edited(base, 27, 'device');
    const account = edited(base, 9, 'account');

    const room = handlers();
    await resolveProjectConflict(
      conflictFromDocuments(account, device, 'room'),
      'use-remote',
      context,
      room
    );
    expect(room.writeRecoveryCopy).toHaveBeenCalledTimes(1);
    expect(room.writeRecoveryCopy).toHaveBeenCalledWith(
      expect.objectContaining({ version: 9 })
    );

    // The device now holds 27; the account still says 9 and raises the same
    // two documents the other way round. Keeping 27 would copy 9 — which the
    // room resolution above already preserved.
    const viaAccount = handlers();
    await resolveProjectConflict(
      conflictFromDocuments(device, account, 'account'),
      'keep-mine',
      context,
      viaAccount
    );
    expect(viaAccount.writeRecoveryCopy).not.toHaveBeenCalled();
    expect(viaAccount.keepMyVersion).toHaveBeenCalledTimes(1);

    // Clearing the marker — what a completed resolution does — does not
    // forget which documents were preserved.
    clearUnresolvedConflict(base.projectId, 'account');
    clearUnresolvedConflict(base.projectId, 'room');
    const again = handlers();
    await resolveProjectConflict(
      conflictFromDocuments(device, account, 'account'),
      'keep-mine',
      context,
      again
    );
    expect(again.writeRecoveryCopy).not.toHaveBeenCalled();
  });

  // A keep-mine is a fenced write that mints a new version of the same model,
  // and the room and the account each cite that new version in their next
  // dialog. Keyed on version and revision, the same model came back under a
  // fresh key on every hop, and every hop wrote another recovery project.
  it('copies a model once however many versions it is cited under', async () => {
    const base = createProjectDocument('Conflict', owner);
    const context = {
      role: 'owner' as const,
      lease: null,
      leasesEnforced: false
    };
    const theirs = edited(base, 9, 'theirs');
    const mine = edited(base, 27, 'mine');

    const first = handlers();
    await resolveProjectConflict(
      conflictFromDocuments(mine, theirs, 'account'),
      'use-remote',
      context,
      first
    );
    expect(first.writeRecoveryCopy).toHaveBeenCalledTimes(1);

    // The same model as `mine`, resaved under a new version by a fenced write
    // and with a fresh revision on top — what every hop looks like.
    const resaved = {
      ...version(mine, 28),
      revisions: [
        ...mine.revisions,
        { ...mine.revisions.at(-1), revisionId: 'rev_resaved' }
      ]
    } as ProjectDocument;
    for (const [local, remote, resolution] of [
      [resaved, theirs, 'use-remote'],
      [theirs, resaved, 'keep-mine'],
      [version(resaved, 29), version(theirs, 10), 'use-remote']
    ] as const) {
      const hop = handlers();
      const outcome = await resolveProjectConflict(
        conflictFromDocuments(local, remote, 'room'),
        resolution,
        context,
        hop
      );
      expect(hop.writeRecoveryCopy).not.toHaveBeenCalled();
      expect(outcome.recoveryCopy).toBe('already-preserved');
    }
  });

  it('writes nothing when both sides would rebuild to the same model', async () => {
    const base = createProjectDocument('Conflict', owner);
    const context = {
      role: 'owner' as const,
      lease: null,
      leasesEnforced: false
    };
    // Only bookkeeping differs: a checkpoint-only save on one side.
    const local = version(base, 4);
    const remote = {
      ...version(base, 5),
      checkpoints: [
        ...base.checkpoints,
        {
          checkpointId: 'cp_manual',
          revisionId: base.revisions.at(-1)?.revisionId ?? 'rev_none',
          documentVersion: 5,
          reason: 'Manual save',
          createdAt: '2026-09-04T16:21:00.000Z'
        }
      ]
    } as ProjectDocument;

    const useRemote = handlers();
    const outcome = await resolveProjectConflict(
      conflictFromDocuments(local, remote, 'account'),
      'use-remote',
      context,
      useRemote
    );
    expect(useRemote.writeRecoveryCopy).not.toHaveBeenCalled();
    expect(outcome.recoveryCopy).toBe('nothing-to-preserve');
    expect(useRemote.useRemoteVersion).toHaveBeenCalledWith(
      expect.objectContaining({ version: 5 }),
      outcome
    );

    // An explicit request for a copy is still a request for a copy.
    const asked = handlers();
    const explicit = await resolveProjectConflict(
      conflictFromDocuments(local, remote, 'account'),
      'save-local-copy',
      context,
      asked
    );
    expect(asked.writeRecoveryCopy).toHaveBeenCalledTimes(1);
    expect(explicit.recoveryCopy).toBe('written');
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
