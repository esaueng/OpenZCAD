import { describe, expect, it } from 'vitest';
import { toArtifactId, type ProjectSummary } from '@openzcad/shared';
import { cachedThumbnailSource, mergeProjectSummaries } from './projectShelf';
import type { ProjectThumbnailRecord } from './localProjectStore';

const LISTED = '2026-08-07T12:25:30.000Z';
const EARLIER = '2026-08-07T12:25:21.000Z';

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
