import { describe, expect, it } from 'vitest';
import { writeDxf } from '@openzcad/io-dxf';
import { computeSketchRegions } from '@openzcad/geometry';
import {
  DxfImportError,
  MAX_DXF_SKETCH_OBJECTS,
  describeDxfCounts,
  dxfSketchImportPlan,
  importDxfSketch
} from '../apps/web/src/lib/dxfImport';
import {
  createProjectDocument,
  findSketch,
  listFeaturesInOrder
} from '@openzcad/document-core';
import { CommandManager } from '@openzcad/command-system';
import { toUserId } from '@openzcad/shared';

/** A DXF with the given header units and raw entity lines (group code/value). */
function dxf(entities: string[], insunits?: number): string {
  const header =
    insunits === undefined
      ? []
      : [
          '0',
          'SECTION',
          '2',
          'HEADER',
          '9',
          '$INSUNITS',
          '70',
          String(insunits),
          '0',
          'ENDSEC'
        ];
  return [
    ...header,
    '0',
    'SECTION',
    '2',
    'ENTITIES',
    ...entities,
    '0',
    'ENDSEC',
    '0',
    'EOF'
  ].join('\n');
}

describe('DXF sketch import (D04)', () => {
  it('reads back what the sketch DXF writer emits, exactly', () => {
    const text = writeDxf([
      { kind: 'line', start: [0, 0], end: [10, 0] },
      { kind: 'circle', center: [5, 5], radius: 2 },
      {
        kind: 'arc',
        center: [0, 0],
        radius: 3,
        startAngleDeg: 270,
        endAngleDeg: 90
      },
      {
        kind: 'polyline',
        points: [
          [0, 0],
          [4, 0],
          [4, 4]
        ],
        closed: true
      }
    ]);
    const result = importDxfSketch(text, 'mm');
    expect(result.sourceUnit).toBe('millimetres');
    expect(result.dropped).toEqual({});
    expect(result.refused).toEqual({});
    expect(result.objects).toEqual([
      { objectKind: 'line', x1: 0, y1: 0, x2: 10, y2: 0 },
      { objectKind: 'circle', centerX: 5, centerY: 5, radius: 2 },
      // The arc keeps its CCW sweep across 0°.
      {
        objectKind: 'arc',
        centerX: 0,
        centerY: 0,
        radius: 3,
        startAngleDeg: 270,
        endAngleDeg: 450
      },
      { objectKind: 'line', x1: 0, y1: 0, x2: 4, y2: 0 },
      { objectKind: 'line', x1: 4, y1: 0, x2: 4, y2: 4 },
      { objectKind: 'line', x1: 4, y1: 4, x2: 0, y2: 0 }
    ]);
  });

  it('turns polyline bulges into the arcs they describe, in either direction', () => {
    // A closed LWPOLYLINE: a 10-wide slot whose ends are semicircles.
    const slot = dxf([
      '0',
      'LWPOLYLINE',
      '90',
      '4',
      '70',
      '1',
      '10',
      '0',
      '20',
      '0',
      '42',
      '0',
      '10',
      '10',
      '20',
      '0',
      '42',
      '1',
      '10',
      '10',
      '20',
      '4',
      '42',
      '0',
      '10',
      '0',
      '20',
      '4',
      '42',
      '1'
    ]);
    const { objects } = importDxfSketch(slot, 'mm');
    expect(objects).toHaveLength(4);
    expect(objects[1]).toMatchObject({
      objectKind: 'arc',
      centerX: 10,
      centerY: 2,
      radius: 2,
      startAngleDeg: 270,
      endAngleDeg: 450
    });
    expect(objects[3]).toMatchObject({
      objectKind: 'arc',
      centerX: 0,
      centerY: 2,
      radius: 2,
      startAngleDeg: 90,
      endAngleDeg: 270
    });
    // It closes into exactly one region a sketch can extrude.
    const regions = computeSketchRegions(
      objects.map((data, index) => ({ id: `o${index}`, data })),
      (value) => Number(value)
    );
    expect(regions).toHaveLength(1);
    expect(regions[0]!.area).toBeCloseTo(10 * 4 + Math.PI * 2 * 2, 6);
    // A negative bulge sweeps clockwise from (0,0) to (4,0): over the top,
    // which the sketch stores as the counter-clockwise arc 0° → 180°.
    const cw = importDxfSketch(
      dxf([
        '0',
        'LWPOLYLINE',
        '90',
        '2',
        '70',
        '0',
        '10',
        '0',
        '20',
        '0',
        '42',
        '-1',
        '10',
        '4',
        '20',
        '0'
      ]),
      'mm'
    ).objects[0]!;
    expect(cw).toMatchObject({
      objectKind: 'arc',
      centerX: 2,
      centerY: 0,
      radius: 2,
      startAngleDeg: 0,
      endAngleDeg: 180
    });
  });

  it('scales declared units into the document units, and reads unitless files as chosen', () => {
    const inch = dxf(['0', 'CIRCLE', '10', '1', '20', '0', '40', '0.5'], 1);
    expect(importDxfSketch(inch, 'mm')).toMatchObject({
      sourceUnit: 'inches',
      objects: [{ centerX: 25.4, centerY: 0, radius: 12.7 }]
    });
    const mm = dxf(['0', 'CIRCLE', '10', '25.4', '20', '0', '40', '12.7'], 4);
    expect(importDxfSketch(mm, 'inch').objects[0]).toMatchObject({
      centerX: 1,
      radius: 0.5
    });
    const unitless = dxf(['0', 'CIRCLE', '10', '2', '20', '0', '40', '1']);
    const asDocument = importDxfSketch(unitless, 'mm');
    expect(asDocument.sourceUnit).toBeNull();
    expect(asDocument.objects[0]).toMatchObject({ centerX: 2, radius: 1 });
    expect(importDxfSketch(unitless, 'mm', 'inch').objects[0]).toMatchObject({
      centerX: 50.8,
      radius: 25.4
    });
    // $INSUNITS 0 is "unitless" too.
    expect(
      importDxfSketch(
        dxf(['0', 'CIRCLE', '10', '2', '20', '0', '40', '1'], 0),
        'mm'
      ).sourceUnit
    ).toBeNull();
  });

  it('drops annotations and refuses what a sketch cannot hold, by type', () => {
    const text = dxf([
      '0',
      'TEXT',
      '10',
      '0',
      '20',
      '0',
      '1',
      'Label',
      '0',
      'TEXT',
      '10',
      '0',
      '20',
      '1',
      '1',
      'Other',
      '0',
      'HATCH',
      '0',
      'ELLIPSE',
      '10',
      '0',
      '20',
      '0',
      '0',
      'SPLINE',
      // A circle drawn on the underside (-Z extrusion) mirrors in 2D.
      '0',
      'CIRCLE',
      '10',
      '1',
      '20',
      '1',
      '40',
      '1',
      '210',
      '0',
      '220',
      '0',
      '230',
      '-1',
      '0',
      'LINE',
      '10',
      '0',
      '20',
      '0',
      '11',
      '1',
      '21',
      '1'
    ]);
    const result = importDxfSketch(text, 'mm');
    expect(result.objects).toEqual([
      { objectKind: 'line', x1: 0, y1: 0, x2: 1, y2: 1 }
    ]);
    expect(result.dropped).toEqual({ TEXT: 2, HATCH: 1 });
    expect(result.refused).toEqual({
      ELLIPSE: 1,
      SPLINE: 1,
      'CIRCLE off the XY plane': 1
    });
    expect(describeDxfCounts(result.dropped)).toBe('2 TEXT, 1 HATCH');
  });

  it.each([
    ['a binary DXF', 'AutoCAD Binary DXF\r\n\u001a\u0000', /binary DXF/],
    ['a file with no ENTITIES section', '0\nEOF\n', /no ENTITIES section/],
    ['a broken group code', '0\nSECTION\nx\nENTITIES\n', /malformed/],
    [
      'an unreadable unit',
      dxf(['0', 'LINE', '10', '0', '20', '0', '11', '1', '21', '1'], 3),
      /\$INSUNITS 3/
    ],
    [
      'a LINE missing its end',
      dxf(['0', 'LINE', '10', '0', '20', '0']),
      /LINE has no usable group 11/
    ]
  ])('refuses %s by name', (_label, text, message) => {
    expect(() => importDxfSketch(text, 'mm')).toThrow(DxfImportError);
    expect(() => importDxfSketch(text, 'mm')).toThrow(message);
  });

  it(`refuses a file with more than ${MAX_DXF_SKETCH_OBJECTS} curves rather than half-reading it`, () => {
    const lines = Array.from({ length: MAX_DXF_SKETCH_OBJECTS + 1 }, (_, i) => [
      '0',
      'LINE',
      '10',
      String(i),
      '20',
      '0',
      '11',
      String(i),
      '21',
      '1'
    ]).flat();
    expect(() => importDxfSketch(dxf(lines), 'mm')).toThrow(/more than 2000/);
  });
});

describe('DXF geometry that is not on Top is refused, never flattened', () => {
  it('refuses elevated and fitted entities and keeps what lies on z = 0', () => {
    const at = (code: string, value: string) => [code, value];
    const text = dxf(
      [
        // On the XY plane: kept.
        ['0', 'LINE'],
        at('10', '0'),
        at('20', '0'),
        at('30', '0'),
        at('11', '1'),
        at('21', '0'),
        at('31', '0'),
        // A LINE rising off the plane.
        ['0', 'LINE'],
        at('10', '0'),
        at('20', '0'),
        at('30', '0'),
        at('11', '1'),
        at('21', '0'),
        at('31', '5'),
        // A CIRCLE at elevation 2.
        ['0', 'CIRCLE'],
        at('10', '0'),
        at('20', '0'),
        at('30', '2'),
        at('40', '1'),
        // An LWPOLYLINE with elevation 3.
        ['0', 'LWPOLYLINE'],
        at('90', '2'),
        at('70', '0'),
        at('38', '3'),
        at('10', '0'),
        at('20', '0'),
        at('10', '1'),
        at('20', '1'),
        // A curve-fitted classic POLYLINE and its vertices.
        ['0', 'POLYLINE'],
        at('66', '1'),
        at('70', '2'),
        ['0', 'VERTEX'],
        at('10', '0'),
        at('20', '0'),
        ['0', 'VERTEX'],
        at('10', '1'),
        at('20', '1'),
        ['0', 'SEQEND'],
        // A flat-flagged POLYLINE whose vertex sits at z = 4.
        ['0', 'POLYLINE'],
        at('66', '1'),
        at('70', '0'),
        ['0', 'VERTEX'],
        at('10', '0'),
        at('20', '0'),
        at('30', '0'),
        ['0', 'VERTEX'],
        at('10', '1'),
        at('20', '1'),
        at('30', '4'),
        ['0', 'SEQEND']
      ].flat()
    );
    const result = importDxfSketch(text, 'mm');
    expect(result.objects).toEqual([
      { objectKind: 'line', x1: 0, y1: 0, x2: 1, y2: 0 }
    ]);
    expect(result.refused).toEqual({
      'LINE off the XY plane': 1,
      'CIRCLE off the XY plane': 1,
      'LWPOLYLINE off the XY plane': 1,
      'POLYLINE (curve-fit or spline-fit)': 1,
      'POLYLINE off the XY plane': 1
    });
  });

  it.each(['CIRCLE', 'ARC'])('refuses a %s with no positive radius', (type) => {
    const text = dxf([
      '0',
      type,
      '10',
      '0',
      '20',
      '0',
      '40',
      '0',
      '50',
      '0',
      '51',
      '90'
    ]);
    expect(() => importDxfSketch(text, 'mm')).toThrow(
      `This DXF is malformed: a ${type} has a radius of 0.`
    );
  });
});

describe('DXF inputs that would corrupt the sketch refuse by name', () => {
  it('refuses coordinates that overflow when converted into the document units', () => {
    const text = dxf(['0', 'CIRCLE', '10', '1e308', '20', '0', '40', '1'], 1);
    expect(() => importDxfSketch(text, 'mm')).toThrow(
      'This DXF has coordinates too large to convert into the document units.'
    );
  });

  it.each([
    [
      'fewer vertices than group 90 declares',
      ['90', '3', '70', '0', '10', '0', '20', '0', '10', '1', '20', '0']
    ],
    [
      'a trailing X with no Y',
      [
        '90',
        '2',
        '70',
        '0',
        '10',
        '0',
        '20',
        '0',
        '10',
        '1',
        '20',
        '0',
        '10',
        '5'
      ]
    ]
  ])('refuses a LWPOLYLINE with %s', (_label, groups) => {
    expect(() =>
      importDxfSketch(dxf(['0', 'LWPOLYLINE', ...groups]), 'mm')
    ).toThrow('a LWPOLYLINE has an incomplete or unusable vertex list');
  });

  it('stops one huge polyline at the curve cap with the named refusal', () => {
    const count = 150_000;
    const groups = ['90', String(count), '70', '0'];
    for (let i = 0; i < count; i += 1)
      groups.push('10', String(i), '20', String(i % 2));
    expect(() =>
      importDxfSketch(dxf(['0', 'LWPOLYLINE', ...groups]), 'mm')
    ).toThrow(/more than 2000 curves/);
  });
});

describe('DXF sketch import plan', () => {
  const doc = (units: 'mm' | 'inch' = 'mm') =>
    createProjectDocument('DXF', toUserId('user_dxf'), units);

  it('commits one undoable sketch on Top named after the file, and says what it read', () => {
    const text = dxf(
      [
        '0',
        'CIRCLE',
        '10',
        '1',
        '20',
        '0',
        '40',
        '0.5',
        '0',
        'LINE',
        '10',
        '0',
        '20',
        '0',
        '11',
        '1',
        '21',
        '0',
        '0',
        'TEXT',
        '10',
        '0',
        '20',
        '0',
        '1',
        'Note',
        '0',
        'SPLINE'
      ],
      1
    );
    const base = doc();
    const plan = dxfSketchImportPlan(base, 'bracket.DXF', text, (n) => n);
    expect(plan.status).toBe(
      'Imported 2 curves from bracket.DXF as sketch "bracket", converted from inches · left out 1 TEXT; could not sketch 1 SPLINE.'
    );
    const manager = new CommandManager(base);
    manager.execute(plan.command);
    const feature = listFeaturesInOrder(manager.document).at(-1)!;
    expect(feature.name).toBe('bracket');
    if (feature.data.featureKind !== 'sketch') throw new Error('not a sketch');
    const sketch = findSketch(manager.document, feature.data.sketchId)!;
    expect(sketch.planeRef).toMatchObject({ type: 'canonical', plane: 'XY' });
    expect(sketch.objectIds).toHaveLength(2);
    manager.undo();
    expect(listFeaturesInOrder(manager.document)).toHaveLength(0);
  });

  it('says how a unitless file was read', () => {
    const plan = dxfSketchImportPlan(
      doc('inch'),
      'outline.dxf',
      dxf(['0', 'CIRCLE', '10', '0', '20', '0', '40', '1']),
      (n) => n
    );
    expect(plan.status).toBe(
      'Imported 1 curve from outline.dxf as sketch "outline"; it declares no units, so they were read as inches.'
    );
  });

  it('refuses a file with nothing to sketch, saying what it had instead', () => {
    expect(() =>
      dxfSketchImportPlan(
        doc(),
        'notes.dxf',
        dxf(['0', 'TEXT', '1', 'a', '0', 'ELLIPSE']),
        (n) => n
      )
    ).toThrow(
      'notes.dxf has no lines, arcs, circles or polylines to sketch (only 1 TEXT, 1 ELLIPSE).'
    );
  });
});
