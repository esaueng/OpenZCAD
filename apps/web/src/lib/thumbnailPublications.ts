/**
 * Which device cards the shelf should keep showing over the account's.
 *
 * Leaving a project uploads its card while the shelf refreshes the project
 * listing. A listing read while the upload finalized names the card it
 * replaced, and because the device record by then carries the new artifact,
 * the tile used to download that previous card over the one just drawn.
 *
 * Nothing here decides what the account's current card is: the order in
 * which this tab hears back says nothing certain about the server's order,
 * and listings are left exactly as the account sent them. It only says that
 * this device's card is at least as new as any listing this tab has applied
 * since — so the tile shows the device image until a listing whose read
 * began after the publish has been applied. That listing is the account's
 * word again, and the ordinary artifact comparison takes over.
 *
 * Publications belong to the account and key session they began in. A
 * session change retires every entry, and a publish that began before it is
 * ignored when it finishes.
 */
let clock = 0;
let session = 0;
let lastAppliedReadStartedAt = 0;
const published = new Map<string, number>();

/** Taken before a publish begins; hand it back to {@link notePublishedThumbnail}. */
export function publicationSession(): number {
  return session;
}

/** Retires every publication: the account or key session changed. */
export function retireThumbnailPublications(): void {
  session += 1;
  published.clear();
}

/** Records that this tab finished publishing a project's device card. */
export function notePublishedThumbnail(
  projectId: string,
  startedInSession: number
): void {
  if (startedInSession !== session) return;
  published.set(projectId, ++clock);
}

/** Marks the start of a listing read; pass the result to the finish. */
export function beginListingRead(): number {
  return ++clock;
}

/** The listing whose read began at `readStartedAt` is now the shelf's. */
export function finishListingRead(readStartedAt: number): void {
  lastAppliedReadStartedAt = Math.max(lastAppliedReadStartedAt, readStartedAt);
  for (const [projectId, at] of published)
    if (at < lastAppliedReadStartedAt) published.delete(projectId);
}

/**
 * True while no applied listing was read after this tab published the
 * project's card, so a listing naming another artifact may simply predate it.
 */
export function deviceCardOutranksListing(projectId: string): boolean {
  const at = published.get(projectId);
  return at !== undefined && at > lastAppliedReadStartedAt;
}
