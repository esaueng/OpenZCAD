/**
 * Keeps a projection cache to what the document still draws, and bounds what
 * it holds for sheets not on screen. Every view of every sheet is a valid
 * key (a document may have 50 sheets of 24 views), so validity alone would
 * keep every projection the user has looked at for as long as Draw is open.
 *
 * - Keys no sheet draws any more go.
 * - The `active` keys (the sheet on screen) always stay, and move to the
 *   recent end of the map's order.
 * - Of the rest, the least recently shown go first until their total size is
 *   within `budgetBytes`.
 */
export function pruneProjectionCache<T>(
  cache: Map<string, T>,
  wanted: ReadonlySet<string>,
  active: ReadonlySet<string>,
  budgetBytes: number,
  sizeOf: (entry: T) => number
): void {
  for (const key of [...cache.keys()]) if (!wanted.has(key)) cache.delete(key);
  for (const key of active) {
    const entry = cache.get(key);
    if (entry === undefined) continue;
    cache.delete(key);
    cache.set(key, entry);
  }
  let inactive = 0;
  for (const [key, entry] of cache)
    if (!active.has(key)) inactive += sizeOf(entry);
  for (const [key, entry] of [...cache]) {
    if (inactive <= budgetBytes) break;
    if (active.has(key)) continue;
    inactive -= sizeOf(entry);
    cache.delete(key);
  }
}
