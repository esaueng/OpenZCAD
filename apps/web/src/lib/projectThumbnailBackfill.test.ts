import { describe, expect, it, vi } from 'vitest';
import {
  toArtifactId,
  toProjectId,
  type ProjectSummary
} from '@openzcad/shared';
import { backfillProjectThumbnail } from './projectThumbnailBackfill';

function summary(version = 3): ProjectSummary {
  return {
    projectId: toProjectId('project_backfill'),
    name: 'Cloud part',
    revisionCount: 1,
    documentVersion: version,
    updatedAt: '2026-08-09T04:00:00.000Z'
  };
}

describe('project thumbnail backfill', () => {
  it('leaves a cache miss unresolved without loading project geometry', async () => {
    const result = await backfillProjectThumbnail(summary(), {
      loadCached: vi.fn().mockResolvedValue(null),
      save: vi.fn().mockResolvedValue(undefined),
      publish: vi.fn()
    });
    expect(result).toEqual({ source: undefined });
  });

  it('publishes an existing device preview without rebuilding the document', async () => {
    const artifactId = toArtifactId('artifact_cached');
    const publish = vi.fn().mockResolvedValue(artifactId);

    const result = await backfillProjectThumbnail(summary(), {
      loadCached: vi.fn().mockResolvedValue({
        projectId: 'project_backfill',
        source: 'data:image/webp;base64,CACHED',
        version: 3,
        updatedAt: '2026-08-09T04:00:00.000Z'
      }),
      save: vi.fn().mockResolvedValue(undefined),
      publish
    });

    expect(result.artifactId).toBe(artifactId);
  });

  it('keeps a cached device preview when publication is refused', async () => {
    const save = vi.fn().mockResolvedValue(undefined);

    const result = await backfillProjectThumbnail(summary(), {
      loadCached: vi.fn().mockResolvedValue({
        projectId: 'project_backfill',
        source: 'data:image/webp;base64,LOCAL',
        version: 3,
        updatedAt: '2026-08-09T04:00:00.000Z'
      }),
      save,
      publish: vi.fn().mockRejectedValue(new Error('read only'))
    });

    expect(result).toEqual({ source: 'data:image/webp;base64,LOCAL' });
    expect(save).not.toHaveBeenCalled();
  });

  it('does not publish a cached preview from an older version', async () => {
    const publish = vi.fn();

    const result = await backfillProjectThumbnail(summary(4), {
      loadCached: vi.fn().mockResolvedValue({
        projectId: 'project_backfill',
        source: 'data:image/webp;base64,STALE',
        artifactId: toArtifactId('artifact_stale'),
        version: 3,
        updatedAt: '2026-08-08T04:00:00.000Z'
      }),
      save: vi.fn().mockResolvedValue(undefined),
      publish
    });

    expect(publish).not.toHaveBeenCalled();
    expect(result).toEqual({ source: undefined });
  });
});
