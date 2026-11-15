import { act, render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { toArtifactId, toProjectId } from '@openzcad/shared';
import { ProjectThumbnailSyncAgent } from './ProjectThumbnailSyncAgent';
import { createThumbnailCapture } from '../lib/projectThumbnailCapture';
import { deviceCardOutranksListing } from '../lib/thumbnailPublications';

function transportPublishing(artifactId: ReturnType<typeof toArtifactId>) {
  return {
    createUploadSession: vi.fn().mockResolvedValue({
      session: {
        uploadSessionId: 'upload_thumbnail',
        artifactId,
        uploadUrl: '/api/uploads/upload_thumbnail/content'
      }
    }),
    uploadArtifact: vi.fn().mockResolvedValue(undefined),
    finalizeArtifact: vi.fn().mockResolvedValue({ artifactId })
  };
}

describe('ProjectThumbnailSyncAgent', () => {
  it('publishes an already-rendered preview and records its artifact id', async () => {
    const artifactId = toArtifactId('artifact_thumbnail');
    const saveThumbnail = vi.fn().mockResolvedValue(undefined);
    const transport = transportPublishing(artifactId);
    const capture = createThumbnailCapture({ idleMs: 0 });

    render(
      <ProjectThumbnailSyncAgent
        projectId={toProjectId('project_thumbnail')}
        version={7}
        updatedAt="2026-08-08T12:00:00.000Z"
        bodyRepresentations={{}}
        publishToCloud
        transport={transport}
        loadThumbnail={vi.fn().mockResolvedValue({
          projectId: 'project_thumbnail',
          source: 'data:image/webp;base64,cHJldmlldw==',
          version: 7,
          updatedAt: '2026-08-08T12:00:00.000Z'
        })}
        saveThumbnail={saveThumbnail}
        capture={capture}
      />
    );

    await act(() => capture.flush());
    await vi.waitFor(() =>
      expect(saveThumbnail).toHaveBeenCalledWith('project_thumbnail', {
        source: 'data:image/webp;base64,cHJldmlldw==',
        artifactId,
        version: 7,
        updatedAt: '2026-08-08T12:00:00.000Z'
      })
    );
    expect(transport.uploadArtifact).toHaveBeenCalledTimes(1);
    // A listing read before now may still name the card this one replaced.
    await vi.waitFor(() =>
      expect(deviceCardOutranksListing('project_thumbnail')).toBe(true)
    );
  });

  it('does not write an upload back over a newer card that finished first', async () => {
    // Version 7's upload finishes after version 8 was captured on this device.
    const artifactId = toArtifactId('artifact_late');
    const transport = transportPublishing(artifactId);
    const saveThumbnail = vi.fn().mockResolvedValue(undefined);
    const loadThumbnail = vi
      .fn()
      .mockResolvedValueOnce({
        projectId: 'project_late_upload',
        source: 'data:image/webp;base64,c2V2ZW4=',
        version: 7,
        updatedAt: '2026-08-08T12:00:00.000Z'
      })
      .mockResolvedValue({
        projectId: 'project_late_upload',
        source: 'data:image/webp;base64,ZWlnaHQ=',
        version: 8,
        updatedAt: '2026-08-08T12:01:00.000Z'
      });
    const capture = createThumbnailCapture({ idleMs: 0 });

    render(
      <ProjectThumbnailSyncAgent
        projectId={toProjectId('project_late_upload')}
        version={7}
        updatedAt="2026-08-08T12:00:00.000Z"
        bodyRepresentations={{}}
        publishToCloud
        transport={transport}
        loadThumbnail={loadThumbnail}
        saveThumbnail={saveThumbnail}
        capture={capture}
      />
    );

    await act(() => capture.flush());
    await vi.waitFor(() =>
      expect(transport.finalizeArtifact).toHaveBeenCalled()
    );
    await vi.waitFor(() => expect(loadThumbnail).toHaveBeenCalledTimes(2));
    await act(async () => undefined);
    expect(saveThumbnail).not.toHaveBeenCalledWith(
      'project_late_upload',
      expect.objectContaining({ artifactId })
    );
    expect(deviceCardOutranksListing('project_late_upload')).toBe(false);
  });

  it('stages the ready geometry so a leave flush can write the card', async () => {
    // Nothing here waits on the idle timer: the capture is armed the moment
    // geometry is ready, and App's leave paths flush it.
    const saveThumbnail = vi.fn().mockResolvedValue(undefined);
    const capture = createThumbnailCapture({ idleMs: 60_000 });

    render(
      <ProjectThumbnailSyncAgent
        projectId={toProjectId('project_thumbnail')}
        version={3}
        updatedAt="2026-09-04T21:00:03.000Z"
        bodyRepresentations={{}}
        publishToCloud={false}
        transport={transportPublishing(toArtifactId('artifact_unused'))}
        loadThumbnail={vi.fn().mockResolvedValue(null)}
        saveThumbnail={saveThumbnail}
        capture={capture}
      />
    );

    await act(() => capture.flush());

    expect(saveThumbnail).toHaveBeenCalledWith('project_thumbnail', {
      source: null,
      version: 3,
      updatedAt: '2026-09-04T21:00:03.000Z'
    });
  });

  it('leaves a published record alone', async () => {
    const artifactId = toArtifactId('artifact_published');
    const transport = transportPublishing(artifactId);
    const saveThumbnail = vi.fn().mockResolvedValue(undefined);
    const capture = createThumbnailCapture({ idleMs: 0 });

    render(
      <ProjectThumbnailSyncAgent
        projectId={toProjectId('project_thumbnail')}
        version={7}
        updatedAt="2026-08-08T12:00:00.000Z"
        bodyRepresentations={{}}
        publishToCloud
        transport={transport}
        loadThumbnail={vi.fn().mockResolvedValue({
          projectId: 'project_thumbnail',
          source: 'data:image/webp;base64,cHJldmlldw==',
          artifactId,
          version: 7,
          updatedAt: '2026-08-08T12:00:00.000Z'
        })}
        saveThumbnail={saveThumbnail}
        capture={capture}
      />
    );

    await act(() => capture.flush());

    expect(transport.createUploadSession).not.toHaveBeenCalled();
    expect(saveThumbnail).not.toHaveBeenCalled();
  });
});
