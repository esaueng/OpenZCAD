import type { ArtifactId, ProjectSummary } from '@openzcad/shared';

/**
 * The account cards this tab has published, ordered against listing reads.
 *
 * The account lists a project's most recently created thumbnail, and
 * finalizing one deletes the cards before it. A card this tab published is
 * therefore the account's current card for any listing read that began
 * before the publish finished: whatever that listing names was there first
 * and has been replaced. Without this, leaving a project raced its card
 * upload against the shelf's listing refresh; a listing read while the
 * upload finalized named the previous card, and the tile fetched that over
 * the one the device had just drawn.
 *
 * Ordering is by when this tab saw each event, not by version numbers or
 * artifact lineage: two devices can each make their own version 9, and an
 * encrypted card's deduplicated blob id can name a later publication. A
 * listing read that began after the publish is the account's word and is
 * left alone, so a newer card from another device still wins.
 */
let clock = 0;
const published = new Map<string, { artifactId: ArtifactId; at: number }>();
const listeners = new Set<
  (projectId: string, artifactId: ArtifactId) => void
>();

/** Marks the start of a listing read; pass the result to the corrections. */
export function beginListingRead(): number {
  return clock;
}

/** Records a card this tab finished publishing to the account. */
export function notePublishedThumbnail(
  projectId: string,
  artifactId: ArtifactId
): void {
  published.set(projectId, { artifactId, at: ++clock });
  for (const listener of listeners) listener(projectId, artifactId);
}

/** The listing's summary, naming this tab's card if it was published later. */
export function withPublishedThumbnail(
  project: ProjectSummary,
  readStartedAt: number
): ProjectSummary {
  const mine = published.get(project.projectId);
  if (
    !mine ||
    mine.at <= readStartedAt ||
    project.thumbnailArtifactId === mine.artifactId
  )
    return project;
  return { ...project, thumbnailArtifactId: mine.artifactId };
}

export function withPublishedThumbnails(
  projects: ProjectSummary[],
  readStartedAt: number
): ProjectSummary[] {
  let changed = false;
  const next = projects.map((project) => {
    const corrected = withPublishedThumbnail(project, readStartedAt);
    if (corrected !== project) changed = true;
    return corrected;
  });
  return changed ? next : projects;
}

/**
 * Called after each publish, for listings already applied: every one of them
 * was read before it, so the published card replaces what they name.
 */
export function subscribePublishedThumbnails(
  listener: (projectId: string, artifactId: ArtifactId) => void
): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
