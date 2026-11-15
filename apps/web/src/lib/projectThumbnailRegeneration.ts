import { listFeaturesInOrder } from '@openzcad/document-core';
import type {
  BodyRepresentation,
  ProjectDocument,
  ProjectSummary
} from '@openzcad/shared';
import { projectNeedsUpdate, thumbnailRecordDescribes } from './projectShelf';

export interface ThumbnailRegenerationHost {
  /** This device's saved model, or null when it holds none. */
  loadLocal(projectId: string): Promise<ProjectDocument | null>;
  /**
   * The account's copy, for a project the account stores that this device
   * holds no current model of.
   */
  loadAccount?(projectId: string): Promise<ProjectDocument>;
  /**
   * An exact rebuild of a model saved without its meshes (an account copy
   * travels without them). Null or a throw leaves the card as it is.
   */
  rebuild(
    document: ProjectDocument
  ): Promise<ProjectDocument['derived'] | null>;
  render(bodies: BodyRepresentation[]): Promise<string | null>;
  /** Writes this device's card record; never the account's. */
  save(
    projectId: string,
    thumbnail: { source: string | null; version: number; updatedAt: string }
  ): Promise<void>;
  /**
   * Whether the run may still act: false once a project opens, the account
   * changes or the key session locks. Asked after every wait, so nothing is
   * loaded, rebuilt, saved or shown for a session that has ended.
   */
  active?(): boolean;
  /** Each card as it is written, so the open shelf can show it at once. */
  drawn?(project: ProjectSummary, source: string | null): void;
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
 * Redraws every project's card on this device from its model, one project
 * at a time.
 *
 * The shelf itself never does this: it reads only small cached images, so a
 * part whose source is too large to load can still be opened or deleted from
 * it (see `resolveShelfThumbnail`). This is the deliberate counterpart, run
 * only when someone asks for it in Settings — for cards that were never
 * captured, such as copies made before copies carried their source's
 * picture, or cards that no longer match the part.
 *
 * It writes this device's card records only and publishes nothing. Which
 * card the account keeps is left to the paths that already decide it — the
 * open workspace's capture, and the shelf's backfill, which publishes a
 * device card the account lacks once it describes the listed version. A
 * bulk run that published would have to prove, per project, that the model
 * it drew is the account's (two devices can each make a different version
 * 12) and fence every upload against the run ending; leaving that to the
 * paths built for it keeps this one to drawing.
 *
 * Projects are taken strictly in turn, so at most one model is in memory and
 * one card renders at a time. The model drawn is the version the listing
 * describes: this device's copy when it is that version, else the account's
 * when that is; failing both, this device's own model. A model saved without
 * its meshes is rebuilt first. Anything that cannot be read or rebuilt — a
 * locked or newer-format project, an encrypted one whose key is not
 * unlocked — keeps its current card and counts as skipped, as does an empty
 * model whose account still holds a picture: the shelf shows the account's
 * picture over an empty device card, so redrawing it would change nothing.
 * The run stops with {@link ThumbnailRegenerationStopped} as soon as
 * `active` says its session ended.
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
      // A save the store refused because the session ended is a stop, not a
      // skip — the last project's included, which no later step would catch.
      ensureActive(host);
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

async function chooseDocument(
  project: ProjectSummary,
  host: ThumbnailRegenerationHost
): Promise<ProjectDocument | null> {
  const local = await host.loadLocal(project.projectId).catch(() => null);
  ensureActive(host);
  if (local && matchesListing(local, project)) return local;
  if (host.loadAccount) {
    const account = await host.loadAccount(project.projectId).catch(() => null);
    ensureActive(host);
    if (account && (!local || matchesListing(account, project))) {
      return account;
    }
  }
  return local;
}

async function redraw(
  project: ProjectSummary,
  host: ThumbnailRegenerationHost
): Promise<boolean> {
  if (projectNeedsUpdate(project)) return false;
  let document = await chooseDocument(project, host);
  if (!document) return false;

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
  await host.save(project.projectId, {
    source,
    version: document.version,
    updatedAt: document.derived.updatedAt
  });
  ensureActive(host);
  host.drawn?.(project, source);
  return true;
}

function liveBodies(
  representations: Record<string, BodyRepresentation>
): BodyRepresentation[] {
  return Object.values(representations).filter((body) => !body.consumed);
}
