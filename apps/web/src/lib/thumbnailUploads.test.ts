import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  THUMBNAIL_UPLOAD_SETTLE_MS,
  settleThumbnailUploads,
  trackThumbnailUpload
} from './thumbnailUploads';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

afterEach(() => vi.useRealTimers());

describe('thumbnailUploads', () => {
  it('resolves at once when nothing is uploading', async () => {
    let settled = false;
    void settleThumbnailUploads().then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(true);
  });

  it('holds a listing read until the card upload settles', async () => {
    const upload = deferred<string>();
    void trackThumbnailUpload(upload.promise);
    let settled = false;
    const waiting = settleThumbnailUploads().then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    upload.resolve('artifact_fresh');
    await waiting;
    expect(settled).toBe(true);
  });

  it('settles on a failed upload without rejecting', async () => {
    const upload = deferred<string>();
    const tracked = trackThumbnailUpload(upload.promise);
    const waiting = settleThumbnailUploads();
    upload.reject(new Error('offline'));
    await expect(tracked).rejects.toThrow('offline');
    await expect(waiting).resolves.toBeUndefined();
    // And it is no longer pending afterwards.
    await expect(settleThumbnailUploads()).resolves.toBeUndefined();
  });

  it('stops waiting on a stalled upload after the timeout', async () => {
    vi.useFakeTimers();
    void trackThumbnailUpload(new Promise(() => undefined));
    let settled = false;
    void settleThumbnailUploads().then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(THUMBNAIL_UPLOAD_SETTLE_MS - 1);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toBe(true);
    // Its time is up, so it no longer holds back the next refresh either.
    let next = false;
    void settleThumbnailUploads().then(() => {
      next = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(next).toBe(true);
  });
});
