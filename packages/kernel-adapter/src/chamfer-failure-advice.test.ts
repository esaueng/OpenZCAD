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
  it('does not tell the user to turn the earlier fillet into a chamfer', () => {
    const kernel = new Proxy(
      {},
      {
        get: () => () => {
          throw new Error('unsupported neighbor');
        }
      }
    ) as RemusKernel;
    const message = edgeModifierFailureMessage(
      kernel,
      1,
      [2],
      'chamfer',
      1,
      false
    );
    expect(message).toContain(
      'could not join this chamfer to the existing fillet or chamfer'
    );
    expect(message).toContain('Smaller distances were refused too');
    expect(message).not.toMatch(
      /edit that earlier|Try a smaller|at any distance/
    );
  });
});
