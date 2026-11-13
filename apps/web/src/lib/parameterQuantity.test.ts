import { describe, expect, it } from 'vitest';
import { quantityTypedIn } from './parameterQuantity';

describe('the quantity a new parameter states with its units', () => {
  it('takes a length or an angle from the unit typed', () => {
    // `width = 40 mm` was added unitless: "40" with an untyped dot.
    expect(quantityTypedIn('40 mm', {}, 'mm')).toBe('length');
    expect(quantityTypedIn('1 in + 25.4 mm', {}, 'mm')).toBe('length');
    expect(quantityTypedIn('15 deg', {}, 'mm')).toBe('angle');
  });

  it('leaves a value with no unit unitless, as before', () => {
    expect(quantityTypedIn('40', {}, 'mm')).toBeUndefined();
    expect(quantityTypedIn('w / 2', { w: 30 }, 'mm')).toBeUndefined();
  });

  it('states nothing for an area or an expression that does not read', () => {
    expect(quantityTypedIn('2 mm * 3 mm', {}, 'mm')).toBeUndefined();
    expect(quantityTypedIn('40 mm +', {}, 'mm')).toBeUndefined();
    expect(quantityTypedIn('missing * 1 mm', {}, 'mm')).toBeUndefined();
  });
});
