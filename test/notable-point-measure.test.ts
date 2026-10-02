import { describe, expect, it } from 'vitest';
import type {
  BodyId,
  BodyRepresentation,
  EdgeTopology,
  TopologySelection,
  Vector3
} from '@openzcad/shared';
import {
  createDistanceMeasurement,
  createThreePointAngle,
  formatMeasurement,
  measurementTargetFromSelection,
  measurementToViewportAnnotation,
  notablePointTarget,
  refreshMeasurements,
  type Measurement,
  type MeasurementDisplayOptions,
  type MeasurementQuality,
  type MeasurementTarget
} from '../apps/web/src/lib/measurements';
import {
  buildMeasurementRecord,
  parseStoredMeasurements
} from '../apps/web/src/lib/measurementStore';

const BODY_ID = 'body-notch' as BodyId;
const DISPLAY: MeasurementDisplayOptions = {
  unit: 'mm',
  precision: 2,
  radialDisplay: 'diameter'
};

const COS_45 = Math.SQRT1_2;
const ARC_CENTER = { x: 10, y: 20, z: 5 };

function meshBody(
  edges: EdgeTopology[],
  faces: NonNullable<BodyRepresentation['topology']>['faces']
): BodyRepresentation {
  return {
    bodyId: BODY_ID,
    name: 'Plate',
    source: 'primitive',
    mesh: {
      kind: 'mesh',
      vertices: Float32Array.from([]),
      indices: Uint32Array.from([])
    },
    faceCount: faces.length,
    color: '#fff',
    exportableStep: true,
    consumed: false,
    volume: 1000,
    bbox: { min: { x: 0, y: 0, z: 0 }, max: { x: 20, y: 30, z: 30 } },
    topology: { edges, faces }
  };
}

function lineEdge(): EdgeTopology {
  return {
    topologyId: 'edge:line',
    hash: 11,
    length: 10,
    curve: { type: 'LINE' },
    points: [0, 0, 0, 10, 0, 0]
  };
}

/** 90-degree arc of radius 4 about ARC_CENTER, sampled at 0/30/60/90 degrees. */
function minorArcEdge(): EdgeTopology {
  const at = (degrees: number): [number, number, number] => {
    const radians = (degrees * Math.PI) / 180;
    return [
      ARC_CENTER.x + 4 * Math.cos(radians),
      ARC_CENTER.y + 4 * Math.sin(radians),
      ARC_CENTER.z
    ];
  };
  return {
    topologyId: 'edge:arc90',
    hash: 12,
    length: (Math.PI / 2) * 4,
    curve: {
      type: 'CIRCLE',
      circle: {
        center: { ...ARC_CENTER },
        axis: { x: 0, y: 0, z: 1 },
        radius: 4
      }
    },
    points: [...at(0), ...at(30), ...at(60), ...at(90)]
  };
}

/** 270-degree arc of radius 4 about ARC_CENTER, sampled every quarter turn. */
function majorArcEdge(): EdgeTopology {
  return {
    topologyId: 'edge:arc270',
    hash: 13,
    length: ((3 * Math.PI) / 2) * 4,
    curve: {
      type: 'CIRCLE',
      circle: {
        center: { ...ARC_CENTER },
        axis: { x: 0, y: 0, z: 1 },
        radius: 4
      }
    },
    points: [14, 20, 5, 10, 24, 5, 6, 20, 5, 10, 16, 5]
  };
}

/** Full rim of radius 2: the polyline repeats its first point. */
function closedCircleEdge(): EdgeTopology {
  return {
    topologyId: 'edge:rim',
    hash: 14,
    length: Math.PI * 2 * 2,
    curve: {
      type: 'CIRCLE',
      circle: {
        center: { x: 0, y: 0, z: 10 },
        axis: { x: 0, y: 0, z: 1 },
        radius: 2
      }
    },
    points: [2, 0, 10, 0, 2, 10, -2, 0, 10, 0, -2, 10, 2, 0, 10]
  };
}

/**
 * L-shaped plate: 10x10 less the top-right 5x5. The six rim vertices average
 * to (5, 5) while the area centroid sits at (25/6, 25/6) — far enough apart
 * that confusing the two cannot hide inside a tolerance.
 */
function lFace() {
  return {
    topologyId: 'face:l',
    hash: 21,
    triangleStart: 0,
    triangleCount: 4,
    geometry: {
      surfaceType: 'plane',
      area: 75,
      center: { x: 5, y: 5, z: 0 },
      centroid: { x: 25 / 6, y: 25 / 6, z: 0 },
      centroidProvenance: 'exact' as const,
      normal: { x: 0, y: 0, z: 1 }
    }
  };
}

function discFace() {
  return {
    topologyId: 'face:disc',
    hash: 22,
    triangleStart: 4,
    triangleCount: 8,
    geometry: {
      surfaceType: 'plane',
      area: Math.PI * 16,
      // A single seam vertex: the vertex mean sits on the rim, one radius
      // from where the face looks centred.
      center: { x: 14, y: 20, z: 5 },
      centroid: { x: 10, y: 20, z: 5 },
      centroidProvenance: 'sampled' as const,
      normal: { x: 0, y: 0, z: 1 }
    }
  };
}

function legacyFace() {
  return {
    topologyId: 'face:legacy',
    hash: 23,
    triangleStart: 12,
    triangleCount: 2,
    geometry: {
      surfaceType: 'plane',
      area: 75,
      center: { x: 5, y: 5, z: 0 },
      centroid: { x: 25 / 6, y: 25 / 6, z: 0 },
      normal: { x: 0, y: 0, z: 1 }
    }
  };
}

function noCentroidFace() {
  return {
    topologyId: 'face:raw',
    hash: 24,
    triangleStart: 14,
    triangleCount: 2,
    geometry: {
      surfaceType: 'plane',
      area: 75,
      center: { x: 5, y: 5, z: 0 },
      normal: { x: 0, y: 0, z: 1 }
    }
  };
}

function holeFace() {
  return {
    topologyId: 'face:hole',
    hash: 25,
    triangleStart: 16,
    triangleCount: 8,
    geometry: {
      surfaceType: 'cylinder',
      area: 120,
      center: { x: 3, y: 4, z: 15 },
      radius: 4,
      diameter: 8,
      axisStart: { x: 3, y: 4, z: 0 },
      axisEnd: { x: 3, y: 4, z: 30 }
    }
  };
}

function selection(
  kind: TopologySelection['kind'],
  topologyId?: string,
  hash?: number
): TopologySelection {
  return {
    bodyId: BODY_ID,
    kind,
    ...(topologyId ? { topologyId } : {}),
    ...(hash !== undefined ? { hash } : {})
  };
}

function pointTarget(
  id: string,
  label: string,
  point: Vector3,
  quality: MeasurementQuality = 'exact-analytic'
): MeasurementTarget {
  return {
    bodyId: BODY_ID,
    bodyName: 'Plate',
    kind: 'edge',
    topologyId: `edge:${id}`,
    hash: id.length * 1000 + point.x,
    label,
    point,
    semantic: 'pick',
    quality
  };
}

describe('arc midpoints', () => {
  it('lands on the arc at the trimmed midpoint, not the chord midpoint', () => {
    const body = meshBody([minorArcEdge()], []);
    const target = notablePointTarget(
      body,
      selection('edge', 'edge:arc90', 12),
      'edge-midpoint'
    )!;
    expect(target).not.toBeNull();
    expect(target.semantic).toBe('edge-midpoint');
    expect(target.quality).toBe('exact-analytic');
    // The 45-degree point of the trimmed range.
    expect(target.point!.x).toBeCloseTo(10 + 4 * COS_45, 9);
    expect(target.point!.y).toBeCloseTo(20 + 4 * COS_45, 9);
    expect(target.point!.z).toBeCloseTo(5, 12);
    // On the circle, not inside it where the chord midpoint (12, 22) sits.
    const radial = Math.hypot(target.point!.x - 10, target.point!.y - 20);
    expect(radial).toBeCloseTo(4, 9);
    expect(
      Math.hypot(target.point!.x - 12, target.point!.y - 22)
    ).toBeGreaterThan(1);
  });

  it('follows the major arc past 180 degrees', () => {
    const body = meshBody([majorArcEdge()], []);
    const target = notablePointTarget(
      body,
      selection('edge', 'edge:arc270', 13),
      'edge-midpoint'
    )!;
    expect(target.point!.x).toBeCloseTo(10 - 4 * COS_45, 9);
    expect(target.point!.y).toBeCloseTo(20 + 4 * COS_45, 9);
    // The chord midpoint (12, 18) is on the minor side; the trimmed midpoint
    // of a 270-degree arc is across the centre from it.
    expect(target.point!.x).toBeLessThan(10);
  });

  it('refuses a closed rim, which has no single midpoint', () => {
    const body = meshBody([closedCircleEdge()], []);
    const sel = selection('edge', 'edge:rim', 14);
    expect(notablePointTarget(body, sel, 'edge-midpoint')).toBeNull();
    // The rim's centre is still exactly answerable.
    const center = notablePointTarget(body, sel, 'circle-center')!;
    expect(center.point).toEqual({ x: 0, y: 0, z: 10 });
    expect(center.quality).toBe('exact-analytic');
  });

  it('keeps the line midpoint on the chord, matching the pick derivation', () => {
    const body = meshBody([lineEdge()], []);
    const sel = selection('edge', 'edge:line', 11);
    const notable = notablePointTarget(body, sel, 'edge-midpoint')!;
    expect(notable.point).toEqual({ x: 5, y: 0, z: 0 });
    // One construction for both paths, so a re-pick deduplicates the row.
    expect(notable).toEqual(
      measurementTargetFromSelection(body, sel, undefined, 'distance')
    );
  });
});

describe('vertices', () => {
  it('resolves both edge ends exactly', () => {
    const body = meshBody([lineEdge()], []);
    const sel = selection('edge', 'edge:line', 11);
    const start = notablePointTarget(body, sel, 'vertex-start')!;
    const end = notablePointTarget(body, sel, 'vertex-end')!;
    expect(start.point).toEqual({ x: 0, y: 0, z: 0 });
    expect(end.point).toEqual({ x: 10, y: 0, z: 0 });
    expect(start.semantic).toBe('vertex-start');
    expect(end.semantic).toBe('vertex-end');
    expect(start.quality).toBe('exact-analytic');

    const measured = createDistanceMeasurement(start, end, 1, 'mm')!;
    expect(measured.result.value).toBeCloseTo(10, 12);
    expect(measured.result.components).toEqual({ x: 10, y: 0, z: 0 });
    expect(measured.quality).toBe('exact-analytic');
    const formatted = formatMeasurement(measured, DISPLAY);
    expect(formatted.value).toBe('10.00 mm');
    expect(formatted.detail).toBe('ΔX 10.00 · ΔY 0.00 · ΔZ 0.00 mm');
    expect(formatted.quality).toBe('Exact');
  });

  it('names the single seam vertex twice on a closed rim', () => {
    const body = meshBody([closedCircleEdge()], []);
    const sel = selection('edge', 'edge:rim', 14);
    const start = notablePointTarget(body, sel, 'vertex-start')!;
    const end = notablePointTarget(body, sel, 'vertex-end')!;
    expect(start.point).toEqual({ x: 2, y: 0, z: 10 });
    expect(end.point).toEqual(start.point);
  });
});

describe('centres', () => {
  it('measures the arc midpoint exactly one radius from its centre', () => {
    const body = meshBody([minorArcEdge()], []);
    const middle = notablePointTarget(
      body,
      selection('edge', 'edge:arc90', 12),
      'edge-midpoint'
    )!;
    const center = notablePointTarget(
      body,
      selection('edge', 'edge:arc90', 12),
      'circle-center'
    )!;
    expect(center.point).toEqual({ ...ARC_CENTER });
    const measured = createDistanceMeasurement(middle, center, 1, 'mm')!;
    expect(measured.result.value).toBeCloseTo(4, 9);
    expect(measured.quality).toBe('exact-analytic');
  });

  it('resolves hole centres from the cylinder axis', () => {
    const body = meshBody([], [holeFace()]);
    const center = notablePointTarget(
      body,
      selection('face', 'face:hole', 25),
      'circle-center'
    )!;
    expect(center.point).toEqual({ x: 3, y: 4, z: 15 });
    expect(center.semantic).toBe('circle-center');
    expect(center.quality).toBe('exact-analytic');
  });

  it('offers no circle centre on a straight edge', () => {
    const body = meshBody([lineEdge()], []);
    expect(
      notablePointTarget(
        body,
        selection('edge', 'edge:line', 11),
        'circle-center'
      )
    ).toBeNull();
  });
});

describe('face centroids', () => {
  it('anchors on the area centroid, never the vertex mean', () => {
    const body = meshBody([], [lFace()]);
    const sel = selection('face', 'face:l', 21);
    const target = notablePointTarget(body, sel, 'face-centroid')!;
    expect(target.semantic).toBe('face-center');
    expect(target.point!.x).toBeCloseTo(25 / 6, 12);
    expect(target.point!.y).toBeCloseTo(25 / 6, 12);
    // The rim mean (5, 5) is more than a millimetre away: confusing the two
    // cannot hide inside a tolerance on this face.
    expect(
      Math.hypot(target.point!.x - 5, target.point!.y - 5)
    ).toBeGreaterThan(1);
    expect(target.quality).toBe('exact-analytic');

    // The existing pick derivation keeps its reproducible vertex-mean anchor
    // (an unchanged contract that saved measurements refresh against); the
    // area centroid is reached only by asking for the notable point.
    const smart = measurementTargetFromSelection(
      body,
      sel,
      undefined,
      'smart'
    )!;
    expect(smart.point).toEqual({ x: 5, y: 5, z: 0 });
    expect(smart.quality).toBe('tessellated');
  });

  it('labels curved-boundary and legacy centroids approximate', () => {
    const sampled = meshBody([], [discFace()]);
    const sampledTarget = notablePointTarget(
      sampled,
      selection('face', 'face:disc', 22),
      'face-centroid'
    )!;
    // Still the centroid — the rim mean sits on the rim — but honestly tiered.
    expect(sampledTarget.point).toEqual({ x: 10, y: 20, z: 5 });
    expect(sampledTarget.quality).toBe('tessellated');

    const legacy = meshBody([], [legacyFace()]);
    expect(
      notablePointTarget(
        legacy,
        selection('face', 'face:legacy', 23),
        'face-centroid'
      )!.quality
    ).toBe('tessellated');
  });

  it('answers nothing when the face reports no centroid', () => {
    const body = meshBody([], [noCentroidFace()]);
    const sel = selection('face', 'face:raw', 24);
    expect(notablePointTarget(body, sel, 'face-centroid')).toBeNull();
  });
});

describe('point-to-point provenance and units', () => {
  it('is exact only when every input point is exact', () => {
    const exact = pointTarget('a', 'A', { x: 0, y: 0, z: 0 });
    const kernel = pointTarget('b', 'B', { x: 3, y: 4, z: 0 }, 'tessellated');
    const approx = pointTarget('c', 'C', { x: 6, y: 8, z: 0 }, 'sampled');

    const exactRow = createDistanceMeasurement(exact, exact, 1, 'mm')!;
    expect(exactRow.quality).toBe('exact-analytic');
    expect(formatMeasurement(exactRow, DISPLAY).quality).toBe('Exact');

    const kernelRow = createDistanceMeasurement(exact, kernel, 1, 'mm')!;
    expect(kernelRow.quality).toBe('tessellated');
    expect(formatMeasurement(kernelRow, DISPLAY).quality).toBe('Kernel');

    const approxRow = createDistanceMeasurement(exact, approx, 1, 'mm')!;
    expect(approxRow.quality).toBe('sampled');
    const formatted = formatMeasurement(approxRow, DISPLAY);
    expect(formatted.quality).toBe('Approx');
    expect(formatted.value.startsWith('≈ ')).toBe(true);
  });

  it('carries a centroid-to-vertex distance at the approximate tier', () => {
    const body = meshBody([lineEdge()], [discFace()]);
    const vertex = notablePointTarget(
      body,
      selection('edge', 'edge:line', 11),
      'vertex-start'
    )!;
    const centroid = notablePointTarget(
      body,
      selection('face', 'face:disc', 22),
      'face-centroid'
    )!;
    const measured = createDistanceMeasurement(vertex, centroid, 1, 'mm')!;
    expect(measured.result.value).toBeCloseTo(Math.hypot(10, 20, 5), 9);
    expect(measured.quality).toBe('tessellated');
    expect(formatMeasurement(measured, DISPLAY).quality).toBe('Kernel');
  });

  it('displays inch documents in inches without touching the stored value', () => {
    const first = pointTarget('a', 'A', { x: 0, y: 0, z: 0 });
    const second = pointTarget('b', 'B', { x: 25.4, y: 0, z: 0 });
    const measured = createDistanceMeasurement(first, second, 1, 'mm')!;
    const formatted = formatMeasurement(measured, {
      unit: 'inch',
      precision: 3,
      radialDisplay: 'diameter'
    });
    expect(formatted.value).toBe('1.000 in');
    expect(formatted.detail).toBe('ΔX 1.000 · ΔY 0.000 · ΔZ 0.000 in');
    expect(measured.result.value).toBe(25.4);

    const inchStored = createDistanceMeasurement(first, second, 1, 'inch')!;
    expect(
      formatMeasurement(inchStored, {
        unit: 'inch',
        precision: 3,
        radialDisplay: 'diameter'
      }).value
    ).toBe('25.400 in');
  });
});

describe('three-point angle', () => {
  it.each([
    { name: 'right', third: { x: 0, y: 10, z: 0 }, expected: 90 },
    { name: 'acute', third: { x: 10, y: 10, z: 0 }, expected: 45 },
    { name: 'straight', third: { x: -10, y: 0, z: 0 }, expected: 180 },
    { name: 'coincident arms', third: { x: 20, y: 0, z: 0 }, expected: 0 }
  ])('measures a $name angle as $expected degrees', ({ third, expected }) => {
    const measured = createThreePointAngle(
      pointTarget('a', 'A', { x: 10, y: 0, z: 0 }),
      pointTarget('v', 'V', { x: 0, y: 0, z: 0 }),
      pointTarget('b', 'B', third),
      1,
      'mm'
    )!;
    expect(measured.kind).toBe('point-angle');
    expect(measured.result.dimension).toBe('angle');
    expect(measured.result.value).toBeCloseTo(expected, 9);
    expect(measured.angleConvention).toBe('included');
    expect(measured.targets).toHaveLength(3);
  });

  it('puts the vertex at the middle pick, wherever it sits', () => {
    // Translated off the origin so a vertex-at-origin assumption reads wrong.
    const measured = createThreePointAngle(
      pointTarget('a', 'A', { x: 15, y: 5, z: 5 }),
      pointTarget('v', 'V', { x: 5, y: 5, z: 5 }),
      pointTarget('b', 'B', { x: 5, y: 15, z: 5 }),
      1,
      'mm'
    )!;
    expect(measured.result.value).toBeCloseTo(90, 9);
    expect(measured.annotation?.anchor).toEqual({ x: 5, y: 5, z: 5 });
    expect(measured.annotation?.segments).toHaveLength(2);
    for (const segment of measured.annotation!.segments) {
      expect(segment.start).toEqual({ x: 5, y: 5, z: 5 });
    }
    const formatted = formatMeasurement(measured, DISPLAY);
    expect(formatted.value).toBe('90.00 °');
    expect(formatted.detail).toBe('Angle included');
  });

  it('refuses a coincident arm rather than reporting 0', () => {
    const vertex = pointTarget('v', 'V', { x: 1, y: 2, z: 3 });
    expect(
      createThreePointAngle(
        pointTarget('a', 'A', { x: 1, y: 2, z: 3 }),
        vertex,
        pointTarget('b', 'B', { x: 4, y: 2, z: 3 }),
        1,
        'mm'
      )
    ).toBeNull();
    expect(
      createThreePointAngle(
        pointTarget('a', 'A', { x: 0, y: 0, z: 0 }),
        { ...vertex, point: undefined },
        pointTarget('b', 'B', { x: 4, y: 2, z: 3 }),
        1,
        'mm'
      )
    ).toBeNull();
  });

  it('carries provenance from the worst of the three points', () => {
    const exact = (id: string, point: Vector3) => pointTarget(id, id, point);
    const measured = createThreePointAngle(
      exact('a', { x: 10, y: 0, z: 0 }),
      exact('v', { x: 0, y: 0, z: 0 }),
      pointTarget('c', 'C', { x: 0, y: 10, z: 0 }, 'sampled'),
      1,
      'mm'
    )!;
    expect(measured.quality).toBe('sampled');
    expect(formatMeasurement(measured, DISPLAY).quality).toBe('Approx');

    const clean = createThreePointAngle(
      exact('a', { x: 10, y: 0, z: 0 }),
      exact('v', { x: 0, y: 0, z: 0 }),
      exact('b', { x: 0, y: 10, z: 0 }),
      1,
      'mm'
    )!;
    expect(clean.quality).toBe('exact-analytic');
    expect(formatMeasurement(clean, DISPLAY).quality).toBe('Exact');
  });

  it('draws arms from the vertex in the viewport', () => {
    const measured = createThreePointAngle(
      pointTarget('a', 'A', { x: 10, y: 0, z: 0 }),
      pointTarget('v', 'V', { x: 0, y: 0, z: 0 }),
      pointTarget('b', 'B', { x: 0, y: 10, z: 0 }),
      1,
      'mm'
    )!;
    const annotation = measurementToViewportAnnotation(
      measured,
      DISPLAY,
      false
    )!;
    expect(annotation.graphic).toBe('arms');
    expect(annotation.anchor).toEqual({ x: 0, y: 0, z: 0 });
  });
});

describe('refresh and persistence of notable rows', () => {
  function notableBodies(): BodyRepresentation[] {
    return [meshBody([lineEdge(), minorArcEdge()], [lFace()])];
  }

  function notableDistance(): Measurement {
    const [body] = notableBodies();
    const start = notablePointTarget(
      body!,
      selection('edge', 'edge:line', 11),
      'vertex-start'
    )!;
    const middle = notablePointTarget(
      body!,
      selection('edge', 'edge:arc90', 12),
      'edge-midpoint'
    )!;
    return createDistanceMeasurement(start, middle, 1, 'mm')!;
  }

  function notableAngle(): Measurement {
    const [body] = notableBodies();
    const a = notablePointTarget(
      body!,
      selection('edge', 'edge:line', 11),
      'vertex-start'
    )!;
    const v = notablePointTarget(
      body!,
      selection('edge', 'edge:line', 11),
      'vertex-end'
    )!;
    const c = notablePointTarget(
      body!,
      selection('face', 'face:l', 21),
      'face-centroid'
    )!;
    return createThreePointAngle(a, v, c, 1, 'mm')!;
  }

  it('rebuilds notable rows from current topology', () => {
    const distance = notableDistance();
    const angle = notableAngle();
    const refreshed = refreshMeasurements(
      [distance, angle],
      notableBodies(),
      2
    );
    expect(refreshed[0]!.status).toBe('current');
    expect(refreshed[0]!.result.value).toBeCloseTo(distance.result.value, 12);
    expect(refreshed[1]!.status).toBe('current');
    expect(refreshed[1]!.result.value).toBeCloseTo(angle.result.value, 12);
    expect(refreshed[1]!.targets).toHaveLength(3);
  });

  it('fails closed when notable topology is gone', () => {
    const distance = notableDistance();
    const angle = notableAngle();
    const refreshed = refreshMeasurements([distance, angle], [], 2);
    expect(refreshed.map((entry) => entry.status)).toEqual([
      'unresolved',
      'unresolved'
    ]);
    expect(refreshed[0]!.reason).toBe('body-missing');
    // The last known values survive as the receipt.
    expect(refreshed[0]!.result.value).toBeCloseTo(distance.result.value, 12);
  });

  it('rejects a point-angle row that lost its third target', () => {
    const angle = notableAngle();
    const malformed: Measurement = {
      ...angle,
      targets: [angle.targets[0]!, angle.targets[1]!]
    };
    const refreshed = refreshMeasurements([malformed], notableBodies(), 1, {
      force: true
    });
    expect(refreshed[0]).toMatchObject({
      status: 'unresolved',
      reason: 'not-found'
    });
  });

  it('round-trips notable rows through the project store', () => {
    const stored = buildMeasurementRecord(
      'p1',
      [notableDistance(), notableAngle()],
      DISPLAY,
      '2026-10-02T00:00:00Z'
    );
    const parsed = parseStoredMeasurements(JSON.parse(JSON.stringify(stored)));
    expect(parsed?.measurements).toHaveLength(2);
    expect(parsed?.measurements.map((entry) => entry.kind)).toEqual([
      'distance',
      'point-angle'
    ]);
    expect(
      parsed?.measurements[0]?.targets.map((target) => target.semantic)
    ).toEqual(['vertex-start', 'edge-midpoint']);
    expect(parsed?.measurements[1]?.targets).toHaveLength(3);
  });
});
