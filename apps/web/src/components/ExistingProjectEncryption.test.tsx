import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within
} from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProjectSummary } from '@openzcad/shared';
import {
  createMigrationController,
  type MigrationLocks
} from '../lib/e2ee/projectMigrations';
import {
  MigrationPausedError,
  memoryLeaseStore,
  type MigrationProgress,
  type ProjectMigrationEngine
} from '../lib/e2ee/projectMigrationEngine';
import type { MigrationPlaintextSource } from '../lib/e2ee/migrationPlaintextSource';
import type { ProjectMigrationsApi } from '../lib/e2ee/projectMigrationsApi';
import {
  migratingProjects,
  migrationLockedProjects,
  setMigratingProjects
} from '../lib/migrationStatus';
import type * as MigrationMembersModule from '../lib/e2ee/migrationMembers';
import type { MigrationMember } from '../lib/e2ee/migrationMembers';
import { ExistingProjectEncryption } from './ExistingProjectEncryption';

const followUps = vi.hoisted(() => ({
  reissued: [] as unknown[],
  reinvited: [] as unknown[]
}));

// Slice 7-4: the follow-ups' real work (5-10 links, 5-3b invitations) has
// its own tests; here they only record what the page asked for.
vi.mock('../lib/e2ee/migrationMembers', async (importOriginal) => ({
  ...(await importOriginal<typeof MigrationMembersModule>()),
  reissuePlaintextShareLinks: vi.fn(
    async (_ctx: unknown, projectId: string, links: { mode: string }[]) => {
      followUps.reissued.push({ projectId, links });
      return links.map((link, index) => ({
        shareId: `shr_${index}`,
        mode: link.mode,
        url: `https://app.example/#share=new${index}`,
        fragment: {},
        pending: []
      }));
    }
  ),
  reinviteToEncryptedProject: vi.fn(
    async (
      _ctx: unknown,
      projectId: string,
      invitations: { email: string }[]
    ) => {
      followUps.reinvited.push({ projectId, invitations });
      return { invited: invitations.map((i) => i.email), failed: [] };
    }
  )
}));

afterEach(() => setMigratingProjects([]));

const project = (
  projectId: string,
  name: string,
  updatedAt: string,
  extra: Partial<ProjectSummary> = {}
) =>
  ({
    projectId,
    name,
    revisionCount: 2,
    updatedAt,
    ...extra
  }) as ProjectSummary;

const PROJECTS = [
  project('proj_new', 'Newer bracket', '2026-10-03T00:00:00.000Z'),
  project('proj_old', 'Older bracket', '2026-10-01T00:00:00.000Z'),
  project('proj_enc', 'Already encrypted', '2026-09-01T00:00:00.000Z', {
    storageFormat: 2
  })
];

function plaintextSource(): MigrationPlaintextSource {
  return {
    listProjects: async () => PROJECTS
  } as unknown as MigrationPlaintextSource;
}

/** An engine that reports each phase and does what the test says. */
function fakeEngine(
  behave: (
    project: ProjectSummary,
    report: (change: Partial<MigrationProgress>) => void,
    signal?: AbortSignal
  ) => Promise<void>
) {
  const migrated: string[] = [];
  let onProgress: (progress: MigrationProgress) => void = () => undefined;
  const engine: ProjectMigrationEngine = {
    async migrate(summary, signal) {
      migrated.push(summary.projectId);
      let progress: MigrationProgress = {
        projectId: summary.projectId,
        name: summary.name,
        phase: 'starting',
        revisionsDone: 0,
        revisionsTotal: 2,
        bytesDone: 0,
        bytesTotal: 4 * 1024 * 1024
      };
      const report = (change: Partial<MigrationProgress>) => {
        progress = { ...progress, ...change };
        onProgress(progress);
      };
      report({});
      await behave(summary, report, signal);
    },
    cancel: vi.fn(async () => undefined)
  };
  return {
    engine,
    migrated,
    listen: (listener: (progress: MigrationProgress) => void) => {
      onProgress = listener;
    }
  };
}

function controllerWith(
  fake: ReturnType<typeof fakeEngine>,
  locks: MigrationLocks | null = null,
  sources: {
    plaintext?: MigrationPlaintextSource;
    migrations?: ProjectMigrationsApi;
  } = {}
) {
  const controller = createMigrationController({
    followUps: {
      shareLinks: async () => ({}) as never,
      invitations: async () => ({}) as never
    },
    userId: 'user_alice',
    plaintext: sources.plaintext ?? plaintextSource(),
    migrations: sources.migrations ?? ({} as never),
    openStaging: async () => {
      throw new Error('not used');
    },
    createEngine: (onProgress) => {
      fake.listen(onProgress);
      return fake.engine;
    },
    leases: memoryLeaseStore(),
    locks
  });
  return controller;
}

describe('the migration controller', () => {
  it('encrypts plaintext projects oldest first and moves on past a failure', async () => {
    const fake = fakeEngine(async (summary, report) => {
      if (summary.projectId === 'proj_old') {
        report({
          phase: 'error',
          error: { message: 'Broke', retryable: true }
        });
        throw new Error('Broke');
      }
      report({ phase: 'done', revisionsDone: 2 });
    });
    const controller = controllerWith(fake);
    await controller.run();
    expect(fake.migrated).toEqual(['proj_old', 'proj_new']);
    const state = controller.getState();
    expect(state.running).toBe(false);
    expect(state.projects.map((p) => [p.projectId, p.phase])).toEqual([
      ['proj_old', 'error'],
      ['proj_new', 'done']
    ]);
    // A retry of the failed one runs only that one.
    fake.migrated.length = 0;
    await controller.run(['proj_old']);
    expect(fake.migrated).toEqual(['proj_old']);
  });

  it('runs in one tab at a time', async () => {
    const fake = fakeEngine(async () => undefined);
    const locks: MigrationLocks = {
      request: async (_name, _options, callback) => callback(null)
    };
    const controller = controllerWith(fake, locks);
    await controller.run();
    expect(fake.migrated).toEqual([]);
    expect(controller.getState().otherTab).toBe(true);
  });

  it('pauses after the step in flight and badges the project meanwhile', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fake = fakeEngine(async (_summary, report, signal) => {
      report({ phase: 'revisions' });
      await gate;
      if (signal?.aborted) {
        report({ phase: 'paused' });
        throw new MigrationPausedError();
      }
    });
    const controller = controllerWith(fake);
    const running = controller.run();
    await waitFor(() =>
      expect(controller.getState().projects[0]?.phase).toBe('revisions')
    );
    expect([...migratingProjects()]).toEqual(['proj_old']);
    controller.pause();
    expect(controller.getState().pausing).toBe(true);
    release();
    await running;
    // It stopped there: the newer project never started.
    expect(fake.migrated).toEqual(['proj_old']);
    expect(controller.getState().projects[0]?.phase).toBe('paused');
    expect([...migratingProjects()]).toEqual([]);
  });
});

describe('editing a project while it is encrypted', () => {
  it('keeps it read-only while its staging holds the plaintext, stopped or not', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fake = fakeEngine(async (summary, report) => {
      if (summary.projectId === 'proj_new') {
        // Refused before anything was staged (a room ahead, say): the
        // plaintext stays writable, so the owner can open and save it.
        report({
          phase: 'error',
          error: { message: 'Save it first.', retryable: true }
        });
        throw new Error('room ahead');
      }
      // Starting: this page's edits are flushed, then the Worker locks it.
      await gate;
      report({ phase: 'revisions', plaintextLocked: true });
      report({
        phase: 'error',
        error: { message: 'Broke.', retryable: true }
      });
      throw new Error('Broke.');
    });
    const controller = controllerWith(fake);
    const running = controller.run();
    await waitFor(() =>
      expect(controller.getState().projects[0]?.phase).toBe('starting')
    );
    // Read-only from the start, before the flush.
    expect([...migrationLockedProjects()]).toEqual(['proj_old']);
    release();
    await running;
    expect(
      controller.getState().projects.map((p) => [p.projectId, p.phase])
    ).toEqual([
      ['proj_old', 'error'],
      ['proj_new', 'error']
    ]);
    // Stopped, its staging still locks the plaintext: still read-only,
    // though no longer badged as in progress. The one refused before
    // staging is editable.
    expect([...migratingProjects()]).toEqual([]);
    expect([...migrationLockedProjects()]).toEqual(['proj_old']);
    // Cancelled, the plaintext unlocks.
    await controller.cancel('proj_old');
    expect([...migrationLockedProjects()]).toEqual([]);
  });
});

describe('a project cut over before its purge finished', () => {
  it('stays listed as finishing, and its retry resumes the purge', async () => {
    // Listed as plaintext until the cutover, encrypted after.
    let storageFormat: 1 | 2 = 1;
    const plaintext = {
      listProjects: async () => [
        project('proj_old', 'Older bracket', '2026-10-01T00:00:00.000Z', {
          storageFormat
        })
      ]
    } as unknown as MigrationPlaintextSource;
    const status = vi.fn(async () => ({
      migration: { state: storageFormat === 2 ? 'purging' : 'staging' }
    }));
    const migrations = { status } as unknown as ProjectMigrationsApi;
    let purgeFails = true;
    const fake = fakeEngine(async (_summary, report) => {
      report({ phase: 'cutover' });
      storageFormat = 2;
      report({ phase: 'purging', cutOver: true });
      if (purgeFails) {
        report({
          phase: 'error',
          error: {
            code: 'PROJECT_ROOM_UNAVAILABLE',
            message: 'The project’s room could not be cleared right now.',
            retryable: true
          }
        });
        throw new Error('purge failed');
      }
      report({ phase: 'done' });
    });
    const controller = controllerWith(fake, null, { plaintext, migrations });
    render(
      <ExistingProjectEncryption
        userId="user_alice"
        unlocked
        controller={controller}
        isOpen={async () => true}
      />
    );
    fireEvent.click(
      await screen.findByRole('button', { name: 'Encrypt projects' })
    );
    const row = await screen.findByRole('listitem', { name: 'Older bracket' });
    expect(
      await within(row).findByText(
        'Stopped before the plaintext copy was deleted'
      )
    ).toBeTruthy();
    await waitFor(() => expect(controller.getState().running).toBe(false));

    // Listed again, now encrypted: it stays, as still finishing, and can
    // only be retried (an abandon after the cutover is refused).
    await act(() => controller.refresh());
    expect(controller.getState().projects).toMatchObject([
      { projectId: 'proj_old', phase: 'error', cutOver: true }
    ]);
    expect(status).toHaveBeenCalledWith('proj_old');
    expect(
      screen.getByText('1 project still finishing encryption')
    ).toBeTruthy();
    expect(within(row).queryByRole('button', { name: 'Cancel' })).toBeNull();
    expect(screen.queryByText('All your projects are encrypted')).toBeNull();

    // The retry runs the engine again, which resumes the purge.
    purgeFails = false;
    fireEvent.click(within(row).getByRole('button', { name: 'Retry' }));
    await waitFor(() =>
      expect(within(row).getByText('Encrypted')).toBeTruthy()
    );
    expect(fake.migrated).toEqual(['proj_old', 'proj_old']);
    expect(screen.getByText('All your projects are encrypted')).toBeTruthy();
  });
});

describe('a cut-over project this page has no record of', () => {
  it('is found after a reload, listed as finishing, and retried', async () => {
    // A fresh page (a reload or a crash after the cutover): no in-memory
    // record, only the listing, where the project already reads as
    // encrypted.
    const plaintext = {
      listProjects: async () => [
        project('proj_cut', 'Cut bracket', '2026-10-02T00:00:00.000Z', {
          storageFormat: 2
        }),
        project('proj_enc', 'Already encrypted', '2026-09-01T00:00:00.000Z', {
          storageFormat: 2
        }),
        project('proj_shared', 'Shared with me', '2026-09-02T00:00:00.000Z', {
          storageFormat: 2
        })
      ]
    } as unknown as MigrationPlaintextSource;
    let purged = false;
    const status = vi.fn(async (projectId: string) => {
      if (projectId === 'proj_shared') {
        throw Object.assign(new Error('Project not found.'), { status: 404 });
      }
      return {
        migration:
          projectId === 'proj_cut'
            ? { state: purged ? 'done' : 'purging' }
            : { state: 'done' }
      };
    });
    const migrations = { status } as unknown as ProjectMigrationsApi;
    const fake = fakeEngine(async (summary, report) => {
      expect(summary.projectId).toBe('proj_cut');
      report({ phase: 'purging', cutOver: true });
      purged = true;
      report({ phase: 'done' });
    });
    const controller = controllerWith(fake, null, { plaintext, migrations });
    render(
      <ExistingProjectEncryption
        userId="user_alice"
        unlocked
        controller={controller}
        isOpen={async () => true}
      />
    );
    const row = await screen.findByRole('listitem', { name: 'Cut bracket' });
    expect(
      within(row).getByText('Stopped before the plaintext copy was deleted')
    ).toBeTruthy();
    expect(controller.getState().projects).toMatchObject([
      { projectId: 'proj_cut', phase: 'error', cutOver: true }
    ]);
    expect(
      screen.getByText('1 project still finishing encryption')
    ).toBeTruthy();
    expect(screen.queryByText('All your projects are encrypted')).toBeNull();
    expect(within(row).queryByRole('button', { name: 'Cancel' })).toBeNull();
    // Read-only meanwhile, as a stop this page saw is.
    expect([...migrationLockedProjects()]).toEqual(['proj_cut']);
    // The finished one and the share are not asked about again.
    status.mockClear();
    await act(() => controller.refresh());
    expect(status.mock.calls.map(([id]) => id)).toEqual(['proj_cut']);

    fireEvent.click(within(row).getByRole('button', { name: 'Retry' }));
    await waitFor(() =>
      expect(within(row).getByText('Encrypted')).toBeTruthy()
    );
    expect(fake.migrated).toEqual(['proj_cut']);
    expect(screen.getByText('All your projects are encrypted')).toBeTruthy();
    expect([...migrationLockedProjects()]).toEqual([]);
  });

  it('asks about a large shelf a few at a time, a bounded number per refresh', async () => {
    const shelf = Array.from({ length: 30 }, (_, index) =>
      project(
        `proj_${String(index).padStart(2, '0')}`,
        `Encrypted ${index}`,
        `2026-09-${String(index + 1).padStart(2, '0')}T00:00:00.000Z`,
        { storageFormat: 2 }
      )
    );
    const plaintext = {
      listProjects: async () => shelf
    } as unknown as MigrationPlaintextSource;
    let inFlight = 0;
    let most = 0;
    const status = vi.fn(async (_projectId: string) => {
      inFlight += 1;
      most = Math.max(most, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 1));
      inFlight -= 1;
      return { migration: { state: 'done' } };
    });
    const migrations = { status } as unknown as ProjectMigrationsApi;
    const controller = controllerWith(
      fakeEngine(async () => undefined),
      null,
      { plaintext, migrations }
    );
    await controller.refresh();
    expect(status).toHaveBeenCalledTimes(24);
    expect(most).toBe(4);
    // Newest first; the rest on the next refresh, the settled ones never
    // again.
    expect(status.mock.calls[0]).toEqual(['proj_29']);
    status.mockClear();
    await controller.refresh();
    expect(status).toHaveBeenCalledTimes(6);
    status.mockClear();
    await controller.refresh();
    expect(status).not.toHaveBeenCalled();
    expect(controller.getState().projects).toEqual([]);
  });
});

describe('Settings › Encryption › Encrypt existing projects', () => {
  it('stays hidden until migration is open to the account', async () => {
    const fake = fakeEngine(async () => undefined);
    const { container } = render(
      <ExistingProjectEncryption
        userId="user_alice"
        unlocked
        controller={controllerWith(fake)}
        isOpen={async () => false}
      />
    );
    await act(async () => undefined);
    expect(container.textContent).toBe('');
  });

  it('says plainly what encrypting means, then shows progress, errors and retry', async () => {
    let fail = true;
    const fake = fakeEngine(async (summary, report) => {
      report({ phase: 'revisions', revisionsDone: 1, bytesDone: 1024 * 1024 });
      if (summary.projectId === 'proj_old' && fail) {
        report({
          phase: 'error',
          error: {
            message: 'Another device is encrypting it.',
            retryable: true
          }
        });
        throw new Error('leased');
      }
      report({ phase: 'done', revisionsDone: 2, bytesDone: 4 * 1024 * 1024 });
    });
    const controller = controllerWith(fake);
    render(
      <ExistingProjectEncryption
        userId="user_alice"
        unlocked
        controller={controller}
        isOpen={async () => true}
      />
    );
    expect(await screen.findByText('2 projects not encrypted')).toBeTruthy();
    // The honest copy: backups first, lost keys, 30-day backups.
    expect(screen.getByText(/\.openzcad/)).toBeTruthy();
    expect(screen.getByText(/cannot be recovered/)).toBeTruthy();
    expect(screen.getByText(/up to 30 days in backups/)).toBeTruthy();
    expect(
      screen.getByText(/added back with their current roles/)
    ).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Encrypt projects' }));
    const older = await screen.findByRole('listitem', {
      name: 'Older bracket'
    });
    expect(
      await within(older).findByText('Another device is encrypting it.')
    ).toBeTruthy();
    expect(
      within(older).getByText(/1 of 2 save states · 1\.0 of 4\.0 MB/)
    ).toBeTruthy();
    const newer = screen.getByRole('listitem', { name: 'Newer bracket' });
    await waitFor(() =>
      expect(within(newer).getByText('Encrypted')).toBeTruthy()
    );

    fail = false;
    fireEvent.click(within(older).getByRole('button', { name: 'Retry' }));
    await waitFor(() =>
      expect(within(older).getByText('Encrypted')).toBeTruthy()
    );
    expect(screen.getByText('All your projects are encrypted')).toBeTruthy();
  });

  it('cancels a stopped project, which unlocks its plaintext', async () => {
    const fake = fakeEngine(async (_summary, report) => {
      report({ phase: 'error', error: { message: 'Broke', retryable: true } });
      throw new Error('Broke');
    });
    const controller = controllerWith(fake);
    render(
      <ExistingProjectEncryption
        userId="user_alice"
        unlocked
        controller={controller}
        isOpen={async () => true}
      />
    );
    fireEvent.click(
      await screen.findByRole('button', { name: 'Encrypt projects' })
    );
    const older = await screen.findByRole('listitem', {
      name: 'Older bracket'
    });
    fireEvent.click(
      await within(older).findByRole('button', { name: 'Cancel' })
    );
    await waitFor(() =>
      expect(fake.engine.cancel).toHaveBeenCalledWith('proj_old')
    );
    await waitFor(() =>
      expect(within(older).getByText('Not encrypted')).toBeTruthy()
    );
  });
});

describe('a shared project (slice 7-4)', () => {
  const member = (
    email: string,
    role: MigrationMember['role'],
    state: MigrationMember['state']
  ): MigrationMember => ({
    userId: `user_${email}`,
    email,
    role,
    state,
    invitation: null
  });

  it('lists who is not ready and what they need to do, then offers encrypted links and invitations', async () => {
    let ready = false;
    const fake = fakeEngine(async (summary, report) => {
      if (summary.projectId !== 'proj_old') {
        report({ phase: 'done' });
        return;
      }
      if (!ready) {
        report({
          phase: 'members',
          members: [
            member('editor@example.com', 'editor', 'verify'),
            member('viewer@example.com', 'viewer', 'needs-encryption')
          ],
          error: {
            code: 'E2EE_MIGRATION_MEMBERS_NOT_READY',
            message: '2 members are not ready to be added yet.',
            retryable: true
          }
        });
        throw new Error('not ready');
      }
      report({
        phase: 'done',
        error: undefined,
        members: [
          member('editor@example.com', 'editor', 'readded'),
          member('viewer@example.com', 'viewer', 'readded')
        ],
        revoked: {
          shareLinks: [{ shareLinkId: 'link_1', mode: 'view' }],
          invitations: [
            {
              invitationId: 'inv_1',
              email: 'friend@example.com',
              role: 'editor'
            }
          ]
        }
      });
    });
    const controller = controllerWith(fake);
    render(
      <ExistingProjectEncryption
        userId="user_alice"
        unlocked
        controller={controller}
        isOpen={async () => true}
      />
    );
    fireEvent.click(
      await screen.findByRole('button', { name: 'Encrypt projects' })
    );
    const older = await screen.findByRole('listitem', {
      name: 'Older bracket'
    });
    expect(await within(older).findByText('Waiting for members')).toBeTruthy();
    const members = within(older).getByRole('list', {
      name: 'Members of Older bracket'
    });
    expect(within(members).getByText('editor@example.com')).toBeTruthy();
    expect(
      within(members).getByText(/Compare codes with editor@example\.com/)
    ).toBeTruthy();
    expect(
      within(members).getByText(
        /viewer@example\.com needs to set up encryption/
      )
    ).toBeTruthy();
    // Nothing was staged: there is nothing to cancel, only to check again.
    expect(within(older).queryByRole('button', { name: 'Cancel' })).toBeNull();

    ready = true;
    fireEvent.click(within(older).getByRole('button', { name: 'Check again' }));
    await waitFor(() =>
      expect(within(older).getByText('Encrypted')).toBeTruthy()
    );
    expect(within(older).getByText(/share link stopped working/)).toBeTruthy();
    expect(
      within(older).getByText(/invitation to friend@example\.com was revoked/)
    ).toBeTruthy();

    fireEvent.click(
      within(older).getByRole('button', { name: 'Create encrypted link' })
    );
    expect(
      await within(older).findByText('https://app.example/#share=new0')
    ).toBeTruthy();
    expect(followUps.reissued).toEqual([
      {
        projectId: 'proj_old',
        links: [{ shareLinkId: 'link_1', mode: 'view' }]
      }
    ]);

    fireEvent.click(
      within(older).getByRole('button', { name: 'Invite again' })
    );
    expect(
      await within(older).findByText(
        'Invited friend@example.com to the encrypted project.'
      )
    ).toBeTruthy();
    expect(followUps.reinvited).toEqual([
      {
        projectId: 'proj_old',
        invitations: [
          { invitationId: 'inv_1', email: 'friend@example.com', role: 'editor' }
        ]
      }
    ]);
    // Both offers are used up.
    expect(
      within(older).queryByRole('button', { name: 'Invite again' })
    ).toBeNull();
  });

  it('keeps a resumed staging that waits for a member read-only, and cancellable', async () => {
    const fake = fakeEngine(async (summary, report) => {
      if (summary.projectId !== 'proj_old') {
        report({ phase: 'done' });
        return;
      }
      // A staging left over (main's #922 lock) whose re-add waits for a
      // member who is no longer ready.
      report({
        plaintextLocked: true,
        phase: 'members',
        members: [member('editor@example.com', 'editor', 'waiting-for-keys')],
        error: {
          code: 'E2EE_MIGRATION_MEMBERS_NOT_READY',
          message: 'editor@example.com is not ready to be added yet.',
          retryable: true
        }
      });
      throw new Error('not ready');
    });
    const controller = controllerWith(fake);
    render(
      <ExistingProjectEncryption
        userId="user_alice"
        unlocked
        controller={controller}
        isOpen={async () => true}
      />
    );
    fireEvent.click(
      await screen.findByRole('button', { name: 'Encrypt projects' })
    );
    const older = await screen.findByRole('listitem', {
      name: 'Older bracket'
    });
    expect(await within(older).findByText('Waiting for members')).toBeTruthy();
    // The Worker still holds its plaintext: read-only, not badged as
    // being encrypted right now.
    await waitFor(() =>
      expect(migrationLockedProjects().has('proj_old')).toBe(true)
    );
    expect(migratingProjects().has('proj_old')).toBe(false);
    // Something is staged, so it can be dropped.
    fireEvent.click(
      await within(older).findByRole('button', { name: 'Cancel' })
    );
    await waitFor(() =>
      expect(fake.engine.cancel).toHaveBeenCalledWith('proj_old')
    );
  });
});
