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
import type { ProjectThumbnailRecord } from './localProjectStore';
import { backfillProjectThumbnail } from './projectThumbnailBackfill';
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

function meshes(id: string): ProjectDocument['derived']['bodyRepresentations'] {
  return { [toBodyId(id)]: { consumed: false } as BodyRepresentation };
}

function host(
  overrides: Partial<ThumbnailRegenerationHost> = {}
): ThumbnailRegenerationHost & {
  save: ReturnType<typeof vi.fn>;
  render: ReturnType<typeof vi.fn>;
  rebuild: ReturnType<typeof vi.fn>;
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
    const drawn = vi.fn();
    const regenerate = host({
      loadLocal: vi.fn().mockResolvedValue(copy),
      drawn
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
    expect(drawn).toHaveBeenCalledWith(
      summary(copy),
      'data:image/webp;base64,CARD'
    );
  });

  it('writes only device records: the shelf backfill publishes one the account lacks', async () => {
    // Re-review: a bulk run that published could not prove the model it drew
    // was the account's, so publishing stays with the backfill, which sends a
    // device card only once it describes the listed version.
    const copy = model('Terminal (copy)', true);
    const store = new Map<string, ProjectThumbnailRecord>();
    await regenerateProjectThumbnails(
      [summary(copy)],
      host({
        loadLocal: vi.fn().mockResolvedValue(copy),
        save: vi.fn(
          async (
            projectId: string,
            thumbnail: Omit<ProjectThumbnailRecord, 'projectId'>
          ) => {
            store.set(projectId, { projectId, ...thumbnail });
          }
        )
      })
    );
    expect(store.get(copy.projectId)?.artifactId).toBeUndefined();

    const publish = vi.fn().mockResolvedValue(toArtifactId('artifact_card'));
    const result = await backfillProjectThumbnail(summary(copy), {
      loadCached: async (projectId) => store.get(projectId) ?? null,
      save: vi.fn().mockResolvedValue(undefined),
      publish
    });
    expect(publish).toHaveBeenCalledWith(
      expect.objectContaining({ version: 4 })
    );
    expect(result.artifactId).toBe('artifact_card');
  });

  it("draws the account's version when this device holds an older one", async () => {
    const stale = model('Shared', true);
    stale.version = 9;
    const current = { ...structuredClone(stale), version: 12 };
    current.derived.bodyRepresentations = {};
    const regenerate = host({
      loadLocal: vi.fn().mockResolvedValue(stale),
      loadAccount: vi.fn().mockResolvedValue(current),
      rebuild: vi.fn().mockResolvedValue({
        ...current.derived,
        bodyRepresentations: meshes('body_v12')
      })
    });

    await regenerateProjectThumbnails(
      [{ ...summary(stale), documentVersion: 12 }],
      regenerate
    );

    expect(regenerate.rebuild).toHaveBeenCalledWith(current);
    expect(regenerate.save).toHaveBeenCalledWith(
      stale.projectId,
      expect.objectContaining({ version: 12 })
    );
  });

  it("rebuilds a model saved without meshes, from the account's copy when this device has none", async () => {
    const account = model('Only in the account', false);
    const regenerate = host({
      loadAccount: vi.fn().mockResolvedValue(account),
      rebuild: vi.fn().mockResolvedValue({
        ...account.derived,
        bodyRepresentations: meshes('body_rebuilt')
      })
    });

    await regenerateProjectThumbnails([summary(account)], regenerate);

    expect(regenerate.rebuild).toHaveBeenCalledWith(account);
    expect(regenerate.render).toHaveBeenCalledWith([{ consumed: false }]);
    expect(regenerate.save).toHaveBeenCalledTimes(1);
  });

  it("draws this device's own model when the account's is no closer to the listing", async () => {
    const ahead = model('Unsynced edits', true);
    ahead.version = 15;
    const behind = { ...structuredClone(ahead), version: 12 };
    const regenerate = host({
      loadLocal: vi.fn().mockResolvedValue(ahead),
      loadAccount: vi.fn().mockResolvedValue(behind)
    });

    await regenerateProjectThumbnails(
      [{ ...summary(ahead), documentVersion: 13 }],
      regenerate
    );

    expect(regenerate.save).toHaveBeenCalledWith(
      ahead.projectId,
      expect.objectContaining({ version: 15 })
    );
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

  it('stops before saving anything once its session ends mid-project', async () => {
    // Review: the run outlived the library, the account and the key session.
    const first = model('First', false);
    const second = model('Second', true);
    let live = true;
    const loadLocal = vi.fn(async (id: string) =>
      id === first.projectId ? first : second
    );
    const drawn = vi.fn();
    const regenerate = host({
      loadLocal,
      // A project opens while the first model rebuilds.
      rebuild: vi.fn(async () => {
        live = false;
        return { ...first.derived, bodyRepresentations: meshes('body_first') };
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
