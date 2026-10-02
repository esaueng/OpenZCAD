import { describe, expect, it } from 'vitest';
import {
  advanceStatusClock,
  retireStatus,
  STATUS_CLOCK_STEP_MS,
  statusExpiresAt,
  STATUS_LIFETIME_MS,
  STATUS_SETTLE_MS
} from './statusLifetime';

describe('status lifetime', () => {
  it('gives an informational message a lifetime and a mode message none', () => {
    expect(statusExpiresAt({ at: 1000, sticky: false })).toBe(
      1000 + STATUS_LIFETIME_MS
    );
    expect(statusExpiresAt({ at: 1000, sticky: true })).toBeNull();
  });

  it('retires a settled message at once and leaves a fresh or sticky one', () => {
    const settled = { text: 'Add box', at: 1000, sticky: false };
    expect(retireStatus(settled, 1000 + STATUS_SETTLE_MS)).toEqual({
      ...settled,
      at: 0
    });
    const fresh = { text: 'Face selected', at: 1000, sticky: false };
    expect(retireStatus(fresh, 1000 + STATUS_SETTLE_MS - 1)).toBe(fresh);
    const mode = { text: 'Sketching on the XY plane', at: 1000, sticky: true };
    expect(retireStatus(mode, 10_000)).toBe(mode);
  });

  it('counts a stalled page as one late step, not the length of the stall', () => {
    expect(advanceStatusClock(1000, STATUS_CLOCK_STEP_MS)).toBe(
      1000 + STATUS_CLOCK_STEP_MS
    );
    // A step that ran a little late still counts in full.
    expect(advanceStatusClock(1000, 400)).toBe(1400);
    // The viewer's first frame held the main thread for nine seconds: the
    // message could not be drawn, so it did not age by nine seconds.
    expect(advanceStatusClock(1000, 9000)).toBe(
      1000 + 2 * STATUS_CLOCK_STEP_MS
    );
    // A clock that went backwards takes nothing away.
    expect(advanceStatusClock(1000, -50)).toBe(1000);
  });
});
