import { listFeaturesInOrder } from '@openzcad/document-core';
import type {
  ArtifactId,
  BodyRepresentation,
  ProjectDocument,
  ProjectSummary
} from '@openzcad/shared';
import { projectNeedsUpdate } from './projectShelf';

export interface ThumbnailRegenerationHost {
  /** This device's saved model, or null when it holds none. */
  loadLocal(projectId: string): Promise<ProjectDocument | null>;
  /** The account's copy, for a project this device has never stored. */
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
  /** Projects whose model could not be read or rebuilt here. */
  skipped: number;
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
 * one card renders at a time. A model saved with its meshes is drawn as
 * saved; one without (the account's copy, or a project never rebuilt here)
 * is rebuilt first. Anything that cannot be read or rebuilt — a locked or
 * newer-format project, an encrypted one whose key is not unlocked — keeps
 * its current card and counts as skipped. Records are keyed to the version
 * drawn, the rule every other card writer follows.
 */
export async function regenerateProjectThumbnails(
  projects: readonly ProjectSummary[],
  host: ThumbnailRegenerationHost
): Promise<ThumbnailRegenerationResult> {
  const result: ThumbnailRegenerationResult = { redrawn: 0, skipped: 0 };
  host.progress?.(0, projects.length);
  for (const [index, project] of projects.entries()) {
    const drawn = await redraw(project, host).catch(() => false);
    if (drawn) result.redrawn += 1;
    else result.skipped += 1;
    host.progress?.(index + 1, projects.length);
  }
  return result;
}

async function redraw(
  project: ProjectSummary,
  host: ThumbnailRegenerationHost
): Promise<boolean> {
  if (projectNeedsUpdate(project)) return false;
  let document = await host.loadLocal(project.projectId).catch(() => null);
  if (!document && host.loadAccount) {
    document = await host.loadAccount(project.projectId).catch(() => null);
  }
  if (!document) return false;

  let bodies = liveBodies(document.derived.bodyRepresentations);
  if (bodies.length === 0 && listFeaturesInOrder(document).length > 0) {
    const derived = await host.rebuild(document).catch(() => null);
    if (!derived) return false;
    document = { ...document, derived };
    bodies = liveBodies(derived.bodyRepresentations);
  }

  const source = await host.render(bodies);
  const record = {
    source,
    version: document.version,
    updatedAt: document.derived.updatedAt
  };
  await host.save(project.projectId, record);

  let artifactId: ArtifactId | undefined;
  if (source && host.publish && host.publishes?.(project.projectId)) {
    artifactId = await host
      .publish({
        projectId: document.projectId,
        source,
        version: record.version,
        updatedAt: record.updatedAt
      })
      .catch(() => undefined);
    if (artifactId) {
      await host.save(project.projectId, { ...record, artifactId });
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
