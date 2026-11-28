import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProjectSummary } from '@openzcad/shared';
import type { AccountView, E2eeContext } from './accountKeys';
import type * as ProjectAuthority from './projectAuthority';

type AuthorityRecovery = ProjectAuthority.AuthorityRecovery;

type Listing = {
  projects: ProjectSummary[];
  pendingEncryptedProjectIds?: ReadonlySet<string>;
};
const mocks = vi.hoisted(() => ({
  listProjects: vi.fn(async (): Promise<Listing> => ({ projects: [] })),
  listLocalProjects: vi.fn(async (): Promise<ProjectSummary[]> => []),
  cachedShelfNames: vi.fn(
    (_accountId: string | null) =>
      new Map<string, { name: string; updatedAt: string }>()
  ),
  projectAuthorityRecovery: vi.fn(
    async (_ctx: unknown, _projectId: string): Promise<AuthorityRecovery> =>
      'none'
  )
}));
vi.mock('../api', () => ({ api: { listProjects: mocks.listProjects } }));
vi.mock('../localProjectStore', () => ({
  listLocalProjects: mocks.listLocalProjects
}));
vi.mock('../projectShelfNames', () => ({
  cachedShelfNames: mocks.cachedShelfNames
}));
vi.mock('./projectAuthority', async (original) => ({
  ...(await original<typeof ProjectAuthority>()),
  projectAuthorityRecovery: mocks.projectAuthorityRecovery
}));

const { encryptedProjectsForRecovery, trustedProjectName } =
  await import('./pageDeviceRemoval');

/** The account's row for an encrypted project whose name did not verify. */
const placeholder = (projectId: string): ProjectSummary =>
  ({
    projectId,
    name: 'Encrypted project',
    revisionCount: 1,
    updatedAt: '2026-11-20T00:00:00.000Z',
    storageFormat: 2
  }) as ProjectSummary;

const ctx = { userId: 'user_alice', api: {}, store: {} } as E2eeContext;
const account = {
  userId: 'user_alice',
  generation: 1,
  deviceStatus: 'none',
  list: { devices: [], revoked: [], entries: [] }
} as unknown as AccountView;

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockClear();
  mocks.projectAuthorityRecovery.mockImplementation(async () => 'none');
});

describe('trustedProjectName', () => {
  const at = (name: string, updatedAt: string) => ({ name, updatedAt });
  it('names nothing when this device knows no title', () => {
    expect(trustedProjectName(undefined, undefined)).toBeNull();
  });
  it('prefers the newer of this device’s copy and its last verified title', () => {
    const device = at('Edited here', '2026-11-22T00:00:00.000Z');
    const verified = at('Verified', '2026-11-21T00:00:00.000Z');
    expect(trustedProjectName(device, undefined)).toBe('Edited here');
    expect(trustedProjectName(undefined, verified)).toBe('Verified');
    expect(trustedProjectName(device, verified)).toBe('Edited here');
    expect(
      trustedProjectName(at('Stale copy', '2026-11-20T00:00:00.000Z'), verified)
    ).toBe('Verified');
  });
});

// PR #2400 review: a withdrawn record leaves the encrypted name unverified.
describe('encryptedProjectsForRecovery', () => {
  it('names two withdrawn projects from this device and keeps their ids apart', async () => {
    mocks.listProjects.mockResolvedValueOnce({
      projects: [
        placeholder('proj_a'),
        placeholder('proj_b'),
        placeholder('proj_c'),
        { ...placeholder('proj_d'), name: 'Verified gear' },
        {
          projectId: 'proj_plain',
          name: 'Plaintext',
          revisionCount: 1,
          updatedAt: '2026-11-20T00:00:00.000Z'
        } as ProjectSummary
      ],
      // The shelf verifier refused every withdrawn project's name.
      pendingEncryptedProjectIds: new Set(['proj_a', 'proj_b', 'proj_c'])
    });
    mocks.listLocalProjects.mockResolvedValueOnce([
      { ...placeholder('proj_a'), name: 'Secret bracket' }
    ]);
    mocks.cachedShelfNames.mockReturnValueOnce(
      new Map([
        ['proj_b', { name: 'Motor mount', updatedAt: '2026-11-19T00:00:00Z' }],
        // Never applied to a name the shelf verified this time.
        ['proj_d', { name: 'Old gear', updatedAt: '2026-11-19T00:00:00Z' }]
      ])
    );
    mocks.projectAuthorityRecovery.mockImplementation(
      async (_groups, projectId) =>
        projectId === 'proj_d' ? 'none' : 'restorable'
    );

    expect(await encryptedProjectsForRecovery(ctx, account)).toEqual([
      { projectId: 'proj_a', name: 'Secret bracket', authority: 'restorable' },
      { projectId: 'proj_b', name: 'Motor mount', authority: 'restorable' },
      // No title on this device: the placeholder, told apart by its id.
      {
        projectId: 'proj_c',
        name: 'Encrypted project',
        unnamed: true,
        authority: 'restorable'
      },
      { projectId: 'proj_d', name: 'Verified gear' }
    ]);
    expect(mocks.cachedShelfNames).toHaveBeenCalledWith('user_alice');
  });

  it('reads no device titles when every encrypted name verified', async () => {
    mocks.listProjects.mockResolvedValueOnce({
      projects: [{ ...placeholder('proj_d'), name: 'Verified gear' }]
    });
    expect(await encryptedProjectsForRecovery(ctx, account)).toEqual([
      { projectId: 'proj_d', name: 'Verified gear' }
    ]);
    expect(mocks.listLocalProjects).not.toHaveBeenCalled();
    expect(mocks.cachedShelfNames).not.toHaveBeenCalled();
  });

  it('keeps the listing when this device’s titles cannot be read', async () => {
    mocks.listProjects.mockResolvedValueOnce({
      projects: [placeholder('proj_a')],
      pendingEncryptedProjectIds: new Set(['proj_a'])
    });
    mocks.listLocalProjects.mockRejectedValueOnce(new Error('blocked'));
    expect(await encryptedProjectsForRecovery(ctx, account)).toEqual([
      { projectId: 'proj_a', name: 'Encrypted project', unnamed: true }
    ]);
  });

  // PR #2400 re-check: the account's listing name is not verified either.
  it('never shows the name the account lists for a project whose name did not verify', async () => {
    mocks.listProjects.mockResolvedValueOnce({
      projects: [
        { ...placeholder('proj_a'), name: 'Secret bracket' },
        { ...placeholder('proj_b'), name: 'Restore me first' },
        { ...placeholder('proj_c'), name: 'Restore me first' }
      ],
      pendingEncryptedProjectIds: new Set(['proj_a', 'proj_b', 'proj_c'])
    });
    mocks.listLocalProjects.mockResolvedValueOnce([
      { ...placeholder('proj_a'), name: 'Motor mount' }
    ]);
    mocks.projectAuthorityRecovery.mockImplementation(
      async (_groups, projectId) =>
        projectId === 'proj_c' ? 'none' : 'restorable'
    );

    expect(await encryptedProjectsForRecovery(ctx, account)).toEqual([
      // This device's own title, not the account's.
      { projectId: 'proj_a', name: 'Motor mount', authority: 'restorable' },
      // No title here: the generic name, and the id says which project.
      {
        projectId: 'proj_b',
        name: 'Encrypted project',
        unnamed: true,
        authority: 'restorable'
      },
      { projectId: 'proj_c', name: 'Encrypted project', unnamed: true }
    ]);
  });
});
