/**
 * Review round 12 of PR #1418: a migration controller chunk that fails to
 * load must be reported, and retried on the triggers the controller would
 * have registered itself (back online, an encryption-state change, a key
 * session becoming ready), not silently leave automatic migration off.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AutomaticMigrationModule } from './automaticMigrationLoader';

beforeEach(() => vi.resetModules());

function controllerModule() {
  const controller = {
    check: vi.fn(async () => undefined),
    dispose: vi.fn()
  };
  const module: AutomaticMigrationModule = {
    automaticProjectMigration: vi.fn(() => controller)
  };
  return { controller, module };
}

const chunkError = () =>
  new TypeError('Failed to fetch dynamically imported module');

describe('loading the automatic migration controller', () => {
  it('reports a failed load and retries it when the page comes back online', async () => {
    const { startAutomaticMigration, AUTOMATIC_MIGRATION_LOAD_ERROR } =
      await import('./automaticMigrationLoader');
    const { controller, module } = controllerModule();
    const load = vi
      .fn<() => Promise<AutomaticMigrationModule>>()
      .mockRejectedValueOnce(chunkError())
      .mockResolvedValue(module);
    const attention = vi.fn();
    const recovered = vi.fn();
    const migration = startAutomaticMigration('account', attention, {
      load,
      recovered
    });
    await migration.loaded();
    expect(attention).toHaveBeenCalledWith(AUTOMATIC_MIGRATION_LOAD_ERROR);
    expect(module.automaticProjectMigration).not.toHaveBeenCalled();

    window.dispatchEvent(new Event('online'));
    await vi.waitFor(() => expect(controller.check).toHaveBeenCalledOnce());
    expect(load).toHaveBeenCalledTimes(2);
    expect(recovered).toHaveBeenCalledOnce();

    // Loaded: the controller's own listeners take over; no more loads.
    window.dispatchEvent(new Event('online'));
    expect(load).toHaveBeenCalledTimes(2);
    migration.dispose();
    expect(controller.dispose).toHaveBeenCalledOnce();
  });

  // offline-startup.spec.ts on PR #1418: a load that failed because the
  // page went offline opened Settings over the startup screen's offline
  // wait. Offline it is only retried, when the page comes back online.
  it('says nothing of a load that fails offline, and retries it online', async () => {
    const { startAutomaticMigration } =
      await import('./automaticMigrationLoader');
    const { controller, module } = controllerModule();
    const load = vi
      .fn<() => Promise<AutomaticMigrationModule>>()
      .mockRejectedValueOnce(chunkError())
      .mockResolvedValue(module);
    const attention = vi.fn();
    const onLine = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    try {
      const migration = startAutomaticMigration('account', attention, {
        load
      });
      await migration.loaded();
      expect(attention).not.toHaveBeenCalled();

      onLine.mockReturnValue(true);
      window.dispatchEvent(new Event('online'));
      await vi.waitFor(() => expect(controller.check).toHaveBeenCalledOnce());
      expect(attention).not.toHaveBeenCalled();
      migration.dispose();
    } finally {
      onLine.mockRestore();
    }
  });

  it('retries on an encryption-state change and a key session becoming ready', async () => {
    const { startAutomaticMigration } =
      await import('./automaticMigrationLoader');
    const { encryptionStateChanged } = await import('./encryptionStateEvents');
    const session = await import('./keySession');
    const { controller, module } = controllerModule();
    const load = vi
      .fn<() => Promise<AutomaticMigrationModule>>()
      .mockRejectedValueOnce(chunkError())
      .mockRejectedValueOnce(chunkError())
      .mockResolvedValue(module);
    const migration = startAutomaticMigration('account', vi.fn(), { load });
    await migration.loaded();

    encryptionStateChanged('account');
    await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(2));
    await migration.loaded();
    expect(controller.check).not.toHaveBeenCalled();

    session.blockKeySession();
    session.allowKeySession(session.getKeySessionRevision());
    await vi.waitFor(() => expect(controller.check).toHaveBeenCalledOnce());
    expect(load).toHaveBeenCalledTimes(3);
    migration.dispose();
  });

  it('stops retrying once disposed or the session moved on', async () => {
    const { startAutomaticMigration } =
      await import('./automaticMigrationLoader');
    const load = vi
      .fn<() => Promise<AutomaticMigrationModule>>()
      .mockRejectedValue(chunkError());
    const attention = vi.fn();
    let current = true;
    const migration = startAutomaticMigration('account', attention, {
      load,
      current: () => current
    });
    await migration.loaded();
    expect(attention).toHaveBeenCalledOnce();

    current = false;
    window.dispatchEvent(new Event('online'));
    await Promise.resolve();
    expect(load).toHaveBeenCalledOnce();

    current = true;
    migration.dispose();
    window.dispatchEvent(new Event('online'));
    await Promise.resolve();
    expect(load).toHaveBeenCalledOnce();
    expect(attention).toHaveBeenCalledOnce();
  });

  it('starts nothing when disposed while the chunk was loading', async () => {
    const { startAutomaticMigration } =
      await import('./automaticMigrationLoader');
    const { module } = controllerModule();
    let resolve!: (value: AutomaticMigrationModule) => void;
    const load = vi.fn(
      () =>
        new Promise<AutomaticMigrationModule>((done) => {
          resolve = done;
        })
    );
    const migration = startAutomaticMigration('account', vi.fn(), { load });
    migration.dispose();
    resolve(module);
    await migration.loaded();
    expect(module.automaticProjectMigration).not.toHaveBeenCalled();
  });
});
