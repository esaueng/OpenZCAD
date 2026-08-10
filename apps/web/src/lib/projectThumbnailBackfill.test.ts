import { describe, expect, it, vi } from 'vitest';
import {
  createProjectDocument,
  withoutDerivedProjection
} from '@openzcad/document-core';
import {
  toArtifactId,
  toProjectId,
  toUserId,
  type BodyRepresentation,
  type ProjectDocument,
  type ProjectSummary
} from '@openzcad/shared';
import { backfillProjectThumbnail } from './projectThumbnailBackfill';

function projectDocument(version = 3): ProjectDocument {
  return {
    ...createProjectDocument('Cloud part', toUserId('user_backfill')),
    projectId: toProjectId('project_backfill'),
    version,
    derived: {
      bodyRepresentations: {},
      exportableBodyIds: [],
      warnings: [],
      updatedAt: '2026-08-09T04:00:00.000Z'
    }
  };
}

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
  it('rebuilds a cloud-only document and publishes its preview', async () => {
    const document = withoutDerivedProjection(projectDocument());
    const body = { consumed: false } as BodyRepresentation;
    const derived = {
      ...document.derived,
      bodyRepresentations: { body_backfill: body }
    };
    const artifactId = toArtifactId('artifact_backfill');
    const save = vi.fn().mockResolvedValue(undefined);
    const rebuild = vi.fn().mockResolvedValue(derived);
    const publish = vi.fn().mockResolvedValue(artifactId);

    const result = await backfillProjectThumbnail(summary(), {
      loadCached: vi.fn().mockResolvedValue(null),
      loadLocalDocument: vi.fn().mockResolvedValue(null),
      loadCloudDocument: vi.fn().mockResolvedValue(document),
      rebuild,
      render: vi.fn().mockReturnValue('data:image/webp;base64,AA'),
      save,
      publish
    });

    expect(rebuild).toHaveBeenCalledWith(document);
    expect(publish).toHaveBeenCalledWith({
      projectId: document.projectId,
      source: 'data:image/webp;base64,AA',
      version: document.version,
      updatedAt: derived.updatedAt
    });
    expect(result).toEqual({
      source: 'data:image/webp;base64,AA',
      artifactId
    });
    expect(save).toHaveBeenLastCalledWith(document.projectId, {
      source: 'data:image/webp;base64,AA',
      artifactId,
      version: document.version,
      updatedAt: derived.updatedAt
    });
  });

  it('publishes an existing device preview without rebuilding the document', async () => {
    const artifactId = toArtifactId('artifact_cached');
    const loadLocalDocument = vi.fn();
    const rebuild = vi.fn();
    const publish = vi.fn().mockResolvedValue(artifactId);

    const result = await backfillProjectThumbnail(summary(), {
      loadCached: vi.fn().mockResolvedValue({
        projectId: 'project_backfill',
        source: 'data:image/webp;base64,CACHED',
        version: 3,
        updatedAt: '2026-08-09T04:00:00.000Z'
      }),
      loadLocalDocument,
      rebuild,
      render: vi.fn(),
      save: vi.fn().mockResolvedValue(undefined),
      publish
    });

    expect(loadLocalDocument).not.toHaveBeenCalled();
    expect(rebuild).not.toHaveBeenCalled();
    expect(result.artifactId).toBe(artifactId);
  });

  it('keeps a rendered device preview when publication is refused', async () => {
    const document = projectDocument();
    const save = vi.fn().mockResolvedValue(undefined);

    const result = await backfillProjectThumbnail(summary(), {
      loadCached: vi.fn().mockResolvedValue(null),
      loadLocalDocument: vi.fn().mockResolvedValue(document),
      render: vi.fn().mockReturnValue('data:image/webp;base64,LOCAL'),
      save,
      publish: vi.fn().mockRejectedValue(new Error('read only'))
    });

    expect(result).toEqual({ source: 'data:image/webp;base64,LOCAL' });
    expect(save).toHaveBeenCalledWith(document.projectId, {
      source: 'data:image/webp;base64,LOCAL',
      version: document.version,
      updatedAt: document.derived.updatedAt
    });
  });

  it('rebuilds instead of publishing a cached preview from an older version', async () => {
    const document = withoutDerivedProjection(projectDocument(4));
    const artifactId = toArtifactId('artifact_current');
    const publish = vi.fn().mockResolvedValue(artifactId);

    const result = await backfillProjectThumbnail(summary(4), {
      loadCached: vi.fn().mockResolvedValue({
        projectId: 'project_backfill',
        source: 'data:image/webp;base64,STALE',
        artifactId: toArtifactId('artifact_stale'),
        version: 3,
        updatedAt: '2026-08-08T04:00:00.000Z'
      }),
      loadLocalDocument: vi.fn().mockResolvedValue(null),
      loadCloudDocument: vi.fn().mockResolvedValue(document),
      rebuild: vi.fn().mockResolvedValue(document.derived),
      render: vi.fn().mockReturnValue('data:image/webp;base64,CURRENT'),
      save: vi.fn().mockResolvedValue(undefined),
      publish
    });

    expect(publish).toHaveBeenCalledWith(
      expect.objectContaining({ source: 'data:image/webp;base64,CURRENT' })
    );
    expect(result).toEqual({
      source: 'data:image/webp;base64,CURRENT',
      artifactId
    });
  });
});
