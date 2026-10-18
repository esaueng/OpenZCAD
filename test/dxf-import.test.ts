import { describe, expect, it } from 'vitest';
import { writeDxf } from '@openzcad/io-dxf';
import { computeSketchRegions } from '@openzcad/geometry';
import {
  DxfImportError,
  MAX_DXF_SKETCH_OBJECTS,
  MAX_DXF_ENTITIES,
  MAX_DXF_PAIRS,
  describeDxfCounts,
  dxfSketchImportPlan,
  importDxfSketch,
  MAX_DXF_IMPORT_BYTES,
  refuseOversizedDxf
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
  const line = ['0', 'LINE', '10', '0', '20', '0', '11', '1', '21', '0'];
  const circle = ['0', 'CIRCLE', '10', '0', '20', '0', '40', '1'];
  const arc = [
    '0',
    'ARC',
    '10',
    '0',
    '20',
    '0',
    '40',
    '1',
    '50',
    '0',
    '51',
    '90'
  ];
  const lwPolyline = [
    '0',
    'LWPOLYLINE',
    '90',
    '2',
    '10',
    '0',
    '20',
    '0',
    '10',
    '1',
    '20',
    '0'
  ];
  const vertex = ['0', 'VERTEX', '10', '0', '20', '0'];
  const endVertex = ['0', 'VERTEX', '10', '1', '20', '0'];

  it.each([
    ['LINE start Z', 'LINE', (z: string) => [...line, '30', z]],
    ['LINE end Z', 'LINE', (z: string) => [...line, '31', z]],
    ['CIRCLE Z', 'CIRCLE', (z: string) => [...circle, '30', z]],
    ['ARC Z', 'ARC', (z: string) => [...arc, '30', z]],
    [
      'LWPOLYLINE elevation',
      'LWPOLYLINE',
      (z: string) => [...lwPolyline, '38', z]
    ],
    [
      'POLYLINE elevation',
      'POLYLINE',
      (z: string) => [
        '0',
        'POLYLINE',
        '30',
        z,
        ...vertex,
        ...endVertex,
        '0',
        'SEQEND'
      ]
    ],
    [
      'first VERTEX Z',
      'POLYLINE',
      (z: string) => [
        '0',
        'POLYLINE',
        ...vertex,
        '30',
        z,
        ...endVertex,
        '0',
        'SEQEND'
      ]
    ],
    [
      'last VERTEX Z',
      'POLYLINE',
      (z: string) => [
        '0',
        'POLYLINE',
        ...vertex,
        ...endVertex,
        '30',
        z,
        '0',
        'SEQEND'
      ]
    ]
  ] as const)(
    'refuses nonzero %s without losing the next entity',
    (_label, type, entity) => {
      for (const z of ['2', '-2', '5e-10', '-5e-10']) {
        const result = importDxfSketch(dxf([...entity(z), ...line]), 'mm');
        expect(result.objects).toEqual([
          { objectKind: 'line', x1: 0, y1: 0, x2: 1, y2: 0 }
        ]);
        expect(result.refused).toEqual({ [`${type} off the XY plane`]: 1 });
        expect(result.dropped).toEqual({});
      }
      for (const z of ['0', '-0']) {
        const result = importDxfSketch(dxf(entity(z)), 'mm');
        expect(result.objects).toHaveLength(1);
        expect(result.refused).toEqual({});
      }
    }
  );

  it.each([2, 4, 3, 5, 6])(
    'refuses fitted POLYLINE flags %i before expanding vertices',
    (flags) => {
      const result = importDxfSketch(
        dxf([
          '0',
          'POLYLINE',
          '70',
          String(flags),
          ...vertex,
          ...endVertex,
          '0',
          'SEQEND',
          ...line
        ]),
        'mm'
      );
      expect(result.objects).toEqual([
        { objectKind: 'line', x1: 0, y1: 0, x2: 1, y2: 0 }
      ]);
      expect(result.refused).toEqual({
        'POLYLINE (curve-fit or spline-fit)': 1
      });
    }
  );

  it.each([1, 8, 16, 9, 18])(
    'refuses fitted VERTEX flags %i even without parent fit flags',
    (flags) => {
      for (const parentFlags of [[], ['70', '0']]) {
        // The fitted vertex comes last: no earlier segment may be imported.
        const result = importDxfSketch(
          dxf([
            '0',
            'POLYLINE',
            ...parentFlags,
            ...vertex,
            ...endVertex,
            '0',
            'VERTEX',
            '10',
            '2',
            '20',
            '1',
            '70',
            String(flags),
            '0',
            'SEQEND',
            ...line
          ]),
          'mm'
        );
        expect(result.objects).toEqual([
          { objectKind: 'line', x1: 0, y1: 0, x2: 1, y2: 0 }
        ]);
        expect(result.refused).toEqual({
          'POLYLINE (curve-fit or spline-fit)': 1
        });
      }
    }
  );

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
    for (const value of ['0', '-0', '-2', '-5e-10']) {
      const text = dxf([
        ...line,
        '0',
        type,
        '10',
        '0',
        '20',
        '0',
        '40',
        value,
        '50',
        '0',
        '51',
        '90'
      ]);
      expect(() => importDxfSketch(text, 'mm')).toThrow(DxfImportError);
      expect(() => importDxfSketch(text, 'mm')).toThrow(
        `This DXF is malformed: a ${type} has a radius of ${Number(value)}.`
      );
    }
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
    ],
    [
      'a second X before the first found its Y',
      [
        '90',
        '2',
        '70',
        '0',
        '10',
        '0',
        '10',
        '9',
        '20',
        '0',
        '10',
        '1',
        '20',
        '0'
      ]
    ],
    [
      'a Y with no X',
      [
        '90',
        '2',
        '70',
        '0',
        '10',
        '0',
        '20',
        '0',
        '20',
        '7',
        '10',
        '1',
        '20',
        '0'
      ]
    ]
  ])('refuses a LWPOLYLINE with %s', (_label, groups) => {
    expect(() =>
      importDxfSketch(dxf(['0', 'LWPOLYLINE', ...groups]), 'mm')
    ).toThrow('a LWPOLYLINE has an incomplete or unusable vertex list');
  });

  it('keeps small geometry exact when fine units scale into a large document unit', () => {
    // 1e5 microinches is 2.54 mm: small in metres, and kept exactly.
    const text = dxf(
      ['0', 'CIRCLE', '10', '100000', '20', '0', '40', '100000'],
      8
    );
    expect(importDxfSketch(text, 'm').objects[0]).toMatchObject({
      centerX: 0.00254,
      radius: 0.00254
    });
  });

  it('refuses a curve that converts to nothing rather than a zero radius', () => {
    // One that underflows to zero in the document units refuses by name;
    // one merely below the sketch's tolerance refuses as unusable.
    const small = dxf(['0', 'CIRCLE', '10', '0', '20', '0', '40', '1e-10']);
    expect(() => importDxfSketch(small, 'mm')).toThrow(
      'too small for the sketch to use'
    );
    const underflow = dxf(
      ['0', 'CIRCLE', '10', '0', '20', '0', '40', '1e-320'],
      8
    );
    expect(() => importDxfSketch(underflow, 'm')).toThrow(
      'geometry too small to represent'
    );
  });

  it('converts an arc and the line it meets the same way, leaving no gap', () => {
    // A quarter arc of radius 0.1234567 m ending on (0, 0.1234567), and a
    // line from there, in a metre drawing imported into millimetres.
    const r = '0.1234567';
    const { objects } = importDxfSketch(
      dxf(
        [
          '0',
          'ARC',
          '10',
          '0',
          '20',
          '0',
          '40',
          r,
          '50',
          '0',
          '51',
          '90',
          '0',
          'LINE',
          '10',
          '0',
          '20',
          r,
          '11',
          '-1',
          '21',
          r
        ],
        6
      ),
      'mm'
    );
    const [arc, line] = objects as unknown as [
      { centerY: number; radius: number },
      { y1: number }
    ];
    expect(arc.centerY + arc.radius).toBe(line.y1);
  });

  it('refuses an ARC sweep the sketch would drop, and keeps a large-radius endpoint exact', () => {
    const text = dxf([
      '0',
      'ARC',
      '10',
      '0',
      '20',
      '0',
      '40',
      '1',
      '50',
      '0',
      '51',
      '4e-10'
    ]);
    // A 4e-10° sweep is under the sketch's 1e-9 rad cutoff: its region
    // builder would drop it, so the import refuses it instead.
    expect(() => importDxfSketch(text, 'mm')).toThrow(
      'too small for the sketch to use'
    );
    // Radius 1e9: a 4e-10° start is 7 mm of arc, so it is not rounded away.
    const large = dxf([
      '0',
      'ARC',
      '10',
      '0',
      '20',
      '0',
      '40',
      '1e9',
      '50',
      '4e-10',
      '51',
      '90'
    ]);
    expect(importDxfSketch(large, 'mm').objects[0]).toMatchObject({
      startAngleDeg: 4e-10
    });
  });

  it('refuses a zero-length LINE instead of quietly dropping it', () => {
    const text = dxf([
      '0',
      'LINE',
      '10',
      '0',
      '20',
      '0',
      '11',
      '5',
      '21',
      '0',
      '0',
      'LINE',
      '10',
      '1',
      '20',
      '1',
      '11',
      '1',
      '21',
      '1'
    ]);
    expect(() => importDxfSketch(text, 'mm')).toThrow('endpoints coincide');
  });

  it('refuses wide polylines rather than importing only their centreline', () => {
    const result = importDxfSketch(
      dxf([
        '0',
        'LWPOLYLINE',
        '90',
        '2',
        '43',
        '0.5',
        '10',
        '0',
        '20',
        '0',
        '10',
        '5',
        '20',
        '0',
        '0',
        'POLYLINE',
        '70',
        '0',
        '0',
        'VERTEX',
        '10',
        '0',
        '20',
        '0',
        '40',
        '1',
        '41',
        '1',
        '0',
        'VERTEX',
        '10',
        '5',
        '20',
        '0',
        '0',
        'SEQEND',
        '0',
        'CIRCLE',
        '10',
        '0',
        '20',
        '0',
        '40',
        '1'
      ]),
      'mm'
    );
    expect(result.objects).toHaveLength(1);
    expect(result.refused).toEqual({
      'LWPOLYLINE with width': 1,
      'POLYLINE with width': 1
    });
  });

  it('keeps a near-full bulge an arc through its endpoints, or refuses it', () => {
    const near = (bulge: string) =>
      dxf([
        '0',
        'LWPOLYLINE',
        '90',
        '2',
        '10',
        '0',
        '20',
        '0',
        '42',
        bulge,
        '10',
        '1',
        '20',
        '0'
      ]);
    const arc = importDxfSketch(near('1000'), 'mm').objects[0] as Record<
      string,
      unknown
    >;
    expect(arc).toMatchObject({ objectKind: 'arc' });
    expect(Number(arc.radius)).toBeCloseTo(250.00025, 6);
    expect(Number(arc.endAngleDeg) - Number(arc.startAngleDeg)).toBeLessThan(
      360
    );
    expect(() => importDxfSketch(near('1e16'), 'mm')).toThrow(
      'bulge too extreme'
    );
  });

  it('refuses a tiny nonzero bulge rather than flattening it or opening gaps', () => {
    const text = dxf([
      '0',
      'LWPOLYLINE',
      '90',
      '2',
      '10',
      '0',
      '20',
      '0',
      '42',
      '5e-13',
      '10',
      '1000000',
      '20',
      '0'
    ]);
    // Its centre is so far away that stored angles could not rebuild the
    // ends: refused rather than imported with gaps.
    expect(() => importDxfSketch(text, 'mm')).toThrow(
      'could not keep its endpoints'
    );
  });

  it('refuses entities with thickness or any tilt as off the XY plane', () => {
    const result = importDxfSketch(
      dxf([
        '0',
        'CIRCLE',
        '10',
        '0',
        '20',
        '0',
        '40',
        '1',
        '39',
        '5',
        '0',
        'CIRCLE',
        '10',
        '1e12',
        '20',
        '0',
        '40',
        '1',
        '210',
        '5e-10',
        '220',
        '0',
        '230',
        '1',
        '0',
        'CIRCLE',
        '10',
        '0',
        '20',
        '0',
        '40',
        '2',
        '39',
        '0',
        '210',
        '0',
        '220',
        '0',
        '230',
        '1'
      ]),
      'mm'
    );
    expect(result.objects).toHaveLength(1);
    expect(result.refused).toEqual({ 'CIRCLE off the XY plane': 2 });
  });

  it('refuses a zero-sweep ARC rather than turning it into a full turn', () => {
    const text = dxf([
      '0',
      'ARC',
      '10',
      '0',
      '20',
      '0',
      '40',
      '1',
      '50',
      '45',
      '51',
      '405'
    ]);
    expect(() => importDxfSketch(text, 'mm')).toThrow(
      'its sweep rounds to zero'
    );
  });

  it('keeps large coordinates exact through unit conversion', () => {
    const big = dxf([
      '0',
      'CIRCLE',
      '10',
      '1000000000001234',
      '20',
      '0',
      '40',
      '1'
    ]);
    expect(importDxfSketch(big, 'mm').objects[0]).toMatchObject({
      centerX: 1000000000001234
    });
    const metres = importDxfSketch(big, 'm', 'mm').objects[0] as {
      centerX: number;
    };
    expect(metres.centerX).toBeCloseTo(1000000000001.234, 3);
  });

  it('refuses spans and coordinates too large to keep finite downstream', () => {
    const overflow = dxf([
      '0',
      'LINE',
      '10',
      '-1e308',
      '20',
      '0',
      '11',
      '1e308',
      '21',
      '0'
    ]);
    expect(() => importDxfSketch(overflow, 'mm')).toThrow(
      'coordinates too large'
    );
    const huge = dxf(['0', 'CIRCLE', '10', '1e200', '20', '0', '40', '1']);
    expect(() => importDxfSketch(huge, 'mm')).toThrow('coordinates too large');
  });

  it('refuses LWPOLYLINE bulges that belong to no single vertex', () => {
    const lw = (groups: string[]) =>
      dxf(['0', 'LWPOLYLINE', '90', '2', ...groups]);
    const cases = [
      ['42', '1', '10', '0', '20', '0', '10', '1', '20', '0'],
      ['10', '0', '20', '0', '42', '1', '42', '0.5', '10', '1', '20', '0'],
      ['10', '0', '42', '1', '20', '0', '10', '1', '20', '0']
    ];
    for (const groups of cases) {
      expect(() => importDxfSketch(lw(groups), 'mm')).toThrow(
        'incomplete or unusable vertex list'
      );
    }
  });

  it('refuses filler before it expands past the pair and entity caps', () => {
    const filler = (count: number) => '0\nX\n'.repeat(count);
    expect(() =>
      importDxfSketch(
        `0\nSECTION\n2\nENTITIES\n${filler(MAX_DXF_PAIRS)}0\nENDSEC\n0\nEOF\n`,
        'mm'
      )
    ).toThrow('too many entries');
    expect(() =>
      importDxfSketch(
        `0\nSECTION\n2\nENTITIES\n${filler(MAX_DXF_ENTITIES + 1)}0\nENDSEC\n0\nEOF\n`,
        'mm'
      )
    ).toThrow(`more than ${MAX_DXF_ENTITIES} entities`);
  });

  it('refuses a near-full bulge on a vanishing chord, and judges length in document units', () => {
    const text = dxf([
      '0',
      'LWPOLYLINE',
      '90',
      '2',
      '10',
      '0',
      '20',
      '0',
      '42',
      '1e12',
      '10',
      '5e-13',
      '20',
      '0',
      '0',
      'CIRCLE',
      '10',
      '0',
      '20',
      '0',
      '40',
      '1'
    ]);
    // Its gap is far inside the sketch's closed-circle tolerance, so it
    // would become a circle: refused rather than closed.
    expect(() => importDxfSketch(text, 'mm')).toThrow('bulge too extreme');
    // The same physical 5e-10 mm line imports whether it was drawn in mm or
    // in metres: the unit declaration never changes eligibility.
    const line = (length: string) => [
      '0',
      'LINE',
      '10',
      '0',
      '20',
      '0',
      '11',
      length,
      '21',
      '0'
    ];
    const inMm = importDxfSketch(dxf(line('0.5'), 4), 'mm').objects[0];
    const inM = importDxfSketch(dxf(line('0.0005'), 6), 'mm').objects[0];
    expect(inMm).toMatchObject({ x2: 0.5 });
    expect((inM as unknown as { x2: number }).x2).toBeCloseTo(0.5, 12);
    // Below the sketch's tolerance it refuses the same way in either unit.
    expect(() => importDxfSketch(dxf(line('5e-10'), 4), 'mm')).toThrow(
      'too small for the sketch to use'
    );
    expect(() => importDxfSketch(dxf(line('5e-13'), 6), 'mm')).toThrow(
      'too small for the sketch to use'
    );
    // A bulge on a repeated vertex still refuses.
    expect(() =>
      importDxfSketch(
        dxf([
          '0',
          'LWPOLYLINE',
          '90',
          '2',
          '10',
          '1',
          '20',
          '1',
          '42',
          '1',
          '10',
          '1',
          '20',
          '1'
        ]),
        'mm'
      )
    ).toThrow('segment too short to represent');
  });

  it('refuses a POLYLINE whose vertices are 3D or mesh records', () => {
    for (const flag of ['32', '64', '128']) {
      const result = importDxfSketch(
        dxf([
          '0',
          'POLYLINE',
          '70',
          '0',
          '0',
          'VERTEX',
          '10',
          '0',
          '20',
          '0',
          '70',
          flag,
          '0',
          'VERTEX',
          '10',
          '5',
          '20',
          '0',
          '70',
          flag,
          '0',
          'SEQEND',
          '0',
          'CIRCLE',
          '10',
          '0',
          '20',
          '0',
          '40',
          '1'
        ]),
        'mm'
      );
      expect(result.objects).toHaveLength(1);
      expect(result.refused).toEqual({ 'POLYLINE (3D or mesh)': 1 });
    }
  });

  it('requires exactly one LWPOLYLINE vertex count', () => {
    const square = [
      '10',
      '0',
      '20',
      '0',
      '10',
      '1',
      '20',
      '0',
      '10',
      '1',
      '20',
      '1'
    ];
    for (const counts of [[], ['90', '3', '90', '3']]) {
      expect(() =>
        importDxfSketch(dxf(['0', 'LWPOLYLINE', ...counts, ...square]), 'mm')
      ).toThrow('incomplete or unusable vertex list');
    }
    expect(
      importDxfSketch(dxf(['0', 'LWPOLYLINE', '90', '3', ...square]), 'mm')
        .objects
    ).toHaveLength(2);
  });

  it('refuses a POLYLINE with no SEQEND, or with the mesh N-closed flag', () => {
    const vertices = [
      '0',
      'VERTEX',
      '10',
      '0',
      '20',
      '0',
      '0',
      'VERTEX',
      '10',
      '5',
      '20',
      '0'
    ];
    expect(() =>
      importDxfSketch(
        dxf([
          '0',
          'POLYLINE',
          '70',
          '0',
          ...vertices,
          '0',
          'CIRCLE',
          '10',
          '0',
          '20',
          '0',
          '40',
          '1'
        ]),
        'mm'
      )
    ).toThrow('no SEQEND');
    expect(() =>
      importDxfSketch(dxf(['0', 'POLYLINE', '70', '0', ...vertices]), 'mm')
    ).toThrow('no SEQEND');
    const mesh = importDxfSketch(
      dxf([
        '0',
        'POLYLINE',
        '70',
        '32',
        ...vertices,
        '0',
        'SEQEND',
        '0',
        'CIRCLE',
        '10',
        '0',
        '20',
        '0',
        '40',
        '1'
      ]),
      'mm'
    );
    expect(mesh.refused).toEqual({ 'POLYLINE (3D or mesh)': 1 });
  });

  it('leaves paper-space entities out of the sketch', () => {
    const result = importDxfSketch(
      dxf([
        '0',
        'LINE',
        '67',
        '1',
        '10',
        '0',
        '20',
        '0',
        '11',
        '100',
        '21',
        '0',
        '0',
        'CIRCLE',
        '67',
        '0',
        '10',
        '0',
        '20',
        '0',
        '40',
        '1'
      ]),
      'mm'
    );
    expect(result.objects).toEqual([
      expect.objectContaining({ objectKind: 'circle' })
    ]);
    expect(result.dropped).toEqual({ 'LINE in paper space': 1 });
  });

  it('refuses fractional or out-of-range flag groups', () => {
    const lw = (flags: string) =>
      dxf([
        '0',
        'LWPOLYLINE',
        '90',
        '2',
        '70',
        flags,
        '10',
        '0',
        '20',
        '0',
        '10',
        '1',
        '20',
        '0'
      ]);
    for (const flags of ['1.5', '70000']) {
      expect(() => importDxfSketch(lw(flags), 'mm')).toThrow(
        'unusable group 70 value'
      );
    }
  });

  it('keeps a tiny negative arc angle instead of wrapping it to 0', () => {
    const arc = (start: string, end: string) =>
      importDxfSketch(
        dxf([
          '0',
          'ARC',
          '10',
          '0',
          '20',
          '0',
          '40',
          '1e15',
          '50',
          start,
          '51',
          end
        ]),
        'mm'
      ).objects[0] as unknown as { startAngleDeg: number; endAngleDeg: number };
    expect(arc('-1e-14', '90')).toMatchObject({
      startAngleDeg: -1e-14,
      endAngleDeg: 90
    });
    // A tiny negative end keeps its digits too; the turn goes on the start.
    const late = arc('10', '-1e-14');
    expect(late.endAngleDeg).toBe(-1e-14);
    expect(late.endAngleDeg - late.startAngleDeg).toBeCloseTo(350, 9);
  });

  it('refuses a near-full arc whose gap a turn would round away', () => {
    const text = dxf([
      '0',
      'ARC',
      '10',
      '0',
      '20',
      '0',
      '40',
      '1e15',
      '50',
      '1e-14',
      '51',
      '-1e-14'
    ]);
    expect(() => importDxfSketch(text, 'mm')).toThrow(
      'would close into a full turn'
    );
  });

  it('refuses an entity that repeats a scalar group', () => {
    const line = dxf([
      '0',
      'LINE',
      '10',
      '0',
      '10',
      '3',
      '20',
      '0',
      '11',
      '5',
      '21',
      '0'
    ]);
    expect(() => importDxfSketch(line, 'mm')).toThrow(
      'a LINE repeats group 10'
    );
    const vertex = dxf([
      '0',
      'POLYLINE',
      '70',
      '0',
      '0',
      'VERTEX',
      '10',
      '0',
      '20',
      '0',
      '42',
      '1',
      '42',
      '0.5',
      '0',
      'VERTEX',
      '10',
      '5',
      '20',
      '0',
      '0',
      'SEQEND'
    ]);
    expect(() => importDxfSketch(vertex, 'mm')).toThrow(
      'a VERTEX repeats group 42'
    );
  });

  it('refuses a repeated $INSUNITS or a repeated section', () => {
    const circle = ['0', 'CIRCLE', '10', '0', '20', '0', '40', '1'];
    const header = [
      '0',
      'SECTION',
      '2',
      'HEADER',
      '9',
      '$INSUNITS',
      '70',
      '1',
      '9',
      '$INSUNITS',
      '70',
      '4',
      '0',
      'ENDSEC'
    ];
    expect(() =>
      importDxfSketch([...header, dxf(circle)].join('\n'), 'mm')
    ).toThrow('declares $INSUNITS twice');
    const one = dxf(circle).replace(/\n0\nEOF\s*$/, '');
    const twice = `${one}\n${dxf(circle)}`;
    expect(() => importDxfSketch(twice, 'mm')).toThrow('two ENTITIES sections');
    // Two whole files pasted together also carry an EOF in the middle.
    expect(() =>
      importDxfSketch(`${dxf(circle)}\n${dxf(circle)}`, 'mm')
    ).toThrow('records after EOF');
  });

  it('refuses VERTEX or SEQEND records with no owning POLYLINE', () => {
    const orphan = dxf([
      '0',
      'VERTEX',
      '10',
      '0',
      '20',
      '0',
      '0',
      'VERTEX',
      '10',
      '5',
      '20',
      '0',
      '0',
      'SEQEND',
      '0',
      'CIRCLE',
      '10',
      '0',
      '20',
      '0',
      '40',
      '1'
    ]);
    expect(() => importDxfSketch(orphan, 'mm')).toThrow(
      'a VERTEX has no POLYLINE owning it'
    );
    // An INSERT's own attribute sequence is consumed with it, not refused.
    const insert = importDxfSketch(
      dxf([
        '0',
        'INSERT',
        '66',
        '1',
        '2',
        'TITLE',
        '10',
        '0',
        '20',
        '0',
        '0',
        'ATTRIB',
        '10',
        '0',
        '20',
        '0',
        '1',
        'A',
        '0',
        'SEQEND',
        '0',
        'CIRCLE',
        '10',
        '0',
        '20',
        '0',
        '40',
        '1'
      ]),
      'mm'
    );
    expect(insert.objects).toHaveLength(1);
    expect(insert.dropped).toEqual({ INSERT: 1 });
    // An ATTRIB whose INSERT was lost is refused like an orphaned VERTEX.
    const loose = dxf([
      '0',
      'ATTRIB',
      '10',
      '0',
      '20',
      '0',
      '1',
      'A',
      '0',
      'CIRCLE',
      '10',
      '0',
      '20',
      '0',
      '40',
      '1'
    ]);
    expect(() => importDxfSketch(loose, 'mm')).toThrow(
      'an ATTRIB has no INSERT owning it'
    );
  });

  it('refuses an $INSUNITS declaration that carries two values', () => {
    const header = [
      '0',
      'SECTION',
      '2',
      'HEADER',
      '9',
      '$INSUNITS',
      '70',
      '4',
      '70',
      '1',
      '9',
      '$MEASUREMENT',
      '70',
      '1',
      '0',
      'ENDSEC'
    ];
    const circle = dxf(['0', 'CIRCLE', '10', '0', '20', '0', '40', '1']);
    expect(() => importDxfSketch([...header, circle].join('\n'), 'mm')).toThrow(
      'its $INSUNITS declaration has no usable value'
    );
    // One value followed by the next variable still reads.
    const good = header.filter((_, index) => index !== 8 && index !== 9);
    expect(
      importDxfSketch([...good, circle].join('\n'), 'mm').sourceUnit
    ).not.toBeNull();
  });

  it('ignores 999 comment groups wherever they fall', () => {
    const text = [
      '999',
      'made by a test',
      '0',
      'SECTION',
      '999',
      'units',
      '2',
      'HEADER',
      '9',
      '$INSUNITS',
      '999',
      'inches',
      '70',
      '1',
      '0',
      'ENDSEC',
      '0',
      'SECTION',
      '2',
      'ENTITIES',
      '0',
      'CIRCLE',
      '999',
      'a hole',
      '10',
      '1',
      '20',
      '0',
      '40',
      '0.5',
      '0',
      'ENDSEC',
      '0',
      'EOF'
    ].join('\n');
    const result = importDxfSketch(text, 'mm');
    expect(result.sourceUnit).not.toBeNull();
    expect(result.objects[0]).toMatchObject({ centerX: 25.4, radius: 12.7 });
  });

  it('refuses a polyline that draws nothing', () => {
    const lw = (groups: string[]) =>
      dxf([
        '0',
        'LWPOLYLINE',
        ...groups,
        '0',
        'CIRCLE',
        '10',
        '0',
        '20',
        '0',
        '40',
        '1'
      ]);
    for (const groups of [
      ['90', '0'],
      ['90', '1', '10', '1', '20', '1'],
      ['90', '2', '10', '1', '20', '1', '10', '1', '20', '1']
    ]) {
      expect(() => importDxfSketch(lw(groups), 'mm')).toThrow(
        'a polyline with nothing to draw'
      );
    }
  });

  it("refuses a radius that vanishes in its centre's precision", () => {
    const far = dxf(['0', 'CIRCLE', '10', '1e60', '20', '1e60', '40', '1']);
    expect(() => importDxfSketch(far, 'mm')).toThrow(
      'geometry too small to represent'
    );
  });

  it('refuses a section cut short, and data before the first entity', () => {
    const cut = [
      '0',
      'SECTION',
      '2',
      'ENTITIES',
      '0',
      'CIRCLE',
      '10',
      '0',
      '20',
      '0',
      '40',
      '1',
      '0',
      'SECTION',
      '2',
      'OBJECTS',
      '0',
      'ENDSEC',
      '0',
      'EOF'
    ].join('\n');
    expect(() => importDxfSketch(cut, 'mm')).toThrow(
      'its ENTITIES section never ends'
    );
    const orphan = [
      '0',
      'SECTION',
      '2',
      'ENTITIES',
      '10',
      '0',
      '20',
      '0',
      '11',
      '5',
      '21',
      '0',
      '0',
      'CIRCLE',
      '10',
      '0',
      '20',
      '0',
      '40',
      '1',
      '0',
      'ENDSEC',
      '0',
      'EOF'
    ].join('\n');
    expect(() => importDxfSketch(orphan, 'mm')).toThrow(
      'data before the first entity'
    );
  });

  it('refuses an arc so near a full turn the sketch would close it', () => {
    const arc = (end: string) =>
      dxf([
        '0',
        'ARC',
        '10',
        '0',
        '20',
        '0',
        '40',
        '1e12',
        '50',
        '0',
        '51',
        end
      ]);
    expect(() => importDxfSketch(arc('359.99999999'), 'mm')).toThrow(
      'would close into a full turn'
    );
    expect(importDxfSketch(arc('359.9999'), 'mm').objects).toHaveLength(1);
  });

  it('refuses records left outside a section by an early ENDSEC', () => {
    const early = [
      '0',
      'SECTION',
      '2',
      'ENTITIES',
      '0',
      'CIRCLE',
      '10',
      '0',
      '20',
      '0',
      '40',
      '1',
      '0',
      'ENDSEC',
      '0',
      'LINE',
      '10',
      '0',
      '20',
      '0',
      '11',
      '5',
      '21',
      '0',
      '0',
      'EOF'
    ].join('\n');
    expect(() => importDxfSketch(early, 'mm')).toThrow(
      'records outside any section'
    );
  });

  it('refuses a space marker other than 0 or 1', () => {
    for (const marker of ['2', '-1']) {
      const text = dxf([
        '0',
        'CIRCLE',
        '67',
        marker,
        '10',
        '0',
        '20',
        '0',
        '40',
        '1',
        '0',
        'CIRCLE',
        '10',
        '5',
        '20',
        '0',
        '40',
        '1'
      ]);
      expect(() => importDxfSketch(text, 'mm')).toThrow('67 must be 0 or 1');
    }
  });

  it('reads many sections in one pass, and refuses a nameless header or data after EOF', () => {
    const circle = dxf(['0', 'CIRCLE', '10', '0', '20', '0', '40', '1']);
    const many =
      '0\nSECTION\n2\nBLOCKS\n0\nENDSEC\n'.repeat(1) +
      Array.from(
        { length: 100_000 },
        (_, i) => `0\nSECTION\n2\nX${i}\n0\nENDSEC`
      ).join('\n') +
      '\n' +
      circle;
    const started = performance.now();
    expect(importDxfSketch(many, 'mm').objects).toHaveLength(1);
    expect(performance.now() - started).toBeLessThan(5_000);
    const nameless = [
      '0',
      'SECTION',
      '9',
      '$ACADVER',
      '2',
      'HEADER',
      '9',
      '$INSUNITS',
      '70',
      '1',
      '0',
      'ENDSEC'
    ].join('\n');
    expect(() => importDxfSketch(`${nameless}\n${circle}`, 'mm')).toThrow(
      'a SECTION has no name after it'
    );
    const trailing = `${circle}\n0\nLINE\n10\n0\n20\n0\n11\n5\n21\n0`;
    expect(() => importDxfSketch(trailing, 'mm')).toThrow('records after EOF');
  });

  it('judges a bulge by its own size, not its distance from the origin', () => {
    const shallow = (x: number) =>
      dxf([
        '0',
        'LWPOLYLINE',
        '90',
        '2',
        '10',
        String(x),
        '20',
        '0',
        '42',
        '5e-13',
        '10',
        String(x + 1e6),
        '20',
        '0'
      ]);
    expect(() => importDxfSketch(shallow(0), 'mm')).toThrow(
      'could not keep its endpoints'
    );
    expect(() => importDxfSketch(shallow(1e12), 'mm')).toThrow(
      'could not keep its endpoints'
    );
    // An ordinary half-circle bulge far from the origin still imports.
    const far = dxf([
      '0',
      'LWPOLYLINE',
      '90',
      '2',
      '10',
      '1e12',
      '20',
      '0',
      '42',
      '1',
      '10',
      String(1e12 + 10),
      '20',
      '0'
    ]);
    expect(importDxfSketch(far, 'mm').objects).toHaveLength(1);
  });

  it('keeps a flat LINE whatever its extrusion direction says', () => {
    const line = dxf([
      '0',
      'LINE',
      '10',
      '0',
      '20',
      '0',
      '11',
      '5',
      '21',
      '0',
      '210',
      '1',
      '220',
      '0',
      '230',
      '0'
    ]);
    expect(importDxfSketch(line, 'mm').objects).toEqual([
      expect.objectContaining({ objectKind: 'line', x2: 5 })
    ]);
  });

  it('refuses a POLYLINE whose vertices carry curve-fit tangents', () => {
    const result = importDxfSketch(
      dxf([
        '0',
        'POLYLINE',
        '70',
        '0',
        '0',
        'VERTEX',
        '10',
        '0',
        '20',
        '0',
        '70',
        '2',
        '50',
        '0',
        '0',
        'VERTEX',
        '10',
        '5',
        '20',
        '0',
        '70',
        '2',
        '50',
        '0',
        '0',
        'SEQEND',
        '0',
        'CIRCLE',
        '10',
        '0',
        '20',
        '0',
        '40',
        '1'
      ]),
      'mm'
    );
    expect(result.objects).toHaveLength(1);
    expect(result.refused).toEqual({
      'POLYLINE (curve-fit or spline-fit)': 1
    });
  });

  it('refuses a line far shorter than the drawing it sits in', () => {
    const text = dxf([
      '0',
      'LINE',
      '10',
      '0',
      '20',
      '0',
      '11',
      '1e6',
      '21',
      '0',
      '0',
      'LINE',
      '10',
      '0',
      '20',
      '1',
      '11',
      '1e-9',
      '21',
      '1'
    ]);
    expect(() => importDxfSketch(text, 'mm')).toThrow(
      'too small for the sketch to use'
    );
  });

  it('leaves invisible entities out, and refuses other visibility values', () => {
    const result = importDxfSketch(
      dxf([
        '0',
        'LINE',
        '60',
        '1',
        '10',
        '0',
        '20',
        '0',
        '11',
        '5',
        '21',
        '0',
        '0',
        'CIRCLE',
        '60',
        '0',
        '10',
        '0',
        '20',
        '0',
        '40',
        '1'
      ]),
      'mm'
    );
    expect(result.objects).toEqual([
      expect.objectContaining({ objectKind: 'circle' })
    ]);
    expect(result.dropped).toEqual({ 'LINE (invisible)': 1 });
    expect(() =>
      importDxfSketch(
        dxf(['0', 'CIRCLE', '60', '2', '10', '0', '20', '0', '40', '1']),
        'mm'
      )
    ).toThrow('60 must be 0 or 1');
  });

  it('leaves entities on off or frozen layers out', () => {
    const tables = [
      '0',
      'SECTION',
      '2',
      'TABLES',
      '0',
      'TABLE',
      '2',
      'LAYER',
      '70',
      '3',
      '0',
      'LAYER',
      '2',
      'OFF',
      '70',
      '0',
      '62',
      '-7',
      '0',
      'LAYER',
      '2',
      'FROZEN',
      '70',
      '1',
      '62',
      '7',
      '0',
      'LAYER',
      '2',
      'PART',
      '70',
      '0',
      '62',
      '7',
      '0',
      'ENDTAB',
      '0',
      'ENDSEC'
    ];
    const entities = dxf([
      '0',
      'LINE',
      '8',
      'OFF',
      '10',
      '0',
      '20',
      '0',
      '11',
      '5',
      '21',
      '0',
      '0',
      'LINE',
      '8',
      'FROZEN',
      '10',
      '0',
      '20',
      '1',
      '11',
      '5',
      '21',
      '1',
      '0',
      'CIRCLE',
      '8',
      'PART',
      '10',
      '0',
      '20',
      '0',
      '40',
      '1'
    ]);
    const result = importDxfSketch([...tables, entities].join('\n'), 'mm');
    expect(result.objects).toEqual([
      expect.objectContaining({ objectKind: 'circle' })
    ]);
    expect(result.dropped).toEqual({ 'LINE (hidden layer)': 2 });
  });

  it('refuses a damaged $INSUNITS rather than reading the file as unitless', () => {
    const header = [
      '0',
      'SECTION',
      '2',
      'HEADER',
      '9',
      '$INSUNITS',
      '71',
      '1',
      '0',
      'ENDSEC'
    ];
    const text = [
      ...header,
      dxf(['0', 'CIRCLE', '10', '0', '20', '0', '40', '1'])
    ].join('\n');
    expect(() => importDxfSketch(text, 'mm')).toThrow(
      'its $INSUNITS declaration has no usable value'
    );
  });

  it('refuses a blank number instead of reading it as 0', () => {
    expect(() =>
      importDxfSketch(
        dxf(['0', 'LINE', '10', '', '20', '0', '11', '1', '21', '1']),
        'mm'
      )
    ).toThrow('This DXF is malformed: a LINE has no usable group 10.');
    expect(() =>
      importDxfSketch(
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
          ' ',
          '10',
          '1',
          '20',
          '1'
        ]),
        'mm'
      )
    ).toThrow('a LWPOLYLINE has an incomplete or unusable vertex list');
  });

  it('refuses an oversized file by its byte size, before reading it', () => {
    expect(() => refuseOversizedDxf(MAX_DXF_IMPORT_BYTES)).not.toThrow();
    expect(() => refuseOversizedDxf(MAX_DXF_IMPORT_BYTES + 1)).toThrow(
      'This DXF is larger than 20 MB; split it first.'
    );
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
