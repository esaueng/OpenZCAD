import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createExactKernelAdapter,
  importMeshFile,
  type ExactKernelAdapter
} from '@openzcad/kernel-adapter/exact';
import {
  scaleUnitlessMeshFile,
  unitlessMeshExtent
} from '@openzcad/kernel-adapter/mesh-import-formats';

/**
 * #2096: the same physical mesh, written in millimetres or in inches, imports
 * to the same triangles once the matching unit is chosen.
 *
 * The import used to read an inch OBJ or PLY as millimetres — translator,
 * tessellation and the one-body rebuild check all on numbers 25.4 times too
 * small — and enlarge the result afterwards. It now rewrites the file's
 * vertex positions into millimetres before any of that runs, so every stage
 * sees what it would see for a millimetre copy of the same part.
 */

const INCH = 25.4;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * A stepped spindle like the #2090 part, in millimetres: a Ø120 × 12 flange
 * with a 0.8 mm rim chamfer under a Ø50 hub to 67 mm, revolved through
 * `sectors` facets, beside a small separate datum box — small features and
 * two shells, the parts of the reported fixture a scale-dependent stage
 * would treat differently.
 */
function spindleMesh(sectors = 48): { vertices: number[]; indices: number[] } {
  // Radius and height, bottom axis to top axis; the chamfer is two short
  // segments' worth of triangles around the rim.
  const profile: [number, number][] = [
    [0, 0],
    [60, 0],
    [60, 11.2],
    [59.2, 12],
    [25, 12],
    [25, 67],
    [0, 67]
  ];
  const vertices: number[] = [];
  const indices: number[] = [];
  const ring: number[][] = [];
  for (const [index, [radius, z]] of profile.entries()) {
    if (radius === 0) {
      ring[index] = [vertices.length / 3];
      vertices.push(0, 0, z);
      continue;
    }
    ring[index] = [];
    for (let sector = 0; sector < sectors; sector += 1) {
      const angle = (2 * Math.PI * sector) / sectors;
      ring[index].push(vertices.length / 3);
      vertices.push(radius * Math.cos(angle), radius * Math.sin(angle), z);
    }
  }
  const at = (row: number, sector: number) => {
    const points = ring[row]!;
    return points.length === 1 ? points[0]! : points[sector % sectors]!;
  };
  for (let row = 0; row + 1 < profile.length; row += 1) {
    for (let sector = 0; sector < sectors; sector += 1) {
      const a = at(row, sector);
      const b = at(row, sector + 1);
      const c = at(row + 1, sector + 1);
      const d = at(row + 1, sector);
      // Outward-facing for a profile walked bottom axis → rim → top axis.
      if (a !== b) indices.push(a, d, b);
      if (c !== d) indices.push(b, d, c);
    }
  }
  // The datum box, 4 mm, clear of the flange.
  const base = vertices.length / 3;
  for (const [x, y, z] of [
    [0, 0, 0],
    [1, 0, 0],
    [1, 1, 0],
    [0, 1, 0],
    [0, 0, 1],
    [1, 0, 1],
    [1, 1, 1],
    [0, 1, 1]
  ]) {
    vertices.push(80 + 4 * x!, 4 * y!, 4 * z!);
  }
  for (const [a, b, c] of [
    [0, 2, 1],
    [0, 3, 2],
    [4, 5, 6],
    [4, 6, 7],
    [0, 1, 5],
    [0, 5, 4],
    [1, 2, 6],
    [1, 6, 5],
    [2, 3, 7],
    [2, 7, 6],
    [3, 0, 4],
    [3, 4, 7]
  ]) {
    indices.push(base + a!, base + b!, base + c!);
  }
  return { vertices, indices };
}

function objText(vertices: readonly number[], indices: readonly number[]) {
  const lines = ['# spindle fixture', 'o spindle'];
  for (let index = 0; index < vertices.length; index += 3) {
    lines.push(
      `v ${vertices[index]} ${vertices[index + 1]} ${vertices[index + 2]}`
    );
  }
  for (let index = 0; index < indices.length; index += 3) {
    lines.push(
      `f ${indices[index]! + 1} ${indices[index + 1]! + 1} ${indices[index + 2]! + 1}`
    );
  }
  return `${lines.join('\n')}\n`;
}

/** A binary little-endian PLY of float32 positions. */
function binaryPly(vertices: readonly number[], indices: readonly number[]) {
  const header = encoder.encode(
    [
      'ply',
      'format binary_little_endian 1.0',
      'comment spindle fixture',
      `element vertex ${vertices.length / 3}`,
      'property float x',
      'property float y',
      'property float z',
      `element face ${indices.length / 3}`,
      'property list uchar int vertex_indices',
      'end_header',
      ''
    ].join('\n')
  );
  const bytes = new Uint8Array(
    header.length + vertices.length * 4 + (indices.length / 3) * 13
  );
  bytes.set(header);
  const view = new DataView(bytes.buffer);
  let offset = header.length;
  for (const value of vertices) {
    view.setFloat32(offset, value, true);
    offset += 4;
  }
  for (let index = 0; index < indices.length; index += 3) {
    view.setUint8(offset, 3);
    offset += 1;
    for (let corner = 0; corner < 3; corner += 1) {
      view.setInt32(offset, indices[index + corner]!, true);
      offset += 4;
    }
  }
  return bytes;
}

interface Shape {
  points: number[][];
  /** Zero-based. */
  faces: number[][];
}

/**
 * A box whose top is fanned around a point `offset` from one corner: 9
 * points, 14 triangles, the two smallest of them `offset` wide. The
 * translator welds positions closer than a fixed distance, so whether those
 * two survive depends on the numbers it is handed.
 */
function fanBox(side: number, offset: number, height = side): Shape {
  return {
    points: [
      [0, 0, 0],
      [side, 0, 0],
      [side, side, 0],
      [0, side, 0],
      [0, 0, height],
      [side, 0, height],
      [side, side, height],
      [0, side, height],
      [offset, offset, height]
    ],
    faces: [
      [0, 2, 1],
      [0, 3, 2],
      [0, 1, 5],
      [0, 5, 4],
      [1, 2, 6],
      [1, 6, 5],
      [2, 3, 7],
      [2, 7, 6],
      [3, 0, 4],
      [3, 4, 7],
      [4, 5, 8],
      [5, 6, 8],
      [6, 7, 8],
      [7, 4, 8]
    ]
  };
}

const scaledShape = (shape: Shape, factor: number): Shape => ({
  points: shape.points.map((point) => point.map((value) => value * factor)),
  faces: shape.faces
});

type AxisTypes = [string, string, string];

/** An ASCII PLY, with a type per axis and optional extra header lines. */
function asciiPly(
  shape: Shape,
  types: AxisTypes = ['double', 'double', 'double'],
  headerLines: string[] = []
) {
  return encoder.encode(
    [
      'ply',
      'format ascii 1.0',
      ...headerLines,
      `element vertex ${shape.points.length}`,
      `property ${types[0]} x`,
      `property ${types[1]} y`,
      `property ${types[2]} z`,
      `element face ${shape.faces.length}`,
      'property list uchar int vertex_indices',
      'end_header',
      ...shape.points.map((point) => point.join(' ')),
      ...shape.faces.map((face) => `${face.length} ${face.join(' ')}`),
      ''
    ].join('\n')
  );
}

const PLY_BINARY_WIDTH: Record<string, number> = {
  double: 8,
  float: 4,
  int: 4,
  short: 2,
  uchar: 1
};

/** A binary little-endian PLY with a type per axis. */
function mixedBinaryPly(shape: Shape, types: AxisTypes) {
  const header = encoder.encode(
    [
      'ply',
      'format binary_little_endian 1.0',
      `element vertex ${shape.points.length}`,
      `property ${types[0]} x`,
      `property ${types[1]} y`,
      `property ${types[2]} z`,
      `element face ${shape.faces.length}`,
      'property list uchar int vertex_indices',
      'end_header',
      ''
    ].join('\n')
  );
  const record = types.reduce((sum, type) => sum + PLY_BINARY_WIDTH[type]!, 0);
  const bytes = new Uint8Array(
    header.length + shape.points.length * record + shape.faces.length * 13
  );
  bytes.set(header);
  const view = new DataView(bytes.buffer);
  let offset = header.length;
  for (const point of shape.points) {
    for (const [axis, type] of types.entries()) {
      const value = point[axis]!;
      if (type === 'double') view.setFloat64(offset, value, true);
      else if (type === 'float') view.setFloat32(offset, value, true);
      else if (type === 'int') view.setInt32(offset, value, true);
      else if (type === 'short') view.setInt16(offset, value, true);
      else view.setUint8(offset, value);
      offset += PLY_BINARY_WIDTH[type]!;
    }
  }
  for (const face of shape.faces) {
    view.setUint8(offset, 3);
    offset += 1;
    for (const corner of face) {
      view.setInt32(offset, corner, true);
      offset += 4;
    }
  }
  return bytes;
}

function objOf(
  shape: Shape,
  vertexLine: (point: number[], index: number) => string = (point) =>
    `v ${point.join(' ')}`
) {
  return [
    ...shape.points.map(vertexLine),
    ...shape.faces.map(
      (face) => `f ${face.map((corner) => corner + 1).join(' ')}`
    ),
    ''
  ].join('\n');
}

type Imported = Awaited<ReturnType<typeof importMeshFile>>;

function bounds(mesh: Imported) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let index = 0; index < mesh.vertices.length; index += 1) {
    const axis = index % 3;
    min[axis] = Math.min(min[axis]!, mesh.vertices[index]!);
    max[axis] = Math.max(max[axis]!, mesh.vertices[index]!);
  }
  return { min, max };
}

function area(mesh: Imported) {
  const v = mesh.vertices;
  let total = 0;
  for (let index = 0; index < mesh.indices.length; index += 3) {
    const [a, b, c] = [0, 1, 2].map((corner) => mesh.indices[index + corner]!);
    const u = [0, 1, 2].map((axis) => v[3 * b! + axis]! - v[3 * a! + axis]!);
    const w = [0, 1, 2].map((axis) => v[3 * c! + axis]! - v[3 * a! + axis]!);
    total +=
      0.5 *
      Math.hypot(
        u[1]! * w[2]! - u[2]! * w[1]!,
        u[2]! * w[0]! - u[0]! * w[2]!,
        u[0]! * w[1]! - u[1]! * w[0]!
      );
  }
  return total;
}

/** The same triangles: same faces, corners within `tolerance` mm. */
function expectSameGeometry(
  actual: Imported,
  expected: Imported,
  tolerance: number
) {
  expect(actual.triangleCount).toBe(expected.triangleCount);
  expect(actual.indices).toEqual(expected.indices);
  expect(actual.vertices).toHaveLength(expected.vertices.length);
  const worst = actual.vertices.reduce(
    (largest, value, index) =>
      Math.max(largest, Math.abs(value - expected.vertices[index]!)),
    0
  );
  expect(worst).toBeLessThanOrEqual(tolerance);
  // Relative: the same tolerance, per millimetre of the part.
  expect(Math.abs(area(actual) - area(expected))).toBeLessThanOrEqual(
    area(expected) * tolerance
  );
}

describe(
  'unitless mesh imports read in a chosen unit (#2096)',
  { timeout: 60_000 },
  () => {
    let adapter: ExactKernelAdapter;
    const spindle = spindleMesh();
    const inchVertices = spindle.vertices.map((value) => value / INCH);

    beforeAll(async () => {
      // The translators load with the kernel the import uses.
      adapter = await createExactKernelAdapter();
    });

    afterAll(() => {
      adapter.dispose();
    });

    it('imports an inch OBJ read as inches to the millimetre OBJ’s geometry', async () => {
      const millimetres = await importMeshFile(
        'obj',
        encoder.encode(objText(spindle.vertices, spindle.indices)),
        'mm'
      );
      const inches = await importMeshFile(
        'obj',
        encoder.encode(objText(inchVertices, spindle.indices)),
        'mm',
        'inch'
      );

      expect(millimetres.triangleCount).toBe(spindle.indices.length / 3);
      expectSameGeometry(inches, millimetres, 1e-9);
      const box = bounds(inches);
      expect(box.min[0]).toBeCloseTo(-60, 9);
      expect(box.max[0]).toBeCloseTo(84, 9);
      expect(box.max[2]).toBeCloseTo(67, 9);
    });

    it('matches the issue’s control exactly: the inch OBJ with its positions multiplied by 25.4', async () => {
      const inchText = objText(inchVertices, spindle.indices);
      const control = inchText.replace(
        /^v (\S+) (\S+) (\S+)$/gm,
        (_line, x: string, y: string, z: string) =>
          `v ${Number(x) * INCH} ${Number(y) * INCH} ${Number(z) * INCH}`
      );
      const read = await importMeshFile(
        'obj',
        encoder.encode(inchText),
        'mm',
        'inch'
      );
      const controlled = await importMeshFile(
        'obj',
        encoder.encode(control),
        'mm'
      );
      expect(read).toEqual(controlled);
    });

    it('imports an inch binary PLY read as inches to the millimetre PLY’s geometry', async () => {
      const inchFile = binaryPly(inchVertices, spindle.indices);
      // A millimetre PLY of the same float32 inch numbers, multiplied out the
      // way a writer would store them.
      const view = new DataView(inchFile.buffer);
      const headerLength =
        decoder.decode(inchFile).indexOf('end_header\n') + 11;
      const control = binaryPly(
        inchVertices.map((_value, index) =>
          Math.fround(view.getFloat32(headerLength + index * 4, true) * INCH)
        ),
        spindle.indices
      );
      const read = await importMeshFile('ply', inchFile, 'mm', 'inch');
      const controlled = await importMeshFile('ply', control, 'mm');
      expect(read).toEqual(controlled);

      const millimetres = await importMeshFile(
        'ply',
        binaryPly(spindle.vertices, spindle.indices),
        'mm'
      );
      // float32 storage: within its rounding of a 120 mm part.
      expectSameGeometry(read, millimetres, 2e-5);
    });

    /**
     * Where reading first and enlarging after went wrong: the translator welds
     * positions closer than a fixed distance, so a feature that survives in
     * millimetres was welded away in the same file's inch numbers. A 0.254 mm
     * (0.01 in) box whose top is fanned around a point 2.54e-7 mm (1e-8 in)
     * from a corner keeps all 14 triangles in millimetres, and lost two when
     * its inch file was read as millimetres and scaled afterwards.
     */
    it('keeps a feature the translator would weld at the inch file’s own numbers', async () => {
      const fannedBox = (side: number, offset: number) => {
        const points = [
          [0, 0, 0],
          [side, 0, 0],
          [side, side, 0],
          [0, side, 0],
          [0, 0, side],
          [side, 0, side],
          [side, side, side],
          [0, side, side],
          [offset, offset, side]
        ];
        const faces = [
          [1, 3, 2],
          [1, 4, 3],
          [1, 2, 6],
          [1, 6, 5],
          [2, 3, 7],
          [2, 7, 6],
          [3, 4, 8],
          [3, 8, 7],
          [4, 1, 5],
          [4, 5, 8],
          [5, 6, 9],
          [6, 7, 9],
          [7, 8, 9],
          [8, 5, 9]
        ];
        return encoder.encode(
          [
            ...points.map((point) => `v ${point.join(' ')}`),
            ...faces.map((face) => `f ${face.join(' ')}`),
            ''
          ].join('\n')
        );
      };
      const inchFile = fannedBox(0.01, 1e-8);
      const millimetres = await importMeshFile(
        'obj',
        fannedBox(0.01 * INCH, 1e-8 * INCH),
        'mm'
      );
      expect(millimetres.triangleCount).toBe(14);
      // The old order, for the record: read as written, enlarged afterwards.
      const readAsWritten = await importMeshFile('obj', inchFile, 'mm');
      expect(readAsWritten.triangleCount).toBeLessThan(14);

      const inches = await importMeshFile('obj', inchFile, 'mm', 'inch');
      expectSameGeometry(inches, millimetres, 1e-12);
    });

    it('returns the same millimetres into an inch document; only the check runs in inches', async () => {
      const file = encoder.encode(objText(inchVertices, spindle.indices));
      const inMillimetreDocument = await importMeshFile(
        'obj',
        file,
        'mm',
        'inch'
      );
      const inInchDocument = await importMeshFile('obj', file, 'inch', 'inch');
      expect(inInchDocument).toEqual(inMillimetreDocument);
    });

    it('reads an integer-position PLY as doubles in the chosen unit, to the millimetre file’s triangles', async () => {
      const box = [
        [0, 0, 0],
        [2, 0, 0],
        [2, 3, 0],
        [0, 3, 0],
        [0, 0, 4],
        [2, 0, 4],
        [2, 3, 4],
        [0, 3, 4]
      ];
      const faces = [
        [0, 2, 1],
        [0, 3, 2],
        [4, 5, 6],
        [4, 6, 7],
        [0, 1, 5],
        [0, 5, 4],
        [1, 2, 6],
        [1, 6, 5],
        [2, 3, 7],
        [2, 7, 6],
        [3, 0, 4],
        [3, 4, 7]
      ];
      const ply = (type: string, scale: number) =>
        encoder.encode(
          [
            'ply',
            'format ascii 1.0',
            'element vertex 8',
            `property ${type} x`,
            `property ${type} y`,
            `property ${type} z`,
            'element face 12',
            'property list uchar int vertex_indices',
            'end_header',
            ...box.map((point) =>
              point.map((value) => value * scale).join(' ')
            ),
            ...faces.map((face) => `3 ${face.join(' ')}`),
            ''
          ].join('\n')
        );
      const integers = ply('int', 1);
      // An integer cannot hold its own value times 25.4, so the positions are
      // promoted to doubles: the file the translator reads is the millimetre
      // file, byte for byte.
      expect(decoder.decode(scaleUnitlessMeshFile('ply', integers, INCH))).toBe(
        decoder.decode(ply('double', INCH))
      );
      const read = await importMeshFile('ply', integers, 'mm', 'inch');
      const millimetres = await importMeshFile(
        'ply',
        ply('double', INCH),
        'mm'
      );
      expect(read).toEqual(millimetres);
    });

    /**
     * Review P2: one integer axis used to send every axis down the old path —
     * read as written, enlarged afterwards — so the translator welded at the
     * inch numbers. `double x`, `double y`, `int z`: 12 triangles from the
     * inch file, 14 from the millimetre one.
     */
    it.each([
      ['ASCII', asciiPly],
      ['binary', mixedBinaryPly]
    ] as const)(
      'keeps a welded-away feature in a %s PLY whose axes are of mixed types',
      async (_encoding, write) => {
        const inchFile = write(fanBox(1, 1e-8), ['double', 'double', 'int']);
        const millimetres = await importMeshFile(
          'ply',
          asciiPly(scaledShape(fanBox(1, 1e-8), INCH)),
          'mm'
        );
        expect(millimetres.triangleCount).toBe(14);
        const inches = await importMeshFile('ply', inchFile, 'mm', 'inch');
        expect(inches).toEqual(millimetres);
      }
    );

    /**
     * Review P1: the header scan stopped at 64 KiB and took any `end_header`
     * followed by blanks for the end, where the translator takes the first
     * `end_header` + line feed anywhere in the file. A file past either
     * difference was handed over unscaled: a one-inch cube imported 1 mm wide.
     */
    it.each([
      [
        'a header longer than 64 KiB',
        Array.from(
          { length: 1700 },
          (_unused, index) => `comment ${'padding '.repeat(5)}${index}`
        )
      ],
      [
        'a comment that ends in end_header and a space',
        ['comment the vertices follow end_header ']
      ],
      [
        'an obj_info line that mentions end_header',
        ['obj_info end_header\tsoon']
      ]
    ])('reads a PLY with %s in the chosen unit', async (_name, headerLines) => {
      const cube = fanBox(1, 0.5);
      const inches = await importMeshFile(
        'ply',
        asciiPly(cube, ['float', 'float', 'float'], headerLines),
        'mm',
        'inch'
      );
      const millimetres = await importMeshFile(
        'ply',
        asciiPly(scaledShape(cube, INCH), ['float', 'float', 'float']),
        'mm'
      );
      expect(bounds(inches).max).toEqual([
        Math.fround(INCH),
        Math.fround(INCH),
        Math.fround(INCH)
      ]);
      expect(inches).toEqual(millimetres);
    });

    /**
     * The layouts a header may declare, each read as the translator reads
     * it: an element before the vertices, positions out of order and of
     * mixed types among other properties and a list, blank lines in an ASCII
     * body, and a header whose reading stops at an `end_header ` line while
     * its bytes run on to the next one.
     */
    it.each(['ascii', 'binary_little_endian'] as const)(
      'finds the positions of a %s PLY wherever its header puts them',
      async (encoding) => {
        const shape = fanBox(1, 1e-8);
        const header = [
          'ply',
          `format ${encoding} 1.0`,
          'element note 2',
          'property list uchar int tags',
          'property float weight',
          `element vertex ${shape.points.length}`,
          'property uchar red',
          'property int z',
          'property list uchar short marks',
          'property double y',
          'property double x',
          `element face ${shape.faces.length}`,
          'property list uchar int vertex_indices',
          'end_header ',
          'comment the header ends at the next line: end_header',
          ''
        ].join('\n');
        let file: Uint8Array;
        if (encoding === 'ascii') {
          file = encoder.encode(
            [
              `${header}3 1 2 3 0.5`,
              '',
              '0 1.5',
              ...shape.points.flatMap(([x, y, z]) => [
                ' \t',
                `255 ${z} 2 7 8 ${y} ${x}`
              ]),
              ...shape.faces.map((face) => `3 ${face.join(' ')}`),
              ''
            ].join('\n')
          );
        } else {
          const head = encoder.encode(header);
          file = new Uint8Array(
            head.length + 17 + 5 + shape.points.length * 26 + 14 * 13
          );
          file.set(head);
          const view = new DataView(file.buffer);
          let offset = head.length;
          view.setUint8(offset, 3);
          offset += 13;
          view.setFloat32(offset, 0.5, true);
          offset += 4 + 1;
          view.setFloat32(offset, 1.5, true);
          offset += 4;
          for (const [x, y, z] of shape.points) {
            view.setUint8(offset, 255);
            view.setInt32(offset + 1, z!, true);
            view.setUint8(offset + 5, 2);
            view.setInt16(offset + 6, 7, true);
            view.setInt16(offset + 8, 8, true);
            view.setFloat64(offset + 10, y!, true);
            view.setFloat64(offset + 18, x!, true);
            offset += 26;
          }
          for (const face of shape.faces) {
            view.setUint8(offset, 3);
            face.forEach((corner, index) =>
              view.setInt32(offset + 1 + index * 4, corner, true)
            );
            offset += 13;
          }
        }
        const millimetres = await importMeshFile(
          'ply',
          asciiPly(scaledShape(shape, INCH)),
          'mm'
        );
        expect(millimetres.triangleCount).toBe(14);
        expect(await importMeshFile('ply', file, 'mm', 'inch')).toEqual(
          millimetres
        );
      }
    );

    /**
     * Review P1: the translator splits on Unicode white space, the scan split
     * on space and tab. A `v` behind a non-breaking space was read by one and
     * not the other, so that corner stayed at its inch numbers while the
     * rest grew by 25.4.
     */
    it.each([
      ['a non-breaking space before v', '\u00a0v 1 1 1'],
      ['a non-breaking space after v', 'v\u00a01 1 1'],
      ['an ideographic space between numbers', 'v 1\u30001 1'],
      ['a next-line control before v', '\u0085v 1 1 1'],
      ['a form feed after v', 'v\f1 1 1'],
      ['a carriage return before the line feed', 'v 1 1 1\r']
    ])('scales an OBJ vertex written with %s', async (_name, line) => {
      const cube = fanBox(1, 0.5);
      const inches = await importMeshFile(
        'obj',
        encoder.encode(
          objOf(cube, (point, index) =>
            index === 6 ? line : `v ${point.join(' ')}`
          )
        ),
        'mm',
        'inch'
      );
      const millimetres = await importMeshFile(
        'obj',
        encoder.encode(objOf(scaledShape(cube, INCH))),
        'mm'
      );
      expect(bounds(inches).max).toEqual([INCH, INCH, INCH]);
      expect(inches).toEqual(millimetres);
    });

    /**
     * What the translator does not read as a vertex is not rewritten as one.
     * A byte-order mark is not white space to it, so the mark hides the first
     * `v` and every face index points one off: the file is the translator's
     * to judge, and it must judge the inch file as it would the millimetre
     * one.
     */
    it('agrees with the translator about what is not a vertex statement', async () => {
      const cube = fanBox(1, 0.5);
      const marked = encoder.encode(`\ufeff${objOf(cube)}`);
      const markedMillimetres = encoder.encode(
        `\ufeff${objOf(scaledShape(cube, INCH))}`
      );
      const outcome = async (run: () => Promise<Imported>) => {
        try {
          return await run();
        } catch (error) {
          return (error as Error).message;
        }
      };
      expect(
        await outcome(() => importMeshFile('obj', marked, 'mm', 'inch'))
      ).toEqual(
        await outcome(() => importMeshFile('obj', markedMillimetres, 'mm'))
      );
    });

    /**
     * Review P2: the vertex budget was the translator's to enforce, after the
     * rewrite had already walked — and allocated for — every vertex.
     */
    it('refuses an OBJ over the vertex budget during the scan, before the translator', async () => {
      const line = encoder.encode('v 0 0 0\n');
      const count = 600_001;
      const file = new Uint8Array(line.length * count);
      for (let index = 0; index < count; index += 1) {
        file.set(line, index * line.length);
      }
      await expect(importMeshFile('obj', file, 'mm', 'inch')).rejects.toThrow(
        'OBJ has more than 600000 vertices; the import limit is 600000.'
      );
    });
  }
);

describe('scaleUnitlessMeshFile', () => {
  it('rewrites only OBJ vertex positions, byte for byte elsewhere', () => {
    const source = [
      '# made in inches',
      'mtllib part.mtl',
      'v 1 2 3',
      '  v\t0.5 -0.25 1e-3 1.0',
      'v 1 1 1 0.2 0.4 0.6 # coloured',
      'vn 0 0 1',
      'vt 0.5 0.5',
      'vp 0.1 0.2',
      'f 1//1 2//1 3//1',
      ''
    ].join('\r\n');
    const scaled = decoder.decode(
      scaleUnitlessMeshFile('obj', encoder.encode(source), 10)
    );
    expect(scaled).toBe(
      [
        '# made in inches',
        'mtllib part.mtl',
        'v 10 20 30',
        '  v\t5 -2.5 0.01 1.0',
        'v 10 10 10 0.2 0.4 0.6 # coloured',
        'vn 0 0 1',
        'vt 0.5 0.5',
        'vp 0.1 0.2',
        'f 1//1 2//1 3//1',
        ''
      ].join('\r\n')
    );
  });

  it('scales a big-endian double PLY in place and leaves the faces alone', () => {
    const header = encoder.encode(
      [
        'ply',
        'format binary_big_endian 1.0',
        'element vertex 1',
        'property double x',
        'property double y',
        'property double z',
        'property uchar red',
        'element face 1',
        'property list uchar int vertex_indices',
        'end_header',
        ''
      ].join('\n')
    );
    const bytes = new Uint8Array(header.length + 25 + 13);
    bytes.set(header);
    const view = new DataView(bytes.buffer);
    view.setFloat64(header.length, 1.5, false);
    view.setFloat64(header.length + 8, -2, false);
    view.setFloat64(header.length + 16, 0.125, false);
    view.setUint8(header.length + 24, 200);
    view.setUint8(header.length + 25, 3);
    const scaled = scaleUnitlessMeshFile('ply', bytes, INCH);
    const out = new DataView(scaled.buffer, scaled.byteOffset);
    expect(out.getFloat64(header.length, false)).toBe(1.5 * INCH);
    expect(out.getFloat64(header.length + 8, false)).toBe(-2 * INCH);
    expect(out.getFloat64(header.length + 16, false)).toBe(0.125 * INCH);
    expect(scaled.subarray(header.length + 24)).toEqual(
      bytes.subarray(header.length + 24)
    );
    expect(scaled.subarray(0, header.length)).toEqual(header);
  });

  /**
   * A file whose positions cannot all be found is refused, not handed on as
   * written: handing it on is how a file the translator could read after all
   * was imported at the wrong size.
   */
  it('refuses a file it cannot read rather than passing it on unscaled', () => {
    const refusal = (format: 'obj' | 'ply', text: string) => () =>
      scaleUnitlessMeshFile(format, encoder.encode(text), INCH);
    const plyOf = (...lines: string[]) =>
      ['ply', 'format ascii 1.0', ...lines, ''].join('\n');
    const xyz = ['property float x', 'property float y', 'property float z'];
    expect(refusal('ply', 'not a mesh')).toThrow(
      'This PLY file cannot be read in the chosen unit: its header has no end_header line.'
    );
    expect(
      refusal(
        'ply',
        plyOf('element vertex 1', ...xyz.slice(0, 2), 'end_header', '0 0')
      )
    ).toThrow(
      'This PLY file cannot be read in the chosen unit: its vertex element does not declare x, y and z.'
    );
    expect(
      refusal('ply', plyOf('element vertex 2', ...xyz, 'end_header', '0 0 0'))
    ).toThrow(
      'This PLY file cannot be read in the chosen unit: it ends before vertex 2 of 2.'
    );
    // One vertex per line, as the translator reads them.
    expect(
      refusal(
        'ply',
        plyOf('element vertex 1', ...xyz, 'end_header', '0 0', '0')
      )
    ).toThrow(
      'This PLY file cannot be read in the chosen unit: vertex 1 of 1 has fewer values than its header declares.'
    );
    expect(
      refusal(
        'ply',
        plyOf('element vertex 1', ...xyz, 'end_header', '0 1e39 0')
      )
    ).toThrow(
      'This PLY file cannot be read in the chosen unit: vertex 1 of 1 has a coordinate its float type cannot hold ("1e39").'
    );
    expect(
      refusal(
        'ply',
        plyOf(
          'element vertex 1',
          ...xyz,
          'property int x',
          'end_header',
          '0 0 0 0'
        )
      )
    ).toThrow(
      'This PLY file cannot be read in the chosen unit: its header declares property x twice.'
    );
    expect(refusal('obj', 'v 1 2\n')).toThrow(
      'This OBJ file cannot be read in the chosen unit: line 1 does not give its vertex three coordinates.'
    );
    expect(refusal('obj', 'v 1 2 3\nv 0x10 0 0\n')).toThrow(
      'This OBJ file cannot be read in the chosen unit: line 2 has a vertex coordinate that is not a number ("0x10").'
    );
    expect(refusal('obj', 'v 1 inf 3\n')).toThrow(
      'This OBJ file cannot be read in the chosen unit: line 1 has a vertex coordinate that is not a finite number ("inf").'
    );
    expect(() =>
      scaleUnitlessMeshFile(
        'obj',
        Uint8Array.of(0x76, 0x20, 0x31, 0x20, 0x32, 0x20, 0xff, 0x0a),
        INCH
      )
    ).toThrow(
      'This OBJ file cannot be read in the chosen unit: it is not UTF-8 text.'
    );
  });

  it('reads the numbers the translator reads, and no others', () => {
    const scaled = (text: string) =>
      new TextDecoder('utf-8', { ignoreBOM: true }).decode(
        scaleUnitlessMeshFile('obj', encoder.encode(text), 10)
      );
    // Signs, bare points and exponents, as Rust's float parser takes them.
    expect(scaled('v +1 .5 5.\nv 1E1 -1.e-1 +.5e+1\n')).toBe(
      'v 10 5 50\nv 100 -1 50\n'
    );
    // A lone carriage return does not end a line: the second `v` here is the
    // first one's fifth token, which the translator ignores.
    expect(scaled('v 1 2 3\rv 4 5 6\n')).toBe('v 10 20 30\rv 4 5 6\n');
    // Only `v` itself: not `vn`, `vt`, `vp`, a `V`, or a comment.
    const others = 'vn 1 2 3\nV 1 2 3\n#v 1 2 3\n # v 1 2 3\nvt 1 2\n';
    expect(scaled(others)).toBe(others);
    // A byte-order mark is not white space to the translator: it hides the
    // first statement, which is then no vertex to either reader.
    expect(scaled('\ufeffv 1 2 3\nv 1 2 3\n')).toBe(
      '\ufeffv 1 2 3\nv 10 20 30\n'
    );
    // Nor is a zero-width space, though JavaScript's \s would not say so of
    // the mark; U+0085 is, though \s would not say that either.
    expect(scaled('\u200bv 1 2 3\n\u0085v\u00851 2 3\u0085\n')).toBe(
      '\u200bv 1 2 3\n\u0085v\u008510 20 30\u0085\n'
    );
  });

  /**
   * Review P2: the rewrite kept two views per vertex until it was done, so a
   * 2.4 MB file of 300,000 vertices held some 290 MiB. It writes into one
   * buffer now, bounded by the caller's budget while it scans.
   */
  it('stops at the vertex and output budgets while it scans', () => {
    const file = encoder.encode('v 3 3 3\n'.repeat(1000));
    expect(() =>
      scaleUnitlessMeshFile('obj', file, INCH, {
        label: 'OBJ',
        maxVertices: 999,
        maxOutputBytes: Infinity
      })
    ).toThrow('OBJ has more than 999 vertices; the import limit is 999.');
    // 3 in is 76.19999999999999 mm: the rewrite is several times the file.
    expect(() =>
      scaleUnitlessMeshFile('obj', file, INCH, {
        label: 'OBJ',
        maxVertices: 1000,
        maxOutputBytes: 2 * file.length
      })
    ).toThrow(
      'This OBJ file is too large to read in the chosen unit; convert it to millimeters first.'
    );
    expect(
      scaleUnitlessMeshFile('obj', file, INCH, {
        label: 'OBJ',
        maxVertices: 1000,
        maxOutputBytes: 56 * 1000
      })
    ).toHaveLength(56 * 1000);
    expect(() =>
      scaleUnitlessMeshFile('ply', asciiPly(fanBox(1, 0.5)), INCH, {
        label: 'PLY',
        maxVertices: 8,
        maxOutputBytes: Infinity
      })
    ).toThrow('PLY has more than 8 vertices; the import limit is 8.');
  });

  it(
    'rewrites 300,000 vertices without holding a view per vertex',
    {
      timeout: 30_000
    },
    () => {
      const line = encoder.encode('v 0 0 0\n');
      const count = 300_000;
      const file = new Uint8Array(line.length * count);
      for (let index = 0; index < count; index += 1) {
        file.set(line, index * line.length);
      }
      const held = () => {
        const usage = process.memoryUsage();
        return usage.heapUsed + usage.external;
      };
      const before = held();
      const scaled = scaleUnitlessMeshFile('obj', file, INCH);
      const grown = held() - before;
      // Zero is zero in any unit: the same bytes, compared without a
      // 2.4-million-element diff.
      expect(Buffer.compare(scaled, file)).toBe(0);
      // The old rewrite left some 600,000 views behind it; one output buffer
      // and the scan's short-lived strings come to a fraction of that.
      expect(grown).toBeLessThan(32 * 1024 * 1024);
    }
  );

  it('promotes an integer axis of a binary PLY to a double and leaves the rest of each record alone', () => {
    const shape = {
      points: [
        [1.5, -2, 3],
        [0.25, 4, -7]
      ],
      faces: [[0, 1, 0]]
    };
    expect(
      scaleUnitlessMeshFile(
        'ply',
        mixedBinaryPly(shape, ['double', 'float', 'short']),
        INCH
      )
    ).toEqual(
      mixedBinaryPly(
        {
          points: [
            [1.5 * INCH, Math.fround(-2 * INCH), 3 * INCH],
            [0.25 * INCH, Math.fround(4 * INCH), -7 * INCH]
          ],
          faces: shape.faces
        },
        ['double', 'float', 'double']
      )
    );
  });
});

describe('unitlessMeshExtent', () => {
  it('reads an OBJ’s and a PLY’s raw size without the kernel', () => {
    const { vertices, indices } = spindleMesh(8);
    const inches = vertices.map((value) => value / INCH);
    const expected = [144 / INCH, 120 / INCH, 67 / INCH];
    const fromObj = unitlessMeshExtent(
      'obj',
      encoder.encode(objText(inches, indices))
    )!;
    const fromPly = unitlessMeshExtent('ply', binaryPly(inches, indices))!;
    for (let axis = 0; axis < 3; axis += 1) {
      expect(fromObj[axis]).toBeCloseTo(expected[axis]!, 9);
      expect(fromPly[axis]).toBeCloseTo(expected[axis]!, 5);
    }
    expect(unitlessMeshExtent('obj', encoder.encode('f 1 2 3\n'))).toBeNull();
  });

  it('sizes the prompt from the vertices the translator will read', () => {
    // The vertex behind a non-breaking space counts.
    expect(
      unitlessMeshExtent('obj', encoder.encode('v 0 0 0\n\u00a0v 2 3 4\n'))
    ).toEqual([2, 3, 4]);
    // A file the import would refuse in any unit but its own has no size to
    // offer; the import names what is wrong with it.
    expect(unitlessMeshExtent('obj', encoder.encode('v 0 0\n'))).toBeNull();
    expect(unitlessMeshExtent('ply', encoder.encode('not a mesh'))).toBeNull();
    expect(
      unitlessMeshExtent(
        'ply',
        asciiPly(
          fanBox(2, 1, 5),
          ['double', 'float', 'int'],
          ['comment end_header ']
        )
      )
    ).toEqual([2, 2, 5]);
  });
});
