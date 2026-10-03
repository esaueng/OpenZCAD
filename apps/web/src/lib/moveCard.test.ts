import { describe, expect, it } from 'vitest';
import { moveHasUnappliedChange } from './moveCard';

const zero = { x: 0, y: 0, z: 0 };

describe('moveHasUnappliedChange', () => {
  it('is false with no Move card, or one still at zero', () => {
    expect(moveHasUnappliedChange(null)).toBe(false);
    expect(
      moveHasUnappliedChange({ translation: zero, rotationDeg: zero })
    ).toBe(false);
  });

  it('is true for any translation or rotation not yet applied', () => {
    expect(
      moveHasUnappliedChange({
        translation: { ...zero, x: 60 },
        rotationDeg: zero
      })
    ).toBe(true);
    expect(
      moveHasUnappliedChange({
        translation: zero,
        rotationDeg: { ...zero, z: -15 }
      })
    ).toBe(true);
  });
});
