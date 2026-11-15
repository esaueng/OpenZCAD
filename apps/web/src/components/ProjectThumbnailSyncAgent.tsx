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
import type { ThumbnailCapture } from '../lib/projectThumbnailCapture';
import { sharedThumbnailCapture } from '../lib/sharedThumbnailCapture';
import {
  notePublishedThumbnail,
  publicationSession
} from '../lib/thumbnailPublications';

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
      const session = publicationSession();
      // Deliberately not cancelled on unmount: the leave flush notifies while
      // this agent is still mounted and the upload must outlive it.
      void uploadCloudThumbnail(transport, {
        projectId,
        version,
        updatedAt,
        source
      })
        .then(async (artifactId) => {
          // Uploads can finish out of order. One that a later capture has
          // already replaced on this device must not write its older image
          // back over the newer card.
          const current = await loadThumbnail(projectId);
          if (current && current.version !== version) return;
          await saveThumbnail(projectId, {
            source,
            artifactId,
            version,
            updatedAt
          });
          // A listing read before this point may name the card it replaced;
          // the shelf keeps the device image until a later one is applied.
          notePublishedThumbnail(projectId, session);
        })
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
