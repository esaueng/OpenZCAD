import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { E2eeConfigResponse } from '@openzcad/shared';
import type { AutomaticMigrationDeps } from './automaticMigration';
import type { MigrationController } from './projectMigrations';

const ON: E2eeConfigResponse = {
  enabled: true,
  projectsEnabled: true,
  migrationEnabled: true,
  defaultOn: true
};
beforeEach(() => vi.resetModules());

function fixture() {
  const state = {
    running: false,
    pausing: false,
    otherTab: false,
    error: null,
    projects: [
      { projectId: 'unfinished-purge', phase: 'error' },
      { projectId: 'complete', phase: 'done' }
    ]
  };
  const controller = {
    getState: () => state,
    refresh: vi.fn(async () => undefined),
    run: vi.fn(async () => undefined)
  } as unknown as MigrationController;
  const deps: AutomaticMigrationDeps = {
    config: vi.fn(async () => ON),
    prepare: vi.fn(async () => controller)
  };
  return { state, controller, deps, attention: vi.fn() };
}

describe('default-on automatic migration', () => {
  it('stays idle when an older or unavailable server cannot report default-on', async () => {
    const { automaticProjectMigration } = await import('./automaticMigration');
    const f = fixture();
    vi.mocked(f.deps.config).mockRejectedValue(
      new Error('Older Worker has no config route')
    );
    const migration = automaticProjectMigration('account', f.attention, f.deps);
    await migration.check();
    expect(f.attention).not.toHaveBeenCalled();
    expect(f.deps.prepare).not.toHaveBeenCalled();
    expect(f.controller.run).not.toHaveBeenCalled();
    migration.dispose();
  });

  it.each([
    { ...ON, defaultOn: false },
    { ...ON, defaultOn: undefined },
    { ...ON, enabled: false },
    { ...ON, projectsEnabled: false },
    { ...ON, migrationEnabled: false }
  ])(
    'does not load keys or migrate when any gate is closed: %j',
    async (config) => {
      const { automaticProjectMigration } =
        await import('./automaticMigration');
      const f = fixture();
      f.deps.config = vi.fn(async () => config);
      const migration = automaticProjectMigration(
        'account',
        f.attention,
        f.deps
      );
      await migration.check();
      expect(f.deps.prepare).not.toHaveBeenCalled();
      migration.dispose();
    }
  );

  it('opens existing key setup and continues once after recovery or device certification', async () => {
    const { automaticProjectMigration } = await import('./automaticMigration');
    const { encryptionStateChanged } = await import('./encryptionStateEvents');
    const f = fixture();
    vi.mocked(f.deps.prepare).mockResolvedValueOnce(
      'Set up and confirm recovery.'
    );
    const migration = automaticProjectMigration('account', f.attention, f.deps);
    await migration.check();
    expect(f.attention).toHaveBeenCalledWith('Set up and confirm recovery.');
    expect(f.controller.run).not.toHaveBeenCalled();
    encryptionStateChanged('different-account');
    expect(f.deps.prepare).toHaveBeenCalledTimes(1);
    encryptionStateChanged('account');
    await migration.check();
    expect(f.controller.run).toHaveBeenCalledWith(
      ['unfinished-purge'],
      expect.any(AbortSignal)
    );
    encryptionStateChanged('account');
    await migration.check();
    expect(f.controller.run).toHaveBeenCalledTimes(1);
    migration.dispose();
  });

  it('respects a manual run and never restarts it from setup notifications', async () => {
    const { automaticProjectMigration } = await import('./automaticMigration');
    const { encryptionStateChanged } = await import('./encryptionStateEvents');
    const f = fixture();
    f.state.running = true;
    const migration = automaticProjectMigration('account', f.attention, f.deps);
    await migration.check();
    f.state.running = false;
    encryptionStateChanged('account');
    await migration.check();
    expect(f.controller.refresh).not.toHaveBeenCalled();
    expect(f.controller.run).not.toHaveBeenCalled();
    migration.dispose();
  });

  it('disposal prevents a delayed availability response from opening keys or starting work', async () => {
    const { automaticProjectMigration } = await import('./automaticMigration');
    const f = fixture();
    let release!: (config: E2eeConfigResponse) => void;
    f.deps.config = vi.fn(
      () =>
        new Promise<E2eeConfigResponse>((resolve) => {
          release = resolve;
        })
    );
    const migration = automaticProjectMigration(
      'old-account',
      f.attention,
      f.deps
    );
    const checking = migration.check();
    migration.dispose();
    release(ON);
    await checking;
    expect(f.deps.prepare).not.toHaveBeenCalled();
    expect(f.attention).not.toHaveBeenCalled();
  });

  it('key teardown aborts an in-flight run and closing a settings scope does not', async () => {
    const { automaticProjectMigration } = await import('./automaticMigration');
    const { invalidateAccountKeyReads } = await import('./unlockedKeys');
    const session = await import('./keySession');
    const f = fixture();
    let signal!: AbortSignal;
    let finish!: () => void;
    vi.mocked(f.controller.run).mockImplementation(async (_ids, active) => {
      signal = active!;
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
    });
    const migration = automaticProjectMigration('account', f.attention, f.deps);
    const checking = migration.check();
    await vi.waitFor(() => expect(signal).toBeDefined());
    invalidateAccountKeyReads('account', {});
    expect(signal.aborted).toBe(false);
    session.beginKeySessionTeardown();
    expect(signal.aborted).toBe(true);
    finish();
    await checking;
    migration.dispose();
  });

  it('reports discovery failures without beginning a run', async () => {
    const { automaticProjectMigration } = await import('./automaticMigration');
    const f = fixture();
    vi.mocked(f.controller.refresh).mockRejectedValue(new Error('Offline'));
    const migration = automaticProjectMigration('account', f.attention, f.deps);
    await migration.check();
    expect(f.attention).toHaveBeenCalledWith('Offline');
    expect(f.controller.run).not.toHaveBeenCalled();
    migration.dispose();
  });
});
