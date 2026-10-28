import { describe, expect, it, vi } from 'vitest';
import { toArtifactId, type ProjectSummary } from '@openzcad/shared';
import {
  cachedThumbnailSource,
  mergeProjectSummaries,
  retainPendingShelfOrder,
  prioritizeShelfEntries,
  withVerifiedShelfMetadata,
  resolveShelfThumbnail,
  thumbnailRecordDescribes
} from './projectShelf';
import type { ProjectThumbnailRecord } from './localProjectStore';

const LISTED = '2026-08-07T12:25:30.000Z';
const EARLIER = '2026-08-07T12:25:21.000Z';

it('verifies pinned and visible cards first without dropping or mutating records', () => {
  const records = ['offscreen', 'visible', 'pinned', 'other'].map(
    (projectId) => ({ projectId })
  );
  expect(
    prioritizeShelfEntries(records, ['pinned', 'visible', 'pinned']).map(
      (entry) => entry.projectId
    )
  ).toEqual(['pinned', 'visible', 'offscreen', 'other']);
  expect(records[0]?.projectId).toBe('offscreen');
});

describe('provisional encrypted shelf refresh', () => {
  const local = {
    projectId: 'proj_pending',
    name: 'Device bracket',
    updatedAt: EARLIER,
    revisionCount: 1,
    thumbnailArtifactId: toArtifactId('cached-preview'),
    documentVersion: 2
  } as ProjectSummary;
  const remote = {
    ...local,
    name: 'Encrypted project',
    storageFormat: 2,
    thumbnailArtifactId: toArtifactId('unverified-preview'),
    updatedAt: LISTED,
    documentVersion: 3
  };
  const pending = new Set([local.projectId]);

  it('keeps known presentation while preserving remote format and version conflict fences', () => {
    const [merged] = mergeProjectSummaries([local], [remote], pending);
    expect(merged).toEqual({
      ...remote,
      name: local.name,
      thumbnailArtifactId: local.thumbnailArtifactId
    });
    expect(
      withVerifiedShelfMetadata(merged!, {
        ...remote,
        name: 'Verified bracket'
      })
    ).toEqual({
      ...merged,
      name: 'Verified bracket',
      thumbnailArtifactId: remote.thumbnailArtifactId
    });
    expect(
      withVerifiedShelfMetadata(
        { ...merged!, documentVersion: 4, name: 'New local edit' },
        remote
      ).name
    ).toBe('New local edit');
  });

  it('accepts verified and ordinary renames, including the literal placeholder text', () => {
    expect(mergeProjectSummaries([local], [remote])[0]?.name).toBe(
      'Encrypted project'
    );
    expect(
      mergeProjectSummaries(
        [local],
        [{ ...remote, storageFormat: 1 }],
        pending
      )[0]?.name
    ).toBe('Encrypted project');
    expect(mergeProjectSummaries([], [remote], pending)[0]?.name).toBe(
      'Encrypted project'
    );
  });

  it('does not pick up unverified thumbnail references when the device has none', () => {
    const { thumbnailArtifactId: _thumbnail, ...noPreview } = local;
    expect(
      mergeProjectSummaries([noPreview], [remote], pending)[0]
        ?.thumbnailArtifactId
    ).toBeUndefined();
  });

  it('holds card order while preserving the real transport timestamps for verification', () => {
    const other = {
      ...local,
      projectId: 'proj_other',
      updatedAt: '2026-08-07T12:25:25.000Z'
    } as ProjectSummary;
    const projects = mergeProjectSummaries([local, other], [remote], pending);
    const stable = retainPendingShelfOrder(projects, [local, other], pending);
    expect(stable.map((project) => project.projectId)).toEqual([
      other.projectId,
      local.projectId
    ]);
    expect(stable[1]?.updatedAt).toBe(LISTED);
    expect(
      retainPendingShelfOrder(projects, [local, other])[0]?.projectId
    ).toBe(local.projectId);
  });
});

describe('late verified shelf metadata', () => {
  const listed = {
    projectId: 'proj_verified',
    name: 'Encrypted project',
    updatedAt: LISTED,
    revisionCount: 1,
    storageFormat: 2
  } as ProjectSummary;
  it('updates only presentation, preserving local organization', () => {
    const organized = {
      ...listed,
      organization: { status: 'archived' as const, pinned: true, sortOrder: 7 }
    };
    expect(
      withVerifiedShelfMetadata(organized, { ...listed, name: 'Verified part' })
    ).toEqual({ ...organized, name: 'Verified part' });
  });
  it('does not overwrite a newer rename or a changed storage format', () => {
    const verified = { ...listed, name: 'Old verified title' };
    for (const changed of [
      { ...listed, name: 'New local title', updatedAt: '2026-10-28T12:00:00Z' },
      { ...listed, storageFormat: 1 }
    ]) {
      expect(withVerifiedShelfMetadata(changed, verified)).toBe(changed);
    }
  });
});

function summary(updatedAt: string): ProjectSummary {
  return {
    projectId: 'proj_thumbnail',
    name: 'Thumbnail Box',
    revisionCount: 1,
    updatedAt
  } as ProjectSummary;
}

function record(
  source: string | null,
  updatedAt: string
): ProjectThumbnailRecord {
  return { projectId: 'proj_thumbnail', source, version: 1, updatedAt };
}

describe('cachedThumbnailSource', () => {
  it('asks the backfill when this device has never rendered the project', () => {
    expect(cachedThumbnailSource(null, summary(LISTED))).toBeUndefined();
  });

  it('answers from the cache when the preview still describes the listing', () => {
    expect(
      cachedThumbnailSource(
        record('data:image/webp;base64,AA', LISTED),
        summary(LISTED)
      )
    ).toBe('data:image/webp;base64,AA');
  });

  it('serves a stale image rather than loading the document to redraw it', () => {
    expect(
      cachedThumbnailSource(
        record('data:image/webp;base64,AA', EARLIER),
        summary(LISTED)
      )
    ).toBe('data:image/webp;base64,AA');
  });

  it('answers "no geometry" for a part that is empty at the listed version', () => {
    expect(
      cachedThumbnailSource(record(null, LISTED), summary(LISTED))
    ).toBeNull();
  });

  it('re-derives a "no geometry" recorded against a version that has moved on', () => {
    // The refresh debounce coming due on a project still empty leaves this
    // record behind. Answering it would put "No geometry" on the card of every
    // part first modelled after that pause, permanently: a null is an answer,
    // so nothing would ask the backfill to look again.
    expect(
      cachedThumbnailSource(record(null, EARLIER), summary(LISTED))
    ).toBeUndefined();
  });

  it('replaces an empty local answer when the account has an image', () => {
    expect(
      cachedThumbnailSource(record(null, LISTED), {
        ...summary(LISTED),
        thumbnailArtifactId: toArtifactId('artifact_cloud_thumbnail')
      })
    ).toBeUndefined();
  });

  it('refreshes a downloaded image when the account preview changes', () => {
    expect(
      cachedThumbnailSource(
        {
          ...record('data:image/webp;base64,AA', LISTED),
          artifactId: toArtifactId('artifact_old_thumbnail')
        },
        {
          ...summary(LISTED),
          thumbnailArtifactId: toArtifactId('artifact_new_thumbnail')
        }
      )
    ).toBeUndefined();
  });
});

describe('mergeProjectSummaries', () => {
  it('keeps the account thumbnail when the device document is newer', () => {
    const [merged] = mergeProjectSummaries(
      [{ ...summary(LISTED), updatedAt: LISTED }],
      [
        {
          ...summary(EARLIER),
          updatedAt: EARLIER,
          thumbnailArtifactId: toArtifactId('artifact_cloud_thumbnail')
        }
      ]
    );

    expect(merged?.thumbnailArtifactId).toBe('artifact_cloud_thumbnail');
    expect(merged?.updatedAt).toBe(LISTED);
  });
});

describe('thumbnailRecordDescribes', () => {
  it('matches a record rendered from the listed version', () => {
    expect(
      thumbnailRecordDescribes(record('data:x', LISTED), {
        documentVersion: 1
      })
    ).toBe(true);
    expect(
      thumbnailRecordDescribes(record('data:x', LISTED), {
        documentVersion: 2
      })
    ).toBe(false);
  });

  it('cannot fault a listing whose version is unknown', () => {
    expect(thumbnailRecordDescribes(record(null, LISTED), {})).toBe(true);
    expect(thumbnailRecordDescribes(null, {})).toBe(false);
  });
});

describe('resolveShelfThumbnail', () => {
  const artifactId = toArtifactId('artifact_listed');

  it('shows the device image when the account copy cannot be fetched', async () => {
    // A listing one refresh stale names a thumbnail the Worker has already
    // superseded and deleted. The device image is still the part.
    const source = await resolveShelfThumbnail(
      { ...summary(LISTED), thumbnailArtifactId: artifactId },
      {
        loadCached: async () => ({
          ...record('data:image/webp;base64,DEVICE', LISTED),
          artifactId: toArtifactId('artifact_superseded')
        }),
        download: async () => {
          throw new Error('404');
        }
      }
    );
    expect(source).toBe('data:image/webp;base64,DEVICE');
  });

  it('prefers the account image when it does arrive', async () => {
    const source = await resolveShelfThumbnail(
      { ...summary(LISTED), thumbnailArtifactId: artifactId },
      {
        loadCached: async () => ({
          ...record('data:image/webp;base64,DEVICE', LISTED),
          artifactId: toArtifactId('artifact_superseded')
        }),
        download: async () => 'data:image/webp;base64,CLOUD'
      }
    );
    expect(source).toBe('data:image/webp;base64,CLOUD');
  });

  it('never answers "no geometry" for a part the account has a picture of', async () => {
    const source = await resolveShelfThumbnail(
      { ...summary(LISTED), thumbnailArtifactId: artifactId },
      {
        loadCached: async () => record(null, LISTED),
        download: async () => {
          throw new Error('offline');
        }
      }
    );
    expect(source).toBeUndefined();
  });

  it('does not touch the network for a device-only project', async () => {
    const download = vi.fn();
    const source = await resolveShelfThumbnail(summary(LISTED), {
      loadCached: async () => record('data:image/webp;base64,DEVICE', EARLIER),
      download
    });
    expect(source).toBe('data:image/webp;base64,DEVICE');
    expect(download).not.toHaveBeenCalled();
  });
});
