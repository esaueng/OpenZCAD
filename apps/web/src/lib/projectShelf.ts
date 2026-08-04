import {
  compareProjectSummaries,
  projectOrganization,
  type ProjectOrganization,
  type ProjectStatus,
  type ProjectSummary
} from '@openzcad/shared';

/**
 * Merges the device's projects with the account's. Which record describes the
 * project is decided by recency, as before — but shelf state is answered
 * separately: it is written to this device first on every change, so a local
 * record wins outright and the account copy only fills in projects this device
 * has never organised (a project first seen on another machine, say).
 */
export function mergeProjectSummaries(
  local: ProjectSummary[],
  remote: ProjectSummary[]
): ProjectSummary[] {
  const merged = new Map(local.map((project) => [project.projectId, project]));
  for (const project of remote) {
    const existing = merged.get(project.projectId);
    if (!existing) {
      merged.set(project.projectId, project);
      continue;
    }
    const newest = project.updatedAt > existing.updatedAt ? project : existing;
    const organization = existing.organization ?? project.organization;
    merged.set(project.projectId, {
      ...newest,
      ...(organization ? { organization } : {})
    });
  }
  return [...merged.values()].sort(compareProjectSummaries);
}

/**
 * Applies device-owned shelf metadata after document summaries are merged.
 * Metadata can exist without a local document when this device organised a
 * cloud-only project, so it cannot be recovered from `local` summaries alone.
 */
export function applyLocalProjectOrganizations(
  projects: ProjectSummary[],
  organizations: ReadonlyMap<string, ProjectOrganization>
): ProjectSummary[] {
  return projects
    .map((project) => {
      const organization = organizations.get(project.projectId);
      return organization ? { ...project, organization } : project;
    })
    .sort(compareProjectSummaries);
}

export type ProjectShelves = Record<ProjectStatus, ProjectSummary[]>;

/** Splits an already-sorted list into the shelf each project sits on. */
export function bucketProjectsByShelf(
  projects: ProjectSummary[]
): ProjectShelves {
  const shelves: ProjectShelves = { active: [], archived: [], deleted: [] };
  for (const project of projects) {
    shelves[projectOrganization(project).status].push(project);
  }
  return shelves;
}

/**
 * `list` with the item at `from` moved to `to`. Out-of-range indices return
 * the list untouched, so a drop that lands on nothing is a no-op rather than a
 * silent reshuffle.
 */
export function moveItem<T>(list: T[], from: number, to: number): T[] {
  if (
    from === to ||
    from < 0 ||
    to < 0 ||
    from >= list.length ||
    to >= list.length
  ) {
    return list;
  }
  const next = [...list];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved!);
  return next;
}
