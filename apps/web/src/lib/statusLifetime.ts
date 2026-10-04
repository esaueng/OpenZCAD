/**
 * The status line is a log of what just happened, not a description of the
 * present. A message that stays after its action is over reads as a fresh
 * complaint about whatever the user did next, so informational messages
 * expire; only text that describes a mode the user is still in stays.
 */

/** How long an informational message stays on the bar. */
export const STATUS_LIFETIME_MS = 8000;

/**
 * How often the bar counts a live message's lifetime. The lifetime is time
 * the page could draw the message, not wall time: opening a project mounts
 * the viewer, whose first frame can hold the main thread for seconds while
 * its shaders compile (a slow GPU, software GL in CI), and a message set
 * around it — "Opened …", a refused shortcut — used to spend its whole
 * lifetime frozen and expire the moment the page could paint again.
 */
export const STATUS_CLOCK_STEP_MS = 250;

/**
 * Adds the time since the last count to a message's lifetime. A gap longer
 * than a late step is the page unable to draw, so it counts as one late step
 * and no more.
 */
export function advanceStatusClock(elapsed: number, gap: number): number {
  return elapsed + Math.min(Math.max(gap, 0), 2 * STATUS_CLOCK_STEP_MS);
}

/**
 * A message younger than this survives a selection change. Pick handlers
 * retire the previous message and then set their own in the same tick, and
 * the order those two land in must not decide whether the new one shows.
 */
export const STATUS_SETTLE_MS = 300;

export interface StatusEntry {
  text: string;
  /** Full diagnostic retained for the Activity log, never the compact bar. */
  detail?: string;
  /** When the message was set (ms since the epoch); 0 retires it at once. */
  at: number;
  /** Mode text that describes a state the user is still in; never expires. */
  sticky: boolean;
  /**
   * Lane-only: where the user now is (a workspace switch), not something
   * that happened to the model, so the activity log leaves it out.
   */
  unlogged?: boolean;
}

export function statusExpiresAt(entry: {
  at: number;
  sticky: boolean;
}): number | null {
  return entry.sticky ? null : entry.at + STATUS_LIFETIME_MS;
}

export function retireStatus(entry: StatusEntry, now: number): StatusEntry {
  if (entry.sticky || now - entry.at < STATUS_SETTLE_MS) {
    return entry;
  }
  return entry.at === 0 ? entry : { ...entry, at: 0 };
}
