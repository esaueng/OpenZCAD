import {
  PERSISTED_ERRORS_KEY,
  activityErrorStore,
  getActivityLogSnapshot,
  prependActivity,
  setActivityErrorSink,
  type ActivityLogEntry
} from './activityLog';
import {
  APP_BUILD_COMMIT,
  buildDescription,
  environmentDescription
} from './crashEnvironment';

/**
 * The activity log's memory across reloads, loaded just after startup rather
 * than carried in the entry chunk. It keeps the newest errors in
 * localStorage, and heads each page load's log with the ones kept from
 * earlier loads and a line naming the build and browser this load runs on.
 * A log copied into a bug report then says what it was recorded on, and a
 * crash the user reloaded away from is still in it.
 */

/** The newest errors kept across reloads. */
export const MAX_PERSISTED_ERRORS = 10;
/** A kept error older than this is no longer shown, and is dropped. */
export const PERSISTED_ERROR_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
// A component stack and an error stack fit well inside this; it bounds a
// pathological message so ten of them stay small next to the storage quota.
const MAX_PERSISTED_TEXT = 4000;

interface PersistedError {
  timestamp: number;
  message: string;
  detail?: string;
  workspace?: string;
  project?: string;
  /** The app commit that recorded it: a crash may predate an update. */
  build: string;
}

function isPersistedError(value: unknown): value is PersistedError {
  if (!value || typeof value !== 'object') return false;
  const entry = value as Record<string, unknown>;
  return (
    typeof entry.timestamp === 'number' &&
    Number.isFinite(entry.timestamp) &&
    typeof entry.message === 'string' &&
    typeof entry.build === 'string' &&
    (entry.detail === undefined || typeof entry.detail === 'string') &&
    (entry.workspace === undefined || typeof entry.workspace === 'string') &&
    (entry.project === undefined || typeof entry.project === 'string')
  );
}

/** Stored errors that are well formed and under a week old, oldest first. */
function keptErrors(stored: string | null, now: number): PersistedError[] {
  let parsed: unknown;
  try {
    parsed = stored ? JSON.parse(stored) : [];
  } catch {
    return [];
  }
  return Array.isArray(parsed)
    ? parsed
        .filter(isPersistedError)
        .filter((entry) => now - entry.timestamp <= PERSISTED_ERROR_MAX_AGE_MS)
        .slice(-MAX_PERSISTED_ERRORS)
    : [];
}

function clip(text: string): string {
  return text.length > MAX_PERSISTED_TEXT
    ? `${text.slice(0, MAX_PERSISTED_TEXT)}…`
    : text;
}

function persistError(entry: ActivityLogEntry) {
  try {
    const store = activityErrorStore();
    if (!store) return;
    const kept = keptErrors(
      store.getItem(PERSISTED_ERRORS_KEY),
      entry.timestamp
    );
    const message = clip(entry.message);
    // A run of the same error (one raised every frame, a crash the automatic
    // remount hit again) is kept once: repeats must not push the distinct
    // errors before them out of the ten kept. Read from storage, not memory,
    // so a run that a Clear interrupted is kept again.
    if (kept.at(-1)?.message === message) return;
    kept.push({
      timestamp: entry.timestamp,
      message,
      ...(entry.detail ? { detail: clip(entry.detail) } : {}),
      ...(entry.workspace ? { workspace: entry.workspace } : {}),
      ...(entry.project ? { project: entry.project } : {}),
      build: APP_BUILD_COMMIT
    });
    store.setItem(
      PERSISTED_ERRORS_KEY,
      JSON.stringify(kept.slice(-MAX_PERSISTED_ERRORS))
    );
  } catch {
    // Quota or blocked storage: the in-memory log still has it.
  }
}

/**
 * From now on, errors the log records are kept across reloads; first those
 * this load recorded before the module arrived, which are still in the log.
 */
export function persistActivityErrors(): void {
  for (const entry of getActivityLogSnapshot().entries) {
    if (entry.level === 'error') persistError(entry);
  }
  setActivityErrorSink(persistError);
}

/**
 * The kept errors as log entries, oldest first, each marked as from an
 * earlier page load and with the build that recorded it.
 */
export function earlierErrorEntries(
  stored: string | null,
  now: number
): Omit<ActivityLogEntry, 'id'>[] {
  return keptErrors(stored, now).map((entry) => ({
    timestamp: entry.timestamp,
    level: 'error' as const,
    source: 'error' as const,
    message: `Earlier page load: ${entry.message}`,
    detail: [entry.detail, `Build ${entry.build.slice(0, 12)}`]
      .filter(Boolean)
      .join('\n'),
    ...(entry.workspace ? { workspace: entry.workspace } : {}),
    ...(entry.project ? { project: entry.project } : {})
  }));
}

/**
 * Heads the log with the earlier errors and the page-load line, then keeps
 * this load's errors (including any raised before this module loaded).
 * `stored` is what startup read before recording anything, and `loadedAt`
 * the log's `startedAt` then. Kept errors stay
 * stored until the log is cleared or they age out, so a second reload does
 * not lose them either. Returns how many errors were restored.
 */
export function restoreActivityLog({
  stored,
  loadedAt,
  now = Date.now(),
  environment = environmentDescription()
}: {
  stored: string | null;
  loadedAt: number;
  now?: number;
  environment?: string[];
}): number {
  // Before the earlier errors join the log: they are kept already.
  persistActivityErrors();
  // Cleared since the page loaded (this module can arrive late): what was
  // cleared stays cleared.
  if (getActivityLogSnapshot().startedAt !== loadedAt) return 0;
  const earlier = earlierErrorEntries(stored, now);
  prependActivity([
    ...earlier,
    {
      timestamp: loadedAt,
      level: 'ready',
      source: 'status',
      message: `Page loaded · ${buildDescription()}`,
      ...(environment.length > 0 ? { detail: environment.join('\n') } : {})
    }
  ]);
  return earlier.length;
}
