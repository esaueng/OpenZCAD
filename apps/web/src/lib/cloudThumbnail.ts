import {
  MAX_THUMBNAIL_BYTES,
  THUMBNAIL_CONTENT_TYPE,
  type ArtifactId,
  type ProjectId
} from '@openzcad/shared';

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

/**
 * Converts a canvas data URL into the original compact image bytes.
 *
 * Decoded here rather than fetched: the app's Content-Security-Policy limits
 * `connect-src` to its own origin, so `fetch('data:…')` is refused in the
 * browser while it succeeds in Node. Every thumbnail upload failed that way
 * for nine days without a single request leaving the page.
 */
export function thumbnailSourceBlob(source: string): Promise<Blob> {
  const match = /^data:([^;,]*)((?:;[^;,]*)*?)(;base64)?,(.*)$/s.exec(source);
  if (!match) {
    return Promise.reject(new Error('Thumbnail image could not be read.'));
  }
  const type = match[1] ?? '';
  const base64 = match[3] !== undefined;
  const payload = match[4] ?? '';
  try {
    const bytes = base64
      ? Uint8Array.from(atob(payload), (char) => char.charCodeAt(0))
      : new TextEncoder().encode(decodeURIComponent(payload));
    return Promise.resolve(new Blob([bytes], { type: type || 'image/webp' }));
  } catch {
    return Promise.reject(new Error('Thumbnail image could not be read.'));
  }
}

/** Converts downloaded private image bytes into a source `<img>` can render. */
export function thumbnailBlobSource(blob: Blob): Promise<string> {
  if (blob.type !== THUMBNAIL_CONTENT_TYPE) {
    return Promise.reject(new Error('Thumbnail artifact is not an image.'));
  }
  if (blob.size > MAX_THUMBNAIL_BYTES) {
    return Promise.reject(new Error('Thumbnail artifact is too large.'));
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
