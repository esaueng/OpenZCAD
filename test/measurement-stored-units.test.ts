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

    // The converted document: the same edge, now stored in inches. The
    // workbench hands over the millimetre bodies it last saw: an old-unit
    // hash alone is never trusted across the conversion.
    const converted = refreshMeasurements([kept], [box(1 / INCH)], 2, {
      force: true,
      unit: 'inch',
      previous: [{ unit: 'mm', bodies: [box(1)] }]
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
      unit: 'mm',
      previous: [{ unit: 'inch', bodies: [box(1 / INCH)] }]
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
      previous: [{ unit: 'mm', bodies: [mm] }]
    });
    expectCarried(converted, 'inch', 900);
    expect(converted.every((row) => row.sourceRevision === 2)).toBe(true);

    // Undo: back in millimetres, onto the original fingerprints.
    const undone = refreshMeasurements(converted, [union(1, 100)], 3, {
      force: true,
      unit: 'mm',
      previous: [{ unit: 'inch', bodies: [inch] }]
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
      previous: [{ unit: 'mm', bodies: [mm] }]
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
      previous: [{ unit: 'mm', bodies: [mm] }]
    });
    expect(facePair!.status).toBe('unresolved');
  });
});

/**
 * #2433 review: across a unit change an old hash names nothing. ADR-011
 * hashes quantized DOCUMENT-unit geometry, so after mm → cm a different
 * entity can land on the very numbers another one had: here the edge at
 * X = 100–200 mm becomes 10–20 cm and takes the hash the 10–20 mm edge had.
 * The kept reading must follow the scaled geometry, never that hash.
 */
describe('an old hash that a different entity carries after the conversion', () => {
  const BOOLEAN_ID = 'body-boolean' as BodyId;
  /** A stand-in fingerprint of an edge's ends, in its document's unit. */
  const fingerprint = (from: number, to: number) =>
    Math.round(from * 1000 + to);

  /** Two collinear edges, X = 10–20 mm and X = 100–200 mm, stored in `unit`. */
  function collinear(unit: 'mm' | 'cm'): BodyRepresentation {
    const k = unit === 'cm' ? 0.1 : 1;
    const edge = (from: number, to: number): EdgeTopology => {
      const hash = fingerprint(from * k, to * k);
      return {
        topologyId: `edge:${hash}`,
        hash,
        length: (to - from) * k,
        curve: { type: 'LINE' },
        points: [from * k, 0, 0, to * k, 0, 0]
      };
    };
    return {
      ...box(k),
      bodyId: BOOLEAN_ID,
      name: 'Boolean',
      bbox: {
        min: { x: 10 * k, y: 0, z: 0 },
        max: { x: 200 * k, y: 0, z: 0 }
      },
      topology: { faces: [], edges: [edge(10, 20), edge(100, 200)] }
    };
  }

  function keptShortEdge(): Measurement {
    const mm = collinear('mm');
    const kept = createSmartMeasurement(
      mm,
      { bodyId: BOOLEAN_ID, kind: 'edge', hash: fingerprint(10, 20) },
      undefined,
      1,
      'mm'
    )!;
    expect(kept.result.value).toBeCloseTo(10, 12);
    // The collision the fixture is about.
    expect(collinear('cm').topology!.edges.map((edge) => edge.hash)).toContain(
      kept.targets[0]!.hash
    );
    return kept;
  }

  it('follows the scaled edge, not the edge that took its hash', () => {
    const [converted] = refreshMeasurements(
      [keptShortEdge()],
      [collinear('cm')],
      2,
      {
        force: true,
        unit: 'cm',
        previous: [{ unit: 'mm', bodies: [collinear('mm')] }]
      }
    );
    expect(converted!.status).toBe('current');
    expect(converted!.sourceUnit).toBe('cm');
    expect(converted!.result.value).toBeCloseTo(1, 12);
    expect(converted!.targets[0]!.hash).toBe(fingerprint(1, 2));
  });

  it('is unresolved, not 10 cm, with no old-unit bodies to compare', () => {
    const [converted] = refreshMeasurements(
      [keptShortEdge()],
      [collinear('cm')],
      2,
      { force: true, unit: 'cm' }
    );
    expect(converted!.status).toBe('unresolved');
    expect(converted!.reason).toBe('not-found');
    // The retained number is the reading it was, in the new unit.
    expect(converted!.result.value).toBeCloseTo(1, 12);
    // A later refresh in the same unit cannot land it on the other edge.
    const [later] = refreshMeasurements([converted!], [collinear('cm')], 3, {
      force: true,
      unit: 'cm'
    });
    expect(later!.status).toBe('unresolved');
    expect(later!.result.value).toBeCloseTo(1, 12);
  });
});

/**
 * #2433 re-check: a target's identity is a (hash, unit) pair. Its hash
 * matches directly only in the unit it was captured in, so an undo back to
 * that unit, or a body that returns in it, resolves by hash again. Across a
 * unit change it rebinds only by a unique scaled match, the row's own
 * witness first; otherwise the row is unresolved and keeps its identity.
 */
describe('a target identity kept with the unit it was captured in', () => {
  const BOOLEAN_ID = 'body-boolean' as BodyId;
  const fingerprint = (from: number, to: number) =>
    Math.round(from * 1000 + to);

  function collinear(unit: 'mm' | 'cm'): BodyRepresentation {
    const k = unit === 'cm' ? 0.1 : 1;
    const edge = (from: number, to: number): EdgeTopology => {
      const hash = fingerprint(from * k, to * k);
      return {
        topologyId: `edge:${hash}`,
        hash,
        length: (to - from) * k,
        curve: { type: 'LINE' },
        points: [from * k, 0, 0, to * k, 0, 0]
      };
    };
    return {
      ...box(k),
      bodyId: BOOLEAN_ID,
      name: 'Boolean',
      bbox: {
        min: { x: 10 * k, y: 0, z: 0 },
        max: { x: 200 * k, y: 0, z: 0 }
      },
      topology: { faces: [], edges: [edge(10, 20), edge(100, 200)] }
    };
  }

  function keptShortEdge(): Measurement {
    return createSmartMeasurement(
      collinear('mm'),
      { bodyId: BOOLEAN_ID, kind: 'edge', hash: fingerprint(10, 20) },
      undefined,
      1,
      'mm'
    )!;
  }

  it('recovers by hash after the body returns in the unit it was kept in', () => {
    // Kept, then its body suppressed.
    let rows = refreshMeasurements([keptShortEdge()], [], 2, {
      force: true,
      unit: 'mm'
    });
    expect(rows[0]!.status).toBe('unresolved');
    // Converted to cm with the body still suppressed: nothing to match.
    rows = refreshMeasurements(rows, [], 3, {
      force: true,
      unit: 'cm',
      previous: [{ unit: 'mm', bodies: [] }]
    });
    expect(rows[0]!.status).toBe('unresolved');
    expect(rows[0]!.sourceUnit).toBe('cm');
    // The identity is the millimetre one, and says so.
    expect(rows[0]!.targets[0]!.hash).toBe(fingerprint(10, 20));
    expect(rows[0]!.targets[0]!.identityUnit).toBe('mm');
    // Undo the conversion, then restore the body.
    rows = refreshMeasurements(rows, [], 4, {
      force: true,
      unit: 'mm',
      previous: [{ unit: 'cm', bodies: [] }]
    });
    expect(rows[0]!.status).toBe('unresolved');
    expect(rows[0]!.targets[0]!.identityUnit).toBeUndefined();
    rows = refreshMeasurements(rows, [collinear('mm')], 5, {
      force: true,
      unit: 'mm',
      previous: [{ unit: 'cm', bodies: [] }]
    });
    expect(rows[0]!.status).toBe('current');
    expect(rows[0]!.result.value).toBeCloseTo(10, 12);
    expect(rows[0]!.targets[0]!.hash).toBe(fingerprint(10, 20));
  });

  it('never resolves a hash in another unit, even later', () => {
    // Restored while the document is in cm, with no mm bodies to compare:
    // the old hash names the 10–20 cm edge there, so the row stays
    // unresolved rather than reading 10 cm...
    let rows = refreshMeasurements([keptShortEdge()], [collinear('cm')], 2, {
      force: true,
      unit: 'cm'
    });
    rows = refreshMeasurements(rows, [collinear('cm')], 3, {
      force: true,
      unit: 'cm'
    });
    expect(rows[0]!.status).toBe('unresolved');
    expect(rows[0]!.result.value).toBeCloseTo(1, 12);
    // ...and an undo back to mm resolves it by its own hash.
    rows = refreshMeasurements(rows, [collinear('mm')], 4, {
      force: true,
      unit: 'mm'
    });
    expect(rows[0]!.status).toBe('current');
    expect(rows[0]!.result.value).toBeCloseTo(10, 12);
  });

  it('rebinds once the scaled body returns in the new unit', () => {
    let rows = refreshMeasurements([keptShortEdge()], [], 2, {
      force: true,
      unit: 'cm',
      previous: [{ unit: 'mm', bodies: [collinear('mm')] }]
    });
    expect(rows[0]!.status).toBe('unresolved');
    rows = refreshMeasurements(rows, [collinear('cm')], 3, {
      force: true,
      unit: 'cm',
      previous: [{ unit: 'mm', bodies: [collinear('mm')] }]
    });
    expect(rows[0]!.status).toBe('current');
    expect(rows[0]!.result.value).toBeCloseTo(1, 12);
    expect(rows[0]!.targets[0]!.hash).toBe(fingerprint(1, 2));
    expect(rows[0]!.targets[0]!.identityUnit).toBeUndefined();
  });

  /** One named edge along X, `length` millimetres long, stored in `unit`. */
  function namedEdge(unit: 'mm' | 'cm', length: number): BodyRepresentation {
    const k = unit === 'cm' ? 0.1 : 1;
    const quantum = (value: number) => Math.round(value / 1e-6);
    const to = length * k;
    const hash = Math.round(to * 1000) + (unit === 'cm' ? 500_000 : 0);
    const reference: EdgeTopologyReferenceV5 = {
      kind: 'edge',
      producingFeatureId: 'feat_extrude' as FeatureId,
      lineageName: 'extrude.edge.side',
      currentHash: hash,
      witnessVersion: 1,
      witness: {
        curveType: 'LINE',
        length: quantum(to),
        closed: false,
        endpoints: [
          [0, 0, 0],
          [quantum(to), 0, 0]
        ],
        midpoint: [quantum(to / 2), 0, 0]
      }
    };
    return {
      ...box(k),
      bodyId: BOOLEAN_ID,
      name: 'Extrude',
      bbox: { min: { x: 0, y: 0, z: 0 }, max: { x: to, y: 0, z: 0 } },
      topology: {
        faces: [],
        edges: [
          {
            topologyId: `edge:${hash}`,
            hash,
            reference,
            length: to,
            curve: { type: 'LINE' },
            points: [0, 0, 0, to, 0, 0]
          }
        ]
      }
    };
  }

  function keptNamedEdge(): Measurement {
    const kept = createSmartMeasurement(
      namedEdge('mm', 10),
      { bodyId: BOOLEAN_ID, kind: 'edge', hash: 10_000 },
      undefined,
      1,
      'mm'
    )!;
    expect(kept.targets[0]!.reference).toBeDefined();
    return kept;
  }

  it('prefers the own witness of a row to a cached body that changed since', () => {
    // Kept on a 10 mm edge. While the list was still loading the edge was
    // resized to 20 mm (the bodies the workbench cached in mm), the
    // document converted to cm, and the edge resized back to 1 cm.
    const [converted] = refreshMeasurements(
      [keptNamedEdge()],
      [namedEdge('cm', 10)],
      5,
      {
        force: true,
        unit: 'cm',
        previous: [{ unit: 'mm', bodies: [namedEdge('mm', 20)] }]
      }
    );
    expect(converted!.status).toBe('current');
    expect(converted!.result.value).toBeCloseTo(1, 9);
    expect(converted!.targets[0]!.hash).toBe(
      namedEdge('cm', 10).topology!.edges[0]!.hash
    );
  });

  it('keeps the identity of a row that neither its witness nor a cached body can carry', () => {
    // Converted and resized to 3 cm: neither its witness nor the cached
    // 20 mm body is that edge scaled.
    const [converted] = refreshMeasurements(
      [keptNamedEdge()],
      [namedEdge('cm', 30)],
      5,
      {
        force: true,
        unit: 'cm',
        previous: [{ unit: 'mm', bodies: [namedEdge('mm', 20)] }]
      }
    );
    expect(converted!.status).toBe('unresolved');
    expect(converted!.targets[0]!.hash).toBe(10_000);
    expect(converted!.targets[0]!.reference?.currentHash).toBe(10_000);
    expect(converted!.targets[0]!.identityUnit).toBe('mm');
  });
});
