import { describe, expect, it, vi } from 'vitest';
import { createProjectDocument } from '@openzcad/document-core';
import {
  toArtifactId,
  toBodyId,
  toProjectId,
  toUserId,
  type BodyRepresentation,
  type ProjectDocument
} from '@openzcad/shared';
import { seedRecoveryCopyThumbnail } from './recoveryCopyThumbnail';

const owner = toUserId('user_owner');

function documents(): { source: ProjectDocument; copy: ProjectDocument } {
  const source = createProjectDocument('Conflict', owner);
  source.version = 7;
  source.derived.bodyRepresentations = {
    [toBodyId('body_live')]: { consumed: false } as BodyRepresentation,
    [toBodyId('body_gone')]: { consumed: true } as BodyRepresentation
  };
  const copy = structuredClone(source);
  copy.projectId = toProjectId('proj_recovery_copy');
  copy.derived.updatedAt = '2026-09-04T16:00:00.000Z';
  return { source, copy };
}

describe('seedRecoveryCopyThumbnail', () => {
  it('reuses the source preview that matches the cloned version, without its artifact', async () => {
    const { source, copy } = documents();
    const save = vi.fn().mockResolvedValue(undefined);
    const render = vi.fn();

    await seedRecoveryCopyThumbnail(source, copy, {
      loadCached: vi.fn().mockResolvedValue({
        projectId: source.projectId,
        source: 'data:image/webp;base64,CACHED',
        artifactId: toArtifactId('artifact_source'),
        version: 7,
        updatedAt: source.derived.updatedAt
      }),
      save,
      render
    });

    expect(render).not.toHaveBeenCalled();
    expect(save).toHaveBeenCalledWith('proj_recovery_copy', {
      source: 'data:image/webp;base64,CACHED',
      version: 7,
      updatedAt: '2026-09-04T16:00:00.000Z'
    });
  });

  it('renders the in-memory bodies when the source cache is stale or missing', async () => {
    const { source, copy } = documents();
    const save = vi.fn().mockResolvedValue(undefined);
    const render = vi.fn().mockResolvedValue('data:image/webp;base64,FRESH');

    await seedRecoveryCopyThumbnail(source, copy, {
      loadCached: vi.fn().mockResolvedValue({
        projectId: source.projectId,
        source: 'data:image/webp;base64,OLD',
        version: 6,
        updatedAt: source.derived.updatedAt
      }),
      save,
      render
    });

    expect(render).toHaveBeenCalledWith([{ consumed: false }]);
    expect(save).toHaveBeenCalledWith('proj_recovery_copy', {
      source: 'data:image/webp;base64,FRESH',
      version: 7,
      updatedAt: '2026-09-04T16:00:00.000Z'
    });
  });

  it('records an empty part when nothing can be rendered', async () => {
    const { source, copy } = documents();
    const save = vi.fn().mockResolvedValue(undefined);

    await seedRecoveryCopyThumbnail(source, copy, {
      loadCached: vi.fn().mockRejectedValue(new Error('no store')),
      save,
      render: vi.fn().mockRejectedValue(new Error('no webgl'))
    });

    expect(save).toHaveBeenCalledWith('proj_recovery_copy', {
      source: null,
      version: 7,
      updatedAt: '2026-09-04T16:00:00.000Z'
    });
  });
});
