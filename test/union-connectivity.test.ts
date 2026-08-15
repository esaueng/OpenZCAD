import { describe, expect, it, vi } from 'vitest';
import {
  analyzeUnionConnectivity,
  disconnectedUnionWarning,
  type UnionSolid
} from '../packages/kernel-adapter/src/union-connectivity';

function box(
  solid: string,
  min: [number, number, number],
  max: [number, number, number]
): UnionSolid<string> {
  return {
    solid,
    bounds: {
      min: { x: min[0], y: min[1], z: min[2] },
      max: { x: max[0], y: max[1], z: max[2] }
    }
  };
}

describe('Union connectivity', () => {
  it('rejects a real gap and reports the exact closest distance', () => {
    const distance = vi.fn(() => 2);
    const result = analyzeUnionConnectivity(
      [
        box('lower', [0, 0, 0], [10, 10, 10]),
        box('upper', [0, 0, 12], [10, 10, 22])
      ],
      distance
    );

    expect(result).toMatchObject({
      connected: false,
      componentCount: 2,
      closestGap: 2
    });
    expect(distance).toHaveBeenCalledTimes(1);
    expect(disconnectedUnionWarning(result, 'mm')).toBe(
      'Union does not fill empty space. The selected solids form 2 disconnected groups. The closest gap is 2 mm. Move or extend a body until every solid touches or overlaps.'
    );
  });

  it('accepts a chain when each solid touches the next one', () => {
    const result = analyzeUnionConnectivity(
      [
        box('a', [0, 0, 0], [10, 10, 10]),
        box('b', [0, 0, 10], [10, 10, 20]),
        box('c', [0, 0, 20], [10, 10, 30])
      ],
      () => 0
    );

    expect(result).toMatchObject({
      connected: true,
      componentCount: 1,
      closestGap: null
    });
  });

  it('uses exact distance when bounding boxes overlap without contact', () => {
    const result = analyzeUnionConnectivity(
      [
        box('ring-left', [0, 0, 0], [10, 10, 10]),
        box('ring-right', [5, 5, 0], [15, 15, 10])
      ],
      () => 1.25
    );

    expect(result).toMatchObject({
      connected: false,
      componentCount: 2,
      closestGap: 1.25
    });
  });

  it('accepts volume overlap when a kernel distance reports penetration', () => {
    const overlap = vi.fn(() => true);
    const result = analyzeUnionConnectivity(
      [
        box('wall', [0, 32, 7.5], [80, 40, 39.5]),
        box('boss', [30, 22, 14], [50, 34, 34])
      ],
      () => 2,
      overlap
    );

    expect(result).toMatchObject({
      connected: true,
      componentCount: 1,
      closestGap: null
    });
    expect(overlap).toHaveBeenCalledTimes(1);
  });

  it('does not mistake a visually tiny gap for contact', () => {
    const result = analyzeUnionConnectivity(
      [
        box('lower', [0, 0, 0], [10, 10, 10]),
        box('upper', [0, 0, 10.00000001], [10, 10, 20.00000001])
      ],
      () => 1e-8
    );

    expect(result.connected).toBe(false);
    expect(result.contactTolerance).toBeLessThan(1e-8);
  });

  it('scales numerical contact tolerance for far-translated geometry', () => {
    const result = analyzeUnionConnectivity(
      [
        box('lower', [1e9, 0, 0], [1e9 + 10, 10, 10]),
        box('upper', [1e9, 0, 10], [1e9 + 10, 10, 20])
      ],
      () => 1e-7
    );

    expect(result.connected).toBe(true);
    expect(result.contactTolerance).toBeGreaterThan(1e-7);
  });

  it('rejects a connectivity graph above the bounded pair budget', () => {
    const solids = Array.from({ length: 318 }, (_, index) =>
      box(String(index), [index * 2, 0, 0], [index * 2 + 1, 1, 1])
    );
    expect(() => analyzeUnionConnectivity(solids, () => 1)).toThrow(
      /limit is 50000/
    );
  });
});
