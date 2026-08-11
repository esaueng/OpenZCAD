import type { ArtifactId, ProjectId } from '@openzcad/shared';

export interface ThumbnailCloudTransport {
  createUploadSession(input: {
    projectId: ProjectId;
    fileName: string;
    contentType: string;
    kind: 'thumbnail';
    metadata: Record<string, string | number | boolean>;
  }): Promise<{
    session: {
      uploadSessionId: string;
      artifactId: ArtifactId;
      uploadUrl?: string;
    };
  }>;
  finalizeArtifact(input: {
    projectId: ProjectId;
    uploadSessionId: string;
    artifactId: ArtifactId;
  }): Promise<{ artifactId: string | null }>;
  uploadArtifact(uploadUrl: string, body: Blob): Promise<void>;
}

/** Converts a canvas data URL into the original compact image bytes. */
export async function thumbnailSourceBlob(source: string): Promise<Blob> {
  const response = await fetch(source);
  if (!response.ok) {
    throw new Error('Thumbnail image could not be read.');
  }
  return response.blob();
}

/** Converts downloaded private image bytes into a source `<img>` can render. */
export function thumbnailBlobSource(blob: Blob): Promise<string> {
  if (!blob.type.startsWith('image/')) {
    return Promise.reject(new Error('Thumbnail artifact is not an image.'));
  }
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener('load', () =>
      typeof reader.result === 'string'
        ? resolve(reader.result)
        : reject(new Error('Thumbnail image could not be decoded.'))
    );
    reader.addEventListener('error', () =>
      reject(reader.error ?? new Error('Thumbnail image could not be decoded.'))
    );
    reader.readAsDataURL(blob);
  });
}

export async function downloadCloudThumbnail(
  artifactId: string,
  download: (artifactId: string) => Promise<Blob> = async (
    currentArtifactId
  ) => {
    const { desktopFetch } = await import('./desktopBridge');
    return desktopFetch(`/api/artifacts/${currentArtifactId}/download`).then(
      (response) => response.blob()
    );
  }
): Promise<string> {
  return thumbnailBlobSource(await download(artifactId));
}

/** Publishes the already-rendered card image without touching the document. */
export async function uploadCloudThumbnail(
  transport: ThumbnailCloudTransport,
  input: {
    projectId: ProjectId;
    version: number;
    updatedAt: string;
    source: string;
  }
): Promise<ArtifactId> {
  const body = await thumbnailSourceBlob(input.source);
  const { session } = await transport.createUploadSession({
    projectId: input.projectId,
    fileName: `${input.projectId}-thumbnail.webp`,
    contentType: body.type || 'image/webp',
    kind: 'thumbnail',
    metadata: {
      documentVersion: input.version,
      documentUpdatedAt: input.updatedAt
    }
  });
  if (!session.uploadUrl) {
    throw new Error('Thumbnail upload is unavailable.');
  }
  // A 360x200 WebP is many orders of magnitude below the multipart boundary.
  await transport.uploadArtifact(session.uploadUrl, body);
  const finalized = await transport.finalizeArtifact({
    projectId: input.projectId,
    uploadSessionId: session.uploadSessionId,
    artifactId: session.artifactId
  });
  if (!finalized.artifactId) {
    throw new Error('Thumbnail upload could not be finalized.');
  }
  return session.artifactId;
}
