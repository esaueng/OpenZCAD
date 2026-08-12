import { describe, expect, it } from 'vitest';
import {
  cylinderRadiusSnapStep,
  cylinderRadiusTolerance,
  cylinderRadialFrame,
  diameterToRadius,
  isValidCylinderRadius,
  radiusFromRadialDelta,
  radiusToDiameter,
  sameCylinderAxis,
  signedRadialDelta,
  supportsRadialCylinderPreview
} from './cylinderRadius';
import type { BodyRepresentation, FaceTopology } from '@openzcad/shared';

function bodyWithFaces(faces: FaceTopology[]): BodyRepresentation {
  return {
    bodyId: 'body-1' as BodyRepresentation['bodyId'],
    name: 'Cylinder Body',
    source: 'primitive',
    mesh: { kind: 'mesh', vertices: [], indices: [] },
    faceCount: faces.length,
    color: '#ffffff',
    exportableStep: true,
    consumed: false,
    volume: 1,
    bbox: {
      min: { x: -1, y: -1, z: 0 },
      max: { x: 1, y: 1, z: 2 }
    },
    topology: { faces, edges: [] }
  };
}

function face(
  topologyId: string,
  surfaceType: string,
  geometry: Partial<NonNullable<FaceTopology['geometry']>> = {}
): FaceTopology {
  return {
    topologyId,
    hash: topologyId.length,
    triangleStart: 0,
    triangleCount: 1,
    geometry: {
      surfaceType,
      area: 1,
      center: { x: 0, y: 0, z: 0 },
      ...geometry
    }
  };
}

describe('cylinder radius drag math', () => {
  it('uses signed radial movement without imposing fixed radius bounds', () => {
    expect(radiusFromRadialDelta(14, 4)).toBe(18);
    expect(radiusFromRadialDelta(0.00002, 0.00001)).toBeCloseTo(0.00003, 10);
    expect(radiusFromRadialDelta(2_000_000, 1_500_000)).toBe(3_500_000);
  });

  it('withholds inverted, non-finite, and scale-degenerate candidates', () => {
    expect(radiusFromRadialDelta(14, -20)).toBeNull();
    expect(radiusFromRadialDelta(14, Number.POSITIVE_INFINITY)).toBeNull();
    expect(isValidCylinderRadius(0.00002, 0.00002)).toBe(true);
    expect(isValidCylinderRadius(0.0000005, 1)).toBe(false);
    expect(isValidCylinderRadius(50, 1_000_000_000_000)).toBe(false);
    expect(cylinderRadiusTolerance(1_000_000_000_000)).toBe(100);
  });

  it('chooses unbounded nice snap steps at the current zoom scale', () => {
    expect(cylinderRadiusSnapStep(0.000001)).toBeCloseTo(0.00001, 12);
    expect(cylinderRadiusSnapStep(0.1)).toBe(1);
    expect(cylinderRadiusSnapStep(1_000_000)).toBe(10_000_000);
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

  it('allows a radial viewport transform only for a simple analytic cylinder', () => {
    const axisStart = { x: 3, y: -4, z: 5 };
    const axisEnd = { x: 3, y: -4, z: 15 };
    const simple = bodyWithFaces([
      face('wall', 'cylinder', { axisStart, axisEnd, radius: 4 }),
      face('bottom', 'plane', { normal: { x: 0, y: 0, z: -1 } }),
      face('top', 'plane', { normal: { x: 0, y: 0, z: 1 } })
    ]);

    expect(supportsRadialCylinderPreview(simple, axisStart, axisEnd)).toBe(
      true
    );
    expect(
      supportsRadialCylinderPreview(
        bodyWithFaces([...simple.topology!.faces, face('fillet', 'torus')]),
        axisStart,
        axisEnd
      )
    ).toBe(false);
    expect(
      supportsRadialCylinderPreview(
        simple,
        { x: axisStart.x + 0.01, y: axisStart.y, z: axisStart.z },
        { x: axisEnd.x + 0.01, y: axisEnd.y, z: axisEnd.z }
      )
    ).toBe(false);
    expect(
      supportsRadialCylinderPreview(
        bodyWithFaces([
          simple.topology!.faces[0]!,
          face('oblique-bottom', 'plane', {
            normal: { x: 0.2, y: 0, z: 0.98 }
          }),
          simple.topology!.faces[2]!
        ]),
        axisStart,
        axisEnd
      )
    ).toBe(false);
  });
});
