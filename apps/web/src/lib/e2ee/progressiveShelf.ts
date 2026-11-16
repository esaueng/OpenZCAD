/**
 * Bound account-wide verification without making one slow card hold the shelf.
 *
 * A failed verification leaves that card locked/unnamed and the rest go on,
 * except a failure `haltOn` matches (a rate limit): every later request
 * would fail the same way while spending the account's shared read budget,
 * so no further entry starts and the listing rejects with that failure.
 * Entries already published stay published.
 */
export async function verifyShelfEntries<T, R>(
  entries: readonly T[],
  verify: (entry: T) => Promise<R>,
  publish: (entry: T, verified: R) => void,
  isCurrent: () => boolean,
  haltOn?: (error: unknown) => boolean
): Promise<void> {
  let next = 0;
  let halted: { readonly error: unknown } | null = null;
  await Promise.all(
    Array.from({ length: Math.min(4, entries.length) }, async () => {
      while (!halted && isCurrent() && next < entries.length) {
        const entry = entries[next++]!;
        try {
          const verified = await verify(entry);
          if (isCurrent()) publish(entry, verified);
        } catch (error) {
          if (!halted && haltOn?.(error)) halted = { error };
          // Otherwise this card stays locked/unnamed, never trusted.
        }
      }
    })
  );
  if (halted) throw (halted as { readonly error: unknown }).error;
}
