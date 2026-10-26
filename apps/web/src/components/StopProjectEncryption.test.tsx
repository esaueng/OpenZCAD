import {
  fireEvent,
  render,
  screen,
  waitFor,
  within
} from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { E2EE_MIGRATION_CODES, type ProjectSummary } from '@openzcad/shared';
import { createDecryptionController } from '../lib/e2ee/projectDecryption';
import type { ProjectDecryptionEngine } from '../lib/e2ee/projectDecryptionEngine';
import {
  memoryLeaseStore,
  type MigrationProgress
} from '../lib/e2ee/projectMigrationEngine';
import type { MigrationLocks } from '../lib/e2ee/projectMigrations';
import type { ProjectMigrationsApi } from '../lib/e2ee/projectMigrationsApi';
import { StopProjectEncryption } from './StopProjectEncryption';

const project = (
  projectId: string,
  name: string,
  extra: Partial<ProjectSummary> = {}
) =>
  ({
    projectId,
    name,
    revisionCount: 2,
    updatedAt: '2026-10-01T00:00:00.000Z',
    storageFormat: 2,
    ...extra
  }) as ProjectSummary;

const PROJECTS = [
  project('proj_secret', 'Secret bracket'),
  project('proj_plain', 'Plain bracket', { storageFormat: 1 })
];

function controllerWith(
  decrypt: (
    summary: ProjectSummary,
    report: (change: Partial<MigrationProgress>) => void
  ) => Promise<void>,
  locks: MigrationLocks | null = null
) {
  const decrypted: string[] = [];
  let onProgress: (progress: MigrationProgress) => void = () => undefined;
  const engine: ProjectDecryptionEngine = {
    async decrypt(summary) {
      decrypted.push(summary.projectId);
      let progress: MigrationProgress = {
        projectId: summary.projectId,
        name: summary.name,
        phase: 'starting',
        revisionsDone: 0,
        revisionsTotal: 2,
        bytesDone: 0,
        bytesTotal: 1024
      };
      const report = (change: Partial<MigrationProgress>) => {
        progress = { ...progress, ...change };
        onProgress(progress);
      };
      report({});
      await decrypt(summary, report);
    },
    cancel: vi.fn(async () => undefined)
  };
  const controller = createDecryptionController({
    userId: 'user_alice',
    listProjects: async () => PROJECTS,
    migrations: {
      status: async () => ({ migration: null })
    } as unknown as ProjectMigrationsApi,
    openReaders: async () => {
      throw new Error('not used');
    },
    createEngine: (listener) => {
      onProgress = listener;
      return engine;
    },
    leases: memoryLeaseStore(),
    locks
  });
  return { controller, decrypted, engine };
}

describe('Settings › Encryption › Stop encrypting a project', () => {
  it('is hidden unless the Worker opens the reverse path and the keys are unlocked', async () => {
    const { controller } = controllerWith(async () => undefined);
    const isOpen = vi.fn(async () => false);
    const { container, rerender } = render(
      <StopProjectEncryption
        userId="user_alice"
        unlocked
        controller={controller}
        isOpen={isOpen}
        optedIn={async () => false}
      />
    );
    await waitFor(() => expect(isOpen).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
    rerender(
      <StopProjectEncryption
        userId="user_alice"
        unlocked={false}
        controller={controller}
        isOpen={async () => true}
        optedIn={async () => false}
      />
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('lists encrypted projects, warns in plain words and runs only after confirmation', async () => {
    const { controller, decrypted } = controllerWith(async (_summary, report) =>
      report({ phase: 'done', revisionsDone: 2, bytesDone: 1024 })
    );
    render(
      <StopProjectEncryption
        userId="user_alice"
        unlocked
        controller={controller}
        isOpen={async () => true}
        optedIn={async () => false}
      />
    );
    expect(
      await screen.findByText(/readable by the OpenZCAD server again/)
    ).toBeInTheDocument();
    const row = await screen.findByRole('listitem', { name: 'Secret bracket' });
    expect(
      screen.queryByRole('listitem', { name: 'Plain bracket' })
    ).not.toBeInTheDocument();
    fireEvent.click(
      within(row).getByRole('button', { name: 'Stop encrypting this project' })
    );
    const confirm = within(row).getByRole('group', {
      name: 'Stop encrypting Secret bracket'
    });
    expect(confirm).toHaveTextContent(
      'will be stored readable by the server again'
    );
    const stop = within(confirm).getByRole('button', {
      name: 'Stop encrypting'
    });
    expect(stop).toBeDisabled();
    fireEvent.click(within(confirm).getByRole('checkbox'));
    expect(stop).toBeEnabled();
    expect(decrypted).toEqual([]);
    fireEvent.click(stop);
    await waitFor(() => expect(decrypted).toEqual(['proj_secret']));
    expect(await within(row).findByText('Not encrypted')).toBeInTheDocument();
  });

  it('keeps it encrypted when the confirmation is declined', async () => {
    const { controller, decrypted } = controllerWith(async () => undefined);
    render(
      <StopProjectEncryption
        userId="user_alice"
        unlocked
        controller={controller}
        isOpen={async () => true}
        optedIn={async () => false}
      />
    );
    const row = await screen.findByRole('listitem', { name: 'Secret bracket' });
    fireEvent.click(
      within(row).getByRole('button', { name: 'Stop encrypting this project' })
    );
    fireEvent.click(
      within(row).getByRole('button', { name: 'Keep it encrypted' })
    );
    expect(within(row).queryByRole('group')).not.toBeInTheDocument();
    expect(decrypted).toEqual([]);
  });

  it('disables the action while the account encrypts new projects', async () => {
    const { controller } = controllerWith(async () => undefined);
    render(
      <StopProjectEncryption
        userId="user_alice"
        unlocked
        controller={controller}
        isOpen={async () => true}
        optedIn={async () => true}
      />
    );
    expect(
      await screen.findByText(/Your account encrypts new projects/)
    ).toBeInTheDocument();
    const row = await screen.findByRole('listitem', { name: 'Secret bracket' });
    await waitFor(() =>
      expect(
        within(row).getByRole('button', {
          name: 'Stop encrypting this project'
        })
      ).toBeDisabled()
    );
  });

  it('shows the Worker’s refusal of a shared project in plain words', async () => {
    const { controller } = controllerWith(async () => {
      throw Object.assign(new Error('shared'), {
        status: 409,
        code: E2EE_MIGRATION_CODES.shared
      });
    });
    await controller.refresh();
    await controller.run('proj_secret');
    const progress = controller.getState().projects[0]!;
    expect(progress).toMatchObject({
      phase: 'error',
      error: { code: E2EE_MIGRATION_CODES.shared, retryable: false }
    });
    expect(progress.error?.message).toMatch(/nobody else can open/);
  });

  it('runs in one tab at a time, sharing the encrypting runner’s lock', async () => {
    const names: string[] = [];
    const held: MigrationLocks = {
      request: async (name, _options, callback) => {
        names.push(name);
        return callback(null);
      }
    };
    const { controller, decrypted } = controllerWith(
      async () => undefined,
      held
    );
    await controller.refresh();
    await controller.run('proj_secret');
    expect(names).toEqual(['openzcad-e2ee-migration:user_alice']);
    expect(controller.getState().otherTab).toBe(true);
    expect(decrypted).toEqual([]);
  });
});
