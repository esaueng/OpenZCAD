/**
 * Hysteresis for hover preselection.
 *
 * Sweeping across a dense edge set lands each frame's pick on a different
 * side of a boundary, and a highlight that follows every frame strobes: the
 * outgoing face starts fading, the incoming one starts rising, and the next
 * frame reverses both. A short dwell settles that. A change of target has to
 * be seen for `dwellMs` before it is committed; entering geometry from empty
 * space and staying on the same target are committed at once, because delay
 * there reads as lag rather than steadiness.
 *
 * The dwell is shorter than the hover fade (`TAU_MS` in `motion.ts`), so a
 * boundary flicker is absorbed before either fade could become visible, while
 * a deliberate move to a neighbour still lands inside `DUR_FAST_MS`.
 */
export const HOVER_DWELL_MS = 60;

export type HoverDwellVerdict<T> =
  { commit: true; candidate: T | null } | { commit: false; pending: boolean };

export class HoverDwell<T> {
  private committedKey: string | null = null;
  private pendingKey: string | null | undefined = undefined;
  private pendingSince = 0;

  constructor(
    private readonly keyOf: (candidate: T | null) => string | null,
    private readonly dwellMs = HOVER_DWELL_MS
  ) {}

  /**
   * Offers the pick under the pointer at `now`. A committed verdict carries
   * the candidate to apply; `pending: true` means the caller should ask for
   * another frame so a pointer that has stopped moving still settles.
   */
  propose(candidate: T | null, now: number): HoverDwellVerdict<T> {
    const key = this.keyOf(candidate);
    if (key === this.committedKey) {
      this.pendingKey = undefined;
      return { commit: false, pending: false };
    }
    if (this.committedKey === null) {
      return this.commit(key, candidate);
    }
    if (this.pendingKey !== key) {
      this.pendingKey = key;
      this.pendingSince = now;
      return { commit: false, pending: true };
    }
    if (now - this.pendingSince >= this.dwellMs) {
      return this.commit(key, candidate);
    }
    return { commit: false, pending: true };
  }

  /** Records a hover applied outside the dwell, so the next proposal measures from it. */
  reset(candidate: T | null = null) {
    this.committedKey = this.keyOf(candidate);
    this.pendingKey = undefined;
  }

  private commit(
    key: string | null,
    candidate: T | null
  ): HoverDwellVerdict<T> {
    this.committedKey = key;
    this.pendingKey = undefined;
    return { commit: true, candidate };
  }
}
