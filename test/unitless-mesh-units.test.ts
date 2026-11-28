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

    it('reads an integer-position PLY by scaling after the translator, to the same size', async () => {
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
      expect(scaleUnitlessMeshFile('ply', integers, INCH)).toBeNull();
      const read = await importMeshFile('ply', integers, 'mm', 'inch');
      const millimetres = await importMeshFile(
        'ply',
        ply('double', INCH),
        'mm'
      );
      expectSameGeometry(read, millimetres, 1e-9);
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
      scaleUnitlessMeshFile('obj', encoder.encode(source), 10)!
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
    const scaled = scaleUnitlessMeshFile('ply', bytes, INCH)!;
    const out = new DataView(scaled.buffer, scaled.byteOffset);
    expect(out.getFloat64(header.length, false)).toBe(1.5 * INCH);
    expect(out.getFloat64(header.length + 8, false)).toBe(-2 * INCH);
    expect(out.getFloat64(header.length + 16, false)).toBe(0.125 * INCH);
    expect(scaled.subarray(header.length + 24)).toEqual(
      bytes.subarray(header.length + 24)
    );
    expect(scaled.subarray(0, header.length)).toEqual(header);
  });

  it('leaves a file it cannot read for the translator to refuse', () => {
    const notPly = encoder.encode('not a mesh');
    expect(scaleUnitlessMeshFile('ply', notPly, INCH)).toBe(notPly);
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
});
