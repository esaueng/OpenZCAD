import { act, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { toArtifactId, toProjectId } from '@openzcad/shared';
import { ProjectThumbnailSyncAgent } from './ProjectThumbnailSyncAgent';

afterEach(() => vi.useRealTimers());

describe('ProjectThumbnailSyncAgent', () => {
  it('publishes an already-rendered preview and records its artifact id', async () => {
    vi.useFakeTimers();
    const artifactId = toArtifactId('artifact_thumbnail');
    const saveThumbnail = vi.fn().mockResolvedValue(undefined);
    const transport = {
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
      />
    );

    await act(() => vi.advanceTimersByTimeAsync(4000));

    expect(transport.uploadArtifact).toHaveBeenCalledTimes(1);
    expect(saveThumbnail).toHaveBeenCalledWith('project_thumbnail', {
      source: 'data:image/webp;base64,cHJldmlldw==',
      artifactId,
      version: 7,
      updatedAt: '2026-08-08T12:00:00.000Z'
    });
  });
});
