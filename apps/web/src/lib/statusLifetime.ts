/**
 * The status line is a log of what just happened, not a description of the
 * present. A message that stays after its action is over reads as a fresh
 * complaint about whatever the user did next, so informational messages
 * expire; only text that describes a mode the user is still in stays.
 */

/** How long an informational message stays on the bar. */
export const STATUS_LIFETIME_MS = 8000;

/**
 * A message younger than this survives a selection change. Pick handlers
 * retire the previous message and then set their own in the same tick, and
 * the order those two land in must not decide whether the new one shows.
 */
export const STATUS_SETTLE_MS = 300;

export interface StatusEntry {
  text: string;
  /** When the message was set (ms since the epoch); 0 retires it at once. */
  at: number;
  /** Mode text that describes a state the user is still in; never expires. */
  sticky: boolean;
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
