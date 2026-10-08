import { describe, expect, it } from 'vitest';
import { formatEntryTime } from './timeline';

describe('assistant turn times', () => {
  it('writes the hour without a leading zero', () => {
    // `2-digit` wrote 9:05 as "09:05 AM" on a 12-hour clock.
    const nineOhFive = new Date(2026, 0, 1, 9, 5).getTime();
    expect(formatEntryTime(nineOhFive)).toMatch(/^9\D05/);
  });
});
