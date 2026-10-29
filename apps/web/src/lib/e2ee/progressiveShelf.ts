/** Bound account-wide verification without making one slow card hold the shelf. */
export async function verifyShelfEntries<T, R>(
  entries: readonly T[],
  verify: (entry: T) => Promise<R>,
  publish: (entry: T, verified: R) => void,
  isCurrent: () => boolean
): Promise<void> {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(4, entries.length) }, async () => {
      while (isCurrent() && next < entries.length) {
        const entry = entries[next++]!;
        try {
          const verified = await verify(entry);
          if (isCurrent()) publish(entry, verified);
        } catch {
          // A failed verification leaves this card locked/unnamed, never trusted.
        }
      }
    })
  );
}
