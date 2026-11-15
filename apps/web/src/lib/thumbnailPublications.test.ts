import { describe, expect, it } from 'vitest';
import {
  beginListingRead,
  deviceCardOutranksListing,
  finishListingRead,
  notePublishedThumbnail,
  publicationSession,
  retireThumbnailPublications
} from './thumbnailPublications';

describe('thumbnailPublications', () => {
  it('keeps the device card over a listing read before the publish finished', () => {
    // Leaving a project uploads its card and refreshes the listing at once.
    const read = beginListingRead();
    notePublishedThumbnail('proj_race', publicationSession());
    finishListingRead(read);
    expect(deviceCardOutranksListing('proj_race')).toBe(true);
  });

  it('hands back to the account once a listing read after the publish is applied', () => {
    notePublishedThumbnail('proj_settled', publicationSession());
    const later = beginListingRead();
    expect(deviceCardOutranksListing('proj_settled')).toBe(true);
    finishListingRead(later);
    // That listing may name another device's newer card; it is not overruled.
    expect(deviceCardOutranksListing('proj_settled')).toBe(false);
  });

  it('is not overruled by an older read finishing after a newer one', () => {
    const older = beginListingRead();
    notePublishedThumbnail('proj_order', publicationSession());
    const newer = beginListingRead();
    finishListingRead(newer);
    finishListingRead(older);
    expect(deviceCardOutranksListing('proj_order')).toBe(false);
  });

  it('says nothing about projects this tab has not published', () => {
    expect(deviceCardOutranksListing('proj_never')).toBe(false);
  });

  it('retires publications when the account or key session changes', () => {
    notePublishedThumbnail('proj_retired', publicationSession());
    retireThumbnailPublications();
    expect(deviceCardOutranksListing('proj_retired')).toBe(false);
  });

  it('ignores a publish that began in a session since retired', () => {
    // An upload started under the previous account finishes after sign-out.
    const startedIn = publicationSession();
    retireThumbnailPublications();
    notePublishedThumbnail('proj_late', startedIn);
    expect(deviceCardOutranksListing('proj_late')).toBe(false);
  });
});
