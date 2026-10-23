import { describe, expect, it } from 'vitest';
import {
  frameForPlaneRef,
  orientLikeStored,
  projectEdgeToSketch,
  projectableCurveFromTopology,
  sameProjectedGeometry,
  type PlaneBasis,
  type ProjectableEdgeCurve
} from '@openzcad/geometry';
import type { SketchObjectData } from '@openzcad/shared';

/**
 * I01 projection math: one exact edge, projected along the sketch normal,
 * as the sketch object that draws it exactly — with closed-form oracles.
 */

const xy: PlaneBasis = frameForPlaneRef(
  { type: 'canonical', plane: 'XY', offset: 3 },
  (value) => Number(value)
);

function projected(curve: ProjectableEdgeCurve, basis = xy): SketchObjectData {
  const outcome = projectEdgeToSketch(curve, basis);
  if (outcome.status !== 'projected') throw new Error(outcome.reason);
  return outcome.data;
}

const v = (x: number, y: number, z: number) => ({ x, y, z });

describe('projectEdgeToSketch', () => {
  it('drops a line onto the plane along its normal', () => {
    expect(
      projected({ kind: 'line', start: v(1, 2, 9), end: v(4, 6, -2) })
    ).toEqual({ objectKind: 'line', x1: 1, y1: 2, x2: 4, y2: 6 });
  });

  it('refuses a line along the normal, which collapses to a point', () => {
    const outcome = projectEdgeToSketch(
      { kind: 'line', start: v(1, 1, 0), end: v(1, 1, 10) },
      xy
    );
    expect(outcome).toEqual({
      status: 'refused',
      reason: expect.stringMatching(/projects to a point/) as unknown
    });
  });

  it('keeps a parallel circle a circle of the same radius', () => {
    expect(
      projected({
        kind: 'circle',
        center: v(2, -1, 40),
        axis: v(0, 0, -1),
        radius: 5
      })
    ).toEqual({ objectKind: 'circle', centerX: 2, centerY: -1, radius: 5 });
  });

  it('chooses the arc its inside point is on, whichever way the edge runs', () => {
    // The upper half of a unit circle about the origin: 0° → 180° CCW.
    const upper = {
      kind: 'circle' as const,
      center: v(0, 0, 0),
      axis: v(0, 0, 1),
      radius: 1,
      arc: { start: v(1, 0, 0), end: v(-1, 0, 0), inside: v(0, 1, 0) }
    };
    const reversed = {
      ...upper,
      arc: { start: v(-1, 0, 0), end: v(1, 0, 0), inside: v(0, 1, 0) }
    };
    for (const curve of [upper, reversed]) {
      const arc = projected(curve);
      expect(arc).toMatchObject({ objectKind: 'arc', radius: 1 });
      if (arc.objectKind !== 'arc') throw new Error('expected an arc');
      expect(arc.startAngleDeg).toBeCloseTo(0, 12);
      expect(arc.endAngleDeg).toBeCloseTo(180, 12);
    }
    // The lower half is the other sweep between the same two ends.
    const lower = projected({
      ...upper,
      arc: { ...upper.arc, inside: v(0, -1, 0) }
    });
    if (lower.objectKind !== 'arc') throw new Error('expected an arc');
    expect(lower.startAngleDeg).toBeCloseTo(180, 12);
    expect(lower.endAngleDeg).toBeCloseTo(0, 12);
  });

  it('projects a tilted circle as an ellipse: r along the hinge, r·cos θ across', () => {
    const theta = Math.PI / 3; // plane tilted 60° about the x axis
    const ellipse = projected({
      kind: 'circle',
      center: v(1, 2, 7),
      axis: v(0, -Math.sin(theta), Math.cos(theta)),
      radius: 4
    });
    expect(ellipse).toMatchObject({ objectKind: 'ellipse', centerX: 1 });
    if (ellipse.objectKind !== 'ellipse') throw new Error('expected ellipse');
    expect(ellipse.centerY).toBeCloseTo(2, 12);
    expect(ellipse.radiusX).toBeCloseTo(4, 12);
    expect(ellipse.radiusY).toBeCloseTo(4 * Math.cos(theta), 12);
    // The hinge is the x axis, so the major axis lies along +u.
    expect(ellipse.rotationDeg).toBeCloseTo(0, 12);
    expect(ellipse.startParamDeg).toBeUndefined();
  });

  it('maps a tilted arc to the elliptical arc between the same ends', () => {
    const theta = Math.PI / 4;
    const axis = v(0, -Math.sin(theta), Math.cos(theta));
    // In-plane basis: e1 = x, e2 = axis × e1.
    const e2 = v(0, Math.cos(theta), Math.sin(theta));
    const at = (deg: number) => {
      const t = (deg * Math.PI) / 180;
      return v(2 * Math.cos(t), 2 * Math.sin(t) * e2.y, 2 * Math.sin(t) * e2.z);
    };
    const arc = projected({
      kind: 'circle',
      center: v(0, 0, 0),
      axis,
      radius: 2,
      arc: { start: at(0), end: at(90), inside: at(45) }
    });
    if (arc.objectKind !== 'ellipse') throw new Error('expected ellipse');
    expect(arc.radiusY).toBeCloseTo(2 * Math.cos(theta), 12);
    expect(arc.startParamDeg).toBeCloseTo(0, 9);
    expect(arc.endParamDeg).toBeCloseTo(90, 9);
  });

  it('refuses a circle seen edge-on and any curve kind it cannot draw exactly', () => {
    expect(
      projectEdgeToSketch(
        { kind: 'circle', center: v(0, 0, 0), axis: v(1, 0, 0), radius: 1 },
        xy
      )
    ).toEqual({
      status: 'refused',
      reason: expect.stringMatching(/edge-on/) as unknown
    });
    expect(
      projectEdgeToSketch(
        { kind: 'unsupported', curveType: 'BSPLINE_CURVE' },
        xy
      )
    ).toEqual({
      status: 'refused',
      reason: expect.stringMatching(
        /bspline_curve edge cannot be projected/
      ) as unknown
    });
  });
});

describe('projectableCurveFromTopology', () => {
  it('keeps proven full circles with only their closing endpoints', () => {
    const circle = { center: v(0, 0, 0), axis: v(0, 0, 1), radius: 20 };
    for (const vertexIds of [[3, 3] as [number, number], undefined]) {
      expect(
        projectableCurveFromTopology({
          curve: { type: 'CIRCLE', circle },
          vertexIds,
          points: [20, 0, 0, 20, 0, 0]
        })
      ).toEqual({ kind: 'circle', ...circle });
    }
  });

  for (const tilt of [0, Math.PI / 3]) {
    for (const reverse of [false, true]) {
      const angle = 0.2;
      const at = (degrees: number) => {
        const t = (degrees * Math.PI) / 180;
        return [
          20 * Math.cos(t),
          20 * Math.sin(t) * Math.cos(tilt),
          20 * Math.sin(t) * Math.sin(tilt)
        ];
      };
      const circle = {
        center: v(0, 0, 0),
        axis: v(0, -Math.sin(tilt), Math.cos(tilt)),
        radius: 20
      };
      it(`refuses a two-sample shallow arc, tilt=${tilt}, reversed=${reverse}`, () => {
        const points = reverse
          ? [...at(angle), ...at(0)]
          : [...at(0), ...at(angle)];
        const curve = projectableCurveFromTopology({
          curve: { type: 'CIRCLE', circle },
          vertexIds: [1, 2],
          points
        });
        expect(projectEdgeToSketch(curve, xy)).toMatchObject({
          status: 'refused'
        });
      });
      it(`keeps the short sweep when a genuine interior sample exists, tilt=${tilt}, reversed=${reverse}`, () => {
        const ends = reverse ? [angle, angle / 2, 0] : [0, angle / 2, angle];
        const curve = projectableCurveFromTopology({
          curve: { type: 'CIRCLE', circle },
          vertexIds: [1, 2],
          points: ends.flatMap(at)
        });
        const data = projected(curve);
        if (tilt === 0) {
          if (data.objectKind !== 'arc') throw new Error('expected an arc');
          expect(data.startAngleDeg).toBeCloseTo(0, 9);
          expect(data.endAngleDeg).toBeCloseTo(angle, 9);
        } else {
          if (data.objectKind !== 'ellipse')
            throw new Error('expected an elliptical arc');
          expect(data.startParamDeg).toBeCloseTo(0, 9);
          expect(data.endParamDeg).toBeCloseTo(angle, 9);
        }
      });
    }
  }

  it('reads a line from its polyline ends and an unproven circle as unsupported', () => {
    expect(
      projectableCurveFromTopology({
        curve: { type: 'LINE' },
        points: [0, 0, 0, 1, 0, 0, 2, 0, 0]
      })
    ).toEqual({ kind: 'line', start: v(0, 0, 0), end: v(2, 0, 0) });
    expect(
      projectableCurveFromTopology({
        curve: { type: 'CIRCLE' },
        points: [1, 0, 0, 0, 1, 0]
      })
    ).toEqual({ kind: 'unsupported', curveType: 'unproven circle' });
  });

  it('reads a closed rim by its vertex ids and an arc with its middle sample', () => {
    const circle = { center: v(0, 0, 0), axis: v(0, 0, 1), radius: 1 };
    expect(
      projectableCurveFromTopology({
        curve: { type: 'CIRCLE', circle },
        vertexIds: [3, 3],
        points: [1, 0, 0, 0, 1, 0, -1, 0, 0, 1, 0, 0]
      })
    ).toEqual({ kind: 'circle', ...circle });
    expect(
      projectableCurveFromTopology({
        curve: { type: 'CIRCLE', circle },
        vertexIds: [1, 2],
        points: [1, 0, 0, 0, 1, 0, -1, 0, 0]
      })
    ).toEqual({
      kind: 'circle',
      ...circle,
      arc: { start: v(1, 0, 0), end: v(-1, 0, 0), inside: v(0, 1, 0) }
    });
  });
});

describe('stored projection comparison', () => {
  const line = {
    objectKind: 'line' as const,
    x1: 0,
    y1: 0,
    x2: 10,
    y2: 0
  };

  it('treats agreement within 1e-6 as unchanged, and a turn of 360° as none', () => {
    expect(sameProjectedGeometry(line, { ...line, x2: 10 + 5e-7 })).toBe(true);
    expect(sameProjectedGeometry(line, { ...line, x2: 10.001 })).toBe(false);
    const arc = {
      objectKind: 'arc' as const,
      centerX: 0,
      centerY: 0,
      radius: 1,
      startAngleDeg: -90,
      endAngleDeg: 90
    };
    expect(
      sameProjectedGeometry(arc, {
        ...arc,
        startAngleDeg: 270,
        endAngleDeg: 450
      })
    ).toBe(true);
    expect(sameProjectedGeometry(line, { ...arc })).toBe(false);
  });

  it('keeps line ends named after the edge comes back reversed', () => {
    const reversed = {
      objectKind: 'line' as const,
      x1: 10,
      y1: 0,
      x2: 0,
      y2: 0
    };
    expect(orientLikeStored(line, reversed)).toEqual(line);
    const moved = { objectKind: 'line' as const, x1: 0, y1: 0, x2: 14, y2: 0 };
    expect(orientLikeStored(line, moved)).toEqual(moved);
  });
});
