import { describe, expect, it, vi } from 'vitest';
import {
  toProjectId,
  type ProjectOrganization,
  type ProjectSummary
} from '@openzcad/shared';
import {
  reconcileRemoteOrganizations,
  type OrganizationMirrorHost
} from './projectOrganizationMirror';

const active: ProjectOrganization = {
  status: 'active',
  pinned: false,
  sortOrder: 0
};
const trashed: ProjectOrganization = {
  status: 'deleted',
  pinned: false,
  sortOrder: 0,
  deletedAt: '2026-09-05T02:30:00.000Z'
};

function listed(organization?: ProjectOrganization): ProjectSummary {
  return {
    projectId: toProjectId('proj_shared'),
    name: 'Shared part',
    updatedAt: '2026-09-05T00:00:00.000Z',
    revisionCount: 1,
    ...(organization ? { organization } : {})
  };
}

function host(overrides: Partial<OrganizationMirrorHost> = {}) {
  return {
    saveLocal: vi.fn().mockResolvedValue(undefined),
    updateRemote: vi.fn().mockResolvedValue(undefined),
    ...overrides
  };
}

describe('reconcileRemoteOrganizations', () => {
  // The regression: a project trashed on another device came back the moment
  // this device listed the shelf, because its stale "active" row always won.
  it('adopts the account row over a device row that is not pending', async () => {
    const h = host();

    const failures = await reconcileRemoteOrganizations(
      new Map([['proj_shared', active]]),
      new Set(),
      [listed(trashed)],
      h
    );

    expect(h.updateRemote).not.toHaveBeenCalled();
    expect(h.saveLocal).toHaveBeenCalledWith('proj_shared', trashed, {
      mirrorPending: false
    });
    expect(failures.size).toBe(0);
  });

  it('pushes a pending device row and clears the flag once it lands', async () => {
    const h = host();

    await reconcileRemoteOrganizations(
      new Map([['proj_shared', trashed]]),
      new Set(['proj_shared']),
      [listed(active)],
      h
    );

    expect(h.updateRemote).toHaveBeenCalledWith('proj_shared', trashed);
    expect(h.saveLocal).toHaveBeenCalledWith('proj_shared', trashed, {
      mirrorPending: false
    });
  });

  it('keeps the flag and reports the project when the push fails', async () => {
    const h = host({
      updateRemote: vi.fn().mockRejectedValue(new Error('offline'))
    });

    const failures = await reconcileRemoteOrganizations(
      new Map([['proj_shared', trashed]]),
      new Set(['proj_shared']),
      [listed(active)],
      h
    );

    expect(h.saveLocal).not.toHaveBeenCalled();
    expect([...failures]).toEqual(['proj_shared']);
  });

  it('clears a pending flag the account already agrees with', async () => {
    const h = host();

    await reconcileRemoteOrganizations(
      new Map([['proj_shared', trashed]]),
      new Set(['proj_shared']),
      [listed(trashed)],
      h
    );

    expect(h.updateRemote).not.toHaveBeenCalled();
    expect(h.saveLocal).toHaveBeenCalledWith('proj_shared', trashed, {
      mirrorPending: false
    });
  });

  it('leaves an agreeing, unflagged row alone', async () => {
    const h = host();

    await reconcileRemoteOrganizations(
      new Map([['proj_shared', active]]),
      new Set(),
      [listed(active)],
      h
    );

    expect(h.updateRemote).not.toHaveBeenCalled();
    expect(h.saveLocal).not.toHaveBeenCalled();
  });

  it('adopts the account row when the device has none', async () => {
    const h = host();

    await reconcileRemoteOrganizations(
      new Map(),
      new Set(),
      [listed(trashed)],
      h
    );

    expect(h.saveLocal).toHaveBeenCalledWith('proj_shared', trashed, {
      mirrorPending: false
    });
  });

  it('pushes the device row when the account never organised the project', async () => {
    const h = host();

    await reconcileRemoteOrganizations(
      new Map([['proj_shared', trashed]]),
      new Set(),
      [listed()],
      h
    );

    expect(h.updateRemote).toHaveBeenCalledWith('proj_shared', trashed);
  });
});
