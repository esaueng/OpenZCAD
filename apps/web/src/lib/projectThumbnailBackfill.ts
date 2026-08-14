import type { ArtifactId, ProjectId, ProjectSummary } from '@openzcad/shared';
import type { ProjectThumbnailRecord } from './localProjectStore';

interface ThumbnailBackfillHost {
  loadCached(projectId: string): Promise<ProjectThumbnailRecord | null>;
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
 * Only cached preview artifacts are consulted. The project shelf is also the
 * recovery surface for malformed or very large documents, so a cache miss
 * must never load or rebuild project-controlled geometry automatically.
 */
export async function backfillProjectThumbnail(
  project: ProjectSummary,
  host: ThumbnailBackfillHost
): Promise<ProjectThumbnailBackfillResult> {
  const cached = await host.loadCached(project.projectId);
  const cachedMatchesProject =
    project.documentVersion === undefined ||
    cached?.version === project.documentVersion;
  const source = cachedMatchesProject ? cached?.source : undefined;
  if (source === undefined) {
    return { source: undefined };
  }
  const version = cached?.version ?? project.documentVersion ?? 0;
  const updatedAt = cached?.updatedAt ?? project.updatedAt;

  let artifactId = cachedMatchesProject ? cached?.artifactId : undefined;
  if (source && !project.thumbnailArtifactId && !artifactId && host.publish) {
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
