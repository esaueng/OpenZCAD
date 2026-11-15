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
import { resolveShelfThumbnail } from './projectShelf';
import {
  regenerateProjectThumbnails,
  ThumbnailRegenerationStopped,
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
      // The account holds the same versions this device does.
      loadAccount: vi.fn(async (id: string) => byId.get(id as never)!),
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

  it("draws the account's version when this device holds an older one, and publishes it", async () => {
    const stale = model('Shared', true);
    stale.version = 9;
    const current = { ...structuredClone(stale), version: 12 };
    current.derived.bodyRepresentations = {};
    const derived = {
      ...current.derived,
      bodyRepresentations: {
        [toBodyId('body_v12')]: { consumed: false } as BodyRepresentation
      }
    };
    const publish = vi.fn().mockResolvedValue(toArtifactId('artifact_v12'));
    const regenerate = host({
      loadLocal: vi.fn().mockResolvedValue(stale),
      loadAccount: vi.fn().mockResolvedValue(current),
      rebuild: vi.fn().mockResolvedValue(derived),
      publish,
      publishes: () => true
    });

    await regenerateProjectThumbnails(
      [{ ...summary(stale), documentVersion: 12 }],
      regenerate
    );

    expect(regenerate.rebuild).toHaveBeenCalledWith(current);
    expect(publish).toHaveBeenCalledWith(
      expect.objectContaining({ version: 12 })
    );
  });

  it('never publishes a version the listing does not describe', async () => {
    // Review: a device holding version 9 of a project the account lists at
    // 12 replaced the card every other device sees with version 9's.
    const stale = model('Out of date', true);
    stale.version = 9;
    const publish = vi.fn().mockResolvedValue(toArtifactId('artifact_wrong'));
    const regenerate = host({
      loadLocal: vi.fn().mockResolvedValue(stale),
      loadAccount: vi.fn().mockRejectedValue(new Error('offline')),
      publish,
      publishes: () => true
    });

    const result = await regenerateProjectThumbnails(
      [{ ...summary(stale), documentVersion: 12 }],
      regenerate
    );

    // Drawn for this device from what it holds, keyed to that version.
    expect(result).toEqual({ redrawn: 1, skipped: 0 });
    expect(regenerate.save).toHaveBeenCalledWith(
      stale.projectId,
      expect.objectContaining({ version: 9 })
    );
    expect(publish).not.toHaveBeenCalled();
  });

  it('draws a local model ahead of the account for this device only', async () => {
    // Re-review: the shelf's listing merges by recency, so it describes the
    // device's newer version 15, which matched and was published over the
    // account's version 12 without the account ever being read.
    const ahead = model('Unsynced edits', true);
    ahead.version = 15;
    const behind = { ...structuredClone(ahead), version: 12 };
    const loadAccount = vi.fn().mockResolvedValue(behind);
    const publish = vi.fn().mockResolvedValue(toArtifactId('artifact_wrong'));
    const regenerate = host({
      loadLocal: vi.fn().mockResolvedValue(ahead),
      loadAccount,
      publish,
      publishes: () => true
    });

    await regenerateProjectThumbnails([summary(ahead)], regenerate);

    expect(loadAccount).toHaveBeenCalledTimes(1);
    expect(regenerate.save).toHaveBeenCalledWith(
      ahead.projectId,
      expect.objectContaining({ version: 15 })
    );
    expect(publish).not.toHaveBeenCalled();
  });

  it('publishes nothing on a listing with no version unless the account holds it', async () => {
    // Re-review: an unknown listing version matched any model.
    const stale = model('Old listing', true);
    stale.version = 9;
    const account = { ...structuredClone(stale), version: 12 };
    const publish = vi.fn().mockResolvedValue(toArtifactId('artifact_wrong'));
    const regenerate = host({
      loadLocal: vi.fn().mockResolvedValue(stale),
      loadAccount: vi.fn().mockResolvedValue(account),
      publish,
      publishes: () => true
    });
    const { documentVersion: _unknown, ...unversioned } = summary(stale);

    await regenerateProjectThumbnails([unversioned], regenerate);

    expect(publish).not.toHaveBeenCalled();
  });

  it('publishes nothing when the account copy cannot be read', async () => {
    const cloud = model('Offline', true);
    const publish = vi.fn().mockResolvedValue(toArtifactId('artifact_wrong'));
    const regenerate = host({
      loadLocal: vi.fn().mockResolvedValue(cloud),
      loadAccount: vi.fn().mockRejectedValue(new Error('offline')),
      publish,
      publishes: () => true
    });

    const result = await regenerateProjectThumbnails(
      [summary(cloud)],
      regenerate
    );

    expect(result).toEqual({ redrawn: 1, skipped: 0 });
    expect(publish).not.toHaveBeenCalled();
  });

  it("leaves an empty model's card alone while the account still holds a picture", async () => {
    // Review: a "No geometry" record lost to the account's older image on
    // the next shelf load, so the redraw reported a change nobody saw.
    const empty = createProjectDocument('Emptied', owner);
    const project = {
      ...summary(empty),
      thumbnailArtifactId: toArtifactId('artifact_old')
    };
    const regenerate = host({
      loadLocal: vi.fn().mockResolvedValue(empty),
      render: vi.fn().mockResolvedValue(null)
    });

    const result = await regenerateProjectThumbnails([project], regenerate);

    expect(result).toEqual({ redrawn: 0, skipped: 1 });
    expect(regenerate.save).not.toHaveBeenCalled();
    await expect(
      resolveShelfThumbnail(project, {
        loadCached: async () => null,
        download: async () => 'data:image/webp;base64,OLD'
      })
    ).resolves.toBe('data:image/webp;base64,OLD');
  });

  it('stops before saving anything once its session ends mid-project', async () => {
    // Review: the run outlived the library, the account and the key session.
    const first = model('First', false);
    const second = model('Second', true);
    let live = true;
    const derived = {
      ...first.derived,
      bodyRepresentations: {
        [toBodyId('body_first')]: { consumed: false } as BodyRepresentation
      }
    };
    const loadLocal = vi.fn(async (id: string) =>
      id === first.projectId ? first : second
    );
    const drawn = vi.fn();
    const regenerate = host({
      loadLocal,
      // A project opens while the first model rebuilds.
      rebuild: vi.fn(async () => {
        live = false;
        return derived;
      }),
      active: () => live,
      drawn
    });

    await expect(
      regenerateProjectThumbnails([summary(first), summary(second)], regenerate)
    ).rejects.toBeInstanceOf(ThumbnailRegenerationStopped);
    expect(regenerate.render).not.toHaveBeenCalled();
    expect(regenerate.save).not.toHaveBeenCalled();
    expect(drawn).not.toHaveBeenCalled();
    expect(loadLocal).toHaveBeenCalledTimes(1);
  });
});
