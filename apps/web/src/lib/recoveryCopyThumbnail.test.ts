import { describe, expect, it, vi } from 'vitest';
import {
  addPrimitiveFeature,
  createProjectDocument,
  withoutDerivedProjection
} from '@openzcad/document-core';
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

  it('records an empty part when it has no features and nothing to draw', async () => {
    const { source, copy } = documents();
    copy.derived.bodyRepresentations = {};
    const save = vi.fn().mockResolvedValue(undefined);

    await seedRecoveryCopyThumbnail(source, copy, {
      loadCached: vi.fn().mockRejectedValue(new Error('no store')),
      save,
      render: vi.fn().mockResolvedValue(null)
    });

    expect(save).toHaveBeenCalledWith('proj_recovery_copy', {
      source: null,
      version: 7,
      updatedAt: '2026-09-04T16:00:00.000Z'
    });
  });

  // "Keep mine" clones the account copy, which is stored without its
  // projection: features, no meshes. A null record keyed to that version would
  // read "No geometry" on the shelf and block the workspace's own capture from
  // ever replacing it, so the copy must list as a placeholder instead.
  it('leaves a copy with features but no meshes unwritten', async () => {
    const built = addPrimitiveFeature(
      createProjectDocument('Conflict', owner),
      {
        name: 'Box',
        primitiveKind: 'box',
        dimensions: { width: 10, height: 10, depth: 10 }
      }
    );
    const source = withoutDerivedProjection(built);
    const copy = structuredClone(source);
    copy.projectId = toProjectId('proj_recovery_copy');
    const save = vi.fn().mockResolvedValue(undefined);
    const render = vi.fn().mockResolvedValue(null);

    await seedRecoveryCopyThumbnail(source, copy, {
      loadCached: vi.fn().mockResolvedValue(null),
      save,
      render
    });

    expect(render).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
  });

  it('leaves the copy unwritten when the render fails', async () => {
    const { source, copy } = documents();
    const save = vi.fn().mockResolvedValue(undefined);

    await seedRecoveryCopyThumbnail(source, copy, {
      loadCached: vi.fn().mockRejectedValue(new Error('no store')),
      save,
      render: vi.fn().mockRejectedValue(new Error('no webgl'))
    });

    expect(save).not.toHaveBeenCalled();
  });
});
