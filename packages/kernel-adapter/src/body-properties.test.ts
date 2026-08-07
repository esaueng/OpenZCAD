import { describe, expect, it } from 'vitest';
import {
  readBodyMassProperties,
  type MassPropertiesSource
} from './body-properties';

/**
 * The boundary that stops an `any`-typed binding from publishing nonsense.
 *
 * `massProperties` is declared `any` and returns a JSON string. Every failure
 * mode below produces a plausible-looking object rather than an exception, so
 * none of them would be caught by a cast or by the type checker.
 */

function stub(result: unknown): MassPropertiesSource {
  return {
    massProperties: () => result
  };
}

const COMPLETE = {
  volume: 8000,
  centerOfMass: [10, 10, 10],
  inertia: [1, 2, 3, 0, 0, 0],
  principalMoments: [1, 2, 3],
  principalAxes: [1, 0, 0, 0, 1, 0, 0, 0, 1]
};

describe('reading mass properties', () => {
  it('parses the JSON string the binding actually returns', () => {
    const found = readBodyMassProperties(stub(JSON.stringify(COMPLETE)), 1);
    expect(found).not.toBeNull();
    expect(found?.centerOfMass).toEqual({ x: 10, y: 10, z: 10 });
    expect(found?.principalMoments).toEqual([1, 2, 3]);
  });

  it('splits the flat row-major nine into three axes', () => {
    // The regression a cast cannot catch: `principalAxes[0]` on the raw
    // payload is the number 1, not a vector, and nothing would complain.
    const found = readBodyMassProperties(
      stub(
        JSON.stringify({
          ...COMPLETE,
          principalAxes: [1, 0, 0, 0, 0, 1, 0, -1, 0]
        })
      ),
      1
    );
    expect(found?.principalAxes).toEqual([
      { x: 1, y: 0, z: 0 },
      { x: 0, y: 0, z: 1 },
      { x: 0, y: -1, z: 0 }
    ]);
  });

  it('accepts an already-parsed object, in case the binding changes', () => {
    expect(readBodyMassProperties(stub(COMPLETE), 1)).not.toBeNull();
  });

  it('returns null rather than a part with no mass', () => {
    // Each of these is what a cast would turn into `undefined` fields, which
    // format as 0.00 and read as a solid part weighing nothing.
    for (const [label, payload] of [
      ['a string that is not JSON', 'not json at all'],
      ['a JSON string holding a scalar', '42'],
      ['null', null],
      ['undefined', undefined],
      ['an empty object', {}],
      ['a missing centre', { ...COMPLETE, centerOfMass: undefined }],
      ['a short centre', { ...COMPLETE, centerOfMass: [1, 2] }],
      ['a short inertia', { ...COMPLETE, inertia: [1, 2, 3] }],
      [
        'eight principal axes',
        { ...COMPLETE, principalAxes: [1, 0, 0, 0, 1, 0, 0, 0] }
      ],
      ['a NaN moment', { ...COMPLETE, principalMoments: [1, Number.NaN, 3] }],
      ['an infinite centre', { ...COMPLETE, centerOfMass: [1, Infinity, 3] }],
      [
        'a stringly-typed number',
        { ...COMPLETE, principalMoments: ['1', 2, 3] }
      ]
    ] as const) {
      expect(
        readBodyMassProperties(stub(payload), 1),
        `expected null for ${label}`
      ).toBeNull();
    }
  });

  it('survives the kernel raising on a degenerate solid', () => {
    // Documented to error where `kernel.volume` merely answers zero. One
    // unmeasurable body must not abort a whole document rebuild.
    const raising: MassPropertiesSource = {
      massProperties: () => {
        throw new Error('zero volume');
      }
    };
    expect(readBodyMassProperties(raising, 1)).toBeNull();
  });
});
