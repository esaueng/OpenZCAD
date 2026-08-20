import { describe, expect, it } from 'vitest';
import type { BodyId, BodyRepresentation, Vector3 } from '@openzcad/shared';
import {
  acuteAngleBetweenLines,
  angleBetweenDirections,
  angleBetweenEdges,
  angleBetweenFaces,
  angleBetweenLineAndPlane,
  ANGLE_CONVENTION_LABELS
} from '../apps/web/src/lib/measurementGeometry';
import {
  createAngleMeasurement,
  formatMeasurement,
  measurementTargetFromSelection,
  type MeasurementDisplayOptions
} from '../apps/web/src/lib/measurements';

const DISPLAY: MeasurementDisplayOptions = {
  unit: 'mm',
  precision: 2,
  radialDisplay: 'diameter'
};

const BODY_ID = 'body-1' as BodyId;

function v(x: number, y: number, z: number): Vector3 {
  return { x, y, z };
}

/** A direction in the XY plane at `deg` from +X. */
function atDegrees(deg: number): Vector3 {
  const radians = (deg * Math.PI) / 180;
  return v(Math.cos(radians), Math.sin(radians), 0);
}

describe('angle between directed vectors', () => {
  it('covers the full 0-180 rather than folding at 90', () => {
    // The defect in one line. `Math.abs` on the dot product made every one of
    // these read as its acute complement: 135 became 45, 180 became 0.
    for (const expected of [0, 30, 45, 90, 135, 179]) {
      expect(
        angleBetweenDirections(atDegrees(0), atDegrees(expected))
      ).toBeCloseTo(expected, 9);
    }
    expect(angleBetweenDirections(v(1, 0, 0), v(-1, 0, 0))).toBeCloseTo(180, 9);
  });

  it('survives the parallel and antiparallel cases without NaN', () => {
    // acos of a dot product a few ulps outside [-1, 1] is NaN, and the two
    // places that happens are exactly the angles a person measures on purpose.
    const almost = v(1, 1e-17, 0);
    expect(angleBetweenDirections(v(1, 0, 0), almost)).not.toBeNaN();
    expect(angleBetweenDirections(v(1, 0, 0), v(-1, -1e-17, 0))).not.toBeNaN();
    expect(angleBetweenDirections(v(1, 0, 0), v(-1, -1e-17, 0))).toBeCloseTo(
      180,
      6
    );
  });

  it('returns null on a degenerate direction instead of NaN', () => {
    expect(angleBetweenDirections(v(0, 0, 0), v(1, 0, 0))).toBeNull();
    expect(acuteAngleBetweenLines(v(1, 0, 0), v(0, 0, 0))).toBeNull();
  });
});

describe('two planar faces', () => {
  it('reports the dihedral by default and the normals on request', () => {
    // A 30 degree wedge: the material meets at 30, the outward normals are
    // 150 apart. Both are true, which is why the convention is named.
    const first = v(0, 0, 1);
    const second = atDegrees(150);

    const dihedral = angleBetweenFaces(first, second);
    expect(dihedral?.convention).toBe('dihedral');

    const normals = angleBetweenFaces(first, second, 'between-normals');
    expect(normals?.convention).toBe('between-normals');
    expect(dihedral!.degrees + normals!.degrees).toBeCloseTo(180, 9);
  });

  it('calls two opposed faces of a box a 0 degree dihedral', () => {
    // Top and bottom of a plate: normals 180 apart, no material angle between
    // them. Reporting 180 here would say they meet at a straight line, which
    // they do not.
    const found = angleBetweenFaces(v(0, 0, 1), v(0, 0, -1));
    expect(found?.degrees).toBeCloseTo(0, 9);
  });

  it('calls two adjacent faces of a box a 90 degree dihedral', () => {
    const found = angleBetweenFaces(v(0, 0, 1), v(1, 0, 0));
    expect(found?.degrees).toBeCloseTo(90, 9);
  });
});

describe('two straight edges', () => {
  it('reports the included angle when they share a corner', () => {
    // A 135 degree corner. Both edges are oriented away from the shared point,
    // so the number describes the corner rather than the traversal order.
    const corner = v(0, 0, 0);
    const found = angleBetweenEdges(
      { direction: v(1, 0, 0), endpoints: [corner, v(10, 0, 0)] },
      { direction: atDegrees(135), endpoints: [corner, atDegrees(135)] }
    );
    expect(found?.convention).toBe('included');
    expect(found?.degrees).toBeCloseTo(135, 6);
  });

  it('is unchanged when the kernel traverses an edge the other way', () => {
    // The reason a signed angle between two bare edge directions is not
    // defensible: `direction` comes from whichever end the kernel started at.
    // Orienting from the shared corner removes that dependence entirely.
    const corner = v(0, 0, 0);
    const forward = angleBetweenEdges(
      { direction: v(1, 0, 0), endpoints: [corner, v(10, 0, 0)] },
      { direction: atDegrees(135), endpoints: [corner, atDegrees(135)] }
    );
    const reversed = angleBetweenEdges(
      { direction: v(-1, 0, 0), endpoints: [v(10, 0, 0), corner] },
      { direction: atDegrees(135), endpoints: [corner, atDegrees(135)] }
    );
    expect(reversed?.degrees).toBeCloseTo(forward!.degrees, 9);
  });

  it('falls back to the acute angle between lines that do not meet', () => {
    // Two skew or parallel-but-separate edges have no corner to measure at, so
    // only the undirected 0-90 figure is defensible.
    const found = angleBetweenEdges(
      { direction: v(1, 0, 0), endpoints: [v(0, 0, 0), v(10, 0, 0)] },
      { direction: atDegrees(135), endpoints: [v(0, 5, 9), v(1, 6, 9)] }
    );
    expect(found?.convention).toBe('acute');
    expect(found?.degrees).toBeCloseTo(45, 6);
  });

  it('still answers when endpoints are absent altogether', () => {
    const found = angleBetweenEdges(
      { direction: v(1, 0, 0) },
      { direction: atDegrees(135) }
    );
    expect(found?.convention).toBe('acute');
    expect(found?.degrees).toBeCloseTo(45, 6);
  });
});

describe('a line against a plane', () => {
  it('measures to the plane, not to its normal', () => {
    // An edge lying in the plane is 0 degrees from it; one along the normal
    // is 90. Measuring to the normal would report the complement of each.
    expect(
      angleBetweenLineAndPlane(v(1, 0, 0), v(0, 0, 1))?.degrees
    ).toBeCloseTo(0, 9);
    expect(
      angleBetweenLineAndPlane(v(0, 0, 1), v(0, 0, 1))?.degrees
    ).toBeCloseTo(90, 9);
    expect(
      angleBetweenLineAndPlane(atDegrees(45), v(0, 1, 0))?.degrees
    ).toBeCloseTo(45, 6);
  });
});

describe('through createAngleMeasurement', () => {
  function bodyWithWedge(): BodyRepresentation {
    return {
      bodyId: BODY_ID,
      name: 'Wedge',
      source: 'primitive',
      mesh: { kind: 'mesh', vertices: Float32Array.from([]), indices: Uint32Array.from([]) },
      faceCount: 2,
      color: '#fff',
      exportableStep: true,
      consumed: false,
      volume: 100,
      bbox: { min: v(0, 0, 0), max: v(10, 10, 10) },
      topology: {
        edges: [],
        faces: [
          {
            topologyId: 'face:flat',
            hash: 1,
            triangleStart: 0,
            triangleCount: 2,
            geometry: {
              surfaceType: 'plane',
              area: 100,
              center: v(5, 5, 0),
              normal: v(0, 0, 1)
            }
          },
          {
            topologyId: 'face:ramp',
            hash: 2,
            triangleStart: 2,
            triangleCount: 2,
            geometry: {
              surfaceType: 'plane',
              area: 100,
              center: v(5, 0, 5),
              // 150 degrees away from +Z, so the material meets at 30.
              normal: v(
                Math.sin((150 * Math.PI) / 180),
                0,
                Math.cos((150 * Math.PI) / 180)
              )
            }
          }
        ]
      }
    };
  }

  it('reports a 30 degree wedge as 30, and names the convention', () => {
    const body = bodyWithWedge();
    const flat = measurementTargetFromSelection(
      body,
      { bodyId: BODY_ID, kind: 'face', hash: 1 },
      undefined,
      'angle'
    )!;
    const ramp = measurementTargetFromSelection(
      body,
      { bodyId: BODY_ID, kind: 'face', hash: 2 },
      undefined,
      'angle'
    )!;

    const measured = createAngleMeasurement(flat, ramp, 1, 'mm')!;
    expect(measured.result.value).toBeCloseTo(30, 6);
    expect(measured.angleConvention).toBe('dihedral');

    // The convention travels with the number wherever it is shown.
    const formatted = formatMeasurement(measured, DISPLAY);
    expect(formatted.value).toBe('30.00 °');
    expect(formatted.detail).toBe(`Angle ${ANGLE_CONVENTION_LABELS.dihedral}`);
  });

  it('reports a nearly-flat joint as obtuse, which the fold could not', () => {
    // This is where old and new genuinely diverge, and it is worth being
    // precise about because the wedge above is NOT: with normals 150 apart,
    // |cos 150| folds to 30, which happens to equal the dihedral. The fold
    // only betrays itself when the normals are ACUTE. Two faces whose normals
    // are 30 apart are nearly coplanar, so the material between them opens to
    // 150 — a number the old code could not produce for any input.
    const body = bodyWithWedge();
    body.topology!.faces[1]!.geometry!.normal = v(
      Math.sin((30 * Math.PI) / 180),
      0,
      Math.cos((30 * Math.PI) / 180)
    );
    const flat = measurementTargetFromSelection(
      body,
      { bodyId: BODY_ID, kind: 'face', hash: 1 },
      undefined,
      'angle'
    )!;
    const ramp = measurementTargetFromSelection(
      body,
      { bodyId: BODY_ID, kind: 'face', hash: 2 },
      undefined,
      'angle'
    )!;

    const measured = createAngleMeasurement(flat, ramp, 1, 'mm')!;
    expect(measured.result.value).toBeCloseTo(150, 6);
    // The old code returned 30 here — the acute complement — for the same pick.
    expect(measured.result.value).not.toBeCloseTo(30, 3);
  });

  it('distinguishes a 150 degree pair of normals from a 30 degree one', () => {
    // The regression guard proper. Under the old `Math.abs` these two wedges
    // were indistinguishable: 150 folded to 30, so both read 30 and the app
    // had no way to express an obtuse relationship at all. They must now
    // differ, and the pair of dihedrals must sum to 180.
    const obtuse = angleBetweenFaces(atDegrees(0), atDegrees(150));
    const acute = angleBetweenFaces(atDegrees(0), atDegrees(30));

    expect(obtuse!.degrees).toBeCloseTo(30, 6);
    expect(acute!.degrees).toBeCloseTo(150, 6);
    expect(obtuse!.degrees).not.toBeCloseTo(acute!.degrees, 3);

    // And the underlying normals really are 150 and 30 apart respectively.
    expect(
      angleBetweenFaces(atDegrees(0), atDegrees(150), 'between-normals')!
        .degrees
    ).toBeCloseTo(150, 6);
    expect(
      angleBetweenFaces(atDegrees(0), atDegrees(30), 'between-normals')!.degrees
    ).toBeCloseTo(30, 6);
  });
});
