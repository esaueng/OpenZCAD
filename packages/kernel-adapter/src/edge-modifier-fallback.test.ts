import { describe, expect, it } from 'vitest';
import { edgeModifierFailureMessage } from './exact-edge-modifiers';
import type { RemusKernel } from './remus-runtime';

/**
 * A kernel that refuses everything: every probe on the size ladder throws,
 * and so does every later topology question. That is the one path where no
 * smaller size built and no cause could be named.
 */
const refusingKernel = new Proxy(
  {},
  {
    get: () => () => {
      throw new Error('refused');
    }
  }
) as RemusKernel;

describe('edge modifier fallback advice', () => {
  it('does not advise a smaller size once every smaller size was refused', () => {
    const fillet = edgeModifierFailureMessage(
      refusingKernel,
      1,
      [2, 3],
      'fillet',
      3,
      false
    );
    expect(fillet).toBe(
      'Fillet could not be created on 2 selected edges with radius 3. ' +
        'Smaller radii were refused too, so the size is not the cause. ' +
        'Try rounding fewer edges at once, or different edges.'
    );
    const chamfer = edgeModifierFailureMessage(
      refusingKernel,
      1,
      [2],
      'chamfer',
      1.5,
      false
    );
    expect(chamfer).toBe(
      'Chamfer could not be created on 1 selected edge with distance 1.5. ' +
        'Smaller distances were refused too, so the size is not the cause. ' +
        'Try chamfering fewer edges at once, or different edges.'
    );
    expect(chamfer).not.toContain('Try a smaller');
  });
});
