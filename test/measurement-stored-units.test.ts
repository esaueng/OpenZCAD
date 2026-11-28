import { describe, expect, it } from 'vitest';
import type {
  BodyId,
  BodyRepresentation,
  EdgeTopology,
  EdgeTopologyReferenceV5,
  FaceTopology,
  FaceTopologyReferenceV5,
  FeatureId
} from '@openzcad/shared';
import {
  MEASUREMENT_UNIT_FREE_FIELDS,
  createDistanceMeasurement,
  createEntityDistanceMeasurement,
  createSmartMeasurement,
  formatMeasurement,
  measurementInUnit,
  measurementTargetFromSelection,
  refreshMeasurements,
  type Measurement
} from '../apps/web/src/lib/measurements';

/**
 * I03 preview finding 1 (PR #1999): a kept measurement across a stored-unit
 * conversion. Kept measurements live beside the document (per-project
 * measurement store), not in it, so `convertDocumentUnits` never sees them;
 * each row carries the unit it was measured in (`sourceUnit`) and the
 * refresh rescales it to the bodies' unit before re-measuring.
 *
 * The bug: the refresh re-measured an 18 mm edge on the converted model
 * (0.7087 in model units) but kept `sourceUnit: 'mm'`, so the dock and the
 * canvas label read 0.7087 mm, shown as "0.03 in".
 */

const BODY_ID = 'body-1' as BodyId;
const INCH = 25.4;

function box(scale: number): BodyRepresentation {
  const [x, y, z] = [25.4 * scale, 18 * scale, 24 * scale];
  return {
    bodyId: BODY_ID,
    name: 'Box',
    source: 'primitive',
    mesh: {
      kind: 'mesh',
      vertices: Float32Array.from([]),
      indices: Uint32Array.from([])
    },
    faceCount: 1,
    color: '#fff',
    exportableStep: true,
    consumed: false,
    volume: x * y * z,
    bbox: { min: { x: 0, y: 0, z: 0 }, max: { x, y, z } },
    topology: {
      faces: [
        {
          topologyId: 'face:21',
          hash: 21,
          triangleStart: 0,
          triangleCount: 2,
          geometry: {
            surfaceType: 'plane',
            area: x * y,
            center: { x: x / 2, y: y / 2, z },
            centroid: { x: x / 2, y: y / 2, z },
            centroidProvenance: 'exact' as const,
            normal: { x: 0, y: 0, z: 1 }
          }
        }
      ],
      edges: [
        {
          topologyId: 'edge:11',
          hash: 11,
          length: y,
          curve: { type: 'LINE' },
          points: [0, 0, 0, 0, y, 0]
        }
      ]
    }
  };
}

const display = (unit: 'mm' | 'inch') => ({
  unit,
  precision: 3,
  radialDisplay: 'diameter' as const
});

function keptEdge(): Measurement {
  return createSmartMeasurement(
    box(1),
    { bodyId: BODY_ID, kind: 'edge', hash: 11 },
    undefined,
    1,
    'mm'
  )!;
}

describe('a kept measurement across a stored-unit conversion', () => {
  it('reads 0.709 in after mm → in, not the converted number read as mm', () => {
    const kept = keptEdge();
    expect(formatMeasurement(kept, display('inch')).value).toBe('0.709 in');

    // The converted document: the same edge, now stored in inches.
    const converted = refreshMeasurements([kept], [box(1 / INCH)], 2, {
      force: true,
      unit: 'inch'
    });
    expect(converted[0]!.status).toBe('current');
    expect(converted[0]!.sourceUnit).toBe('inch');
    expect(converted[0]!.result.value).toBeCloseTo(18 / INCH, 12);
    expect(formatMeasurement(converted[0]!, display('inch')).value).toBe(
      '0.709 in'
    );
    // The canvas label's geometry is in the converted model's space too.
    const span = converted[0]!.annotation!.segments[0]!;
    expect(Math.hypot(span.end.y - span.start.y)).toBeCloseTo(18 / INCH, 9);

    // Undo: the document is back in millimetres.
    const undone = refreshMeasurements(converted, [box(1)], 3, {
      force: true,
      unit: 'mm'
    });
    expect(undone[0]!.sourceUnit).toBe('mm');
    expect(formatMeasurement(undone[0]!, display('mm')).value).toBe(
      '18.000 mm'
    );
  });

  it('rescales a row that cannot be re-measured, so it is stale, not wrong', () => {
    const kept = keptEdge();
    const refreshed = refreshMeasurements([kept], [], 2, {
      force: true,
      unit: 'inch'
    });
    expect(refreshed[0]!.status).toBe('unresolved');
    expect(formatMeasurement(refreshed[0]!, display('inch')).value).toBe(
      '0.709 in'
    );
  });

  it('rescales areas by k² and volumes by k³', () => {
    const face = createSmartMeasurement(
      box(1),
      { bodyId: BODY_ID, kind: 'face', hash: 21 },
      undefined,
      1,
      'mm'
    )!;
    const body = createSmartMeasurement(
      box(1),
      { bodyId: BODY_ID, kind: 'body' },
      undefined,
      1,
      'mm'
    )!;
    expect(measurementInUnit(face, 'inch').result.value).toBeCloseTo(
      (25.4 * 18) / INCH ** 2,
      12
    );
    const bodyIn = measurementInUnit(body, 'inch');
    expect(bodyIn.result.value).toBeCloseTo((25.4 * 18 * 24) / INCH ** 3, 12);
    expect(bodyIn.result.components!.y).toBeCloseTo(18 / INCH, 12);
  });

  it('classifies every number a measurement carries (audit)', () => {
    const body = box(1);
    const first = measurementTargetFromSelection(
      body,
      { bodyId: BODY_ID, kind: 'face', hash: 21 },
      { x: 2, y: 3, z: 24 },
      'distance'
    )!;
    const second = measurementTargetFromSelection(
      body,
      { bodyId: BODY_ID, kind: 'edge', hash: 11 },
      undefined,
      'distance'
    )!;
    const samples: Measurement[] = [
      keptEdge(),
      createDistanceMeasurement(first, second, 1, 'mm')!,
      createSmartMeasurement(
        body,
        { bodyId: BODY_ID, kind: 'body' },
        undefined,
        1,
        'mm'
      )!
    ];
    const unitFree = MEASUREMENT_UNIT_FREE_FIELDS.map(
      (pattern) =>
        new RegExp(
          `^${pattern.replace(/\./g, '\\.').replace(/\*/g, '\\d+')}(\\.|$)`
        )
    );
    const leaves = (value: unknown, path: string[] = []): [string, number][] =>
      typeof value === 'number'
        ? [[path.join('.'), value]]
        : typeof value === 'object' && value !== null
          ? Object.entries(value).flatMap(([key, child]) =>
              leaves(child, [...path, key])
            )
          : [];
    const unclassified: string[] = [];
    for (const sample of samples) {
      const before = new Map(leaves(sample));
      const after = new Map(leaves(measurementInUnit(sample, 'cm')));
      for (const [path, value] of before) {
        if (unitFree.some((pattern) => pattern.test(path))) {
          expect(after.get(path), path).toBe(value);
          continue;
        }
        // Every other number scales: a zero stays zero, the rest move.
        if (value !== 0 && after.get(path) === value)
          unclassified.push(`${sample.kind} ${path}`);
      }
    }
    expect(unclassified).toEqual([]);
  });
});

/**
 * #2361: kept rows on a Boolean result across a stored-unit conversion.
 *
 * A Boolean output's faces and edges are named by their quantized geometry
 * (an unnamed one only by its ADR-011 hash), so converting the document gives
 * them new identities, and a row that resolved them came back `not-found` on
 * the same solid, scaled. The refresh that rescales a row now re-attaches
 * each target to the scaled entity, by the evidence the conversion verified.
 */
describe('kept rows on a Boolean result across a stored-unit conversion', () => {
  const UNION_ID = 'body-union' as BodyId;
  const FEATURE = 'feat_union' as FeatureId;
  const quantum = (value: number) => Math.round(value / 1e-6);
  const at = (x: number, y: number, z: number): [number, number, number] => [
    quantum(x),
    quantum(y),
    quantum(z)
  ];
  /** The direction quantum does not scale, so both builds agree on it. */
  const UP: [number, number, number] = [0, 0, 1_000_000_000];
  const DOWN: [number, number, number] = [0, 0, -1_000_000_000];

  /**
   * A 4 × 6 × 2 block made by uniting two halves, in a document whose unit is
   * `scale` millimetres. `hashBase` stands in for ADR-011's fingerprint,
   * which a conversion changes. Unnamed, as a Boolean's split faces are; or
   * named the way a Boolean names an imported face, by the import's witness
   * hash, which the conversion also changes.
   */
  function union(
    scale: number,
    hashBase: number,
    named = false
  ): BodyRepresentation {
    const s = (value: number) => value * scale;
    const lineage = (kind: 'face' | 'edge', name: string, hash: number) => ({
      producingFeatureId: FEATURE,
      lineageName: `boolean.${kind}.target.import.step.${kind}.${hash
        .toString(16)
        .padStart(8, '0')}.${name}`,
      currentHash: hash,
      witnessVersion: 1 as const
    });
    const plane = (
      name: string,
      hash: number,
      z: number,
      normal: [number, number, number]
    ): FaceTopology => {
      const reference: FaceTopologyReferenceV5 = {
        kind: 'face',
        ...lineage('face', name, hash),
        witness: {
          surfaceType: 'plane',
          perimeter: quantum(s(20)),
          centroid: at(s(2), s(3), s(z)),
          analytic: { kind: 'plane', normal, offset: quantum(s(z)) },
          closure: { u: 'open', v: 'open' }
        }
      };
      return {
        topologyId: `face:${hash}`,
        hash,
        ...(named ? { reference } : {}),
        triangleStart: 0,
        triangleCount: 2,
        geometry: {
          surfaceType: 'plane',
          area: s(4) * s(6),
          center: { x: s(2), y: s(3), z: s(z) },
          centroid: { x: s(2), y: s(3), z: s(z) },
          centroidProvenance: 'exact',
          normal: { x: 0, y: 0, z: normal[2] > 0 ? 1 : -1 }
        }
      };
    };
    const line = (
      name: string,
      hash: number,
      from: [number, number, number],
      to: [number, number, number]
    ): EdgeTopology => {
      const a = from.map(s) as [number, number, number];
      const b = to.map(s) as [number, number, number];
      const length = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
      const reference: EdgeTopologyReferenceV5 = {
        kind: 'edge',
        ...lineage('edge', name, hash),
        witness: {
          curveType: 'LINE',
          length: quantum(length),
          closed: false,
          endpoints: [at(...a), at(...b)],
          midpoint: at((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2)
        }
      };
      return {
        topologyId: `edge:${hash}`,
        hash,
        ...(named ? { reference } : {}),
        length,
        curve: { type: 'LINE' },
        points: [...a, ...b]
      };
    };
    return {
      ...box(scale),
      bodyId: UNION_ID,
      name: 'Union',
      bbox: {
        min: { x: 0, y: 0, z: 0 },
        max: { x: s(4), y: s(6), z: s(2) }
      },
      topology: {
        faces: [
          plane('top', hashBase + 1, 2, UP),
          plane('bottom', hashBase + 2, 0, DOWN)
        ],
        edges: [
          line('front', hashBase + 11, [0, 0, 2], [4, 0, 2]),
          line('back', hashBase + 12, [0, 6, 0], [4, 6, 0])
        ]
      }
    };
  }

  function pickOf(body: BodyRepresentation, hash: number) {
    const face = body.topology?.faces?.find((item) => item.hash === hash);
    const edge = body.topology?.edges?.find((item) => item.hash === hash);
    const found = (face ?? edge)!;
    return {
      bodyId: body.bodyId,
      kind: face ? ('face' as const) : ('edge' as const),
      topologyId: found.topologyId,
      hash: found.hash,
      ...(found.reference ? { reference: found.reference } : {})
    };
  }

  /** A kept face pair, a snapped edge-midpoint distance and a maximum. */
  function keptRows(body: BodyRepresentation): Measurement[] {
    const target = (
      hash: number,
      point?: { x: number; y: number; z: number }
    ) =>
      measurementTargetFromSelection(
        body,
        pickOf(body, hash),
        point,
        'distance'
      )!;
    const facePair = createEntityDistanceMeasurement(
      'parallel',
      [body],
      target(101, { x: 1, y: 1, z: 2 }),
      target(102, { x: 3, y: 5, z: 0 }),
      1,
      'mm'
    ) as Measurement;
    const front = target(111);
    expect(front.semantic).toBe('edge-midpoint');
    const midpoints = createDistanceMeasurement(front, target(112), 1, 'mm')!;
    const farthest = createEntityDistanceMeasurement(
      'maximum',
      [body],
      target(111),
      target(112),
      1,
      'mm'
    ) as Measurement;
    return [facePair, midpoints, farthest];
  }

  const MM = [2, Math.hypot(6, 2), Math.hypot(4, 6, 2)];

  function expectCarried(
    rows: readonly Measurement[],
    unit: 'mm' | 'inch',
    hashBase: number
  ) {
    const k = unit === 'inch' ? 1 / INCH : 1;
    for (const [index, row] of rows.entries()) {
      expect(row.status, row.kind).toBe('current');
      expect(row.sourceUnit).toBe(unit);
      expect(row.result.value).toBeCloseTo(MM[index]! * k, 9);
      for (const target of row.targets) {
        expect(target.hash! - hashBase, row.kind).toBeGreaterThan(0);
        expect(target.hash! - hashBase, row.kind).toBeLessThan(100);
      }
    }
  }

  it('re-attaches a face pair, a snapped edge midpoint and a maximum distance', () => {
    const mm = union(1, 100);
    const rows = keptRows(mm);
    expect(rows.map((row) => row.kind)).toEqual([
      'parallel-distance',
      'distance',
      'max-distance'
    ]);
    expectCarried(rows, 'mm', 100);

    // The converted document: the same solid in inches, every fingerprint new.
    const inch = union(1 / INCH, 900);
    const converted = refreshMeasurements(rows, [inch], 2, {
      force: true,
      unit: 'inch',
      previous: { unit: 'mm', bodies: [mm] }
    });
    expectCarried(converted, 'inch', 900);
    expect(converted.every((row) => row.sourceRevision === 2)).toBe(true);

    // Undo: back in millimetres, onto the original fingerprints.
    const undone = refreshMeasurements(converted, [union(1, 100)], 3, {
      force: true,
      unit: 'mm',
      previous: { unit: 'inch', bodies: [inch] }
    });
    expectCarried(undone, 'mm', 100);
  });

  it('re-attaches named targets by their stored witness alone', () => {
    // A row first refreshed after a reload has no old-unit bodies to read;
    // a named target's stored witness still says what it was.
    const rows = keptRows(union(1, 100, true));
    const converted = refreshMeasurements(
      rows,
      [union(1 / INCH, 900, true)],
      2,
      {
        force: true,
        unit: 'inch'
      }
    );
    expectCarried(converted, 'inch', 900);
    for (const target of converted.flatMap((row) => row.targets))
      expect(target.reference?.currentHash).toBe(target.hash);
  });

  it('leaves an unnamed target unresolved with nothing to compare it to', () => {
    const rows = keptRows(union(1, 100));
    const [facePair] = refreshMeasurements(
      [rows[0]!],
      [union(1 / INCH, 900)],
      2,
      {
        force: true,
        unit: 'inch'
      }
    );
    expect(facePair!.status).toBe('unresolved');
    expect(facePair!.reason).toBe('not-found');
  });

  it('stays unresolved when the scaled geometry is not there', () => {
    const mm = union(1, 100);
    const rows = keptRows(mm);
    // Converted, but the top face is no longer the scaled one: it moved.
    const moved = union(1 / INCH, 900);
    const top = moved.topology!.faces[0]!;
    moved.topology!.faces[0] = {
      ...top,
      geometry: {
        ...top.geometry!,
        center: { x: 2 / INCH, y: 3 / INCH, z: 3 / INCH },
        centroid: { x: 2 / INCH, y: 3 / INCH, z: 3 / INCH }
      }
    };
    const [facePair] = refreshMeasurements([rows[0]!], [moved], 2, {
      force: true,
      unit: 'inch',
      previous: { unit: 'mm', bodies: [mm] }
    });
    expect(facePair!.status).toBe('unresolved');
    expect(facePair!.reason).toBe('not-found');
    // The retained number is in the new unit and still names the revision
    // that produced it (#2360).
    expect(facePair!.result.value).toBeCloseTo(2 / INCH, 9);
    expect(facePair!.sourceRevision).toBe(1);
    expect(facePair!.checkedRevision).toBe(2);
  });

  it('refuses two converted faces that both fit, rather than choosing', () => {
    const mm = union(1, 100);
    const rows = keptRows(mm);
    const twin = union(1 / INCH, 900);
    const top = twin.topology!.faces[0]!;
    twin.topology!.faces.push({ ...top, topologyId: 'face:999', hash: 999 });
    const [facePair] = refreshMeasurements([rows[0]!], [twin], 2, {
      force: true,
      unit: 'inch',
      previous: { unit: 'mm', bodies: [mm] }
    });
    expect(facePair!.status).toBe('unresolved');
  });
});
