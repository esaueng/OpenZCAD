/**
 * Whether the open plaintext cloud project started moving to encrypted
 * storage somewhere else (ADR-024 Phase 7, slice 7-2): another tab of this
 * browser, or another device, began staging it. Its plaintext takes no
 * writes from then on, and an edit made here after the staging froze its
 * snapshot would be missing from the encrypted copy that replaces it, so
 * the workspace locks itself read-only as soon as it learns of it instead
 * of waiting for an autosave to be refused (which never comes with cloud
 * autosave off, and comes only after the debounce with it on).
 *
 * It learns of it three ways:
 * - the project's room closes with code 4003 ("This project is moving to
 *   encrypted storage."), or a save is refused with PROJECT_MIGRATING
 *   (`noteProjectMigrating`): locked at once, then confirmed by asking;
 * - asking the account for the project's migration (`GET
 *   /api/e2ee/projects/:id/migration`) when the workspace opens, when the
 *   page regains focus or becomes visible, and every
 *   {@link MIGRATION_WATCH_INTERVAL_MS} while it is visible: only when the
 *   account may migrate projects at all (`/api/e2ee/config`), so no other
 *   account sends a request more;
 * - this page's own runs changing what they lock (a cancel here may have
 *   abandoned the staging another tab's lock came from).
 *
 * A staging, cutover or purge locks; anything else (none, abandoned, or a
 * staging abandoned since) lifts a lock this watch set. No crypto.
 */
import { useEffect } from 'react';
import type {
  E2eeConfigResponse,
  E2eeProjectMigrationRecord,
  E2eeProjectMigrationResponse
} from '@openzcad/shared';
import { desktopFetch } from './desktopBridge';
import { createProjectMigrationsApi } from './e2ee/projectMigrationsApi';
import {
  migrationElsewhere,
  migrationRunLockedProjects,
  setMigrationElsewhere,
  subscribeMigratingProjects,
  subscribeProjectMigrating
} from './migrationStatus';

/** How often a visible workspace asks (judgment: a modest half minute). */
export const MIGRATION_WATCH_INTERVAL_MS = 30_000;
/** Focus and visibility ask at most this often. */
export const MIGRATION_WATCH_FOCUS_GAP_MS = 5_000;

/**
 * The plaintext is locked, or already replaced, by this migration. A
 * finished one stays locked: the open workspace still holds the plaintext
 * the encrypted copy replaced, so its edits would save nowhere. It unlocks
 * only once the workspace closes or reopens the project (#924 review).
 */
export function migrationLocksPlaintext(
  migration: E2eeProjectMigrationRecord | null
): boolean {
  return (
    migration !== null &&
    migration.direction === 'encrypt' &&
    (migration.state === 'staging' ||
      migration.state === 'cutover' ||
      migration.state === 'purging' ||
      migration.state === 'done')
  );
}

interface FocusTarget {
  addEventListener(type: string, listener: () => void): void;
  removeEventListener(type: string, listener: () => void): void;
}

export interface ProjectMigrationWatchOptions {
  readonly projectId: string;
  status(projectId: string): Promise<E2eeProjectMigrationResponse>;
  /** Whether the account may migrate projects; nothing is polled otherwise. */
  migrationOpen(): Promise<boolean>;
  readonly intervalMs?: number;
  readonly focusGapMs?: number;
  readonly now?: () => number;
  /** Where focus and visibility changes arrive (the window). */
  readonly focusTarget?: FocusTarget | null;
  readonly visibilityTarget?: FocusTarget | null;
  isVisible?(): boolean;
}

/** Starts watching; the returned function stops it. */
export function watchProjectMigration(
  options: ProjectMigrationWatchOptions
): () => void {
  const { projectId } = options;
  const intervalMs = options.intervalMs ?? MIGRATION_WATCH_INTERVAL_MS;
  const focusGapMs = options.focusGapMs ?? MIGRATION_WATCH_FOCUS_GAP_MS;
  const now = options.now ?? (() => Date.now());
  const isVisible =
    options.isVisible ??
    (() => globalThis.document?.visibilityState !== 'hidden');
  const focusTarget =
    options.focusTarget === undefined
      ? ((globalThis as { window?: FocusTarget }).window ?? null)
      : options.focusTarget;
  const visibilityTarget =
    options.visibilityTarget === undefined
      ? ((globalThis as { document?: FocusTarget }).document ?? null)
      : options.visibilityTarget;
  let stopped = false;
  /** The account may migrate projects, so this one is polled. */
  let polling = false;
  let timer: ReturnType<typeof setInterval> | null = null;
  let asking = false;
  let askAgain = false;
  let lastAsked = Number.NEGATIVE_INFINITY;
  /**
   * Bumped by anything newer than a question in flight (a room close, a
   * refusal, this page's own run): that answer may predate it, so it is
   * dropped and the question asked again.
   */
  let generation = 0;

  async function ask(): Promise<void> {
    if (stopped) return;
    if (asking) {
      askAgain = true;
      return;
    }
    asking = true;
    lastAsked = now();
    const asked = generation;
    try {
      const { migration } = await options.status(projectId);
      if (!stopped && asked === generation) {
        setMigrationElsewhere(projectId, migrationLocksPlaintext(migration));
      }
    } catch (error) {
      const status = (error as { status?: unknown } | null)?.status;
      // No migration status for this account or project (the feature off,
      // or not the owner's): nothing to poll. A lock stays as it was: the
      // room or the account said it moves.
      if (status === 501 || status === 404 || status === 403) stopPolling();
    } finally {
      asking = false;
      if ((askAgain || asked !== generation) && !stopped) {
        askAgain = false;
        void ask();
      }
    }
  }

  function stopPolling() {
    polling = false;
    if (timer !== null) clearInterval(timer);
    timer = null;
  }

  const onNotice = (noticed: string) => {
    if (noticed !== projectId) return;
    generation += 1;
    void ask();
  };
  let runLocked = migrationRunLockedProjects().has(projectId);
  const onLocks = () => {
    const next = migrationRunLockedProjects().has(projectId);
    if (next === runLocked) return;
    runLocked = next;
    generation += 1;
    if (polling || migrationElsewhere().has(projectId)) void ask();
  };
  const onFocus = () => {
    if (!isVisible()) return;
    if (!polling && !migrationElsewhere().has(projectId)) return;
    if (now() - lastAsked < focusGapMs) return;
    void ask();
  };
  const unsubscribeNotices = subscribeProjectMigrating(onNotice);
  const unsubscribeLocks = subscribeMigratingProjects(onLocks);
  focusTarget?.addEventListener('focus', onFocus);
  visibilityTarget?.addEventListener('visibilitychange', onFocus);

  // A lock learned before this workspace opened is asked about at once.
  if (migrationElsewhere().has(projectId)) void ask();
  void options.migrationOpen().then(
    (open) => {
      if (stopped || !open) return;
      polling = true;
      timer = setInterval(() => {
        if (polling && isVisible()) void ask();
      }, intervalMs);
      void ask();
    },
    () => undefined
  );

  // Stopped (the project closed, or it is no longer a plaintext project
  // this account owns): its lock is forgotten, as a refused save's was,
  // and a project opened again is asked about afresh.
  return () => {
    stopped = true;
    setMigrationElsewhere(projectId, false);
    stopPolling();
    unsubscribeNotices();
    unsubscribeLocks();
    focusTarget?.removeEventListener('focus', onFocus);
    visibilityTarget?.removeEventListener('visibilitychange', onFocus);
  };
}

const migrationOpenByUser = new Map<string, Promise<boolean>>();

/**
 * Whether the Worker opens migration to the signed-in account, asked once
 * per account and page; an answer that could not be had is asked again.
 */
function accountMigrationOpen(userId: string): Promise<boolean> {
  const known = migrationOpenByUser.get(userId);
  if (known) return known;
  const asked = (async () => {
    const response = await desktopFetch('/api/e2ee/config', {
      credentials: 'same-origin'
    });
    if (!response.ok) throw new Error(`${response.status}`);
    const config = (await response.json()) as E2eeConfigResponse;
    return config.migrationEnabled === true;
  })();
  migrationOpenByUser.set(userId, asked);
  asked.catch(() => migrationOpenByUser.delete(userId));
  return asked.catch(() => false);
}

/**
 * Watches the open project while it is a plaintext cloud project the
 * signed-in account owns (`projectId` null otherwise).
 */
export function useProjectMigrationWatch(
  projectId: string | null,
  userId: string | null
): void {
  useEffect(() => {
    if (!projectId || !userId) return;
    const migrations = createProjectMigrationsApi();
    return watchProjectMigration({
      projectId,
      status: (id) => migrations.status(id),
      migrationOpen: () => accountMigrationOpen(userId)
    });
  }, [projectId, userId]);
}
