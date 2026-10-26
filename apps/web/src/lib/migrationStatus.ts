/**
 * Which projects this page is encrypting right now (ADR-024 Phase 7, slice
 * 7-2), for the shelf's lock badge, and which of them the editor keeps
 * read-only: those plus any whose staging is paused or stopped while the
 * Worker still holds its plaintext locked, and any this page learned is
 * being encrypted elsewhere (another tab or device: its room closed for
 * the move, the account refused a save, or its migration status said so;
 * `projectMigrationWatch.ts`). No crypto: the engine that encrypts them
 * loads with Settings › Encryption.
 */
import { useSyncExternalStore } from 'react';

let migrating: ReadonlySet<string> = new Set();
/** Locked by this page's own runs. */
let locked: ReadonlySet<string> = new Set();
/** Locked by a migration this page learned of from the account. */
let elsewhere: ReadonlySet<string> = new Set();
/** `locked` and `elsewhere` together, as the editor and the shelf read it. */
let lockedView: ReadonlySet<string> = new Set();
const listeners = new Set<() => void>();

const same = (a: ReadonlySet<string>, b: ReadonlySet<string>) =>
  a.size === b.size && [...a].every((projectId) => b.has(projectId));

function publish() {
  const next = new Set([...locked, ...elsewhere]);
  if (!same(next, lockedView)) lockedView = next;
  for (const listener of listeners) listener();
}

/**
 * The projects being encrypted, and those locked for editing meanwhile
 * (by default the same ones).
 */
export function setMigratingProjects(
  projectIds: Iterable<string>,
  lockedProjectIds?: Iterable<string>
): void {
  const next = new Set(projectIds);
  const nextLocked = new Set(lockedProjectIds ?? next);
  for (const projectId of next) nextLocked.add(projectId);
  if (same(next, migrating) && same(nextLocked, locked)) return;
  if (!same(next, migrating)) migrating = next;
  if (!same(nextLocked, locked)) locked = nextLocked;
  publish();
}

/**
 * Records whether a project is being encrypted elsewhere (another tab or
 * device holds its staging, or it was cut over), as the account told this
 * page. Kept until the account says otherwise or the open workspace's
 * watch stops.
 */
export function setMigrationElsewhere(
  projectId: string,
  isLocked: boolean
): void {
  if (elsewhere.has(projectId) === isLocked) return;
  const next = new Set(elsewhere);
  if (isLocked) next.add(projectId);
  else next.delete(projectId);
  elsewhere = next;
  publish();
}

export function migrationElsewhere(): ReadonlySet<string> {
  return elsewhere;
}

export function useMigrationElsewhere(): ReadonlySet<string> {
  return useSyncExternalStore(
    subscribeMigratingProjects,
    migrationElsewhere,
    migrationElsewhere
  );
}

/** The projects this page's own runs keep read-only. */
export function migrationRunLockedProjects(): ReadonlySet<string> {
  return locked;
}

/**
 * Hears that the account turned a project away because it is being moved
 * to encrypted storage: its room closed for the move (code 4003) or a save
 * was refused with PROJECT_MIGRATING. Locked at once; the open workspace's
 * watch then asks the account how long for.
 */
type MigrationNotice = (projectId: string) => void;
const notices = new Set<MigrationNotice>();

export function noteProjectMigrating(projectId: string): void {
  setMigrationElsewhere(projectId, true);
  for (const notice of notices) notice(projectId);
}

export function subscribeProjectMigrating(notice: MigrationNotice): () => void {
  notices.add(notice);
  return () => notices.delete(notice);
}

export function subscribeMigratingProjects(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function migratingProjects(): ReadonlySet<string> {
  return migrating;
}

/** The projects this page is encrypting, re-rendered as that changes. */
export function useMigratingProjects(): ReadonlySet<string> {
  return useSyncExternalStore(
    subscribeMigratingProjects,
    migratingProjects,
    migratingProjects
  );
}

/**
 * The projects the editor keeps read-only while they are encrypted, here
 * or elsewhere.
 */
export function migrationLockedProjects(): ReadonlySet<string> {
  return lockedView;
}

export function useMigrationLockedProjects(): ReadonlySet<string> {
  return useSyncExternalStore(
    subscribeMigratingProjects,
    migrationLockedProjects,
    migrationLockedProjects
  );
}

/**
 * Saves this page's pending edits to a project before it is encrypted;
 * the open workspace registers it.
 */
type ProjectFlush = (projectId: string) => Promise<void>;
let projectFlush: ProjectFlush | null = null;

export function registerProjectFlush(flush: ProjectFlush | null): void {
  projectFlush = flush;
}

export async function flushProjectEdits(projectId: string): Promise<void> {
  await projectFlush?.(projectId);
}
