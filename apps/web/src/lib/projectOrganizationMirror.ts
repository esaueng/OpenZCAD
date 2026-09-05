import {
  projectOrganization,
  type ProjectOrganization,
  type ProjectSummary
} from '@openzcad/shared';

export interface OrganizationMirrorHost {
  saveLocal(
    projectId: string,
    organization: ProjectOrganization,
    options: { mirrorPending: boolean }
  ): Promise<void>;
  updateRemote(
    projectId: string,
    organization: ProjectOrganization
  ): Promise<void>;
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

/**
 * Settles each listed project's shelf state between this device and the
 * account.
 *
 * The account is authoritative unless this device holds a change that has
 * not reached it yet — the `mirrorPending` flag a local write sets and a
 * successful mirror clears. Before that flag existed the device row always
 * won, so a project trashed on one device came back the moment another
 * device listed the shelf, and every device undid every other.
 *
 * | device row | account row | pending | action                               |
 * | ---------- | ----------- | ------- | ------------------------------------ |
 * | none       | any         | —       | adopt the account row                |
 * | equal      | equal       | yes     | clear the flag                       |
 * | differs    | none        | —       | push the device row (never organised)|
 * | differs    | present     | yes     | push the device row; keep flag on failure |
 * | differs    | present     | no      | adopt the account row                |
 *
 * Returns the projects whose push failed, so the caller can defer purging
 * a local tombstone the account has not yet seen.
 */
export async function reconcileRemoteOrganizations(
  local: ReadonlyMap<string, ProjectOrganization>,
  pending: ReadonlySet<string>,
  remote: ProjectSummary[],
  host: OrganizationMirrorHost
): Promise<Set<string>> {
  const mirrorFailures = new Set<string>();
  await Promise.all(
    remote.map(async (project) => {
      const localOrganization = local.get(project.projectId);
      const isPending = pending.has(project.projectId);
      if (!localOrganization) {
        if (project.organization) {
          await host
            .saveLocal(project.projectId, project.organization, {
              mirrorPending: false
            })
            .catch(() => undefined);
        }
        return;
      }
      const remoteOrganization = projectOrganization(project);
      if (sameWritableOrganization(localOrganization, remoteOrganization)) {
        if (isPending) {
          await host
            .saveLocal(project.projectId, localOrganization, {
              mirrorPending: false
            })
            .catch(() => undefined);
        }
        return;
      }
      if (project.organization && !isPending) {
        await host
          .saveLocal(project.projectId, project.organization, {
            mirrorPending: false
          })
          .catch(() => undefined);
        return;
      }
      try {
        await host.updateRemote(project.projectId, localOrganization);
      } catch {
        mirrorFailures.add(project.projectId);
        return;
      }
      if (isPending) {
        await host
          .saveLocal(project.projectId, localOrganization, {
            mirrorPending: false
          })
          .catch(() => undefined);
      }
    })
  );
  return mirrorFailures;
}
