import { describe, expect, it } from 'vitest';

import {
  canonicalDirection,
  cylinderAnalyticSignature,
  planeAnalyticSignature
} from './topology-fingerprint';

describe('topology fingerprint direction canonicalization', () => {
  it('ignores sub-quantization sign noise before choosing an axis direction', () => {
    const positiveNoise = { x: 1e-12, y: -1, z: 0 };
    const negativeNoise = { x: -1e-12, y: -1, z: 0 };

    expect(canonicalDirection(positiveNoise).y).toBeGreaterThan(0);
    expect(canonicalDirection(negativeNoise).y).toBeGreaterThan(0);
    expect(planeAnalyticSignature(positiveNoise, 5)).toBe(
      planeAnalyticSignature(negativeNoise, 5)
    );
    expect(
      cylinderAnalyticSignature({ x: 0, y: 0, z: 0 }, positiveNoise, 2)
    ).toBe(cylinderAnalyticSignature({ x: 0, y: 0, z: 0 }, negativeNoise, 2));
  });

  it('keeps antipodal plane representations byte-identical', () => {
    expect(planeAnalyticSignature({ x: 0, y: -1, z: 0 }, 5)).toBe(
      planeAnalyticSignature({ x: 0, y: 1, z: 0 }, -5)
    );
  });
});
