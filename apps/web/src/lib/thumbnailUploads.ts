/**
 * Card uploads still on their way to the account.
 *
 * Leaving a project uploads its card and refreshes the project listing at
 * once. A listing read while the upload was finalizing names the card it
 * replaced, and since the device record by then carries the new artifact, the
 * tile downloaded the previous card over the one just drawn and kept it until
 * the next refresh. Reading the listing after the upload settles removes the
 * race at its source: the account then names its own current card, and
 * nothing on this side has to guess at the server's order.
 *
 * The shelf does not wait on this to show the new card — the capture seeds
 * the tile directly — only the listing refresh behind it does.
 */
const pending = new Set<Promise<void>>();

/** The longest a listing refresh waits on any one upload. */
export const THUMBNAIL_UPLOAD_SETTLE_MS = 5000;

/**
 * Tracks an upload until it settles, or for at most
 * {@link THUMBNAIL_UPLOAD_SETTLE_MS}; returns the same promise. The bound is
 * per upload, so one that stalls stops holding listings back once its time
 * is up rather than delaying every refresh after it.
 */
export function trackThumbnailUpload<T>(upload: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const settled = Promise.race([
    upload.then(
      () => undefined,
      () => undefined
    ),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, THUMBNAIL_UPLOAD_SETTLE_MS);
    })
  ]).finally(() => {
    clearTimeout(timer);
    pending.delete(settled);
  });
  pending.add(settled);
  return upload;
}

/**
 * Resolves once every upload tracked before this call has settled or run out
 * of time. Never rejects. A failed or stalled upload only costs the listing
 * that delay; the race it guards against then remains possible, as before.
 */
export function settleThumbnailUploads(): Promise<void> {
  if (pending.size === 0) return Promise.resolve();
  return Promise.all([...pending]).then(() => undefined);
}
