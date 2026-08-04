import { describe, expect, it, vi } from 'vitest';
import { createProjectDocument } from '@openzcad/document-core';
import { toUserId, type ProjectDocument } from '@openzcad/shared';
import {
  clearUnresolvedConflict,
  conflictFromDocuments,
  readUnresolvedConflict,
  resolveProjectConflict,
  type ConflictResolutionHandlers,
  type ProjectConflict
} from './conflictRecovery';

const owner = toUserId('user_owner');
const base = createProjectDocument('Bracket', owner);

function at(version: number): ProjectDocument {
  return { ...base, version };
}

function handlers(order: string[] = []): ConflictResolutionHandlers {
  return {
    writeRecoveryCopy: vi.fn(async () => {
      order.push('recovery');
    }),
    useRemoteVersion: vi.fn(async () => {
      order.push('remote');
    }),
    keepMyVersion: vi.fn(async () => {
      order.push('mine');
    }),
    saveLocalAsCopy: vi.fn(async () => {
      order.push('copy');
    })
  };
}

function accountConflict(): ProjectConflict {
  clearUnresolvedConflict(base.projectId);
  return conflictFromDocuments(at(7), at(9), 'account');
}

describe('a conflict raised by the account rather than a room', () => {
  it('records which side it came from', () => {
    expect(accountConflict().source).toBe('account');
  });

  it('leaves a marker so the divergence survives a reload', () => {
    const conflict = accountConflict();
    expect(readUnresolvedConflict(conflict.projectId)).toMatchObject({
      localVersion: 7,
      remoteVersion: 9
    });
    clearUnresolvedConflict(conflict.projectId);
  });

  it('lets the owner keep their version with no lease in sight', async () => {
    // A lease is a room concept. Requiring one here would leave the user with a
    // divergence they are not permitted to resolve.
    const order: string[] = [];
    const recovery = handlers(order);
    await resolveProjectConflict(
      accountConflict(),
      'keep-mine',
      { role: 'owner', lease: null, leasesEnforced: false },
      recovery
    );
    expect(order).toEqual(['recovery', 'mine']);
  });

  it('writes the recovery copy before anything else, on every resolution', async () => {
    for (const resolution of [
      'use-remote',
      'keep-mine',
      'save-local-copy'
    ] as const) {
      const order: string[] = [];
      await resolveProjectConflict(
        accountConflict(),
        resolution,
        { role: 'owner', lease: null, leasesEnforced: false },
        handlers(order)
      );
      expect(order[0]).toBe('recovery');
    }
  });

  it('saves the local copy and then takes the account version', async () => {
    const order: string[] = [];
    await resolveProjectConflict(
      accountConflict(),
      'save-local-copy',
      { role: 'owner', lease: null, leasesEnforced: false },
      handlers(order)
    );
    expect(order).toEqual(['recovery', 'copy', 'remote']);
  });

  it('passes the account version a keep-mine write must be fenced against', async () => {
    const recovery = handlers();
    await resolveProjectConflict(
      accountConflict(),
      'keep-mine',
      { role: 'owner', lease: null, leasesEnforced: false },
      recovery
    );
    expect(recovery.keepMyVersion).toHaveBeenCalledWith(
      expect.objectContaining({ expectedRemoteVersion: 9 })
    );
  });

  it('still refuses a viewer, whoever raised the conflict', async () => {
    await expect(
      resolveProjectConflict(
        accountConflict(),
        'keep-mine',
        { role: 'viewer', lease: null, leasesEnforced: false },
        handlers()
      )
    ).rejects.toMatchObject({ code: 'VIEWER_FORBIDDEN' });
  });

  it('refuses once the account has moved again underneath the conflict', async () => {
    const conflict = accountConflict();
    const stale: ProjectConflict = {
      ...conflict,
      remoteDocument: at(11)
    };
    await expect(
      resolveProjectConflict(
        stale,
        'use-remote',
        { role: 'owner', lease: null, leasesEnforced: false },
        handlers()
      )
    ).rejects.toMatchObject({ code: 'REMOTE_VERSION_MISMATCH' });
  });

  it('refuses documents that stopped describing one project', async () => {
    const other = createProjectDocument('Other', owner);
    expect(() => conflictFromDocuments(at(7), other, 'account')).toThrow(
      /different projects/
    );
  });
});

describe('a conflict raised by a room', () => {
  it('still demands a lease when leases are enforced', async () => {
    clearUnresolvedConflict(base.projectId);
    const conflict = conflictFromDocuments(at(7), at(9), 'room');
    await expect(
      resolveProjectConflict(
        conflict,
        'keep-mine',
        { role: 'editor', lease: null, leasesEnforced: true },
        handlers()
      )
    ).rejects.toMatchObject({ code: 'LEASE_REQUIRED' });
  });

  it('demands a lease by default, so an unset flag cannot loosen the rule', async () => {
    clearUnresolvedConflict(base.projectId);
    const conflict = conflictFromDocuments(at(7), at(9), 'room');
    await expect(
      resolveProjectConflict(
        conflict,
        'keep-mine',
        { role: 'editor', lease: null },
        handlers()
      )
    ).rejects.toMatchObject({ code: 'LEASE_REQUIRED' });
  });

  it('accepts an active lease for this project', async () => {
    clearUnresolvedConflict(base.projectId);
    const conflict = conflictFromDocuments(at(7), at(9), 'room');
    const order: string[] = [];
    await resolveProjectConflict(
      conflict,
      'keep-mine',
      {
        role: 'editor',
        lease: {
          leaseId: 'lease_1',
          projectId: base.projectId,
          clientId: 'client_1',
          userId: owner,
          expiresAt: Date.now() + 30_000
        },
        leasesEnforced: true
      },
      handlers(order)
    );
    expect(order).toEqual(['recovery', 'mine']);
  });
});
