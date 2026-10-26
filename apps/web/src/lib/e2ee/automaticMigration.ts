/** Default-on starts the journaled migration once per signed-in page session. */
import type { E2eeConfigResponse } from '@openzcad/shared';
import { desktopFetch } from '../desktopBridge';
import { subscribeEncryptionState } from './encryptionStateEvents';
import {
  getKeySessionRevision,
  isCurrentKeySession,
  isKeySessionActive,
  subscribeKeySession
} from './keySession';
import { invalidateAccountKeyReads, unlockedAccount } from './unlockedKeys';
import type { MigrationController } from './projectMigrations';

export interface AutomaticMigrationDeps {
  config(signal: AbortSignal): Promise<E2eeConfigResponse>;
  prepare(
    signal: AbortSignal,
    scope: object
  ): Promise<MigrationController | string>;
}

function pageDependencies(userId: string): AutomaticMigrationDeps {
  const config = async (signal: AbortSignal) => {
    const response = await desktopFetch('/api/e2ee/config', {
      credentials: 'same-origin',
      signal
    });
    if (!response.ok)
      throw new Error('Encryption availability could not be checked.');
    return (await response.json()) as E2eeConfigResponse;
  };
  return {
    config,
    async prepare(signal, scope) {
      // No cryptography or migration engine is loaded while default-on is off.
      const [keys, devices, api, preferences, migrations] = await Promise.all([
        import('./accountKeys'),
        import('./keychainDeviceKeys'),
        import('./e2eeApi'),
        import('./projectPreferences'),
        import('./projectMigrations')
      ]);
      const revision = getKeySessionRevision();
      const current = () => !signal.aborted && isCurrentKeySession(revision);
      const fetcher = async (path: string, init?: RequestInit) => {
        if (!current())
          throw new DOMException('Encryption session ended.', 'AbortError');
        const response = await desktopFetch(path, { ...init, signal });
        if (!current())
          throw new DOMException('Encryption session ended.', 'AbortError');
        return response;
      };
      const state = await keys.loadEncryption({
        userId,
        readScope: scope,
        api: api.createE2eeApi(fetcher),
        store: devices.deviceKeyStore(),
        isCurrent: current
      });
      if (!current())
        throw new DOMException('Encryption session ended.', 'AbortError');
      if (
        state.kind !== 'ready' ||
        !state.account.unlocked ||
        state.account.deviceStatus !== 'certified'
      ) {
        return 'Set up or unlock encryption on a certified device to encrypt your existing cloud projects. Save and confirm your recovery key when prompted.';
      }
      const account = unlockedAccount(userId);
      if (!account)
        throw new Error('Unlock encryption before migrating projects.');
      const ctx = {
        userId,
        accountKey: account.accountKey,
        api: preferences.createProjectPreferenceApi(fetcher),
        pins: preferences.localStoragePreferencePins()
      };
      let preference = await preferences.loadProjectPreference(ctx);
      if (preference.kind === 'refused') return preference.message;
      if (preference.kind !== 'verified' || !preference.encryptNewProjects) {
        preference = await preferences.saveProjectPreference(
          ctx,
          true,
          preferences.preferenceFloor(preference)
        );
      }
      if (!current())
        throw new DOMException('Encryption session ended.', 'AbortError');
      if (preference.kind !== 'verified' || !preference.encryptNewProjects) {
        return 'Confirm encryption for new projects before migrating existing projects.';
      }
      return migrations.pageMigrationController(userId);
    }
  };
}

export function automaticProjectMigration(
  userId: string,
  attention: (message: string) => void,
  deps: AutomaticMigrationDeps = pageDependencies(userId)
): { check(): Promise<void>; dispose(): void } {
  const scope = {};
  let disposed = false;
  let started = false;
  let checking: Promise<void> | null = null;
  let again = false;
  let active: AbortController | null = null;

  async function attempt() {
    if (disposed || started || !isKeySessionActive()) return;
    const stop = (active = new AbortController());
    const revision = getKeySessionRevision();
    const current = () =>
      !disposed && !stop.signal.aborted && isCurrentKeySession(revision);
    try {
      const config = await deps.config(stop.signal);
      if (
        !current() ||
        config.enabled !== true ||
        config.projectsEnabled !== true ||
        config.migrationEnabled !== true ||
        config.defaultOn !== true
      )
        return;
      const prepared = await deps.prepare(stop.signal, scope);
      if (!current()) return;
      if (typeof prepared === 'string') {
        attention(prepared);
        return;
      }
      // A manual run already owns this page's controller. Its pause/error state
      // stays with the user; readiness notifications never restart it.
      if (prepared.getState().running) {
        started = true;
        return;
      }
      await prepared.refresh();
      if (!current()) return;
      const state = prepared.getState();
      if (state.error) {
        attention(state.error);
        return;
      }
      const ids = state.projects
        .filter((project) => project.phase !== 'done')
        .map((project) => project.projectId);
      started = true;
      if (!ids.length) return;
      attention(
        'Encrypting existing cloud projects. You can follow progress or pause here; projects waiting for other members remain listed.'
      );
      // Explicit ids also resume an unfinished purge discovered after reload.
      await prepared.run(ids, stop.signal);
    } catch (error) {
      if (current())
        attention(
          error instanceof Error
            ? error.message
            : 'Existing projects could not be encrypted. Retry from Encryption settings.'
        );
    } finally {
      if (active === stop) active = null;
    }
  }

  function check(): Promise<void> {
    if (disposed) return Promise.resolve();
    if (checking) {
      again = true;
      return checking;
    }
    checking = (async () => {
      do {
        again = false;
        await attempt();
      } while (again && !disposed && !started);
    })().finally(() => {
      checking = null;
    });
    return checking;
  }
  const unsubscribeState = subscribeEncryptionState(userId, () => {
    void check();
  });
  const unsubscribeSession = subscribeKeySession((event) => {
    if (event.phase === 'ready') void check();
    else {
      active?.abort();
      invalidateAccountKeyReads(userId, scope);
      started = false;
    }
  });
  return {
    check,
    dispose() {
      disposed = true;
      active?.abort();
      invalidateAccountKeyReads(userId, scope);
      unsubscribeState();
      unsubscribeSession();
    }
  };
}
