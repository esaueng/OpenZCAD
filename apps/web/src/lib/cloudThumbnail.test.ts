import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  MAX_THUMBNAIL_BYTES,
  toArtifactId,
  toProjectId
} from '@openzcad/shared';
import {
  downloadCloudThumbnail,
  thumbnailSourceBlob,
  uploadCloudThumbnail
} from './cloudThumbnail';

describe('cloud thumbnails', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // The app's CSP refuses `fetch('data:…')`, which Node's fetch accepts, so
  // the upload path must never touch fetch to read its own image bytes.
  it('reads the image bytes without fetching the data URL', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValue(new TypeError('Failed to fetch'))
    );

    const blob = await thumbnailSourceBlob(
      'data:image/webp;base64,cHJldmlldw=='
    );

    expect(blob.type).toBe('image/webp');
    expect(await blob.text()).toBe('preview');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('rejects a source that is not a data URL', async () => {
    await expect(
      thumbnailSourceBlob('https://example.com/x.webp')
    ).rejects.toThrow('could not be read');
    await expect(
      thumbnailSourceBlob('data:image/webp;base64,%%%')
    ).rejects.toThrow('could not be read');
  });

  it('downloads image bytes as a reusable data URL', async () => {
    const source = await downloadCloudThumbnail(
      'artifact_thumbnail',
      vi.fn().mockResolvedValue(new Blob(['preview'], { type: 'image/webp' }))
    );

    expect(source).toMatch(/^data:image\/webp;base64,/);
  });

  it('rejects a non-image artifact', async () => {
    await expect(
      downloadCloudThumbnail(
        'artifact_not_an_image',
        vi
          .fn()
          .mockResolvedValue(new Blob(['not an image'], { type: 'text/plain' }))
      )
    ).rejects.toThrow('not an image');
  });

  it('rejects an oversized image before converting it to a data URL', async () => {
    await expect(
      downloadCloudThumbnail(
        'artifact_too_large',
        vi.fn().mockResolvedValue(
          new Blob([new Uint8Array(MAX_THUMBNAIL_BYTES + 1)], {
            type: 'image/webp'
          })
        )
      )
    ).rejects.toThrow('too large');
  });

  it('uploads and finalizes one image artifact with document metadata', async () => {
    const artifactId = toArtifactId('artifact_thumbnail');
    const calls: string[] = [];
    const transport = {
      createUploadSession: vi.fn().mockResolvedValue({
        session: {
          uploadSessionId: 'upload_thumbnail',
          artifactId,
          uploadUrl: '/api/uploads/upload_thumbnail/content'
        }
      }),
      uploadArtifact: vi.fn(async (_url: string, body: Blob) => {
        calls.push(`upload:${body.type}:${body.size}`);
      }),
      createMultipartUpload: vi.fn(),
      uploadArtifactPart: vi.fn(),
      completeMultipartUpload: vi.fn(),
      abortMultipartUpload: vi.fn(),
      finalizeArtifact: vi.fn().mockResolvedValue({ artifactId })
    };

    await expect(
      uploadCloudThumbnail(transport, {
        projectId: toProjectId('project_thumbnail'),
        version: 7,
        updatedAt: '2026-08-08T12:00:00.000Z',
        source: 'data:image/webp;base64,cHJldmlldw=='
      })
    ).resolves.toBe(artifactId);

    expect(calls).toEqual(['upload:image/webp:7']);
    expect(transport.createUploadSession).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'thumbnail',
        metadata: {
          documentVersion: 7,
          documentUpdatedAt: '2026-08-08T12:00:00.000Z'
        }
      })
    );
    expect(transport.finalizeArtifact).toHaveBeenCalledWith({
      projectId: 'project_thumbnail',
      uploadSessionId: 'upload_thumbnail',
      artifactId
    });
  });
});
