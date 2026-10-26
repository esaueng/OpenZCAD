/**
 * Which projects this page is encrypting right now (ADR-024 Phase 7, slice
 * 7-2), for the shelf's lock badge, and which of them the editor keeps
 * read-only: those plus any whose staging is paused or stopped while the
 * Worker still holds its plaintext locked. No crypto: the engine that
 * encrypts them loads with Settings › Encryption.
 */
import { useSyncExternalStore } from 'react';

let migrating: ReadonlySet<string> = new Set();
let locked: ReadonlySet<string> = new Set();
const listeners = new Set<() => void>();

const same = (a: ReadonlySet<string>, b: ReadonlySet<string>) =>
  a.size === b.size && [...a].every((projectId) => b.has(projectId));

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
  for (const listener of listeners) listener();
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

/** The projects the editor keeps read-only while they are encrypted. */
export function migrationLockedProjects(): ReadonlySet<string> {
  return locked;
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
