import { projectOrganization, type ProjectSummary } from '@openzcad/shared';
import type { LocalProjectOrganizationSnapshot } from './localProjectStore';
import {
  mirrorScopeCurrent,
  acknowledgeOrganization,
  organizationMirrorQueue,
  sameWritableOrganization,
  updateOrganizationRemote,
  type OrganizationMirrorHost,
  type OrganizationMirrorQueue,
  type OrganizationMirrorScope
} from './projectOrganizationMirror';

export const ORGANIZATION_SESSION_KEY = 'openzcad.organization-session.v1';
export const ORGANIZATION_ADMISSION_PREFIX =
  'openzcad.organization-admission.v1:';
const INTERVAL_MS = 1_000; // At most 60 background writes/minute across tabs.
const BACKOFF_MS = 60_000; // Other account writes share the server's 120/minute.
const PASS_SIZE = 20;
type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;
export interface OrganizationLocks {
  request<T>(name: string, action: () => T | Promise<T>): Promise<T>;
}
export interface OrganizationDiscoveryScope extends OrganizationMirrorScope {
  /** Local discovery can own retention work while signed out. */
  ownsDiscovery(): boolean;
}
interface SessionMarker {
  accountId: string | null;
  token: string;
}
interface Admission {
  nextAt: number;
  blockedUntil: number;
}
function browserStorage(): StorageLike | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}
function browserLocks(): OrganizationLocks | null {
  const locks = globalThis.navigator?.locks;
  return locks
    ? { request: (name, action) => locks.request(name, action) }
    : null;
}
function readMarker(storage: StorageLike | null): SessionMarker | null {
  try {
    const value: unknown = JSON.parse(
      storage?.getItem(ORGANIZATION_SESSION_KEY) ?? 'null'
    );
    if (
      value &&
      typeof value === 'object' &&
      'accountId' in value &&
      (value.accountId === null || typeof value.accountId === 'string') &&
      'token' in value &&
      typeof value.token === 'string'
    )
      return value as SessionMarker;
  } catch {
    /* Unavailable storage cannot grant background admission. */
  }
  return null;
}
function readAdmission(storage: StorageLike, key: string): Admission {
  const value: unknown = JSON.parse(storage.getItem(key) ?? '{}');
  if (
    value &&
    typeof value === 'object' &&
    'nextAt' in value &&
    typeof value.nextAt === 'number' &&
    Number.isFinite(value.nextAt) &&
    'blockedUntil' in value &&
    typeof value.blockedUntil === 'number' &&
    Number.isFinite(value.blockedUntil)
  )
    return { nextAt: value.nextAt, blockedUntil: value.blockedUntil };
  return { nextAt: 0, blockedUntil: 0 };
}
function wait(ms: number, scope: OrganizationMirrorScope): Promise<boolean> {
  return new Promise((resolve) => {
    if (!mirrorScopeCurrent(scope)) {
      resolve(false);
      return;
    }
    const finish = () => {
      clearTimeout(timer);
      scope.signal.removeEventListener('abort', aborted);
      resolve(mirrorScopeCurrent(scope));
    };
    const aborted = () => finish();
    const timer = setTimeout(finish, ms);
    scope.signal.addEventListener('abort', aborted, { once: true });
  });
}

/** Local-only adoption. Pending rows never wait for a network lock or timer,
 * and are all protected from retention, including rows absent from the listing.
 * Do not acknowledge pending values using a stale listing: an older PATCH can
 * still be in flight even when that listing happens to agree with the edit. */
export async function prepareOrganizationMirrors(
  local: ReadonlyMap<string, LocalProjectOrganizationSnapshot>,
  remote: readonly ProjectSummary[],
  host: OrganizationMirrorHost,
  scope?: OrganizationMirrorScope
): Promise<{ pending: ProjectSummary[]; protectedProjectIds: Set<string> }> {
  const protectedProjectIds = new Set(
    [...local].filter(([, row]) => row.mirrorPending).map(([id]) => id)
  );
  const pending: ProjectSummary[] = [];
  for (let offset = 0; offset < remote.length; offset += 32) {
    if (!mirrorScopeCurrent(scope)) break;
    await Promise.all(
      remote.slice(offset, offset + 32).map(async (project) => {
        const previous = local.get(project.projectId);
        const account = projectOrganization(project);
        if (
          previous?.mirrorPending ||
          (previous &&
            !project.organization &&
            !sameWritableOrganization(previous.organization, account))
        ) {
          protectedProjectIds.add(project.projectId);
          pending.push(project);
          return;
        }
        if (
          !project.organization ||
          (previous && sameWritableOrganization(previous.organization, account))
        )
          return;
        try {
          if (
            !mirrorScopeCurrent(scope) ||
            !(await acknowledgeOrganization(
              host,
              project.projectId,
              account,
              previous?.revision ?? null,
              scope
            ))
          )
            protectedProjectIds.add(project.projectId);
        } catch {
          protectedProjectIds.add(project.projectId);
        }
      })
    );
  }
  return { pending, protectedProjectIds };
}

/** A lazy cursor owns at most one queued write. Admission sleeps occur before
 * enqueueing and outside both locks, so fresh actions can use the write queue.
 * No Web Locks/storage means no coordinated background admission; intent stays
 * durable for a later refresh and explicit user actions remain available. */
export class OrganizationMirrorBackground {
  readonly #storage: StorageLike | null;
  readonly #locks: OrganizationLocks | null;
  readonly #queue: OrganizationMirrorQueue;
  readonly #online: () => boolean;
  #scope: OrganizationDiscoveryScope | null = null;
  #accountId: string | null = null;
  #abort: AbortController | null = null;
  #jobs: readonly ProjectSummary[] = [];
  #cursor = 0;
  #host: OrganizationMirrorHost | null = null;
  #running: OrganizationMirrorScope | null = null;

  constructor(
    options: {
      storage?: StorageLike | null;
      locks?: OrganizationLocks | null;
      queue?: OrganizationMirrorQueue;
      online?: () => boolean;
    } = {}
  ) {
    this.#storage =
      options.storage === undefined ? browserStorage() : options.storage;
    this.#locks = options.locks === undefined ? browserLocks() : options.locks;
    this.#queue = options.queue ?? organizationMirrorQueue;
    this.#online =
      options.online ?? (() => globalThis.navigator?.onLine !== false);
  }

  begin(accountId: string | null): OrganizationDiscoveryScope {
    return this.#begin(accountId, false);
  }

  /** A failed session lookup or device-local cancellation is not a logout. */
  confirmSignedOut(): void {
    this.#begin(null, true);
  }

  #begin(
    accountId: string | null,
    confirmedSignOut: boolean
  ): OrganizationDiscoveryScope {
    this.#abort?.abort();
    this.#abort = new AbortController();
    this.#accountId = accountId;
    this.#jobs = [];
    this.#cursor = 0;
    let marker = readMarker(this.#storage);
    try {
      if (
        this.#storage &&
        (accountId !== null || confirmedSignOut) &&
        (!marker || marker.accountId !== accountId || confirmedSignOut)
      ) {
        marker = { accountId, token: crypto.randomUUID() };
        this.#storage?.setItem(
          ORGANIZATION_SESSION_KEY,
          JSON.stringify(marker)
        );
      }
    } catch {
      marker = null;
    }
    const token = marker?.token;
    const scope: OrganizationDiscoveryScope = {
      signal: this.#abort.signal,
      ownsDiscovery: () =>
        !scope.signal.aborted &&
        this.#scope === scope &&
        readMarker(this.#storage)?.token === token,
      isCurrent: () => accountId !== null && scope.ownsDiscovery()
    };
    this.#scope = scope;
    return scope;
  }

  scopeFor(accountId: string): OrganizationMirrorScope {
    if (this.#accountId === accountId && this.#scope) return this.#scope;
    return { signal: AbortSignal.abort(), isCurrent: () => false };
  }
  cancel(): void {
    this.begin(null);
  }
  dispose(): void {
    this.#abort?.abort();
    this.#jobs = [];
  }
  accountChanged(): void {
    if (this.#scope && !this.#scope.ownsDiscovery()) this.#abort?.abort();
  }
  start(
    scope: OrganizationMirrorScope,
    jobs: readonly ProjectSummary[],
    host: OrganizationMirrorHost
  ): void {
    if (!mirrorScopeCurrent(scope)) return;
    this.#jobs = jobs;
    this.#cursor = 0;
    this.#host = host;
    this.resume();
  }
  resume(): void {
    const scope = this.#scope,
      host = this.#host;
    if (
      !scope ||
      !host ||
      !mirrorScopeCurrent(scope) ||
      this.#running === scope
    )
      return;
    this.#running = scope;
    void this.#run(scope, host).finally(() => {
      if (this.#running === scope) this.#running = null;
    });
  }

  async #admit(
    scope: OrganizationMirrorScope,
    operation: (started: () => void) => Promise<void>
  ): Promise<boolean> {
    if (!this.#locks || !this.#storage || !this.#accountId) return false;
    const key = ORGANIZATION_ADMISSION_PREFIX + this.#accountId;
    while (mirrorScopeCurrent(scope) && this.#online()) {
      // This account's grant covers the one queued request. Other background
      // tabs wait here, not in the network queue. Pacing timers hold no lock.
      const delay = await this.#locks.request(key, async () => {
        if (!mirrorScopeCurrent(scope)) return null;
        const budget = readAdmission(this.#storage!, key),
          now = Date.now();
        const remaining = Math.max(budget.nextAt, budget.blockedUntil) - now;
        if (remaining > 0) return Math.min(remaining, BACKOFF_MS);
        try {
          await operation(() => {
            this.#storage!.setItem(
              key,
              JSON.stringify({ ...budget, nextAt: Date.now() + INTERVAL_MS })
            );
          });
        } catch (error) {
          if (
            mirrorScopeCurrent(scope) &&
            error &&
            typeof error === 'object' &&
            'status' in error &&
            error.status === 429
          ) {
            this.#storage!.setItem(
              key,
              JSON.stringify({
                ...readAdmission(this.#storage!, key),
                blockedUntil: Date.now() + BACKOFF_MS
              })
            );
          }
          throw error;
        }
        return 0;
      });
      if (delay === null || !mirrorScopeCurrent(scope)) return false;
      if (delay === 0) return true;
      if (!(await wait(delay, scope))) return false;
    }
    return false;
  }
  async #run(
    scope: OrganizationMirrorScope,
    host: OrganizationMirrorHost
  ): Promise<void> {
    let pass = 0;
    while (
      this.#cursor < this.#jobs.length &&
      mirrorScopeCurrent(scope) &&
      this.#online()
    ) {
      if (!(await wait(pass++ % PASS_SIZE === 0 ? 25 : 0, scope))) return;
      const project = this.#jobs[this.#cursor]!;
      try {
        const before = await host.readLocal(project.projectId);
        if (!mirrorScopeCurrent(scope)) return;
        if (
          !before ||
          (!before.mirrorPending &&
            (project.organization ||
              sameWritableOrganization(
                before.organization,
                projectOrganization(project)
              )))
        ) {
          this.#cursor++;
          continue;
        }
        if (
          !(await this.#admit(scope, (started) =>
            this.#queue.run(async () => {
              if (!mirrorScopeCurrent(scope)) return;
              const current = await host.readLocal(project.projectId);
              if (
                !current ||
                !mirrorScopeCurrent(scope) ||
                (!current.mirrorPending &&
                  (project.organization ||
                    sameWritableOrganization(
                      current.organization,
                      projectOrganization(project)
                    )))
              )
                return;
              started();
              await updateOrganizationRemote(
                host,
                project.projectId,
                current.organization,
                scope
              );
              if (mirrorScopeCurrent(scope))
                await acknowledgeOrganization(
                  host,
                  project.projectId,
                  current.organization,
                  current.revision,
                  scope
                );
            })
          ))
        )
          return;
        this.#cursor++;
      } catch (error) {
        if (!mirrorScopeCurrent(scope)) return;
        const status =
          error && typeof error === 'object' && 'status' in error
            ? error.status
            : undefined;
        if (status === 429) continue;
        else if (status === 403 || status === 404) this.#cursor++;
        else return; // Retry on an online event or the next refresh, not a loop.
      }
    }
  }
}
