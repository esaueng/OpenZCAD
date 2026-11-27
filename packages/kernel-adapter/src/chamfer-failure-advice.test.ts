import { describe, expect, it, vi } from 'vitest';
import type { RemusKernel } from './remus-runtime';

vi.mock('./exact-brep', () => ({
  countBlendFaces: () => 0,
  selectionTouchesBlendFace: () => true
}));
vi.mock('./exact-witnesses', () => ({
  MEASUREMENT_DEFLECTION: 0.01,
  edgeSampleOf: () => ({ closed: false })
}));

import { edgeModifierFailureMessage } from './exact-edge-modifiers';

describe('chamfer refusal at an earlier blend', () => {
  it('explains a smooth boundary without suggesting a smaller distance', () => {
    const kernel = {
      getSolidSmoothEdges: () => Uint32Array.of(2)
    } as unknown as RemusKernel;
    const message = edgeModifierFailureMessage(
      kernel,
      1,
      [2],
      'chamfer',
      1,
      false
    );
    expect(message).toContain('already meet smoothly');
    expect(message).toContain('Select a sharp edge');
    expect(message).not.toMatch(/smaller|earlier feature/);
  });
  /**
   * A kernel whose every question throws; with a code, every rung of the
   * size ladder instead reaches the typed chamfer and is refused with it.
   */
  function joinKernel(code?: string): RemusKernel {
    const table: Record<string, unknown> = code
      ? {
          boundingBox: () => Float64Array.from([0, 0, 0, 10, 10, 10]),
          chamferDetailed: () => ({
            status: 'error',
            code,
            category: 'internal',
            details: { kernelCode: code, message: 'an invented sentence' }
          })
        }
      : {};
    return new Proxy(
      {},
      {
        get: (_target, name: string) =>
          table[name] ??
          (() => {
            throw new Error('unsupported neighbor');
          })
      }
    ) as RemusKernel;
  }

  it('does not tell the user to turn the earlier fillet into a chamfer', () => {
    const message = edgeModifierFailureMessage(
      joinKernel('fillet-failed'),
      1,
      [2],
      'chamfer',
      1,
      false,
      'fillet-failed: an invented sentence',
      undefined,
      undefined,
      'fillet-failed'
    );
    expect(message).toContain(
      'could not join this chamfer to the existing fillet or chamfer'
    );
    expect(message).toContain('Smaller distances were refused too');
    expect(message).not.toMatch(
      /edit that earlier|Try a smaller|at any distance/
    );
  });

  it('says smaller distances were refused only of rungs refused by code', () => {
    // The rungs threw, so they carry no code and prove nothing about size.
    const message = edgeModifierFailureMessage(
      joinKernel(),
      1,
      [2],
      'chamfer',
      1,
      false
    );
    expect(message).toContain(
      'could not join this chamfer to the existing fillet or chamfer. The last valid body is unchanged.'
    );
    expect(message).not.toMatch(/[Ss]maller/);
  });
});
