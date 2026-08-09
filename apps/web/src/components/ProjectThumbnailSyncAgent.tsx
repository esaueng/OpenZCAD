import { useEffect } from 'react';
import type {
  ArtifactId,
  BodyRepresentation,
  ProjectId
} from '@openzcad/shared';
import type { ProjectThumbnailRecord } from '../lib/localProjectStore';
import {
  uploadCloudThumbnail,
  type ThumbnailCloudTransport
} from '../lib/cloudThumbnail';
import { renderPartThumbnail } from '../lib/partThumbnail';

const THUMBNAIL_REFRESH_MS = 4000;

interface ProjectThumbnailSyncAgentProps {
  projectId: ProjectId;
  version: number;
  updatedAt: string;
  bodyRepresentations: Record<string, BodyRepresentation>;
  publishToCloud: boolean;
  transport: ThumbnailCloudTransport;
  loadThumbnail(projectId: string): Promise<ProjectThumbnailRecord | null>;
  saveThumbnail(
    projectId: string,
    thumbnail: {
      source: string | null;
      artifactId?: ArtifactId;
      version: number;
      updatedAt: string;
    }
  ): Promise<void>;
}

/**
 * Refreshes the shelf projection while the document meshes are already in
 * memory. Kept behind a workspace-only lazy boundary so cloud preview support
 * adds no weight to the launcher that displays the cards.
 */
export function ProjectThumbnailSyncAgent({
  projectId,
  version,
  updatedAt,
  bodyRepresentations,
  publishToCloud,
  transport,
  loadThumbnail,
  saveThumbnail
}: ProjectThumbnailSyncAgentProps) {
  useEffect(() => {
    let cancelled = false;
    const timer = setTimeout(() => {
      void (async () => {
        const cached = await loadThumbnail(projectId).catch(() => null);
        if (cancelled) {
          return;
        }
        let source = cached?.version === version ? cached.source : undefined;
        if (source === undefined) {
          source = await renderPartThumbnail(
            Object.values(bodyRepresentations).filter((body) => !body.consumed)
          ).catch(() => null);
        }
        if (cancelled) {
          return;
        }
        if (cached?.version !== version) {
          await saveThumbnail(projectId, { source, version, updatedAt }).catch(
            () => undefined
          );
        }
        if (
          !source ||
          !publishToCloud ||
          (cached?.version === version && cached.artifactId)
        ) {
          return;
        }
        const artifactId = await uploadCloudThumbnail(transport, {
          projectId,
          version,
          updatedAt,
          source
        }).catch(() => null);
        if (cancelled || !artifactId) {
          return;
        }
        await saveThumbnail(projectId, {
          source,
          artifactId,
          version,
          updatedAt
        }).catch(() => undefined);
      })();
    }, THUMBNAIL_REFRESH_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [
    bodyRepresentations,
    loadThumbnail,
    projectId,
    publishToCloud,
    saveThumbnail,
    transport,
    updatedAt,
    version
  ]);

  return null;
}
