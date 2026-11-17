import { describe, expect, it } from 'vitest';
import {
  computeSketchRegions,
  ellipsePoint,
  resolveEllipseGeometry,
  resolveSplineGeometry,
  splineDomain,
  splinePoint
} from '@openzcad/geometry';
import {
  createProjectDocument,
  findSketch,
  listFeaturesInOrder
} from '@openzcad/document-core';
import { CommandManager } from '@openzcad/command-system';
import { toUserId, type SketchObjectData } from '@openzcad/shared';
import {
  DxfImportError,
  dxfSketchImportPlan,
  importDxfSketch,
  inspectDxfUnits
} from '../apps/web/src/lib/dxfImport';

/**
 * D04: DXF ELLIPSE and SPLINE import onto the sketch's exact ellipse and
 * control-spline objects. Each imported curve is compared point for point
 * with the curve the file describes, evaluated here from the DXF definition.
 */

function dxf(entities: (string | number)[], insunits?: number): string {
  const header =
    insunits === undefined
      ? []
      : ['0', 'SECTION', '2', 'HEADER', '9', '$INSUNITS', '70', insunits];
  return [
    ...header,
    ...(insunits === undefined ? [] : ['0', 'ENDSEC']),
    '0',
    'SECTION',
    '2',
    'ENTITIES',
    ...entities,
    '0',
    'ENDSEC',
    '0',
    'EOF'
  ]
    .map(String)
    .join('\n');
}

type P = [number, number];

function ellipseEntity(options: {
  center: P;
  major: P;
  ratio: number;
  start?: number;
  end?: number;
  normalZ?: number;
}): (string | number)[] {
  return [
    0,
    'ELLIPSE',
    10,
    options.center[0],
    20,
    options.center[1],
    30,
    0,
    11,
    options.major[0],
    21,
    options.major[1],
    31,
    0,
    ...(options.normalZ === undefined
      ? []
      : [210, 0, 220, 0, 230, options.normalZ]),
    40,
    options.ratio,
    41,
    options.start ?? 0,
    42,
    options.end ?? 2 * Math.PI
  ];
}

function splineEntity(options: {
  degree: number;
  knots: number[];
  controls: P[];
  weights?: number[];
  flags?: number;
}): (string | number)[] {
  return [
    0,
    'SPLINE',
    70,
    options.flags ?? 8,
    71,
    options.degree,
    72,
    options.knots.length,
    73,
    options.controls.length,
    74,
    0,
    ...options.knots.flatMap((knot) => [40, knot]),
    ...(options.weights ?? []).flatMap((weight) => [41, weight]),
    ...options.controls.flatMap(([x, y]) => [10, x, 20, y, 30, 0])
  ];
}

function line(from: P, to: P): (string | number)[] {
  return [0, 'LINE', 10, from[0], 20, from[1], 11, to[0], 21, to[1]];
}

/** The DXF's own ellipse: C + cos t·M + sin t·ratio·(N × M). */
function dxfEllipsePoint(
  center: P,
  major: P,
  ratio: number,
  normalZ: 1 | -1,
  t: number
): P {
  // N × M for N = (0, 0, ±1).
  const minor: P = [-normalZ * major[1] * ratio, normalZ * major[0] * ratio];
  return [
    center[0] + Math.cos(t) * major[0] + Math.sin(t) * minor[0],
    center[1] + Math.cos(t) * major[1] + Math.sin(t) * minor[1]
  ];
}

/** De Boor evaluation of a non-rational B-spline over its own knots. */
function deBoor(degree: number, knots: number[], controls: P[], u: number): P {
  let span = degree;
  while (span < controls.length - 1 && u >= knots[span + 1]!) span += 1;
  const d = Array.from({ length: degree + 1 }, (_, j) => [
    ...controls[j + span - degree]!
  ]) as P[];
  for (let r = 1; r <= degree; r += 1) {
    for (let j = degree; j >= r; j -= 1) {
      const i = j + span - degree;
      const denominator = knots[i + degree - r + 1]! - knots[i]!;
      const alpha = denominator === 0 ? 0 : (u - knots[i]!) / denominator;
      d[j] = [
        (1 - alpha) * d[j - 1]![0] + alpha * d[j]![0],
        (1 - alpha) * d[j - 1]![1] + alpha * d[j]![1]
      ];
    }
  }
  return d[degree]!;
}

const resolve = (value: unknown) => Number(value);

function only<K extends SketchObjectData['objectKind']>(
  objects: SketchObjectData[],
  kind: K
): Extract<SketchObjectData, { objectKind: K }> {
  expect(objects).toHaveLength(1);
  expect(objects[0]!.objectKind).toBe(kind);
  return objects[0] as Extract<SketchObjectData, { objectKind: K }>;
}

function regionsOf(objects: SketchObjectData[]) {
  return computeSketchRegions(
    objects.map((data, index) => ({ id: `o${index}`, data })),
    resolve
  );
}

describe('DXF ELLIPSE import (D04)', () => {
  it('reads a rotated full ellipse onto the sketch ellipse, point for point', () => {
    const center: P = [5, 3];
    const major: P = [3, 4];
    const { objects, refused } = importDxfSketch(
      dxf(ellipseEntity({ center, major, ratio: 0.5 })),
      'mm'
    );
    expect(refused).toEqual({});
    const ellipse = only(objects, 'ellipse');
    expect(ellipse.startParamDeg).toBeUndefined();
    expect(ellipse).toMatchObject({ centerX: 5, centerY: 3, radiusX: 5 });
    expect(Number(ellipse.radiusY)).toBe(2.5);
    const geometry = resolveEllipseGeometry(ellipse, resolve);
    for (let step = 0; step < 16; step += 1) {
      const t = (step / 16) * 2 * Math.PI;
      const sketch = ellipsePoint(geometry, t);
      const file = dxfEllipsePoint(center, major, 0.5, 1, t);
      expect(sketch.x).toBeCloseTo(file[0], 12);
      expect(sketch.y).toBeCloseTo(file[1], 12);
    }
    // The prompt sizes a unitless file by its extent: 2a by 2b, rotated.
    const extent = inspectDxfUnits(
      dxf(ellipseEntity({ center, major, ratio: 0.5 }))
    ).extent!;
    expect(extent[0]).toBeCloseTo(2 * Math.hypot(5 * 0.6, 2.5 * 0.8), 3);
  });

  it('closes a half ellipse with its diameter into one region of area πab/2', () => {
    const { objects } = importDxfSketch(
      dxf([
        ...ellipseEntity({
          center: [0, 0],
          major: [10, 0],
          ratio: 0.4,
          start: 0,
          end: Math.PI
        }),
        ...line([-10, 0], [10, 0])
      ]),
      'mm'
    );
    expect(objects[0]).toMatchObject({
      objectKind: 'ellipse',
      startParamDeg: 0,
      endParamDeg: 180
    });
    const regions = regionsOf(objects);
    expect(regions).toHaveLength(1);
    expect(regions[0]!.area).toBeCloseTo((Math.PI * 10 * 4) / 2, 6);
  });

  it('runs a -Z elliptical arc the other way, matching the file from +Z', () => {
    const center: P = [2, 1];
    const major: P = [0, 6];
    const start = Math.PI / 6;
    const end = (4 * Math.PI) / 3;
    const { objects } = importDxfSketch(
      dxf(
        ellipseEntity({ center, major, ratio: 0.5, start, end, normalZ: -1 })
      ),
      'mm'
    );
    const ellipse = only(objects, 'ellipse');
    const geometry = resolveEllipseGeometry(ellipse, resolve);
    expect(geometry.sweep).toBeCloseTo(end - start, 12);
    // The sketch arc runs from the file's end to its start.
    const first = ellipsePoint(geometry, geometry.start);
    const last = ellipsePoint(geometry, geometry.start + geometry.sweep);
    const fileStart = dxfEllipsePoint(center, major, 0.5, -1, start);
    const fileEnd = dxfEllipsePoint(center, major, 0.5, -1, end);
    expect(first.x).toBeCloseTo(fileEnd[0], 12);
    expect(first.y).toBeCloseTo(fileEnd[1], 12);
    expect(last.x).toBeCloseTo(fileStart[0], 12);
    expect(last.y).toBeCloseTo(fileStart[1], 12);
    // And between them it is the file's curve.
    for (let step = 1; step < 8; step += 1) {
      const t = start + ((end - start) * step) / 8;
      const sketch = ellipsePoint(geometry, -t);
      const file = dxfEllipsePoint(center, major, 0.5, -1, t);
      expect(sketch.x).toBeCloseTo(file[0], 12);
      expect(sketch.y).toBeCloseTo(file[1], 12);
    }
  });

  it('reads a range of a whole turn as the full ellipse, and converts units', () => {
    const { objects, sourceUnit } = importDxfSketch(
      dxf(
        ellipseEntity({
          center: [1, 0],
          major: [2, 0],
          ratio: 0.5,
          start: 1,
          end: 1 + 2 * Math.PI
        }),
        1
      ),
      'mm'
    );
    expect(sourceUnit).toBe('inches');
    const ellipse = only(objects, 'ellipse');
    expect(ellipse.startParamDeg).toBeUndefined();
    expect(ellipse).toMatchObject({
      centerX: 25.4,
      radiusX: 50.8,
      radiusY: 25.4
    });
  });

  it.each([
    [
      'a zero sweep',
      ellipseEntity({
        center: [0, 0],
        major: [1, 0],
        ratio: 0.5,
        start: 1,
        end: 1
      }),
      /elliptical arc too short/
    ],
    [
      // A range under 1e-9 rad is a tiny arc, never the closed ellipse.
      'a sweep too short to represent',
      ellipseEntity({
        center: [0, 0],
        major: [1000000, 0],
        ratio: 0.5,
        start: 0,
        end: 5e-10
      }),
      /elliptical arc too short/
    ],
    [
      'a zero axis ratio',
      ellipseEntity({ center: [0, 0], major: [1, 0], ratio: 0 }),
      /axis ratio of 0/
    ],
    [
      'no major axis',
      ellipseEntity({ center: [0, 0], major: [0, 0], ratio: 0.5 }),
      /no usable major axis/
    ]
  ])('refuses an ELLIPSE with %s', (_, entity, message) => {
    expect(() => importDxfSketch(dxf(entity), 'mm')).toThrow(DxfImportError);
    expect(() => importDxfSketch(dxf(entity), 'mm')).toThrow(message);
  });

  it('counts an ellipse off the XY plane instead of flattening it', () => {
    const tilted = ellipseEntity({ center: [0, 0], major: [1, 0], ratio: 0.5 });
    tilted[tilted.indexOf(31) + 1] = 1;
    const result = importDxfSketch(
      dxf([...tilted, ...line([0, 0], [1, 1])]),
      'mm'
    );
    expect(result.refused).toEqual({ 'ELLIPSE off the XY plane': 1 });
    expect(result.objects).toHaveLength(1);
  });
});

describe('DXF SPLINE import (D04)', () => {
  const controls: P[] = [
    [0, 0],
    [2, 5],
    [6, 6],
    [9, 2],
    [12, 0]
  ];

  it('reads a clamped uniform cubic as a control spline over the same points', () => {
    // Knots 0…10, not 0…1: an affine change of parameter is the same curve.
    const knots = [0, 0, 0, 0, 5, 10, 10, 10, 10];
    const { objects, refused } = importDxfSketch(
      dxf(splineEntity({ degree: 3, knots, controls })),
      'mm'
    );
    expect(refused).toEqual({});
    const spline = only(objects, 'spline');
    expect(spline).toMatchObject({ method: 'control', degree: 3 });
    expect(spline.closed).toBeUndefined();
    expect(spline.points).toEqual(controls.map(([x, y]) => ({ x, y })));
    const geometry = resolveSplineGeometry(spline, resolve);
    const [low, high] = splineDomain(geometry);
    for (let step = 0; step <= 20; step += 1) {
      const u = (10 * step) / 20;
      const file = deBoor(3, knots, controls, Math.min(u, 10 - 1e-12));
      const sketch = splinePoint(geometry, low + ((high - low) * u) / 10);
      expect(sketch.x).toBeCloseTo(file[0], 10);
      expect(sketch.y).toBeCloseTo(file[1], 10);
    }
  });

  it('takes decimal knots that are uniform to the writer’s rounding, and equal weights', () => {
    const knots = [0, 0, 0, 0.333333333333, 0.666666666667, 1, 1, 1];
    const { objects, refused } = importDxfSketch(
      dxf(
        splineEntity({
          degree: 2,
          knots,
          controls,
          weights: [2, 2, 2, 2, 2],
          flags: 12
        })
      ),
      'mm'
    );
    expect(refused).toEqual({});
    expect(only(objects, 'spline')).toMatchObject({ degree: 2 });
  });

  it('reads a periodic spline as the sketch’s closed spline, one region', () => {
    const ring: P[] = [
      [0, -5],
      [5, -4],
      [6, 3],
      [0, 6],
      [-6, 2]
    ];
    const wrapped = [...ring, ...ring.slice(0, 3)];
    const knots = Array.from({ length: wrapped.length + 4 }, (_, i) => i - 3);
    const { objects, refused } = importDxfSketch(
      dxf(splineEntity({ degree: 3, knots, controls: wrapped, flags: 11 })),
      'mm'
    );
    expect(refused).toEqual({});
    const spline = only(objects, 'spline');
    expect(spline).toMatchObject({ closed: true, degree: 3 });
    expect(spline.points).toHaveLength(5);
    const geometry = resolveSplineGeometry(spline, resolve);
    const [low, high] = splineDomain(geometry);
    // The file's domain is [knots[3], knots[8]] = [0, 5].
    for (let step = 0; step <= 20; step += 1) {
      const u = (5 * step) / 20;
      const file = deBoor(3, knots, wrapped, Math.min(u, 5 - 1e-12));
      const sketch = splinePoint(geometry, low + ((high - low) * u) / 5);
      expect(sketch.x).toBeCloseTo(file[0], 10);
      expect(sketch.y).toBeCloseTo(file[1], 10);
    }
    expect(regionsOf(objects)).toHaveLength(1);
  });

  it.each([
    [
      'two spans',
      3,
      [0, 0, 0, 0, 0.5, 1, 1, 1, 1],
      [
        [0, 0],
        [10, -4],
        [14, 6],
        [4, 10],
        [0, 0]
      ] as P[]
    ],
    [
      'one span',
      3,
      [0, 0, 0, 0, 1, 1, 1, 1],
      [
        [0, 0],
        [12, -6],
        [12, 6],
        [0, 0]
      ] as P[]
    ],
    [
      'three quadratic spans',
      2,
      [0, 0, 0, 1, 2, 3, 3, 3],
      [
        [0, 0],
        [8, -3],
        [10, 6],
        [2, 8],
        [0, 0]
      ] as P[]
    ]
  ])(
    'splits a clamped spline that starts where it ends (%s) into two that close a region',
    (_, degree, knots, loop) => {
      const { objects } = importDxfSketch(
        dxf(splineEntity({ degree, knots, controls: loop, flags: 9 })),
        'mm'
      );
      expect(objects).toHaveLength(2);
      const [left, right] = objects.map((object) => {
        if (object.objectKind !== 'spline') throw new Error('not a spline');
        expect(object).toMatchObject({ method: 'control', degree });
        return resolveSplineGeometry(object, resolve);
      });
      // Together the halves are the file's curve, point for point.
      const low = knots[0]!;
      const high = knots.at(-1)!;
      // Split at the middle interior knot, or mid-span when there is none.
      const spans = loop.length - degree;
      const at =
        spans >= 2 ? knots[degree + Math.floor(spans / 2)]! : (low + high) / 2;
      const middle = left!.controls.at(-1)!;
      const split = right!.controls[0]!;
      expect(split).toEqual(middle);
      for (let step = 0; step <= 40; step += 1) {
        const u = low + ((high - low) * step) / 40;
        const file = deBoor(degree, knots, loop, Math.min(u, high - 1e-12));
        // Each half is the file's curve over its share of the parameter.
        const half = u <= at ? left! : right!;
        const [from, to] = u <= at ? [low, at] : [at, high];
        const [a, b] = splineDomain(half);
        const sketch = splinePoint(
          half,
          a + ((b - a) * (u - from)) / (to - from)
        );
        expect(sketch.x).toBeCloseTo(file[0], 9);
        expect(sketch.y).toBeCloseTo(file[1], 9);
      }
      const regions = regionsOf(objects);
      expect(regions).toHaveLength(1);
    }
  );

  it('reads a degree-1 spline as the lines through its control points', () => {
    const { objects } = importDxfSketch(
      dxf(
        splineEntity({
          degree: 1,
          knots: [0, 0, 0.3, 0.5, 1, 1],
          controls: [
            [0, 0],
            [4, 0],
            [4, 3],
            [0, 0]
          ]
        })
      ),
      'mm'
    );
    expect(objects.map((object) => object.objectKind)).toEqual([
      'line',
      'line',
      'line'
    ]);
    expect(regionsOf(objects)[0]!.area).toBeCloseTo(6, 9);
  });

  it.each([
    [
      'unequal weights',
      splineEntity({
        degree: 2,
        knots: [0, 0, 0, 0.5, 1, 1, 1],
        controls: controls.slice(0, 4),
        weights: [1, 2, 1, 1],
        flags: 12
      }),
      'SPLINE (rational)'
    ],
    [
      'non-uniform knots',
      splineEntity({
        degree: 3,
        knots: [0, 0, 0, 0, 0.3, 1, 1, 1, 1],
        controls
      }),
      'SPLINE (non-uniform knots)'
    ],
    [
      'unclamped knots that do not wrap',
      splineEntity({
        degree: 2,
        knots: [0, 1, 2, 3, 4, 5, 6, 7],
        controls
      }),
      'SPLINE (non-uniform knots)'
    ],
    [
      'degree 5',
      splineEntity({
        degree: 5,
        knots: [0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1],
        controls: [...controls, [14, 1]]
      }),
      'SPLINE (degree 5)'
    ],
    [
      'more control points than a sketch spline holds',
      splineEntity({
        degree: 2,
        knots: [0, 0, ...Array.from({ length: 64 }, (_, i) => i / 63), 1, 1],
        controls: Array.from({ length: 65 }, (_, i): P => [i, (i * i) % 7])
      }),
      'SPLINE (more than 64 control points)'
    ],
    [
      'fit points only',
      [0, 'SPLINE', 71, 3, 74, 3, 11, 0, 21, 0, 11, 1, 21, 2, 11, 3, 21, 0],
      'SPLINE (fit points only)'
    ]
  ])(
    'counts a spline with %s instead of approximating it',
    (_, entity, why) => {
      const result = importDxfSketch(
        dxf([...entity, ...line([0, 0], [1, 0])]),
        'mm'
      );
      expect(result.refused).toEqual({ [why]: 1 });
      expect(result.objects).toHaveLength(1);
    }
  );

  it.each([
    [
      'a control count that does not match its list',
      [
        ...splineEntity({
          degree: 2,
          knots: [0, 0, 0, 1, 1, 1],
          controls: controls.slice(0, 3)
        })
      ].map((value, index, all) => (all[index - 1] === 73 ? 4 : value)),
      /declares 4 control points but lists 3/
    ],
    [
      'too few knots',
      splineEntity({
        degree: 2,
        knots: [0, 0, 1, 1, 1],
        controls: controls.slice(0, 3)
      }),
      /degree 2 has 3 control points and 5 knots/
    ],
    [
      'decreasing knots',
      splineEntity({
        degree: 2,
        knots: [0, 0, 0, 0.6, 0.4, 1, 1, 1],
        controls
      }),
      /decreasing knots/
    ],
    [
      'a zero weight',
      splineEntity({
        degree: 2,
        knots: [0, 0, 0, 1, 1, 1],
        controls: controls.slice(0, 3),
        weights: [1, 0, 1]
      }),
      /unusable weights/
    ],
    [
      'a control point missing its Y',
      [
        0,
        'SPLINE',
        71,
        2,
        40,
        0,
        40,
        0,
        40,
        0,
        40,
        1,
        40,
        1,
        40,
        1,
        10,
        0,
        20,
        0,
        10,
        1,
        20,
        1,
        10,
        2
      ],
      /incomplete point list/
    ]
  ])('refuses a SPLINE with %s as malformed', (_, entity, message) => {
    expect(() => importDxfSketch(dxf(entity), 'mm')).toThrow(message);
  });

  it('counts a spline off the XY plane', () => {
    const entity = splineEntity({
      degree: 2,
      knots: [0, 0, 0, 1, 1, 1],
      controls: controls.slice(0, 3)
    });
    entity[entity.lastIndexOf(30) + 1] = 2;
    expect(
      importDxfSketch(dxf([...entity, ...line([0, 0], [1, 0])]), 'mm').refused
    ).toEqual({
      'SPLINE off the XY plane': 1
    });
  });

  it('imports a drawing of an ellipse and a spline as one undoable sketch', () => {
    const base = createProjectDocument('Curves', toUserId('test'));
    const plan = dxfSketchImportPlan(
      base,
      'cam.dxf',
      dxf(
        [
          ...ellipseEntity({ center: [0, 0], major: [1, 0], ratio: 0.5 }),
          ...splineEntity({
            degree: 3,
            knots: [0, 0, 0, 0, 0.5, 1, 1, 1, 1],
            controls: controls.map(([x, y]): P => [x / 10, y / 10])
          })
        ],
        1
      ),
      (name) => name
    );
    expect(plan.status).toBe(
      'Imported 2 curves from cam.dxf as sketch "cam", converted from inches.'
    );
    const manager = new CommandManager(base);
    manager.execute(plan.command);
    const feature = listFeaturesInOrder(manager.document).at(-1)!;
    if (feature.data.featureKind !== 'sketch') throw new Error('not a sketch');
    const sketch = findSketch(manager.document, feature.data.sketchId)!;
    const data = sketch.objectIds.map((id) => {
      const node = manager.document.nodes[id];
      if (node?.kind !== 'sketch-object') throw new Error('not an object');
      return node.data;
    });
    expect(data.map((object) => object.objectKind)).toEqual([
      'ellipse',
      'spline'
    ]);
    const spline = data[1]!;
    if (spline.objectKind !== 'spline') throw new Error('not a spline');
    expect(Number(spline.points[4]!.x)).toBeCloseTo(30.48, 12);
    expect(Number(spline.points[4]!.y)).toBe(0);
    manager.undo();
    expect(listFeaturesInOrder(manager.document)).toHaveLength(
      listFeaturesInOrder(base).length
    );
  });
});
