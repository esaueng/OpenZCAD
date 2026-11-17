/**
 * Loads the default-on migration controller (`automaticMigration.ts`) off
 * the entry chunk, and keeps trying when the load fails.
 *
 * Nothing optional loads until the server confirms all four rollout gates
 * (`/api/e2ee/config`: enabled, projects, migration and default-on). With
 * any gate closed, an older Worker answering 404 or the check unreachable,
 * no chunk is requested and Settings stays closed; the same triggers below
 * ask again (#953; `encryption-settings.spec.ts`, "closed gates").
 *
 * The controller registers its own retry triggers (back online, an
 * encryption-state change, a key session becoming ready), so a chunk that
 * never arrives would leave automatic migration off for the whole session
 * with nothing said. This loader lives in the entry chunk instead: a load
 * that fails while the page is online is reported
 * (`AUTOMATIC_MIGRATION_LOAD_ERROR`; offline it is only retried), and the
 * same three
 * triggers retry the load until it succeeds or the session ends. Once the
 * controller has loaded, its own listeners take over.
 */
import type { E2eeConfigResponse } from '@openzcad/shared';
import { desktopFetch } from '../desktopBridge';
import { subscribeEncryptionState } from './encryptionStateEvents';
import { subscribeKeySession } from './keySession';

export const AUTOMATIC_MIGRATION_LOAD_ERROR =
  'Automatic encryption could not load. Reload to try again.';

/** The controller module's surface this loader uses. */
export interface AutomaticMigrationModule {
  automaticProjectMigration(
    userId: string,
    attention: (message: string) => void
  ): { check(): Promise<void>; dispose(): void };
}

export interface AutomaticMigrationLoaderOptions {
  /** Injected in tests; the app asks `/api/e2ee/config`. */
  readonly gatesOpen?: () => Promise<boolean>;
  /** Injected in tests; the app imports the controller chunk. */
  readonly load?: () => Promise<AutomaticMigrationModule>;
  /** False once the session this load was for is no longer current. */
  readonly current?: () => boolean;
  /** Called when the controller loads after an earlier load failed. */
  readonly recovered?: () => void;
}

const loadController = () =>
  import('./automaticMigration') as Promise<AutomaticMigrationModule>;

/**
 * Whether the server opens every automatic-migration gate. Anything but a
 * clear yes on all four, including an older Worker, reads as closed.
 */
async function migrationGatesOpen(): Promise<boolean> {
  const response = await desktopFetch('/api/e2ee/config', {
    credentials: 'same-origin'
  });
  if (!response.ok) return false;
  const config = (await response.json()) as Partial<E2eeConfigResponse>;
  return (
    config.enabled === true &&
    config.projectsEnabled === true &&
    config.migrationEnabled === true &&
    config.defaultOn === true
  );
}

/** Whether the browser says it is offline now. */
const offline = () =>
  typeof navigator !== 'undefined' && navigator.onLine === false;

/**
 * Starts the controller for `userId`, loading it first. `attention` hears
 * both the controller's messages and this loader's load failure. Returns
 * the disposer; nothing runs after it is called.
 */
export function startAutomaticMigration(
  userId: string,
  attention: (message: string) => void,
  {
    gatesOpen = migrationGatesOpen,
    load = loadController,
    current = () => true,
    recovered = () => undefined
  }: AutomaticMigrationLoaderOptions = {}
): { dispose(): void; loaded(): Promise<void> } {
  let disposed = false;
  let failed = false;
  let controller: { dispose(): void } | null = null;
  let loading: Promise<void> | null = null;
  /** A trigger arrived while a check was in flight; its answer may be stale. */
  let again = false;
  const live = () => !disposed && current();

  const detach: Array<() => void> = [];
  const stopRetrying = () => {
    for (const undo of detach.splice(0)) undo();
  };

  function attempt(): Promise<void> {
    if (!live() || controller) return Promise.resolve();
    if (loading) {
      again = true;
      return loading;
    }
    loading = gatesOpen()
      // A check that cannot be made reads as closed, said nowhere, and is
      // asked again on the next trigger.
      .catch(() => false)
      .then((open) => (open && live() && !controller ? load() : null))
      .then(
        (module) => {
          if (!module) return;
          if (!live() || controller) return;
          stopRetrying();
          if (failed) recovered();
          const started = module.automaticProjectMigration(
            userId,
            (message) => {
              if (live()) attention(message);
            }
          );
          controller = started;
          void started.check();
        },
        () => {
          // Retried on the next trigger below. Reported only while this
          // page is online: offline, a chunk is expected not to arrive, and
          // coming back online retries it. Reporting it would open
          // Settings over whatever the page shows offline (the startup
          // screen's "You're offline" wait, `offline-startup.spec.ts`).
          if (offline()) return;
          failed = true;
          if (live()) attention(AUTOMATIC_MIGRATION_LOAD_ERROR);
        }
      )
      .finally(() => {
        loading = null;
        if (again) {
          again = false;
          void attempt();
        }
      });
    return loading;
  }

  const retry = () => {
    void attempt();
  };
  detach.push(subscribeEncryptionState(userId, retry));
  detach.push(
    subscribeKeySession((event) => {
      if (event.phase === 'ready') retry();
    })
  );
  if (typeof window !== 'undefined') {
    window.addEventListener('online', retry);
    detach.push(() => window.removeEventListener('online', retry));
  }
  const first = attempt();

  return {
    loaded: () => loading ?? first,
    dispose() {
      disposed = true;
      stopRetrying();
      controller?.dispose();
      controller = null;
    }
  };
}
