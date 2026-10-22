import {
  projectOrganization,
  type ProjectOrganization,
  type ProjectSummary
} from '@openzcad/shared';
import type { LocalProjectOrganizationSnapshot } from './localProjectStore';

export interface OrganizationMirrorHost {
  readLocal(
    projectId: string
  ): Promise<LocalProjectOrganizationSnapshot | null>;
  saveLocal(
    projectId: string,
    organization: ProjectOrganization,
    expectedRevision: string | null,
    isCurrent?: () => boolean
  ): Promise<boolean>;
  updateRemote(
    projectId: string,
    organization: ProjectOrganization,
    signal?: AbortSignal
  ): Promise<void>;
}

export interface OrganizationMirrorScope {
  signal: AbortSignal;
  isCurrent(): boolean;
}

export function mirrorScopeCurrent(scope?: OrganizationMirrorScope): boolean {
  return !scope || (!scope.signal.aborted && scope.isCurrent());
}

export async function updateOrganizationRemote(
  host: OrganizationMirrorHost,
  projectId: string,
  organization: ProjectOrganization,
  scope?: OrganizationMirrorScope
): Promise<void> {
  if (!mirrorScopeCurrent(scope)) return;
  if (scope) await host.updateRemote(projectId, organization, scope.signal);
  else await host.updateRemote(projectId, organization);
}

export function acknowledgeOrganization(
  host: OrganizationMirrorHost,
  projectId: string,
  organization: ProjectOrganization,
  revision: string | null,
  scope?: OrganizationMirrorScope
): Promise<boolean> {
  return scope
    ? host.saveLocal(projectId, organization, revision, () =>
        mirrorScopeCurrent(scope)
      )
    : host.saveLocal(projectId, organization, revision);
}

export function sameWritableOrganization(
  left: ProjectOrganization,
  right: ProjectOrganization
): boolean {
  return (
    left.status === right.status &&
    left.pinned === right.pinned &&
    left.sortOrder === right.sortOrder
  );
}

/** Shelf PATCHes and reorder batches share one order, including across tabs.
 * Read the current device row only after acquiring the queue/lock: waiting
 * jobs coalesce to the latest pending choice rather than replaying old intent. */
export class OrganizationMirrorQueue {
  #tail: Promise<unknown> = Promise.resolve();

  run<T>(operation: () => Promise<T>): Promise<T> {
    const execute = () => {
      const locks = globalThis.navigator?.locks;
      return locks
        ? locks.request('openzcad-organization-mirror', operation)
        : operation();
    };
    const result = this.#tail.then(execute, execute);
    this.#tail = result.catch(() => undefined);
    return result;
  }
}

export const organizationMirrorQueue = new OrganizationMirrorQueue();

export function mirrorPendingOrganization(
  projectId: string,
  host: OrganizationMirrorHost,
  queue = organizationMirrorQueue,
  scope?: OrganizationMirrorScope
): Promise<void> {
  return queue.run(async () => {
    if (!mirrorScopeCurrent(scope)) return;
    const current = await host.readLocal(projectId);
    if (!current?.mirrorPending || !mirrorScopeCurrent(scope)) return;
    await updateOrganizationRemote(
      host,
      projectId,
      current.organization,
      scope
    );
    if (!mirrorScopeCurrent(scope)) return;
    await acknowledgeOrganization(
      host,
      projectId,
      current.organization,
      current.revision,
      scope
    );
  });
}

/** Keep reordering as one API batch. Its returned account rows identify any
 * still-pending pin/shelf edit the order-only endpoint cannot acknowledge. */
export function mirrorPendingReorder(
  projectIds: readonly string[],
  host: OrganizationMirrorHost,
  reorder: (projectIds: string[]) => Promise<ProjectSummary[]>,
  queue = organizationMirrorQueue,
  scope?: OrganizationMirrorScope
): Promise<void> {
  return queue.run(async () => {
    if (!mirrorScopeCurrent(scope)) return;
    const current = await Promise.all(
      projectIds.map(async (id) => ({ id, snapshot: await host.readLocal(id) }))
    );
    if (
      !mirrorScopeCurrent(scope) ||
      !current.some(({ snapshot }) => snapshot?.mirrorPending)
    )
      return;
    const ordered = current
      .filter(
        (
          entry
        ): entry is {
          id: string;
          snapshot: LocalProjectOrganizationSnapshot;
        } => entry.snapshot !== null
      )
      .sort(
        (a, b) =>
          a.snapshot.organization.sortOrder - b.snapshot.organization.sortOrder
      );
    const account = new Map<string, ProjectOrganization>(
      (await reorder(ordered.map(({ id }) => id))).map((project) => [
        project.projectId,
        projectOrganization(project)
      ])
    );
    for (const { id, snapshot } of ordered) {
      if (!mirrorScopeCurrent(scope)) return;
      if (!snapshot.mirrorPending) continue;
      const remote = account.get(id);
      if (!remote || !sameWritableOrganization(snapshot.organization, remote)) {
        await updateOrganizationRemote(host, id, snapshot.organization, scope);
      }
      if (!mirrorScopeCurrent(scope)) return;
      await acknowledgeOrganization(
        host,
        id,
        snapshot.organization,
        snapshot.revision,
        scope
      );
    }
  });
}

/** Account rows win unless this device holds a pending edit. Snapshot revisions
 * prevent an older listing from undoing an edit acknowledged while it loaded.
 * Failures remain excluded from retention purges until mirrored successfully. */
export async function reconcileRemoteOrganizations(
  local: ReadonlyMap<string, LocalProjectOrganizationSnapshot>,
  remote: ProjectSummary[],
  host: OrganizationMirrorHost,
  queue = organizationMirrorQueue
): Promise<Set<string>> {
  const failures = new Set<string>();
  await Promise.all(
    remote.map((project) =>
      queue
        .run(async () => {
          const previous = local.get(project.projectId) ?? null;
          const current = await host.readLocal(project.projectId);
          if (current?.revision !== previous?.revision) {
            if (current?.mirrorPending) failures.add(project.projectId);
            return;
          }
          const save = async (organization: ProjectOrganization) => {
            if (
              !(await host.saveLocal(
                project.projectId,
                organization,
                current?.revision ?? null
              ))
            )
              failures.add(project.projectId);
          };
          const account = projectOrganization(project);
          if (!current) {
            if (project.organization) await save(account);
            return;
          }
          if (sameWritableOrganization(current.organization, account)) {
            if (current.mirrorPending) await save(current.organization);
            return;
          }
          if (project.organization && !current.mirrorPending) {
            await save(account);
            return;
          }
          await host.updateRemote(project.projectId, current.organization);
          await save(current.organization);
        })
        .catch(() => {
          failures.add(project.projectId);
        })
    )
  );
  return failures;
}
