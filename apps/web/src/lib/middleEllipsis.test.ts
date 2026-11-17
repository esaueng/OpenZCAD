import { describe, expect, it } from 'vitest';
import { fitMiddleEllipsis, middleEllipsis } from './middleEllipsis';

describe('middleEllipsis', () => {
  it('keeps the head and the tail around one ellipsis', () => {
    expect(middleEllipsis('OAWIHDOIAWHDOIHAWawdawd VERSION 2', 19)).toBe(
      'OAWIHDOIAWHD…RSION 2'
    );
  });

  it('returns a name that already fits unchanged', () => {
    expect(middleEllipsis('Tiny Fox', 8)).toBe('Tiny Fox');
    expect(middleEllipsis('Tiny Fox', 40)).toBe('Tiny Fox');
  });

  it('trims the spaces that would touch the ellipsis', () => {
    expect(middleEllipsis('Cable Clamp Early loft study', 10)).toBe(
      'Cable…tudy'
    );
    expect(middleEllipsis('Cable Clamp Early loft study', 15)).toBe(
      'Cable Cla…study'
    );
  });

  it('never splits a surrogate pair', () => {
    const shortened = middleEllipsis('🔩🔩🔩🔩🔩🔩🔩🔩🔩🔩', 5);
    expect(shortened).toBe('🔩🔩🔩…🔩🔩');
    expect(shortened).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
  });

  it('reduces to a bare ellipsis at zero', () => {
    expect(middleEllipsis('Bracket', 0)).toBe('…');
  });
});

describe('fitMiddleEllipsis', () => {
  const within = (limit: number) => (text: string) =>
    Array.from(text).length <= limit;

  it('leaves a fitting name whole', () => {
    expect(fitMiddleEllipsis('Lucky Quokka', within(20))).toBe('Lucky Quokka');
  });

  it('finds the longest middle-shortened form that fits', () => {
    const name = 'PiKVM v3.3 Enclosure V6 - Hardware fit and cable routing';
    const fitted = fitMiddleEllipsis(name, within(30));
    expect(Array.from(fitted)).toHaveLength(30);
    expect(fitted).toBe('PiKVM v3.3 Enclosu…ble routing');
    expect(fitted).toContain('…');
  });

  it('measures only a logarithmic number of candidates', () => {
    let calls = 0;
    fitMiddleEllipsis('x'.repeat(256), (text) => {
      calls += 1;
      return text.length <= 40;
    });
    expect(calls).toBeLessThanOrEqual(10);
  });

  it('falls back to the ellipsis when nothing fits', () => {
    expect(fitMiddleEllipsis('Bracket', () => false)).toBe('…');
  });
});
