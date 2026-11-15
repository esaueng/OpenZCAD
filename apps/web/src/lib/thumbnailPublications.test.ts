import { describe, expect, it, vi } from 'vitest';
import { toArtifactId, type ProjectSummary } from '@openzcad/shared';
import {
  beginListingRead,
  notePublishedThumbnail,
  subscribePublishedThumbnails,
  withPublishedThumbnail,
  withPublishedThumbnails
} from './thumbnailPublications';

function summary(
  projectId: string,
  thumbnailArtifactId?: string
): ProjectSummary {
  return {
    projectId,
    name: 'Card',
    updatedAt: '2026-11-14T20:00:00.000Z',
    documentVersion: 9,
    ...(thumbnailArtifactId
      ? { thumbnailArtifactId: toArtifactId(thumbnailArtifactId) }
      : {})
  } as ProjectSummary;
}

describe('thumbnailPublications', () => {
  it('names the card this tab published while the listing was being read', () => {
    // Leaving a project uploads its card and refreshes the listing at once.
    // A listing read before the upload finalized names the card it replaced.
    const readStartedAt = beginListingRead();
    notePublishedThumbnail('proj_race', toArtifactId('artifact_fresh'));
    expect(
      withPublishedThumbnail(
        summary('proj_race', 'artifact_replaced'),
        readStartedAt
      ).thumbnailArtifactId
    ).toBe('artifact_fresh');
    // A listing read before the project had any card at all, too.
    expect(
      withPublishedThumbnail(summary('proj_race'), readStartedAt)
        .thumbnailArtifactId
    ).toBe('artifact_fresh');
  });

  it("leaves a listing read after the publish alone, so another device's newer card wins", () => {
    notePublishedThumbnail('proj_later', toArtifactId('artifact_mine'));
    const readStartedAt = beginListingRead();
    const listed = summary('proj_later', 'artifact_other_device');
    expect(withPublishedThumbnail(listed, readStartedAt)).toBe(listed);
  });

  it('leaves projects this tab has not published untouched', () => {
    const readStartedAt = beginListingRead();
    notePublishedThumbnail('proj_published', toArtifactId('artifact_new'));
    const untouched = summary('proj_untouched', 'artifact_listed');
    const corrected = withPublishedThumbnails(
      [untouched, summary('proj_published', 'artifact_old')],
      readStartedAt
    );
    expect(corrected[0]).toBe(untouched);
    expect(corrected[1]?.thumbnailArtifactId).toBe('artifact_new');
  });

  it('returns the same list when nothing needed correcting', () => {
    const readStartedAt = beginListingRead();
    const projects = [summary('proj_quiet', 'artifact_listed')];
    expect(withPublishedThumbnails(projects, readStartedAt)).toBe(projects);
  });

  it('tells subscribers about each publish, and stops when unsubscribed', () => {
    const listener = vi.fn();
    const unsubscribe = subscribePublishedThumbnails(listener);
    notePublishedThumbnail('proj_heard', toArtifactId('artifact_heard'));
    unsubscribe();
    notePublishedThumbnail('proj_heard', toArtifactId('artifact_unheard'));
    expect(listener).toHaveBeenCalledOnce();
    expect(listener).toHaveBeenCalledWith('proj_heard', 'artifact_heard');
  });
});
