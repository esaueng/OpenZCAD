import { describe, expect, it } from 'vitest';
import {
  cylinderRadialFrame,
  diameterToRadius,
  radiusFromRadialDelta,
  radiusToDiameter,
  sameCylinderAxis,
  signedRadialDelta
} from './cylinderRadius';

describe('cylinder radius drag math', () => {
  it('uses signed radial movement and clamps before inversion', () => {
    expect(radiusFromRadialDelta(14, 4, 0.1, 100)).toBe(18);
    expect(radiusFromRadialDelta(14, -20, 0.1, 100)).toBe(0.1);
    expect(radiusFromRadialDelta(14, 200, 0.1, 100)).toBe(100);
  });

  it('keeps radius and diameter conversion explicit', () => {
    expect(radiusToDiameter(18)).toBe(36);
    expect(diameterToRadius(36)).toBe(18);
  });

  it('derives the same radius direction at different points around the wall', () => {
    const axisStart = { x: 10, y: -5, z: 3 };
    const axisEnd = { x: 10, y: -5, z: 31 };
    const xSide = cylinderRadialFrame(
      { x: 24, y: -5, z: 17 },
      { x: 1, y: 0, z: 0 },
      axisStart,
      axisEnd
    );
    const ySide = cylinderRadialFrame(
      { x: 10, y: 9, z: 17 },
      { x: 0, y: 1, z: 0 },
      axisStart,
      axisEnd
    );
    expect(xSide?.radiusAtHit).toBeCloseTo(14, 8);
    expect(ySide?.radiusAtHit).toBeCloseTo(14, 8);
    expect(xSide?.axisOrigin).toEqual(ySide?.axisOrigin);
    expect(
      signedRadialDelta(
        { x: 24, y: -5, z: 17 },
        { x: 28, y: -5, z: 17 },
        xSide!.radialDirection
      )
    ).toBeCloseTo(4, 8);
    expect(
      signedRadialDelta(
        { x: 10, y: 9, z: 17 },
        { x: 10, y: 13, z: 17 },
        ySide!.radialDirection
      )
    ).toBeCloseTo(4, 8);
  });

  it('is invariant under a rotated, translated cylinder axis', () => {
    const frame = cylinderRadialFrame(
      { x: 7, y: 8, z: 9 },
      { x: 0, y: 1, z: 0 },
      { x: 7, y: 3, z: 4 },
      { x: 7, y: 3, z: 14 }
    );
    expect(frame?.axisOrigin).toEqual({ x: 7, y: 3, z: 9 });
    expect(frame?.axisDirection).toEqual({ x: 0, y: 0, z: 1 });
    expect(frame?.radialDirection).toEqual({ x: 0, y: 1, z: 0 });
    expect(frame?.radiusAtHit).toBe(5);
    expect(frame?.concavity).toBe('boss');
  });

  it('does not project axial movement into the radius delta', () => {
    expect(
      signedRadialDelta(
        { x: 5, y: 0, z: 0 },
        { x: 5, y: 0, z: 20 },
        { x: 1, y: 0, z: 0 }
      )
    ).toBe(0);
  });

  it('remaps a regenerated face only when its world-space axis is invariant', () => {
    const start = { x: 125, y: -42, z: 8 };
    const end = { x: 141, y: -30, z: 28 };
    expect(
      sameCylinderAxis(start, end, { ...start }, { ...end })
    ).toBe(true);
    expect(
      sameCylinderAxis(start, end, { ...end }, { ...start })
    ).toBe(true);
    expect(
      sameCylinderAxis(
        start,
        end,
        { x: start.x + 0.01, y: start.y, z: start.z },
        { x: end.x + 0.01, y: end.y, z: end.z }
      )
    ).toBe(false);
  });
});
