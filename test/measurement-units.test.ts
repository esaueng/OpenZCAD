import { describe, expect, it } from 'vitest';
import {
  formatInches,
  notationAppliesTo,
  type InchDenominator
} from '../apps/web/src/lib/measurementUnits';

describe('fractional inches', () => {
  it('reduces to the fraction a rule is actually marked with', () => {
    // 0.40625 in is 13/32. Written as a decimal it is a number nobody can
    // find on a tape measure, which is the whole reason this exists.
    expect(formatInches(0.40625, 'fractional', 32).text).toBe('13/32"');
    expect(formatInches(0.5, 'fractional').text).toBe('1/2"');
    expect(formatInches(0.375, 'fractional').text).toBe('3/8"');
    expect(formatInches(2.75, 'fractional').text).toBe('2 3/4"');
  });

  it('writes a whole inch without a fraction part', () => {
    expect(formatInches(3, 'fractional').text).toBe('3"');
    expect(formatInches(0, 'fractional').text).toBe('0"');
  });

  it('carries into the whole inch when the fraction rounds up to one', () => {
    // 15.99/16 snaps to 16/16, which must read 1" rather than 0 16/16".
    expect(formatInches(0.99999, 'fractional', 16).text).toBe('1"');
    expect(formatInches(2.9999, 'fractional', 16).text).toBe('3"');
  });

  it('reports whether snapping moved the value', () => {
    // A fraction is a rounding of the measurement. A tool that hides its own
    // rounding is the thing this overhaul exists to stop being.
    expect(formatInches(0.5, 'fractional', 16).exact).toBe(true);
    const snapped = formatInches(0.51, 'fractional', 16);
    expect(snapped.text).toBe('1/2"');
    expect(snapped.exact).toBe(false);
  });

  it('keeps the sign outside the fraction', () => {
    // A distance component along an axis can be negative, and -1 -1/2" is not
    // something anyone writes.
    expect(formatInches(-1.5, 'fractional').text).toBe('-1 1/2"');
    expect(formatInches(-0.25, 'fractional').text).toBe('-1/4"');
  });

  it('honours the requested denominator', () => {
    // The same value at three rule resolutions, coarse to fine.
    const value = 0.3;
    const at = (denominator: InchDenominator) =>
      formatInches(value, 'fractional', denominator).text;
    expect(at(2)).toBe('1/2"');
    expect(at(8)).toBe('1/4"');
    expect(at(32)).toBe('5/16"');
    expect(at(64)).toBe('19/64"');
  });
});

describe('feet and inches', () => {
  it('splits a foot part out and omits it below twelve inches', () => {
    expect(formatInches(30.5, 'feet-inches').text).toBe(`2' 6 1/2"`);
    expect(formatInches(24, 'feet-inches').text).toBe(`2' 0"`);
    // Writing 0' for anything under a foot would be noise on every small part.
    expect(formatInches(6.25, 'feet-inches').text).toBe('6 1/4"');
  });

  it('writes a bare fraction when the inch part is zero but feet are not', () => {
    expect(formatInches(12.5, 'feet-inches').text).toBe(`1' 1/2"`);
  });

  it('keeps the sign in front of the feet', () => {
    expect(formatInches(-30.5, 'feet-inches').text).toBe(`-2' 6 1/2"`);
  });
});

describe('guards', () => {
  it('refuses a non-finite value rather than printing NaN', () => {
    expect(formatInches(Number.NaN, 'fractional').text).toBe('—');
    expect(formatInches(Number.POSITIVE_INFINITY, 'fractional').exact).toBe(
      false
    );
  });

  it('confines fractional notations to inches', () => {
    // "3/16 mm" is a category error, and honouring the request silently would
    // put it on screen.
    expect(notationAppliesTo('fractional', 'inch')).toBe(true);
    expect(notationAppliesTo('feet-inches', 'inch')).toBe(true);
    expect(notationAppliesTo('fractional', 'mm')).toBe(false);
    expect(notationAppliesTo('decimal', 'mm')).toBe(true);
  });
});
