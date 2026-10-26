/**
 * Which projects this page is encrypting right now (ADR-024 Phase 7, slice
 * 7-2), for the shelf's lock badge. No crypto: the engine that encrypts
 * them loads with Settings › Encryption.
 */
import { useSyncExternalStore } from 'react';

let migrating: ReadonlySet<string> = new Set();
const listeners = new Set<() => void>();

export function setMigratingProjects(projectIds: Iterable<string>): void {
  const next = new Set(projectIds);
  if (
    next.size === migrating.size &&
    [...next].every((projectId) => migrating.has(projectId))
  ) {
    return;
  }
  migrating = next;
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
