import { describe, expect, it } from 'vitest';
import { formatMeasuredQuantity } from './model';

describe('formatMeasuredQuantity', () => {
  it('gives every area and volume readout the same two decimals', () => {
    // The face the callout showed as 511.73 and the inspector as 511.726.
    expect(formatMeasuredQuantity(511.7264)).toBe('511.73');
    expect(formatMeasuredQuantity(12281.4163)).toBe('12281.42');
    expect(formatMeasuredQuantity(720.0000004)).toBe('720');
    expect(formatMeasuredQuantity(3600)).toBe('3600');
  });

  it('keeps small inch-scale values readable', () => {
    expect(formatMeasuredQuantity(0.01234)).toBe('0.0123');
    expect(formatMeasuredQuantity(0.5)).toBe('0.5');
  });

  it('falls back to exponent form at the extremes', () => {
    expect(formatMeasuredQuantity(0)).toBe('0');
    expect(formatMeasuredQuantity(0.0000123)).toBe('1.230e-5');
    expect(formatMeasuredQuantity(2.5e8)).toBe('2.500e+8');
    expect(formatMeasuredQuantity(Number.NaN)).toBe('—');
  });
});
