import { listFeaturesInOrder } from '@openzcad/document-core';
import type {
  ArtifactId,
  BodyRepresentation,
  ProjectDocument,
  ProjectSummary
} from '@openzcad/shared';
import { projectNeedsUpdate, thumbnailRecordDescribes } from './projectShelf';

export interface ThumbnailRegenerationHost {
  /** This device's saved model, or null when it holds none. */
  loadLocal(projectId: string): Promise<ProjectDocument | null>;
  /** The account's copy, for projects the account stores. */
  loadAccount?(projectId: string): Promise<ProjectDocument>;
  /**
   * An exact rebuild of a model saved without its meshes (an account copy
   * travels without them). Null or a throw leaves the card as it is.
   */
  rebuild(
    document: ProjectDocument
  ): Promise<ProjectDocument['derived'] | null>;
  render(bodies: BodyRepresentation[]): Promise<string | null>;
  save(
    projectId: string,
    thumbnail: {
      source: string | null;
      artifactId?: ArtifactId;
      version: number;
      updatedAt: string;
    }
  ): Promise<void>;
  /**
   * Sends a new card to the account, for projects the account stores. A
   * refusal (a read-only seat) keeps the card on this device.
   */
  publish?(input: {
    projectId: ProjectDocument['projectId'];
    source: string;
    version: number;
    updatedAt: string;
  }): Promise<ArtifactId>;
  /** Whether `publish` applies to this project. */
  publishes?(projectId: string): boolean;
  /**
   * Whether the run may still act: false once a project opens, the account
   * changes or the key session locks. Asked after every wait, so nothing is
   * loaded, rebuilt, saved, published or shown for a session that has ended.
   */
  active?(): boolean;
  /** Each card as it is written, so the open shelf can show it at once. */
  drawn?(
    project: ProjectSummary,
    source: string | null,
    artifactId?: ArtifactId
  ): void;
  progress?(done: number, total: number): void;
}

export interface ThumbnailRegenerationResult {
  /** Cards drawn from the model (a "No geometry" card included). */
  redrawn: number;
  /** Projects whose card was left as it was. */
  skipped: number;
}

/** Thrown when the run stops because its session ended. */
export class ThumbnailRegenerationStopped extends Error {
  constructor() {
    super('Redrawing project cards stopped.');
    this.name = 'AbortError';
  }
}

/**
 * Redraws every project's card from its model, one project at a time.
 *
 * The shelf itself never does this: it reads only small cached images, so a
 * part whose source is too large to load can still be opened or deleted from
 * it (see `resolveShelfThumbnail`). This is the deliberate counterpart, run
 * only when someone asks for it in Settings — for cards that were never
 * captured, such as copies made before copies carried their source's
 * picture, or cards that no longer match the part.
 *
 * Projects are taken strictly in turn, so at most one model is in memory and
 * one card renders at a time. The model drawn is the version the listing
 * describes: this device's copy when it is that version, else the account's.
 * A card is published only when the model drawn is the account's own
 * version, read from the account copy itself: the shelf's listing merges
 * this device's projects with the account's by recency, so it can describe
 * a local version the account does not hold, or no version at all. A device
 * holding an older or newer model therefore never replaces the card other
 * devices see; its own model is drawn for this device alone. A model saved without
 * its meshes is rebuilt first. Anything that cannot be read or rebuilt — a
 * locked or newer-format project, an encrypted one whose key is not
 * unlocked — keeps its current card and counts as skipped, as does an empty
 * model whose account still holds a picture: an empty card cannot replace
 * that picture, so redrawing it would change nothing anyone sees. The run
 * stops with {@link ThumbnailRegenerationStopped} as soon as `active` says
 * its session ended.
 */
export async function regenerateProjectThumbnails(
  projects: readonly ProjectSummary[],
  host: ThumbnailRegenerationHost
): Promise<ThumbnailRegenerationResult> {
  const result: ThumbnailRegenerationResult = { redrawn: 0, skipped: 0 };
  host.progress?.(0, projects.length);
  for (const [index, project] of projects.entries()) {
    ensureActive(host);
    let drawn: boolean;
    try {
      drawn = await redraw(project, host);
    } catch (error) {
      if (error instanceof ThumbnailRegenerationStopped) throw error;
      drawn = false;
    }
    if (drawn) result.redrawn += 1;
    else result.skipped += 1;
    host.progress?.(index + 1, projects.length);
  }
  return result;
}

function ensureActive(host: ThumbnailRegenerationHost): void {
  if (host.active && !host.active()) throw new ThumbnailRegenerationStopped();
}

/** The listing's version, or true when the listing predates versions. */
function matchesListing(
  document: ProjectDocument,
  project: ProjectSummary
): boolean {
  return thumbnailRecordDescribes({ version: document.version }, project);
}

/**
 * The model to draw, and the account's version when the account copy was
 * read: the only thing that may authorise publishing a card.
 */
async function chooseDocument(
  project: ProjectSummary,
  host: ThumbnailRegenerationHost,
  publishing: boolean
): Promise<{ document: ProjectDocument; accountVersion?: number } | null> {
  const local = await host.loadLocal(project.projectId).catch(() => null);
  ensureActive(host);
  const localDescribed = local !== null && matchesListing(local, project);
  // Read the account when it may be drawn, or to learn whether the card
  // drawn is the one the account holds.
  const account =
    host.loadAccount && (publishing || !localDescribed)
      ? await host.loadAccount(project.projectId).catch(() => null)
      : null;
  ensureActive(host);
  const known = account ? { accountVersion: account.version } : {};
  if (local && localDescribed) return { document: local, ...known };
  if (account && (!local || matchesListing(account, project))) {
    return { document: account, ...known };
  }
  return local ? { document: local, ...known } : null;
}

async function redraw(
  project: ProjectSummary,
  host: ThumbnailRegenerationHost
): Promise<boolean> {
  if (projectNeedsUpdate(project)) return false;
  const publishing = Boolean(
    host.publish && host.publishes?.(project.projectId)
  );
  const chosen = await chooseDocument(project, host, publishing);
  if (!chosen) return false;
  let document = chosen.document;

  let bodies = liveBodies(document.derived.bodyRepresentations);
  if (bodies.length === 0 && listFeaturesInOrder(document).length > 0) {
    const derived = await host.rebuild(document).catch(() => null);
    ensureActive(host);
    if (!derived) return false;
    document = { ...document, derived };
    bodies = liveBodies(derived.bodyRepresentations);
  }

  const source = await host.render(bodies);
  ensureActive(host);
  if (source === null && project.thumbnailArtifactId) return false;
  const record = {
    source,
    version: document.version,
    updatedAt: document.derived.updatedAt
  };
  await host.save(project.projectId, record);
  ensureActive(host);

  let artifactId: ArtifactId | undefined;
  if (
    source &&
    host.publish &&
    publishing &&
    chosen.accountVersion === document.version
  ) {
    artifactId = await host
      .publish({
        projectId: document.projectId,
        source,
        version: record.version,
        updatedAt: record.updatedAt
      })
      .catch(() => undefined);
    ensureActive(host);
    if (artifactId) {
      await host.save(project.projectId, { ...record, artifactId });
      ensureActive(host);
    }
  }
  host.drawn?.(project, source, artifactId);
  return true;
}

function liveBodies(
  representations: Record<string, BodyRepresentation>
): BodyRepresentation[] {
  return Object.values(representations).filter((body) => !body.consumed);
}
