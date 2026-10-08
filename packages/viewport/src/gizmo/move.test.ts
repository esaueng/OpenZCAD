import { describe, expect, it } from 'vitest';
import { snapTo } from './move';

/**
 * The Move panel shows these values verbatim, so a snapped drag has to land
 * on the decimal the step names: 0.3, never 0.30000000000000004.
 */
describe('snapTo', () => {
  it('lands decimal steps on their own decimal places', () => {
    expect(snapTo(0.33, 0.1, false)).toBe(0.3);
    expect(String(snapTo(0.33, 0.1, false))).toBe('0.3');
    expect(snapTo(0.72, 0.1, false)).toBe(0.7);
    expect(snapTo(0.16, 0.05, false)).toBe(0.15);
    expect(snapTo(1.237, 0.01, false)).toBe(1.24);
    expect(snapTo(-0.33, 0.1, false)).toBe(-0.3);
    expect(snapTo(7.3, 0.25, false)).toBe(7.25);
  });

  it('keeps whole steps whole and folds negative zero', () => {
    expect(snapTo(12.3, 5, false)).toBe(10);
    expect(snapTo(137, 25, false)).toBe(125);
    expect(Object.is(snapTo(-0.04, 0.1, false), 0)).toBe(true);
  });

  it('preserves non-finite values instead of substituting an origin snap', () => {
    expect(snapTo(Number.NaN, 0.1, false)).toBeNaN();
    expect(snapTo(Infinity, 0.1, false)).toBe(Infinity);
    expect(snapTo(-Infinity, 0.1, false)).toBe(-Infinity);
  });

  it('rounds a fine drag to hundredths', () => {
    expect(snapTo(0.123, 0.1, true)).toBe(0.12);
  });
});
