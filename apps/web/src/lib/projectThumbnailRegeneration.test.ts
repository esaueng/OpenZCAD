import { describe, expect, it, vi } from 'vitest';
import {
  addPrimitiveFeature,
  createProjectDocument
} from '@openzcad/document-core';
import {
  toArtifactId,
  toBodyId,
  toUserId,
  type BodyRepresentation,
  type ProjectDocument,
  type ProjectSummary
} from '@openzcad/shared';
import {
  regenerateProjectThumbnails,
  type ThumbnailRegenerationHost
} from './projectThumbnailRegeneration';

const owner = toUserId('user_owner');

/** A one-box model, saved with (or without) its meshes. */
function model(name: string, withMeshes: boolean): ProjectDocument {
  const document = addPrimitiveFeature(createProjectDocument(name, owner), {
    name: 'Box',
    bodyName: 'Box',
    primitiveKind: 'box',
    dimensions: { width: 10, height: 10, depth: 10 }
  });
  document.version = 4;
  document.derived.updatedAt = '2026-11-05T10:00:00.000Z';
  document.derived.bodyRepresentations = withMeshes
    ? {
        [toBodyId('body_live')]: { consumed: false } as BodyRepresentation,
        [toBodyId('body_gone')]: { consumed: true } as BodyRepresentation
      }
    : {};
  return document;
}

function summary(document: ProjectDocument): ProjectSummary {
  return {
    projectId: document.projectId,
    name: document.name,
    revisionCount: 1,
    updatedAt: document.derived.updatedAt,
    documentVersion: document.version
  };
}

function host(
  overrides: Partial<ThumbnailRegenerationHost> = {}
): ThumbnailRegenerationHost & {
  save: ReturnType<typeof vi.fn>;
  render: ReturnType<typeof vi.fn>;
} {
  return {
    loadLocal: vi.fn().mockResolvedValue(null),
    rebuild: vi.fn().mockResolvedValue(null),
    render: vi.fn().mockResolvedValue('data:image/webp;base64,CARD'),
    save: vi.fn().mockResolvedValue(undefined),
    ...overrides
  } as never;
}

describe('regenerateProjectThumbnails', () => {
  it('draws a card from the saved meshes, keyed to the version drawn', async () => {
    // 14 Nov 2026: a copy made before copies carried their source's picture
    // kept the placeholder until it was opened.
    const copy = model('Terminal (copy)', true);
    const regenerate = host({
      loadLocal: vi.fn().mockResolvedValue(copy)
    });

    const result = await regenerateProjectThumbnails(
      [summary(copy)],
      regenerate
    );

    expect(result).toEqual({ redrawn: 1, skipped: 0 });
    expect(regenerate.rebuild).not.toHaveBeenCalled();
    expect(regenerate.render).toHaveBeenCalledWith([{ consumed: false }]);
    expect(regenerate.save).toHaveBeenCalledWith(copy.projectId, {
      source: 'data:image/webp;base64,CARD',
      version: 4,
      updatedAt: '2026-11-05T10:00:00.000Z'
    });
  });

  it("rebuilds a model saved without meshes, falling back to the account's copy", async () => {
    const account = model('Only in the account', false);
    const derived = {
      ...account.derived,
      bodyRepresentations: {
        [toBodyId('body_rebuilt')]: { consumed: false } as BodyRepresentation
      }
    };
    const regenerate = host({
      loadAccount: vi.fn().mockResolvedValue(account),
      rebuild: vi.fn().mockResolvedValue(derived)
    });

    await regenerateProjectThumbnails([summary(account)], regenerate);

    expect(regenerate.rebuild).toHaveBeenCalledWith(account);
    expect(regenerate.render).toHaveBeenCalledWith([{ consumed: false }]);
    expect(regenerate.save).toHaveBeenCalledTimes(1);
  });

  it('publishes to the account only where it applies, and keeps a refused card', async () => {
    const cloud = model('Cloud', true);
    const device = model('Device', true);
    const refused = model('Read-only', true);
    const byId = new Map(
      [cloud, device, refused].map((document) => [document.projectId, document])
    );
    const publish = vi.fn(async ({ projectId }: { projectId: string }) => {
      if (projectId === refused.projectId) throw new Error('403');
      return toArtifactId('artifact_new');
    });
    const drawn = vi.fn();
    const regenerate = host({
      loadLocal: vi.fn(async (id: string) => byId.get(id as never) ?? null),
      publish,
      publishes: (id) => id !== device.projectId,
      drawn
    });

    const result = await regenerateProjectThumbnails(
      [summary(cloud), summary(device), summary(refused)],
      regenerate
    );

    expect(result).toEqual({ redrawn: 3, skipped: 0 });
    expect(publish).toHaveBeenCalledTimes(2);
    expect(regenerate.save).toHaveBeenCalledWith(cloud.projectId, {
      source: 'data:image/webp;base64,CARD',
      artifactId: 'artifact_new',
      version: 4,
      updatedAt: '2026-11-05T10:00:00.000Z'
    });
    expect(drawn).toHaveBeenCalledWith(
      summary(cloud),
      'data:image/webp;base64,CARD',
      'artifact_new'
    );
    expect(drawn).toHaveBeenCalledWith(
      summary(refused),
      'data:image/webp;base64,CARD',
      undefined
    );
  });

  it('skips what it cannot read or rebuild, and carries on in turn', async () => {
    const unreadable = model('Locked', true);
    const unbuildable = model('Fails to rebuild', false);
    const fine = model('Fine', true);
    const order: string[] = [];
    const regenerate = host({
      loadLocal: vi.fn(async (id: string) => {
        order.push(id);
        if (id === unreadable.projectId) throw new Error('key locked');
        return id === unbuildable.projectId ? unbuildable : fine;
      }),
      rebuild: vi.fn().mockRejectedValue(new Error('kernel refused')),
      progress: vi.fn()
    });
    const newer = { ...summary(fine), storageFormat: 99 };

    const result = await regenerateProjectThumbnails(
      [summary(unreadable), summary(unbuildable), newer, summary(fine)],
      regenerate
    );

    expect(result).toEqual({ redrawn: 1, skipped: 3 });
    // A newer-format project is never loaded; the rest are taken in order.
    expect(order).toEqual([
      unreadable.projectId,
      unbuildable.projectId,
      fine.projectId
    ]);
    expect(regenerate.save).toHaveBeenCalledTimes(1);
    expect(regenerate.progress).toHaveBeenLastCalledWith(4, 4);
  });

  it('records "No geometry" for an empty project without rebuilding it', async () => {
    const empty = createProjectDocument('Empty', owner);
    const regenerate = host({
      loadLocal: vi.fn().mockResolvedValue(empty),
      render: vi.fn().mockResolvedValue(null)
    });

    await regenerateProjectThumbnails([summary(empty)], regenerate);

    expect(regenerate.rebuild).not.toHaveBeenCalled();
    expect(regenerate.save).toHaveBeenCalledWith(empty.projectId, {
      source: null,
      version: empty.version,
      updatedAt: empty.derived.updatedAt
    });
  });
});
