import { describe, expect, it } from 'vitest';
import { pointerSlack, TOUCH_TOLERANCE_SCALE } from './pointerSlack';

describe('pointerSlack', () => {
  it('doubles a tolerance for a finger only', () => {
    expect(pointerSlack({ pointerType: 'touch' })).toBe(TOUCH_TOLERANCE_SCALE);
    expect(TOUCH_TOLERANCE_SCALE).toBe(2);
    expect(pointerSlack({ pointerType: 'pen' })).toBe(1);
    expect(pointerSlack({ pointerType: 'mouse' })).toBe(1);
    // A dblclick MouseEvent carries no pointer type.
    expect(pointerSlack({})).toBe(1);
    expect(pointerSlack(null)).toBe(1);
  });
});
