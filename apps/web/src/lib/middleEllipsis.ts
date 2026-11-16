/**
 * Names shortened in the middle rather than at the end.
 *
 * Library names in a series differ at their ends ("PiKVM v3.3 Enclosure V4"
 * and "… V5"), so an end ellipsis hides exactly the part that tells two tiles
 * apart. Keeping the head and the tail, with "…" between, keeps both the
 * family and the distinguishing suffix in sight.
 */

export const MIDDLE_ELLIPSIS = '…';

/**
 * `name` reduced to `keep` characters around a middle ellipsis: a little more
 * of the head than the tail, since the head names the thing and the tail
 * only has to carry the suffix. Counts code points, so a surrogate pair is
 * never split, and trims the spaces that would otherwise sit against the
 * ellipsis. A `keep` at or past the name's length returns it unchanged.
 */
export function middleEllipsis(name: string, keep: number): string {
  const chars = Array.from(name);
  if (keep >= chars.length) return name;
  const kept = Math.max(0, Math.floor(keep));
  const tail = Math.floor(kept * 0.4);
  const head = kept - tail;
  return (
    chars.slice(0, head).join('').trimEnd() +
    MIDDLE_ELLIPSIS +
    (tail > 0
      ? chars
          .slice(chars.length - tail)
          .join('')
          .trimStart()
      : '')
  );
}

/**
 * The longest middle-shortened form of `name` that `fits` accepts, or the
 * name itself when it fits whole. `fits` is a measurement (for a tile, "lays
 * out in two lines"); it is assumed monotonic in length, so a binary search
 * finds the answer in a handful of calls rather than one per character.
 * When not even a bare ellipsis fits, the ellipsis is returned anyway: the
 * caller's own clipping is the last resort.
 */
export function fitMiddleEllipsis(
  name: string,
  fits: (text: string) => boolean
): string {
  if (fits(name)) return name;
  const length = Array.from(name).length;
  let low = 0;
  let high = length - 1;
  let best = middleEllipsis(name, 0);
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const candidate = middleEllipsis(name, mid);
    if (fits(candidate)) {
      best = candidate;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return best;
}
