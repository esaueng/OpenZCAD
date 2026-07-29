import { describe, expect, it } from 'vitest';
import type { PlaneBasis } from '@openzcad/geometry';
import { triangulateRegionGeometry } from './regionOverlay';

const rotatedBasis: PlaneBasis = {
  origin: { x: 5, y: -2, z: 9 },
  u: { x: 0, y: 1, z: 0 },
  v: { x: 0, y: 0, z: 1 },
  normal: { x: 1, y: 0, z: 0 }
};

describe('triangulateRegionGeometry', () => {
  it('triangulates a hole without filling its interior on a rotated plane', () => {
    const outer = [
      { x: -5, y: -5 },
      { x: 5, y: -5 },
      { x: 5, y: 5 },
      { x: -5, y: 5 }
    ];
    const hole = [
      { x: -2, y: -2 },
      { x: -2, y: 2 },
      { x: 2, y: 2 },
      { x: 2, y: -2 }
    ];
    const result = triangulateRegionGeometry(outer, [hole], rotatedBasis);
    let triangleArea = 0;
    for (let index = 0; index < result.indices.length; index += 3) {
      const a = result.indices[index]!;
      const b = result.indices[index + 1]!;
      const c = result.indices[index + 2]!;
      const ay = result.positions[a * 3 + 1]!;
      const az = result.positions[a * 3 + 2]!;
      const by = result.positions[b * 3 + 1]!;
      const bz = result.positions[b * 3 + 2]!;
      const cy = result.positions[c * 3 + 1]!;
      const cz = result.positions[c * 3 + 2]!;
      triangleArea +=
        Math.abs((by - ay) * (cz - az) - (bz - az) * (cy - ay)) / 2;
      expect(result.positions[a * 3]).toBeCloseTo(rotatedBasis.origin.x, 6);
    }
    expect(triangleArea).toBeCloseTo(100 - 16, 6);
  });
});
