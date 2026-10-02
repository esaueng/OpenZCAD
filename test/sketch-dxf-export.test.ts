import { beforeAll, describe, expect, it } from 'vitest';

import {
  addPrimitiveFeature,
  addSketchFeature,
  createProjectDocument,
  findSketch,
  holeBody,
  setParameter
} from '@openzcad/document-core';
import {
  createExactKernelAdapter,
  type ExactKernelAdapter
} from '@openzcad/kernel-adapter/exact';
import {
  sketchDxfEntities,
  validateSketchDxfBasis
} from '../packages/kernel-adapter/src/exact-sketch-dxf';
import type { PlaneBasis } from '@openzcad/geometry';
import { toUserId } from '@openzcad/shared';
import type {
  BodyId,
  EntityId,
  FeatureId,
  ProjectDocument,
  SketchId,
  SketchObjectData,
  SketchPlaneRef,
  UnitSystem
} from '@openzcad/shared';

/**
 * Whole-sketch DXF export (D04): exact local-plane LINE/CIRCLE/ARC output,
 * exact rectangle/polygon line expansion, millimetre conversion, construction
 * exclusion, and fail-closed named refusals — all through the existing DXF
 * writer, never a second one.
 */

let adapter: ExactKernelAdapter;

beforeAll(async () => {
  adapter = await createExactKernelAdapter();
});

/** Parse a DXF text into [code, value] pairs for structural assertions. */
function pairs(text: string): Array<[number, string]> {
  const lines = text.split('\r\n').filter((l) => l.length > 0);
  const out: Array<[number, string]> = [];
  for (let i = 0; i < lines.length; i += 2) {
    out.push([Number(lines[i]), lines[i + 1]!]);
  }
  return out;
}

/** Group parsed pairs into entities within the ENTITIES section. */
function entities(
  text: string
): Array<{ type: string; groups: Map<number, string[]> }> {
  const p = pairs(text);
  const startAt = p.findIndex(([c, v]) => c === 2 && v === 'ENTITIES');
  const out: Array<{ type: string; groups: Map<number, string[]> }> = [];
  let current: { type: string; groups: Map<number, string[]> } | undefined;
  for (const [code, value] of p.slice(startAt + 1)) {
    if (code === 0) {
      if (value === 'ENDSEC' || value === 'EOF') {
        break;
      }
      current = { type: value, groups: new Map() };
      out.push(current);
      continue;
    }
    if (current) {
      const bucket = current.groups.get(code) ?? [];
      bucket.push(value);
      current.groups.set(code, bucket);
    }
  }
  return out;
}

const num = (
  entity: { groups: Map<number, string[]> },
  code: number,
  index = 0
): number => Number(entity.groups.get(code)![index]);

function sketchDocument(
  name: string,
  objects: SketchObjectData[],
  planeRef: SketchPlaneRef = { type: 'canonical', plane: 'XY', offset: 0 },
  units: UnitSystem = 'mm'
): { document: ProjectDocument; sketchId: SketchId } {
  const root = createProjectDocument(name, toUserId('user_sketchdxf'), units);
  const { document, sketchId } = addSketchFeature(root, {
    name: 'Sketch',
    planeRef,
    objects
  });
  return { document, sketchId };
}

const line = (
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  extra: Partial<Extract<SketchObjectData, { objectKind: 'line' }>> = {}
): SketchObjectData => ({ objectKind: 'line', x1, y1, x2, y2, ...extra });

async function refuses(
  promise: Promise<string>,
  reason: string
): Promise<void> {
  await expect(promise).rejects.toThrow(reason);
}

describe('exportSketchDxf', { timeout: 120_000 }, () => {
  it('exports a canonical XY rectangle as four exact lines', async () => {
    const { document, sketchId } = sketchDocument('Rect', [
      { objectKind: 'rectangle', width: 32, height: 18, centerX: 0, centerY: 0 }
    ]);
    const text = await adapter.exportSketchDxf(document, sketchId);
    const all = entities(text);
    expect(all.map((e) => e.type)).toEqual(['LINE', 'LINE', 'LINE', 'LINE']);
    // rectangleProfile corner order: (-16,-9) -> (16,-9) -> (16,9) -> (-16,9).
    const corners: Array<[number, number]> = [
      [-16, -9],
      [16, -9],
      [16, 9],
      [-16, 9]
    ];
    all.forEach((entity, index) => {
      const start = corners[index]!;
      const end = corners[(index + 1) % corners.length]!;
      expect([num(entity, 10), num(entity, 20)]).toEqual(start);
      expect([num(entity, 11), num(entity, 21)]).toEqual(end);
    });
  });

  it('preserves local coordinates and orientation on XZ and YZ sketches', async () => {
    for (const plane of ['XZ', 'YZ'] as const) {
      const { document, sketchId } = sketchDocument(
        `${plane} sketch`,
        [
          line(1, 2, 3, 4),
          {
            objectKind: 'arc',
            centerX: 0,
            centerY: 0,
            radius: 5,
            startAngleDeg: 0,
            endAngleDeg: 90
          }
        ],
        { type: 'canonical', plane, offset: 0 }
      );
      const text = await adapter.exportSketchDxf(document, sketchId);
      const all = entities(text);
      expect(all.map((e) => e.type)).toEqual(['LINE', 'ARC']);
      // Sketch-local (u, v) — including XZ's signed local v — never a world
      // projection, so authored values and arc orientation survive verbatim.
      expect([num(all[0]!, 10), num(all[0]!, 20)]).toEqual([1, 2]);
      expect([num(all[0]!, 11), num(all[0]!, 21)]).toEqual([3, 4]);
      expect(num(all[1]!, 40)).toBe(5);
      expect(num(all[1]!, 50)).toBe(0);
      expect(num(all[1]!, 51)).toBe(90);
    }
  });

  it('scales inch and centimetre documents once and declares millimetres', async () => {
    const inchDoc = sketchDocument(
      'Inch',
      [
        line(0, 0, 1, 0),
        { objectKind: 'circle', radius: 2, centerX: 0, centerY: 0 }
      ],
      { type: 'canonical', plane: 'XY', offset: 0 },
      'inch'
    );
    const inchText = await adapter.exportSketchDxf(
      inchDoc.document,
      inchDoc.sketchId
    );
    const inchEntities = entities(inchText);
    expect([num(inchEntities[0]!, 11), num(inchEntities[0]!, 21)]).toEqual([
      25.4, 0
    ]);
    expect(num(inchEntities[1]!, 40)).toBeCloseTo(50.8, 9);

    const cmDoc = sketchDocument(
      'Cm',
      [line(0, 0, 1, 0)],
      { type: 'canonical', plane: 'XY', offset: 0 },
      'cm'
    );
    const cmEntities = entities(
      await adapter.exportSketchDxf(cmDoc.document, cmDoc.sketchId)
    );
    expect([num(cmEntities[0]!, 11), num(cmEntities[0]!, 21)]).toEqual([10, 0]);

    // The header states the millimetre unit the coordinates are written in.
    const header = pairs(inchText);
    expect(header).toContainEqual([1, 'AC1009']);
    expect(header).toContainEqual([70, '4']);
    expect(header).toContainEqual([70, '1']);
  });

  it('keeps circles analytic and arcs directed, converting only raw +360°', async () => {
    const { document, sketchId } = sketchDocument('Arcs', [
      { objectKind: 'circle', radius: 3, centerX: 7, centerY: -2 },
      {
        objectKind: 'arc',
        centerX: 0,
        centerY: 0,
        radius: 4,
        startAngleDeg: 300,
        endAngleDeg: 60
      },
      {
        objectKind: 'arc',
        centerX: 10,
        centerY: 10,
        radius: 2,
        startAngleDeg: 0,
        endAngleDeg: 360
      }
    ]);
    const text = await adapter.exportSketchDxf(document, sketchId);
    const all = entities(text);
    expect(all.map((e) => e.type)).toEqual(['CIRCLE', 'ARC', 'CIRCLE']);
    expect([num(all[0]!, 10), num(all[0]!, 20)]).toEqual([7, -2]);
    expect(num(all[0]!, 40)).toBe(3);
    // An arc crossing 0° keeps its directed counter-clockwise endpoints.
    expect(num(all[1]!, 50)).toBe(300);
    expect(num(all[1]!, 51)).toBe(60);
    // A raw +360° sweep is the same locus as a circle; R12 has no portable
    // full-turn arc.
    expect([num(all[2]!, 10), num(all[2]!, 20)]).toEqual([10, 10]);
    expect(num(all[2]!, 40)).toBe(2);
  });

  it('refuses a zero-sweep arc without emitting a zero-length ARC', async () => {
    const { document, sketchId } = sketchDocument('Flat arc', [
      {
        objectKind: 'arc',
        centerX: 0,
        centerY: 0,
        radius: 4,
        startAngleDeg: 0,
        endAngleDeg: 0
      }
    ]);
    await refuses(
      adapter.exportSketchDxf(document, sketchId),
      'invalid-geometry'
    );
  });

  it('refuses a raw -360° arc that wraps to a zero sweep', async () => {
    const { document, sketchId } = sketchDocument('Wrapped arc', [
      {
        objectKind: 'arc',
        centerX: 0,
        centerY: 0,
        radius: 4,
        startAngleDeg: 300,
        endAngleDeg: -60
      }
    ]);
    await refuses(
      adapter.exportSketchDxf(document, sketchId),
      'invalid-geometry'
    );
  });

  it('expands a polygon to its exact bounded side count, never a polyline', async () => {
    const { document, sketchId } = sketchDocument('Pentagon', [
      { objectKind: 'polygon', sides: 5, radius: 10, centerX: 0, centerY: 0 }
    ]);
    const text = await adapter.exportSketchDxf(document, sketchId);
    const all = entities(text);
    expect(all.map((e) => e.type)).toEqual([
      'LINE',
      'LINE',
      'LINE',
      'LINE',
      'LINE'
    ]);
    expect(all.some((e) => e.type === 'POLYLINE')).toBe(false);
    expect(text).not.toContain('VERTEX');
    // Top-start counter-clockwise: the first vertex sits at (0, 10).
    expect([num(all[0]!, 10), num(all[0]!, 20)]).toEqual([0, 10]);
    // Radius is exact on every vertex (parsed back from 9-decimal text).
    for (const entity of all) {
      for (const [xCode, yCode] of [
        [10, 20],
        [11, 21]
      ] as const) {
        const radius = Math.hypot(num(entity, xCode), num(entity, yCode));
        expect(radius).toBeCloseTo(10, 6);
      }
    }
  });

  it('resolves expression-driven values and refuses unresolved ones wholly', async () => {
    const created = sketchDocument('Params', [
      {
        objectKind: 'line',
        x1: 0,
        y1: 0,
        x2: 'w',
        y2: 0
      }
    ]);
    const sketchId = created.sketchId;
    let document = created.document;
    document = setParameter(document, { name: 'w', expression: '2*5' });
    const resolved = entities(
      await adapter.exportSketchDxf(document, sketchId)
    );
    expect([num(resolved[0]!, 11), num(resolved[0]!, 21)]).toEqual([10, 0]);

    const broken = setParameter(document, { name: 'w', expression: 'bogus +' });
    await refuses(
      adapter.exportSketchDxf(broken, sketchId),
      'parameters-invalid'
    );
  });

  it('omits construction geometry but refuses construction-only sketches', async () => {
    const mixed = sketchDocument('Mixed', [
      line(0, 0, 10, 0),
      {
        objectKind: 'circle',
        radius: 3,
        centerX: 0,
        centerY: 0,
        construction: true
      }
    ]);
    const mixedEntities = entities(
      await adapter.exportSketchDxf(mixed.document, mixed.sketchId)
    );
    expect(mixedEntities.map((e) => e.type)).toEqual(['LINE']);

    const only = sketchDocument('Only construction', [
      line(0, 0, 10, 0, { construction: true })
    ]);
    await refuses(
      adapter.exportSketchDxf(only.document, only.sketchId),
      'construction-only'
    );
  });

  it('refuses a sketch with non-construction text rather than dropping it', async () => {
    const { document, sketchId } = sketchDocument('Texted', [
      line(0, 0, 10, 0),
      {
        objectKind: 'text',
        text: 'HI',
        fontFamily: 'open-sans',
        fontStyle: 'regular',
        size: 5,
        x: 0,
        y: 0
      }
    ]);
    await refuses(
      adapter.exportSketchDxf(document, sketchId),
      'unsupported-object'
    );
  });

  it('refuses unknown object kinds and dangling object ids', async () => {
    const future = sketchDocument('Future', [
      { objectKind: 'spline', points: [] } as unknown as SketchObjectData
    ]);
    await refuses(
      adapter.exportSketchDxf(future.document, future.sketchId),
      'unsupported-object'
    );

    const { document, sketchId } = sketchDocument('Dangling', [
      line(0, 0, 10, 0)
    ]);
    const sketch = findSketch(document, sketchId)!;
    sketch.objectIds = [...sketch.objectIds, 'ent_missing' as EntityId];
    await refuses(
      adapter.exportSketchDxf(document, sketchId),
      'unsupported-object'
    );
  });

  it('refuses an absent sketch id', async () => {
    const { document } = sketchDocument('Present', [line(0, 0, 10, 0)]);
    await refuses(
      adapter.exportSketchDxf(document, 'sketch_missing' as SketchId),
      'sketch-not-found'
    );
  });

  it('refuses a corrupt persisted frame', async () => {
    const { document, sketchId } = sketchDocument(
      'Sheared',
      [line(0, 0, 10, 0)],
      {
        type: 'frame',
        frame: {
          origin: { x: 0, y: 0, z: 0 },
          xAxis: { x: 1, y: 0, z: 0 },
          // Not perpendicular to xAxis: a corrupt persisted frame.
          yAxis: { x: 0.5, y: 1, z: 0 },
          zAxis: { x: 0, y: 0, z: 1 }
        }
      }
    );
    await refuses(
      adapter.exportSketchDxf(document, sketchId),
      'invalid-plane-frame'
    );
  });

  it('refuses a face attachment whose body is gone', async () => {
    const root = createProjectDocument('Stale', toUserId('user_sketchdxf'));
    const { document, sketchId } = addSketchFeature(root, {
      name: 'Detached',
      planeRef: {
        type: 'face',
        bodyId: 'body_missing' as BodyId,
        faceHash: 1,
        faceReference: {
          kind: 'face',
          producingFeatureId: 'feat_missing' as unknown as FeatureId,
          lineageName: 'primitive.face.top',
          currentHash: 1,
          witnessVersion: 1,
          witness: {
            surfaceType: 'plane',
            perimeter: 1,
            centroid: null,
            analytic: { kind: 'none' },
            closure: { u: 'closed', v: 'closed' }
          }
        },
        sourceArea: 1,
        sourceCenter: { x: 0, y: 0, z: 0 },
        sourceNormal: { x: 0, y: 0, z: 1 },
        frame: {
          origin: { x: 0, y: 0, z: 0 },
          xAxis: { x: 1, y: 0, z: 0 },
          yAxis: { x: 0, y: 1, z: 0 },
          zAxis: { x: 0, y: 0, z: 1 }
        }
      },
      objects: [line(0, 0, 10, 0)]
    });
    await refuses(
      adapter.exportSketchDxf(document, sketchId),
      'stale-plane-attachment'
    );
  });

  it('refuses a face attachment that is no longer planar', async () => {
    const document = addPrimitiveFeature(
      createProjectDocument('Bored', toUserId('user_sketchdxf')),
      {
        name: 'Plate',
        primitiveKind: 'box',
        dimensions: { width: 40, depth: 24, height: 10 }
      }
    );
    const bodyId = document.bodyOrder[0]!;
    const synced = await adapter.syncDocument(document);
    const top = synced.bodyRepresentations[bodyId]!.topology!.faces.find(
      (face) => face.geometry?.surfaceType === 'plane'
    )!;
    const bored = holeBody(document, {
      name: 'Bore',
      targetBodyId: bodyId,
      faceHash: top.hash,
      ...(top.reference ? { faceReference: top.reference } : {}),
      style: 'simple',
      diameter: 8,
      depthMode: 'through',
      position: { u: 0, v: 0 }
    });
    const derived = await adapter.syncDocument(bored.document);
    const wall = derived.bodyRepresentations[
      bored.bodyId
    ]!.topology!.faces.find(
      (face) => face.geometry?.surfaceType === 'cylinder'
    )!;
    expect(wall.reference?.kind).toBe('face');
    const geometry = wall.geometry!;
    const { document: withSketch, sketchId } = addSketchFeature(
      { ...bored.document, derived },
      {
        name: 'On the wall',
        planeRef: {
          type: 'face',
          bodyId: bored.bodyId,
          faceHash: wall.hash,
          faceReference:
            wall.reference?.kind === 'face' ? wall.reference : undefined,
          sourceArea: geometry.area,
          sourceCenter: geometry.center,
          sourceNormal: geometry.normal!,
          frame: {
            origin: geometry.centroid ?? geometry.center,
            xAxis: { x: 1, y: 0, z: 0 },
            yAxis: { x: 0, y: 1, z: 0 },
            zAxis: geometry.normal!
          }
        },
        objects: [line(0, 0, 10, 0)]
      }
    );
    await refuses(
      adapter.exportSketchDxf(withSketch, sketchId),
      'stale-plane-attachment'
    );
  });

  it('refuses non-finite, degenerate, oversized, and invalid-side inputs', async () => {
    const cases: Array<{
      name: string;
      objects: SketchObjectData[];
      reason: string;
    }> = [
      {
        name: 'non-finite coordinate',
        objects: [line(0, 0, Number.NaN, 0)],
        reason: 'invalid-geometry'
      },
      {
        name: 'zero-length line',
        objects: [line(5, 5, 5, 5)],
        reason: 'invalid-geometry'
      },
      {
        name: 'zero radius',
        objects: [{ objectKind: 'circle', radius: 0, centerX: 0, centerY: 0 }],
        reason: 'invalid-geometry'
      },
      {
        name: 'negative radius',
        objects: [{ objectKind: 'circle', radius: -2, centerX: 0, centerY: 0 }],
        reason: 'invalid-geometry'
      },
      {
        name: 'negative rectangle dimension',
        objects: [
          {
            objectKind: 'rectangle',
            width: -4,
            height: 2,
            centerX: 0,
            centerY: 0
          }
        ],
        reason: 'invalid-geometry'
      },
      {
        name: 'oversized coordinate the writer cannot serialize',
        objects: [line(0, 0, 1e21, 0)],
        reason: 'writer-refused'
      },
      {
        name: 'two-sided polygon',
        objects: [
          { objectKind: 'polygon', sides: 2, radius: 5, centerX: 0, centerY: 0 }
        ],
        reason: 'invalid-geometry'
      },
      {
        name: 'oversized polygon',
        objects: [
          {
            objectKind: 'polygon',
            sides: 65,
            radius: 5,
            centerX: 0,
            centerY: 0
          }
        ],
        reason: 'invalid-geometry'
      },
      {
        name: 'fractional polygon sides',
        objects: [
          {
            objectKind: 'polygon',
            sides: 4.5,
            radius: 5,
            centerX: 0,
            centerY: 0
          }
        ],
        reason: 'invalid-geometry'
      },
      {
        name: 'arc beyond a full turn',
        objects: [
          {
            objectKind: 'arc',
            centerX: 0,
            centerY: 0,
            radius: 4,
            startAngleDeg: 0,
            endAngleDeg: 720
          }
        ],
        reason: 'invalid-geometry'
      }
    ];
    for (const { name, objects, reason } of cases) {
      const { document, sketchId } = sketchDocument(`Bad: ${name}`, objects);
      await refuses(adapter.exportSketchDxf(document, sketchId), reason);
    }
  });

  it('is deterministic for the same document and object order', async () => {
    const { document, sketchId } = sketchDocument('Stable', [
      line(0, 0, 10, 5),
      { objectKind: 'circle', radius: 3, centerX: 20, centerY: 5 },
      { objectKind: 'rectangle', width: 8, height: 6, centerX: -4, centerY: 2 }
    ]);
    const first = await adapter.exportSketchDxf(document, sketchId);
    const second = await adapter.exportSketchDxf(document, sketchId);
    expect(second).toBe(first);
  });

  it('pins a golden small sketch byte for byte', async () => {
    const { document, sketchId } = sketchDocument('Golden', [
      line(0, 0, 10, 0),
      { objectKind: 'circle', radius: 3, centerX: 20, centerY: 5 },
      {
        objectKind: 'arc',
        centerX: 0,
        centerY: 0,
        radius: 4,
        startAngleDeg: 30,
        endAngleDeg: 120
      }
    ]);
    const text = await adapter.exportSketchDxf(document, sketchId);
    const join = (codes: Array<string | number>): string =>
      `${codes.join('\r\n')}\r\n`;
    const expected = join([
      0,
      'SECTION',
      2,
      'HEADER',
      9,
      '$ACADVER',
      1,
      'AC1009',
      9,
      '$INSUNITS',
      70,
      '4',
      9,
      '$MEASUREMENT',
      70,
      '1',
      0,
      'ENDSEC',
      0,
      'SECTION',
      2,
      'ENTITIES',
      0,
      'LINE',
      8,
      '0',
      10,
      '0',
      20,
      '0',
      30,
      '0',
      11,
      '10',
      21,
      '0',
      31,
      '0',
      0,
      'CIRCLE',
      8,
      '0',
      10,
      '20',
      20,
      '5',
      30,
      '0',
      40,
      '3',
      0,
      'ARC',
      8,
      '0',
      10,
      '0',
      20,
      '0',
      30,
      '0',
      40,
      '4',
      50,
      '30',
      51,
      '120',
      0,
      'ENDSEC',
      0,
      'EOF'
    ]);
    expect(text).toBe(expected);
  });
});

describe('sketchDxfEntities (pure)', () => {
  const unit: PlaneBasis = {
    origin: { x: 0, y: 0, z: 0 },
    u: { x: 1, y: 0, z: 0 },
    v: { x: 0, y: 1, z: 0 },
    normal: { x: 0, y: 0, z: 1 }
  };

  it('records a full-turn arc conversion in the export diagnostic', () => {
    const outcome = sketchDxfEntities({
      objects: [
        {
          id: 'arc-branch',
          data: {
            objectKind: 'arc',
            centerX: 1,
            centerY: 2,
            radius: 3,
            startAngleDeg: 0,
            endAngleDeg: 360
          }
        }
      ],
      scope: {},
      basis: unit,
      millimeterScale: 1
    });
    expect(outcome.status).toBe('ok');
    if (outcome.status !== 'ok') {
      return;
    }
    expect(outcome.entities).toEqual([
      { kind: 'circle', center: [1, 2], radius: 3 }
    ]);
    expect(outcome.diagnostics.join(' ')).toMatch(/arc-branch.*CIRCLE/);
  });

  it('counts excluded construction objects in the diagnostic', () => {
    const outcome = sketchDxfEntities({
      objects: [
        {
          id: 'kept',
          data: { objectKind: 'line', x1: 0, y1: 0, x2: 1, y2: 0 }
        },
        {
          id: 'dropped',
          data: {
            objectKind: 'circle',
            radius: 1,
            centerX: 0,
            centerY: 0,
            construction: true
          }
        }
      ],
      scope: {},
      basis: unit,
      millimeterScale: 1
    });
    expect(outcome.status).toBe('ok');
    if (outcome.status !== 'ok') {
      return;
    }
    expect(outcome.entities).toHaveLength(1);
    expect(outcome.excludedConstructionCount).toBe(1);
    expect(outcome.diagnostics.join(' ')).toMatch(/1 construction/);
  });

  it('validates the basis without emitting anything first', () => {
    const objects = [{ id: 'a', data: line(0, 0, 10, 0) }];
    expect(validateSketchDxfBasis(unit)).toBeNull();
    const corrupt: PlaneBasis[] = [
      { ...unit, u: { x: 2, y: 0, z: 0 } },
      { ...unit, v: { x: 1, y: 0, z: 0 } },
      { ...unit, normal: { x: 0, y: 0, z: -1 } },
      { ...unit, u: { x: Number.NaN, y: 0, z: 0 } }
    ];
    for (const basis of corrupt) {
      expect(validateSketchDxfBasis(basis)?.reason).toBe('invalid-plane-frame');
      const outcome = sketchDxfEntities({
        objects,
        scope: {},
        basis,
        millimeterScale: 1
      });
      expect(outcome.status).toBe('refused');
      if (outcome.status === 'refused') {
        expect(outcome.reason).toBe('invalid-plane-frame');
      }
    }
  });
});
