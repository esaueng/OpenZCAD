import { describe, expect, it } from 'vitest';

import { resolveShaprImportLimits } from './limits';
import { decodeShaprMessagePack } from './msgpack';

const limits = resolveShaprImportLimits();

describe('bounded SHAPR MessagePack decoding', () => {
  it('decodes the independently implemented array/string/number subset', () => {
    const encoded = new Uint8Array([
      0x95,
      0x02,
      0xc0,
      0xa9,
      ...new TextEncoder().encode('Sketch 01'),
      0xa7,
      ...new TextEncoder().encode('Extrude'),
      0x91,
      0x2a
    ]);

    expect(decodeShaprMessagePack(encoded, limits)).toEqual([
      2,
      null,
      'Sketch 01',
      'Extrude',
      [42]
    ]);
  });

  it('rejects unsupported map and extension types', () => {
    expect(() =>
      decodeShaprMessagePack(new Uint8Array([0x80]), limits)
    ).toThrow('unsupported');
    expect(() =>
      decodeShaprMessagePack(new Uint8Array([0xd4]), limits)
    ).toThrow('unsupported');
  });

  it('rejects trailing bytes and excessive nesting', () => {
    expect(() =>
      decodeShaprMessagePack(new Uint8Array([0x01, 0x02]), limits)
    ).toThrow('trailing bytes');

    expect(() =>
      decodeShaprMessagePack(
        new Uint8Array([0x91, 0x91, 0x91, 0x01]),
        resolveShaprImportLimits({ maxValueDepth: 2 })
      )
    ).toThrow('nesting-depth limit');
  });
});
