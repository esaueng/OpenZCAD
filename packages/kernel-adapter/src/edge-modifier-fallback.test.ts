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
  it.each(['fillet', 'chamfer'] as const)(
    'does not advise selecting fewer edges for a single refused %s edge',
    (kind) => {
      const message = edgeModifierFailureMessage(
        refusingKernel,
        1,
        [2],
        kind,
        2.1,
        false
      );
      expect(message).not.toContain('fewer edges');
      expect(message).toContain('neighboring faces');
      expect(message).not.toContain('Try a smaller');
    }
  );

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
        'Smaller distances were refused too. The kernel could not build this edge ' +
        'with its current neighboring faces. Try a different edge or change the adjacent geometry.'
    );
    expect(chamfer).not.toContain('Try a smaller');
  });
});
