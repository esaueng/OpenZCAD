import type {
  ArtifactId,
  BodyRepresentation,
  ProjectDocument,
  ProjectId,
  ProjectSummary
} from '@openzcad/shared';
import type { ProjectThumbnailRecord } from './localProjectStore';

interface ThumbnailBackfillHost {
  loadCached(projectId: string): Promise<ProjectThumbnailRecord | null>;
  loadLocalDocument(projectId: string): Promise<ProjectDocument | null>;
  loadCloudDocument?: (projectId: string) => Promise<ProjectDocument | null>;
  rebuild?: (
    document: ProjectDocument
  ) => Promise<ProjectDocument['derived']>;
  render(bodies: BodyRepresentation[]): string | null;
  save(
    projectId: string,
    thumbnail: {
      source: string | null;
      artifactId?: ArtifactId;
      version: number;
      updatedAt: string;
    }
  ): Promise<void>;
  publish?: (thumbnail: {
    projectId: ProjectId;
    source: string;
    version: number;
    updatedAt: string;
  }) => Promise<ArtifactId>;
}

export interface ProjectThumbnailBackfillResult {
  source: string | null | undefined;
  artifactId?: ArtifactId;
}

/**
 * Fills one missing shelf preview from the cheapest available source.
 *
 * A current device cache wins. Otherwise a matching local document can use
 * its saved derived projection. A cloud-only (or locally stale) document is
 * rebuilt through the caller's browser worker before rendering. The caller
 * serializes this whole operation so an expanded shelf never holds several
 * documents or WebGL contexts at once.
 */
export async function backfillProjectThumbnail(
  project: ProjectSummary,
  host: ThumbnailBackfillHost
): Promise<ProjectThumbnailBackfillResult> {
  const cached = await host.loadCached(project.projectId);
  const cachedMatchesProject =
    project.documentVersion === undefined ||
    cached?.version === project.documentVersion;
  let source = cachedMatchesProject ? cached?.source : undefined;
  let version = cached?.version ?? project.documentVersion ?? 0;
  let updatedAt = cached?.updatedAt ?? project.updatedAt;

  if (source === undefined) {
    let document = await host.loadLocalDocument(project.projectId);
    const localMatchesProject = Boolean(
      document &&
        (project.documentVersion === undefined ||
          document.version === project.documentVersion)
    );
    let derived =
      localMatchesProject && document ? document.derived : undefined;

    if (
      (!document || !localMatchesProject) &&
      host.loadCloudDocument &&
      host.rebuild
    ) {
      document = await host.loadCloudDocument(project.projectId);
      derived = document ? await host.rebuild(document) : undefined;
    }
    if (!document || !derived) {
      return { source: undefined };
    }

    source = host.render(
      Object.values(derived.bodyRepresentations).filter(
        (body) => !body.consumed
      )
    );
    version = document.version;
    updatedAt = derived.updatedAt;
    await host.save(project.projectId, { source, version, updatedAt });
  }

  let artifactId = cachedMatchesProject ? cached?.artifactId : undefined;
  if (
    source &&
    !project.thumbnailArtifactId &&
    !artifactId &&
    host.publish
  ) {
    // Read-only collaborators can render a useful device cache but cannot
    // publish into the owner's project. Keep that local success if upload is
    // refused instead of turning the card back into a placeholder.
    artifactId = await host
      .publish({
        projectId: project.projectId,
        source,
        version,
        updatedAt
      })
      .catch(() => undefined);
    if (artifactId) {
      await host.save(project.projectId, {
        source,
        artifactId,
        version,
        updatedAt
      });
    }
  }

  return {
    source,
    ...(artifactId ? { artifactId } : {})
  };
}
