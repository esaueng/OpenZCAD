import { describe, expect, it } from 'vitest';
import {
  cylinderRadiusSnapStep,
  cylinderRadiusTolerance,
  cylinderRadialFrame,
  findResizedCylinderFace,
  isUnchangedCylinderRadius,
  isValidCylinderRadius,
  radiusFromRadialDelta,
  sameCylinderAxis,
  snapCylinderRadius,
  supportsRadialCylinderPreview,
  borePreviewProfile,
  boreRimAnchor,
  cylinderPreviewProfile
} from './cylinderRadius';
import type { BodyRepresentation, FaceTopology } from '@openzcad/shared';

function bodyWithFaces(faces: FaceTopology[]): BodyRepresentation {
  return {
    bodyId: 'body-1' as BodyRepresentation['bodyId'],
    name: 'Cylinder Body',
    source: 'primitive',
    mesh: {
      kind: 'mesh',
      vertices: Float32Array.from([]),
      indices: Uint32Array.from([])
    },
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
    expect(xSide?.radialDirection.x).toBeCloseTo(1, 8);
    expect(xSide?.radialDirection.y).toBeCloseTo(0, 8);
    expect(ySide?.radialDirection.x).toBeCloseTo(0, 8);
    expect(ySide?.radialDirection.y).toBeCloseTo(1, 8);
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

  it('remaps a regenerated face only when its world-space axis is invariant', () => {
    const start = { x: 125, y: -42, z: 8 };
    const end = { x: 141, y: -30, z: 28 };
    expect(sameCylinderAxis(start, end, { ...start }, { ...end })).toBe(true);
    expect(sameCylinderAxis(start, end, { ...end }, { ...start })).toBe(true);
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

describe('round rim cylinder preview eligibility', () => {
  const profile = {
    axisStart: { x: 0, y: 0, z: 2 },
    axisEnd: { x: 0, y: 0, z: 20 },
    radius: 28,
    coreRadius: 26
  };
  function body(
    geometries: Partial<NonNullable<FaceTopology['geometry']>>[]
  ): BodyRepresentation {
    return {
      topology: { faces: geometries.map((geometry) => ({ geometry })) }
    } as BodyRepresentation;
  }
  const surfaces: Partial<NonNullable<FaceTopology['geometry']>>[] = [
    { surfaceType: 'cylinder', ...profile },
    { surfaceType: 'plane', normal: { x: 0, y: 0, z: -1 } },
    { surfaceType: 'plane', normal: { x: 0, y: 0, z: 1 } },
    ...[2, 20].map(
      (z) =>
        ({
          surfaceType: 'torus',
          featureType: 'blend',
          torusCenter: { x: 0, y: 0, z },
          majorRadius: 26,
          minorRadius: 2
        }) as NonNullable<FaceTopology['geometry']>
    )
  ];

  it('recognizes only coaxial full cylinder caps and round rims', () => {
    expect(cylinderPreviewProfile(body(surfaces))).toEqual(profile);
    expect(cylinderPreviewProfile(body(surfaces.slice(0, 4)))).toEqual(profile);
    expect(
      cylinderPreviewProfile(
        body([
          ...surfaces.slice(0, 4),
          { ...surfaces[4], majorRadius: 25, minorRadius: 3 }
        ])
      )
    ).toEqual({ ...profile, coreRadius: 25 });
    expect(cylinderPreviewProfile(body(surfaces.slice(0, 3)))).toEqual({
      ...profile,
      coreRadius: 28
    });
    for (const replacement of [
      { surfaceType: 'unknown' },
      { ...surfaces[3], torusCenter: { x: 1, y: 0, z: 2 } },
      { ...surfaces[3], majorRadius: 20 },
      { ...surfaces[3], torusCenter: { x: 0, y: 0, z: 10 } },
      surfaces[4]
    ]) {
      expect(
        cylinderPreviewProfile(
          body([
            ...surfaces.slice(0, 3),
            replacement as NonNullable<FaceTopology['geometry']>,
            surfaces[4]!
          ])
        )
      ).toBeNull();
    }
    expect(
      cylinderPreviewProfile(body([surfaces[0]!, surfaces[0]!, surfaces[2]!]))
    ).toBeNull();
    expect(
      cylinderPreviewProfile(
        body([
          surfaces[0]!,
          { surfaceType: 'plane', normal: { x: 1, y: 0, z: 0 } },
          surfaces[2]!
        ])
      )
    ).toBeNull();
  });
});

describe('hole diameter drag', () => {
  it('snaps the diameter it shows, not the radius underneath', () => {
    // At 100 px per mm the step is 0.1: on the radius that is Ø 10.4 or
    // Ø 10.2 apart, on the diameter it reads Ø 10.3.
    expect(snapCylinderRadius(5.16, 1 / 100, 'diameter') * 2).toBeCloseTo(
      10.3,
      9
    );
    expect(snapCylinderRadius(5.16, 1 / 100, 'radius')).toBeCloseTo(5.2, 9);
    // Smaller on screen, coarser steps: whole millimetres of diameter.
    expect(snapCylinderRadius(5.16, 1 / 10, 'diameter') * 2).toBe(10);
  });

  it('treats a value back at the start as no edit, by each edit gate', () => {
    // Through-hole resize: 1e-6, or a millionth of the radius.
    expect(isUnchangedCylinderRadius(3, 3, 'through-hole')).toBe(true);
    expect(isUnchangedCylinderRadius(3 + 1e-7, 3, 'through-hole')).toBe(true);
    expect(isUnchangedCylinderRadius(3.01, 3, 'through-hole')).toBe(false);
    expect(isUnchangedCylinderRadius(100.0005, 100, 'through-hole')).toBe(
      false
    );
    // Direct cylindrical-face resize: 1e-5 of the radius, so 100 → 100.0005
    // is refused by the kernel and must not be sent.
    expect(isUnchangedCylinderRadius(100.0005, 100, 'cylindrical-face')).toBe(
      true
    );
    expect(isUnchangedCylinderRadius(100.002, 100, 'cylindrical-face')).toBe(
      false
    );
    expect(
      isUnchangedCylinderRadius(1e-4 + 5e-10, 1e-4, 'cylindrical-face')
    ).toBe(true);
    // A primitive's radius parameter rebuilds any change: 100 → 100.0005
    // is a real edit there, and only rounding noise is none.
    expect(
      isUnchangedCylinderRadius(100.0005, 100, 'primitive-parameter')
    ).toBe(false);
    expect(
      isUnchangedCylinderRadius(0.1 + 0.2, 0.3, 'primitive-parameter')
    ).toBe(true);
  });

  it('finds the resized bore on the same axis to keep it selected', () => {
    const bore = (
      topologyId: string,
      radius: number,
      at: { x: number; y: number }
    ): FaceTopology =>
      ({
        topologyId,
        hash: radius,
        geometry: {
          surfaceType: 'cylinder',
          radius,
          diameter: radius * 2,
          axisStart: { ...at, z: 0 },
          axisEnd: { ...at, z: 10 },
          center: { ...at, z: 5 },
          area: 0
        }
      }) as FaceTopology;
    const faces = [
      bore('other-hole', 2, { x: 34, y: 0 }),
      bore('bore', 2, { x: 0, y: 34 }),
      bore('hub', 12, { x: 0, y: 0 })
    ];
    const axisStart = { x: 0, y: 34, z: -0.5 };
    const axisEnd = { x: 0, y: 34, z: 3 };
    expect(
      findResizedCylinderFace(faces, axisStart, axisEnd, 2)?.topologyId
    ).toBe('bore');
    expect(findResizedCylinderFace(faces, axisStart, axisEnd, 3)).toBeNull();
    expect(
      findResizedCylinderFace(
        [...faces, bore('twin', 2, { x: 0, y: 34 })],
        axisStart,
        axisEnd,
        2
      )
    ).toBeNull();
    // A separate band on the same axis and radius, further along it, is not
    // the edited wall and does not make the pick ambiguous.
    const band = bore('lower-band', 2, { x: 0, y: 34 });
    band.geometry!.axisStart = { x: 0, y: 34, z: 20 };
    band.geometry!.axisEnd = { x: 0, y: 34, z: 30 };
    expect(
      findResizedCylinderFace([...faces, band], axisStart, axisEnd, 2)
        ?.topologyId
    ).toBe('bore');
  });
});

describe('hole radius handle', () => {
  const wall = {
    axisStart: { x: 0, y: 0, z: 0 },
    axisEnd: { x: 0, y: 0, z: 20 },
    radius: 10
  };

  it('measures the round on each rim of the bore', () => {
    const rim = (z: number, minor: number) =>
      face(`rim-${z}`, 'torus', {
        torusCenter: { x: 0, y: 0, z },
        majorRadius: 10 + minor,
        minorRadius: minor
      });
    expect(
      borePreviewProfile(bodyWithFaces([rim(20, 1), rim(0, 0.5)]), wall)
    ).toEqual({ ...wall, rimStart: 0.5, rimEnd: 1 });
    // A boss round (major + minor = radius), an off-axis torus and a round
    // at mid-wall are not this bore's rims.
    expect(
      borePreviewProfile(
        bodyWithFaces([
          face('boss', 'torus', {
            torusCenter: { x: 0, y: 0, z: 20 },
            majorRadius: 9,
            minorRadius: 1
          }),
          face('off', 'torus', {
            torusCenter: { x: 3, y: 0, z: 20 },
            majorRadius: 11,
            minorRadius: 1
          }),
          rim(10, 1)
        ]),
        wall
      )
    ).toEqual({ ...wall, rimStart: 0, rimEnd: 0 });
  });

  it('sits on the rim the camera looks into, at the picked azimuth', () => {
    const picked = {
      ...wall,
      point: { x: 0, y: 10, z: 7 },
      radialDirection: { x: 0, y: 1, z: 0 },
      originalRadius: 10
    };
    expect(boreRimAnchor(picked, { x: 5, y: -40, z: 90 })).toEqual({
      x: 0,
      y: 10,
      z: 20
    });
    expect(boreRimAnchor(picked, { x: 5, y: -40, z: -60 })).toEqual({
      x: 0,
      y: 10,
      z: 0
    });
  });
});
