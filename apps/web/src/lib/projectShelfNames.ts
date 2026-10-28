/** Last verified titles on this device, like local document summaries (ADR-024).
 * Presentation hints only: never a document, key, thumbnail reference or permission.
 */
import type { ProjectSummary } from '@openzcad/shared';
import {
  getKeySessionRevision,
  isCurrentKeySession,
  isKeySessionActive,
  subscribeKeySession
} from './e2ee/keySession';

interface NameHint {
  name: string;
  updatedAt: string;
}
export const SHELF_NAMES_PREFIX = 'openzcad:shelf-names:v1:';
const LIMIT = 1000;
let current:
  | { accountId: string; revision: number; names: Map<string, NameHint> }
  | undefined;
let timer: ReturnType<typeof setTimeout> | undefined;
const key = (accountId: string) =>
  SHELF_NAMES_PREFIX + encodeURIComponent(accountId);

function persist(scope: NonNullable<typeof current>): void {
  if (current !== scope || !isCurrentKeySession(scope.revision)) return;
  try {
    localStorage.setItem(
      key(scope.accountId),
      JSON.stringify(
        [...scope.names].map(([id, hint]) => [id, hint.name, hint.updatedAt])
      )
    );
  } catch {
    /* An optional display cache cannot fail project loading. */
  }
}

subscribeKeySession(() => {
  clearTimeout(timer);
  timer = undefined;
  current = undefined;
});

/** Only called with the account returned by this page's authenticated session. */
export function cachedShelfNames(
  accountId: string | null
): ReadonlyMap<string, NameHint> {
  if (!accountId || !isKeySessionActive()) return new Map();
  const revision = getKeySessionRevision();
  if (current?.accountId === accountId && current.revision === revision)
    return current.names;
  clearTimeout(timer);
  timer = undefined;
  const names = new Map<string, NameHint>();
  try {
    const saved: unknown = JSON.parse(
      localStorage.getItem(key(accountId)) ?? 'null'
    );
    if (Array.isArray(saved))
      for (const row of saved.slice(-LIMIT)) {
        if (!Array.isArray(row) || row.length !== 3) continue;
        const [id, name, updatedAt] = row as unknown[];
        if (
          typeof id === 'string' &&
          id.length > 0 &&
          id.length <= 128 &&
          typeof name === 'string' &&
          name.length > 0 &&
          name.length <= 1024 &&
          typeof updatedAt === 'string' &&
          Number.isFinite(Date.parse(updatedAt))
        )
          names.set(id, { name, updatedAt });
      }
  } catch {
    /* Unavailable/corrupt storage never holds up the library. */
  }
  current = { accountId, revision, names };
  return names;
}

/** Invoke only for output of encryptedProjectShelf's verifier. */
export function rememberVerifiedShelfName(
  accountId: string,
  project: ProjectSummary
): void {
  if (!accountId || !isKeySessionActive() || project.storageFormat !== 2)
    return;
  cachedShelfNames(accountId);
  const scope = current!;
  const previous = scope.names.get(project.projectId);
  if (previous && previous.updatedAt > project.updatedAt) return;
  scope.names.delete(project.projectId);
  scope.names.set(project.projectId, {
    name: project.name,
    updatedAt: project.updatedAt
  });
  if (scope.names.size > LIMIT)
    scope.names.delete(scope.names.keys().next().value!);
  // A stream of verified cards updates React immediately; coalesce disk writes.
  if (timer !== undefined) return;
  timer = setTimeout(() => {
    timer = undefined;
    persist(scope);
  }, 100);
}

/** Purged projects and withdrawn account memberships leave no stale title. */
export function forgetShelfProjectNames(
  accountId: string,
  projectIds: Iterable<string>,
  isCurrent?: () => boolean
): void {
  if (isCurrent?.() === false) return;
  if (!isKeySessionActive()) {
    forgetShelfNames(accountId);
    return;
  }
  cachedShelfNames(accountId);
  if (!current || current.accountId !== accountId) return;
  let changed = false;
  for (const id of projectIds) changed = current.names.delete(id) || changed;
  if (changed) persist(current);
}

/** Reuse a prior verified title while current encrypted metadata is pending. */
export function withCachedShelfNames(
  projects: ProjectSummary[],
  names: ReadonlyMap<string, NameHint>,
  pending: ReadonlySet<string> | undefined,
  local: ProjectSummary[]
): ProjectSummary[] {
  if (!pending?.size || !names.size) return projects;
  const device = new Map(local.map((project) => [project.projectId, project]));
  return projects.map((project) => {
    const hint = pending.has(project.projectId)
      ? names.get(project.projectId)
      : undefined;
    const localTitle = device.get(project.projectId);
    return hint &&
      (!localTitle || localTitle.updatedAt <= hint.updatedAt) &&
      project.name !== hint.name
      ? { ...project, name: hint.name }
      : project;
  });
}

export function forgetShelfNames(accountId: string): void {
  if (current?.accountId === accountId) {
    clearTimeout(timer);
    timer = undefined;
    current = undefined;
  }
  try {
    localStorage.removeItem(key(accountId));
  } catch {
    /* Storage unavailable. */
  }
}
