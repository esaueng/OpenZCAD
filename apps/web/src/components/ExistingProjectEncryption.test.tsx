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
import {
  migratingProjects,
  setMigratingProjects
} from '../lib/migrationStatus';
import { ExistingProjectEncryption } from './ExistingProjectEncryption';

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
  locks: MigrationLocks | null = null
) {
  const controller = createMigrationController({
    userId: 'user_alice',
    plaintext: plaintextSource(),
    migrations: {} as never,
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
      screen.getByText(/Shared projects cannot be encrypted yet/)
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
