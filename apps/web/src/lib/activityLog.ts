import { useSyncExternalStore } from 'react';
import { trimComponentStack } from './crashDiagnostics';

/**
 * The session's activity log: every status message, geometry phase, notice
 * and uncaught error, kept in memory for the life of the tab. It lives
 * outside React so the workspace, the start screen and Settings › Activity
 * log all read one record, and so a page that is not mounted still records.
 *
 * Errors alone also outlive the tab's memory: the newest few are kept in
 * localStorage, and `activityLogPersistence` puts them back at the head of the
 * next page load's log, marked as from an earlier load.
 */

export type ActivityLevel = 'ready' | 'running' | 'warning' | 'error';
export type ActivitySource = 'status' | 'geometry' | 'notice' | 'error';

export interface ActivityLogEntry {
  id: number;
  /** Epoch milliseconds. */
  timestamp: number;
  level: ActivityLevel;
  source: ActivitySource;
  message: string;
  detail?: string;
  /** Where the user was: a workspace mode label, or Projects. */
  workspace?: string;
  project?: string;
}

export interface ActivityLogSnapshot {
  entries: readonly ActivityLogEntry[];
  /** Entries dropped from the front to keep the log bounded. */
  dropped: number;
  /** When this log started: page load, or the last Clear. */
  startedAt: number;
}

export interface ActivityContext {
  workspace?: string;
  project?: string;
}

// A day-long session sends thousands of status ticks; past this the oldest
// go, so memory and the Settings list stay bounded.
export const MAX_ACTIVITY_LOG_ENTRIES = 1000;

let snapshot: ActivityLogSnapshot = {
  entries: [],
  dropped: 0,
  startedAt: Date.now()
};
let nextId = 0;
let context: ActivityContext = {};
const listeners = new Set<() => void>();

function publish(next: ActivityLogSnapshot) {
  snapshot = next;
  for (const listener of listeners) {
    listener();
  }
}

/** Publishes `all`, dropping the oldest past the bound and counting them. */
function publishBounded(all: ActivityLogEntry[]) {
  const overflow = Math.max(0, all.length - MAX_ACTIVITY_LOG_ENTRIES);
  publish({
    entries: overflow > 0 ? all.slice(overflow) : all,
    dropped: snapshot.dropped + overflow,
    startedAt: snapshot.startedAt
  });
}

/** Where later entries happen; stamped on each as it is recorded. */
export function setActivityContext(next: ActivityContext): void {
  context = {
    ...(next.workspace ? { workspace: next.workspace } : {}),
    ...(next.project ? { project: next.project } : {})
  };
}

/** Where errors are kept across reloads (by `activityLogPersistence`). */
export const PERSISTED_ERRORS_KEY = 'openzcad-activity-errors:v1';

/** localStorage, or null where it is blocked. */
export function activityErrorStore(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    // Storage blocked (private mode, sandboxed frame): memory only.
    return null;
  }
}

/**
 * The kept errors as stored, or null. Startup reads this before the page
 * records anything, so an error this load raises is never shown back to it
 * as one from an earlier load.
 */
export function readStoredErrors(): string | null {
  try {
    return activityErrorStore()?.getItem(PERSISTED_ERRORS_KEY) ?? null;
  } catch {
    return null;
  }
}

// Errors reach storage through the sink `activityLogPersistence` installs
// once it has loaded, just after startup; it first keeps the errors this load
// recorded before then, which are still in the log.
let errorSink: ((entry: ActivityLogEntry) => void) | null = null;

/** Installs (or, with null, removes) where errors are kept. */
export function setActivityErrorSink(
  sink: ((entry: ActivityLogEntry) => void) | null
): void {
  errorSink = sink;
}

/**
 * Puts entries at the head of the log: the errors restored from earlier page
 * loads and the page-load line, which arrive (lazily) after this load may
 * already have recorded something.
 */
export function prependActivity(
  entries: readonly Omit<ActivityLogEntry, 'id'>[]
): void {
  if (entries.length === 0) return;
  const all = [
    ...entries.map((entry) => ({ id: nextId++, ...entry })),
    ...snapshot.entries
  ];
  publishBounded(all);
}

export function recordActivity(
  entry: Omit<
    ActivityLogEntry,
    'id' | 'timestamp' | 'workspace' | 'project'
  > & {
    timestamp?: number;
  }
): void {
  const recorded: ActivityLogEntry = {
    id: nextId++,
    timestamp: entry.timestamp ?? Date.now(),
    level: entry.level,
    source: entry.source,
    message: entry.message,
    ...(entry.detail ? { detail: entry.detail } : {}),
    ...context
  };
  const all = [...snapshot.entries, recorded];
  publishBounded(all);
  if (recorded.level === 'error') errorSink?.(recorded);
}

/** The newest entry from one source, if any. */
export function lastActivity(
  source: ActivitySource
): ActivityLogEntry | undefined {
  for (let index = snapshot.entries.length - 1; index >= 0; index -= 1) {
    const entry = snapshot.entries[index]!;
    if (entry.source === source) {
      return entry;
    }
  }
  return undefined;
}

export function clearActivityLog(): void {
  try {
    activityErrorStore()?.removeItem(PERSISTED_ERRORS_KEY);
  } catch {
    // Blocked storage kept nothing to forget.
  }
  publish({ entries: [], dropped: 0, startedAt: Date.now() });
}

export function subscribeActivityLog(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getActivityLogSnapshot(): ActivityLogSnapshot {
  return snapshot;
}

export function useActivityLog(): ActivityLogSnapshot {
  return useSyncExternalStore(
    subscribeActivityLog,
    getActivityLogSnapshot,
    getActivityLogSnapshot
  );
}

export interface ActivityLogFilter {
  query?: string;
  /** Levels to keep; empty or absent keeps all. */
  levels?: ReadonlySet<ActivityLevel>;
  /** Sources to keep; empty or absent keeps all. */
  sources?: ReadonlySet<ActivitySource>;
}

export function filterActivityLog(
  entries: readonly ActivityLogEntry[],
  { query = '', levels, sources }: ActivityLogFilter
): ActivityLogEntry[] {
  const needle = query.trim().toLowerCase();
  return entries.filter(
    (entry) =>
      (!levels || levels.size === 0 || levels.has(entry.level)) &&
      (!sources || sources.size === 0 || sources.has(entry.source)) &&
      (needle === '' ||
        [entry.message, entry.detail, entry.workspace, entry.project]
          .filter(Boolean)
          .join('\n')
          .toLowerCase()
          .includes(needle))
  );
}

export const ACTIVITY_LEVEL_LABELS: Record<ActivityLevel, string> = {
  ready: 'Info',
  running: 'Progress',
  warning: 'Warning',
  error: 'Error'
};

export const ACTIVITY_SOURCE_LABELS: Record<ActivitySource, string> = {
  status: 'Status',
  geometry: 'Geometry',
  notice: 'Notice',
  error: 'Runtime error'
};

/** Plain text, one entry per block, ISO timestamps: for a bug report. */
export function formatActivityLogText(
  entries: readonly ActivityLogEntry[]
): string {
  return entries
    .map((entry) => {
      const where = [entry.project, entry.workspace]
        .filter(Boolean)
        .join(' · ');
      const head = `${new Date(entry.timestamp).toISOString()} ${ACTIVITY_LEVEL_LABELS[entry.level].toUpperCase()} [${ACTIVITY_SOURCE_LABELS[entry.source]}]${where ? ` (${where})` : ''} ${entry.message}`;
      return entry.detail
        ? `${head}\n${entry.detail
            .split('\n')
            .map((line) => `    ${line}`)
            .join('\n')}`
        : head;
    })
    .join('\n');
}

export function formatActivityLogJson(
  entries: readonly ActivityLogEntry[]
): string {
  return JSON.stringify(
    entries.map((entry) => ({
      ...entry,
      time: new Date(entry.timestamp).toISOString()
    })),
    null,
    2
  );
}

// Browser noise that says nothing about the app: the spec permits it and
// every engine raises it during ordinary layout.
const BENIGN_ERROR = /^ResizeObserver loop/;

function errorDetail(error: unknown, location?: string): string | undefined {
  const stack =
    error instanceof Error && error.stack
      ? error.stack.split('\n').slice(0, 12).join('\n')
      : undefined;
  return [location, stack].filter(Boolean).join('\n') || undefined;
}

/**
 * Records uncaught errors and unhandled rejections. Listening only: the
 * browser and any other handler still see each one. Returns the uninstaller.
 */
export function installRuntimeErrorCapture(
  target: Pick<Window, 'addEventListener' | 'removeEventListener'> = window
): () => void {
  const onError = (event: ErrorEvent) => {
    const message =
      event.message ||
      (event.error instanceof Error ? event.error.message : 'Script error');
    if (BENIGN_ERROR.test(message)) {
      return;
    }
    const location = event.filename
      ? `${event.filename}:${event.lineno}:${event.colno}`
      : undefined;
    recordActivity({
      level: 'error',
      source: 'error',
      message,
      ...optionalDetail(errorDetail(event.error, location))
    });
  };
  const onRejection = (event: PromiseRejectionEvent) => {
    const reason: unknown = event.reason;
    const message =
      reason instanceof Error
        ? reason.message || reason.name
        : typeof reason === 'string'
          ? reason
          : 'Unhandled promise rejection';
    recordActivity({
      level: 'error',
      source: 'error',
      message: `Unhandled rejection: ${message}`,
      ...optionalDetail(errorDetail(reason))
    });
  };
  target.addEventListener('error', onError as EventListener);
  target.addEventListener('unhandledrejection', onRejection as EventListener);
  return () => {
    target.removeEventListener('error', onError as EventListener);
    target.removeEventListener(
      'unhandledrejection',
      onRejection as EventListener
    );
  };
}

/**
 * Records a render crash an error boundary caught. React reports caught
 * errors only to the console, so without this a panel that fell over left
 * no trace in the log a user can copy.
 */
export function recordCaughtError(
  label: string,
  error: unknown,
  componentStack?: string | null
): void {
  const message =
    error instanceof Error
      ? error.message || error.name
      : typeof error === 'string'
        ? error
        : 'Unknown error';
  // Innermost first: the component that threw (or looped) leads.
  const components = trimComponentStack(componentStack);
  recordActivity({
    level: 'error',
    source: 'error',
    message: `${label} crashed: ${message}`,
    ...optionalDetail(
      [
        errorDetail(error),
        components ? `Component stack:\n${components}` : undefined
      ]
        .filter(Boolean)
        .join('\n') || undefined
    )
  });
}

function optionalDetail(detail: string | undefined): { detail?: string } {
  return detail ? { detail } : {};
}

/** Test seam: an empty log with fresh ids and no context. */
export function resetActivityLogForTests(): void {
  nextId = 0;
  context = {};
  snapshot = { entries: [], dropped: 0, startedAt: Date.now() };
  for (const listener of listeners) {
    listener();
  }
}
