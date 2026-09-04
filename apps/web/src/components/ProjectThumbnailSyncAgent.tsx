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
import { queuePartThumbnail, renderThumbnailFrame } from '../lib/partThumbnail';
import {
  sharedThumbnailCapture,
  type ThumbnailCapture
} from '../lib/projectThumbnailCapture';

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
  /** Injected by tests; the app stages into the shared instance. */
  capture?: ThumbnailCapture;
}

/**
 * Stages the shelf projection while the document meshes are already in
 * memory, and publishes each captured card to the account. The capture itself
 * lives in {@link sharedThumbnailCapture} so App's leave paths can flush it
 * whether or not this agent is mounted — it is not, during every rebuild.
 * Kept behind a workspace-only lazy boundary so cloud preview support adds no
 * weight to the launcher that displays the cards.
 */
export function ProjectThumbnailSyncAgent({
  projectId,
  version,
  updatedAt,
  bodyRepresentations,
  publishToCloud,
  transport,
  loadThumbnail,
  saveThumbnail,
  capture = sharedThumbnailCapture
}: ProjectThumbnailSyncAgentProps) {
  useEffect(() => {
    const unsubscribe = capture.subscribe((captured) => {
      if (
        captured.projectId !== projectId ||
        captured.version !== version ||
        !captured.source ||
        !publishToCloud ||
        captured.artifactId
      ) {
        return;
      }
      const source = captured.source;
      // Deliberately not cancelled on unmount: the leave flush notifies while
      // this agent is still mounted and the upload must outlive it. The
      // record is keyed by version, so a late write cannot mislabel anything.
      void uploadCloudThumbnail(transport, {
        projectId,
        version,
        updatedAt,
        source
      })
        .then((artifactId) =>
          saveThumbnail(projectId, { source, artifactId, version, updatedAt })
        )
        .catch(() => undefined);
    });
    capture.stage(
      {
        projectId,
        version,
        updatedAt,
        bodies: Object.values(bodyRepresentations).filter(
          (body) => !body.consumed
        )
      },
      {
        render: renderThumbnailFrame,
        load: loadThumbnail,
        save: saveThumbnail,
        queue: queuePartThumbnail
      }
    );
    return unsubscribe;
  }, [
    bodyRepresentations,
    capture,
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
