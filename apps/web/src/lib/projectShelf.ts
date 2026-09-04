import {
  compareProjectSummaries,
  projectOrganization,
  type ProjectOrganization,
  type ProjectStatus,
  type ProjectSummary
} from '@openzcad/shared';
import type { ProjectThumbnailRecord } from './localProjectStore';

/**
 * Whether a device record was rendered from the version a listing describes.
 * The one rule shared by every consumer of the thumbnail store — the shelf
 * loader, the cloud publisher, and the workspace capture — so "is this record
 * current" cannot drift into three answers again. A listing that predates
 * `documentVersion` cannot be checked and counts as described.
 *
 * | consumer  | question                              | uses               |
 * |-----------|---------------------------------------|--------------------|
 * | loader    | may I *show* this record?             | cachedThumbnailSource (tolerates stale images) |
 * | publisher | may I *publish* this record?          | this, strictly     |
 * | capture   | is this version already on disk?      | this, strictly     |
 */
export function thumbnailRecordDescribes(
  record: Pick<ProjectThumbnailRecord, 'version'> | null,
  project: Pick<ProjectSummary, 'documentVersion'>
): boolean {
  return (
    record !== null &&
    (project.documentVersion === undefined ||
      record.version === project.documentVersion)
  );
}

/**
 * The shelf's preview source: this device's record, upgraded by the account's
 * artifact when the listing names one the record does not carry. Reads a
 * small image and nothing else — never the project document, which for a
 * large import is the load that once took the start screen down.
 *
 * The account copy only ever upgrades a card. When it cannot be fetched (a
 * listing one refresh stale points at a thumbnail the Worker has already
 * superseded and deleted, or the device is offline) the device image is still
 * the part, and a placeholder would be strictly worse than a stale picture.
 */
export async function resolveShelfThumbnail(
  project: ProjectSummary,
  host: {
    loadCached(projectId: string): Promise<ProjectThumbnailRecord | null>;
    download(artifactId: string): Promise<string>;
  }
): Promise<string | null | undefined> {
  const cached = await host.loadCached(project.projectId).catch(() => null);
  const cachedSource = cachedThumbnailSource(cached, project);
  if (cachedSource !== undefined || !project.thumbnailArtifactId) {
    return cachedSource;
  }
  const cloud = await host
    .download(project.thumbnailArtifactId)
    .catch(() => undefined);
  // A cached null is not a fallback here: the account holds an image, so the
  // part has geometry, and "No geometry" would be wrong. Placeholder instead.
  return cloud ?? (cached?.source || undefined);
}

/**
 * What this device's cached preview may still say about the project the shelf
 * is listing: the source to show, or undefined for "ask the backfill".
 *
 * Serving a stale *image* is deliberate — recognising the part is worth more
 * than the document load a redraw would cost, which is the entire reason the
 * cache exists. A stale *null* is not the same trade. It claims the part has
 * no geometry on the strength of a version that no longer exists, and because
 * a null is an answer rather than a miss it is the one value that also stops
 * the backfill from correcting it. A new project left alone long enough for
 * the shelf refresh to come due while it is still empty records exactly that,
 * so a part first modelled after such a pause read "No geometry" on its card
 * until it was next opened and left open long enough to be re-recorded. Send
 * that one back to the backfill instead.
 */
export function cachedThumbnailSource(
  cached: ProjectThumbnailRecord | null,
  project: ProjectSummary
): string | null | undefined {
  if (!cached) {
    return undefined;
  }
  if (
    project.thumbnailArtifactId &&
    cached.artifactId !== project.thumbnailArtifactId &&
    (cached.artifactId !== undefined || cached.source === null)
  ) {
    return undefined;
  }
  if (cached.source === null && cached.updatedAt !== project.updatedAt) {
    return undefined;
  }
  return cached.source;
}

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
    const thumbnailArtifactId =
      project.thumbnailArtifactId ?? existing.thumbnailArtifactId;
    merged.set(project.projectId, {
      ...newest,
      ...(thumbnailArtifactId ? { thumbnailArtifactId } : {}),
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
