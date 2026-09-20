import { readFileSync } from 'node:fs';

import type { MeshImportFormat } from '@openzcad/kernel-adapter/mesh-import-formats';

/**
 * The same box in every mesh interchange format the importers read.
 *
 * Generated rather than committed: each file is a few hundred bytes of shape
 * anyone can check by eye, and a fixture that is written here cannot drift
 * away from the geometry the assertions expect. One shape across all four
 * formats is also what makes their results comparable — every import must
 * produce the same twelve triangles and the same 24 mm³.
 */
export const FIXTURE_BOX = { x: 2, y: 3, z: 4 } as const;
export const FIXTURE_BOX_VOLUME = FIXTURE_BOX.x * FIXTURE_BOX.y * FIXTURE_BOX.z;
export const FIXTURE_BOX_TRIANGLES = 12;

const VERTICES: readonly (readonly [number, number, number])[] = [
  [0, 0, 0],
  [FIXTURE_BOX.x, 0, 0],
  [FIXTURE_BOX.x, FIXTURE_BOX.y, 0],
  [0, FIXTURE_BOX.y, 0],
  [0, 0, FIXTURE_BOX.z],
  [FIXTURE_BOX.x, 0, FIXTURE_BOX.z],
  [FIXTURE_BOX.x, FIXTURE_BOX.y, FIXTURE_BOX.z],
  [0, FIXTURE_BOX.y, FIXTURE_BOX.z]
];

/** Outward-facing triangles, so the box encloses a positive volume. */
const TRIANGLES: readonly (readonly [number, number, number])[] = [
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

const encoder = new TextEncoder();

/**
 * The box, `count` times over, each copy clear of the last.
 *
 * OBJ carries no object container the translator reports separately — several
 * disjoint boxes come back as one solid holding several shells — which is why
 * a guard that counts solids never sees them.
 */
export function objFixture(count = 1): Uint8Array {
  const lines: string[] = [];
  for (let copy = 0; copy < count; copy += 1) {
    const offset = copy * FIXTURE_OBJECT_PITCH;
    for (const [x, y, z] of VERTICES) {
      lines.push(`v ${x + offset} ${y} ${z}`);
    }
  }
  for (let copy = 0; copy < count; copy += 1) {
    const base = copy * VERTICES.length + 1;
    for (const triangle of TRIANGLES) {
      lines.push(`f ${triangle.map((index) => index + base).join(' ')}`);
    }
  }
  return encoder.encode(`${lines.join('\n')}\n`);
}

export function plyFixture(count = 1): Uint8Array {
  const vertices: string[] = [];
  const faces: string[] = [];
  for (let copy = 0; copy < count; copy += 1) {
    const offset = copy * FIXTURE_OBJECT_PITCH;
    const base = copy * VERTICES.length;
    for (const [x, y, z] of VERTICES) {
      vertices.push(`${x + offset} ${y} ${z}`);
    }
    for (const triangle of TRIANGLES) {
      faces.push(`3 ${triangle.map((index) => index + base).join(' ')}`);
    }
  }
  const lines = [
    'ply',
    'format ascii 1.0',
    `element vertex ${vertices.length}`,
    'property float x',
    'property float y',
    'property float z',
    `element face ${faces.length}`,
    'property list uchar int vertex_index',
    'end_header',
    ...vertices,
    ...faces
  ];
  return encoder.encode(`${lines.join('\n')}\n`);
}

/**
 * How a 3MF package under test differs from the plain one-box default.
 *
 * A 3MF is the only mesh format here that declares its own length unit, the
 * only one that routinely holds several objects, and the only one whose
 * `<build>` section says where each of them goes — so the unit, the resources,
 * the build items and their matrices are the axes the 3MF cases vary, plus the
 * Zip compression every real exporter uses and the fixture writer does not.
 */
export interface ThreeMfOptions {
  /** The `unit` attribute to declare; omitted entirely when null. */
  readonly unit?: string | null;
  /** How many box object resources to write, each offset clear of the last. */
  readonly objects?: number;
  /**
   * The `<build>` items to write. Defaults to one identity item per object,
   * which is what an ordinary single-plate export looks like.
   */
  readonly items?: readonly ThreeMfItem[];
  /** Write no `<build>` element at all. */
  readonly omitBuild?: boolean;
  /**
   * Append an object composed of `<components>` rather than its own mesh,
   * referencing object 1.
   */
  readonly componentObject?: boolean;
  /**
   * Pad the `<model>` element's `name` attribute out to this many characters.
   *
   * Legal XML that withholds a `>` for as long as it likes, which is what the
   * model-part scan's carry buffer has to survive: a modest padding is a file
   * the scan must still read, and a huge one is a file it must refuse rather
   * than accumulate and rescan.
   */
  readonly namePadding?: number;
}

/** One `<build><item>`: which object it places, and the matrix it places it with. */
export interface ThreeMfItem {
  readonly objectid: number | string;
  /** The twelve numbers of a 3MF transform, verbatim. */
  readonly transform?: string;
  /** A `path` attribute, for the production-extension refusal. */
  readonly path?: string;
}

/** The 3MF core format's own default when `<model>` omits `unit`. */
export const THREE_MF_UNIT_MILLIMETRES: Readonly<Record<string, number>> = {
  micron: 0.001,
  millimeter: 1,
  centimeter: 10,
  inch: 25.4,
  foot: 304.8,
  meter: 1000
};

/** The offset that keeps the nth fixture box clear of the one before it. */
export const FIXTURE_OBJECT_PITCH = FIXTURE_BOX.x + 1;

function threeMfModelXml(options: ThreeMfOptions = {}): string {
  const count = options.objects ?? 1;
  const unit = options.unit === undefined ? 'millimeter' : options.unit;
  const meshes = Array.from({ length: count }, (_unused, index) => {
    // Each object clear of the last, so several of them are genuinely
    // separate shells rather than one merged solid.
    const offset = index * FIXTURE_OBJECT_PITCH;
    const vertices = VERTICES.map(
      ([x, y, z]) => `<vertex x="${x + offset}" y="${y}" z="${z}"/>`
    ).join('');
    const triangles = TRIANGLES.map(
      ([a, b, c]) => `<triangle v1="${a}" v2="${b}" v3="${c}"/>`
    ).join('');
    return (
      `<object id="${index + 1}" type="model"><mesh>` +
      `<vertices>${vertices}</vertices><triangles>${triangles}</triangles>` +
      '</mesh></object>'
    );
  }).join('');
  const composed = options.componentObject
    ? `<object id="${count + 1}" type="model"><components>` +
      '<component objectid="1"/></components></object>'
    : '';
  const items: readonly ThreeMfItem[] =
    options.items ??
    Array.from({ length: count }, (_unused, index) => ({
      objectid: index + 1
    }));
  const placed = items
    .map(
      (item) =>
        `<item objectid="${item.objectid}"` +
        (item.transform === undefined ? '' : ` transform="${item.transform}"`) +
        (item.path === undefined ? '' : ` path="${item.path}"`) +
        '/>'
    )
    .join('');
  const name =
    options.namePadding === undefined
      ? ''
      : ` name="${'A'.repeat(options.namePadding)}"`;
  return (
    '<?xml version="1.0" encoding="UTF-8"?>' +
    `<model${unit === null ? '' : ` unit="${unit}"`}${name} xml:lang="en-US" ` +
    'xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">' +
    `<resources>${meshes}${composed}</resources>` +
    (options.omitBuild ? '' : `<build>${placed}</build>`) +
    '</model>'
  );
}

function threeMfParts(
  options: ThreeMfOptions
): { name: string; data: Uint8Array }[] {
  const model = threeMfModelXml(options);
  const contentTypes =
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>' +
    '</Types>';
  const relationships =
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Target="/3D/3dmodel.model" Id="rel0" ' +
    'Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>' +
    '</Relationships>';
  return [
    { name: '[Content_Types].xml', data: encoder.encode(contentTypes) },
    { name: '_rels/.rels', data: encoder.encode(relationships) },
    { name: '3D/3dmodel.model', data: encoder.encode(model) }
  ];
}

function threeMfBox(options: ThreeMfOptions = {}): Uint8Array {
  return storedZip(threeMfParts(options));
}

/** A 3MF package built to order: a declared unit, or several objects. */
export function threeMfFixture(options: ThreeMfOptions): Uint8Array {
  return threeMfBox(options);
}

/**
 * The same package with every part deflated, which is what a real exporter
 * writes. The stored-entry fixtures above exercise the reader's easy path;
 * this one is the path production files actually take.
 */
export async function deflatedThreeMfFixture(
  options: ThreeMfOptions = {}
): Promise<Uint8Array> {
  const parts = threeMfParts(options);
  const bodies = await Promise.all(
    parts.map((part) => deflateRaw(part.data))
  );
  return storedZip(parts, bodies);
}

async function deflateRaw(data: Uint8Array): Promise<Uint8Array> {
  // `BufferSource`, because that is what the compression streams accept.
  const source = new ReadableStream<BufferSource>({
    start(controller) {
      controller.enqueue(new Uint8Array(data));
      controller.close();
    }
  });
  const reader = source
    .pipeThrough(new CompressionStream('deflate-raw'))
    .getReader();
  const chunks: Uint8Array[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    chunks.push(value);
  }
  return concat(chunks);
}

/**
 * A plate 2 mm x 3 mm across and `thicknessMm` thick, as an OBJ.
 *
 * The thickness is the point: `importMeshSolid` sews at a tolerance derived
 * from the numbers it is handed, so a plate thin enough sews cleanly in
 * millimetres and collapses in metres. That is what makes it the fixture for
 * a rebuild check that runs at the wrong scale.
 */
export function thinPlateObj(thicknessMm: number): Uint8Array {
  const plate: readonly (readonly [number, number, number])[] = [
    [0, 0, 0],
    [FIXTURE_BOX.x, 0, 0],
    [FIXTURE_BOX.x, FIXTURE_BOX.y, 0],
    [0, FIXTURE_BOX.y, 0],
    [0, 0, thicknessMm],
    [FIXTURE_BOX.x, 0, thicknessMm],
    [FIXTURE_BOX.x, FIXTURE_BOX.y, thicknessMm],
    [0, FIXTURE_BOX.y, thicknessMm]
  ];
  const lines = [
    ...plate.map(([x, y, z]) => `v ${x} ${y} ${z}`),
    ...TRIANGLES.map(
      (triangle) => `f ${triangle.map((index) => index + 1).join(' ')}`
    )
  ];
  return encoder.encode(`${lines.join('\n')}\n`);
}

/**
 * Two copies of the fixture box in the same place: 24 triangles that weld into
 * a non-manifold soup the sew refuses.
 *
 * The kernel-read formats put this through the import-time rebuild check and
 * refuse it by name. STL keeps its own parser and does not, which is the one
 * carve-out the README documents — this soup is how both halves are measured
 * against the same triangles.
 */
export function coincidentBoxSoup(): {
  vertices: number[];
  indices: number[];
  triangleCount: number;
} {
  const vertices: number[] = [];
  const indices: number[] = [];
  for (let copy = 0; copy < 2; copy += 1) {
    const base = vertices.length / 3;
    for (const [x, y, z] of VERTICES) {
      vertices.push(x, y, z);
    }
    for (const triangle of TRIANGLES) {
      indices.push(triangle[0] + base, triangle[1] + base, triangle[2] + base);
    }
  }
  return { vertices, indices, triangleCount: indices.length / 3 };
}

/** The box, `count` times over, each copy its own glTF mesh and node. */
export function glbFixture(count = 1): Uint8Array {
  const accessors: unknown[] = [];
  const bufferViews: unknown[] = [];
  const meshes: unknown[] = [];
  const nodes: unknown[] = [];
  const parts: Uint8Array[] = [];
  let offset = 0;
  const pad = (to: number): void => {
    if (to > offset) {
      parts.push(new Uint8Array(to - offset));
      offset = to;
    }
  };
  for (let copy = 0; copy < count; copy += 1) {
    const shift = copy * FIXTURE_OBJECT_PITCH;
    const positions = new Float32Array(
      VERTICES.flatMap(([x, y, z]) => [x + shift, y, z])
    );
    const indices = new Uint16Array(TRIANGLES.flat());
    const positionBytes = new Uint8Array(positions.buffer.slice(0));
    const indexBytes = new Uint8Array(indices.buffer.slice(0));
    pad(align4(offset));
    const positionOffset = offset;
    parts.push(positionBytes);
    offset += positionBytes.length;
    pad(align4(offset));
    const indexOffset = offset;
    parts.push(indexBytes);
    offset += indexBytes.length;
    bufferViews.push(
      {
        buffer: 0,
        byteOffset: positionOffset,
        byteLength: positionBytes.length,
        target: 34962
      },
      {
        buffer: 0,
        byteOffset: indexOffset,
        byteLength: indexBytes.length,
        target: 34963
      }
    );
    accessors.push(
      {
        bufferView: copy * 2,
        componentType: 5126, // FLOAT
        count: VERTICES.length,
        type: 'VEC3',
        min: [shift, 0, 0],
        max: [FIXTURE_BOX.x + shift, FIXTURE_BOX.y, FIXTURE_BOX.z]
      },
      {
        bufferView: copy * 2 + 1,
        componentType: 5123, // UNSIGNED_SHORT
        count: TRIANGLES.length * 3,
        type: 'SCALAR'
      }
    );
    meshes.push({
      primitives: [
        {
          attributes: { POSITION: copy * 2 },
          indices: copy * 2 + 1,
          mode: 4
        }
      ]
    });
    nodes.push({ mesh: copy });
  }
  pad(align4(offset));
  const binary = concat(parts);
  const json = encoder.encode(
    JSON.stringify({
      asset: { version: '2.0' },
      scene: 0,
      scenes: [{ nodes: nodes.map((_unused, index) => index) }],
      nodes,
      meshes,
      accessors,
      bufferViews,
      buffers: [{ byteLength: binary.length }]
    })
  );
  // Chunks are 4-byte aligned; JSON pads with spaces, BIN with zeroes.
  const jsonChunk = new Uint8Array(align4(json.length)).fill(0x20);
  jsonChunk.set(json, 0);
  const total = 12 + 8 + jsonChunk.length + 8 + binary.length;
  const glb = new Uint8Array(total);
  const view = new DataView(glb.buffer);
  view.setUint32(0, 0x46546c67, true); // "glTF"
  view.setUint32(4, 2, true);
  view.setUint32(8, total, true);
  view.setUint32(12, jsonChunk.length, true);
  view.setUint32(16, 0x4e4f534a, true); // "JSON"
  glb.set(jsonChunk, 20);
  const binaryHeader = 20 + jsonChunk.length;
  view.setUint32(binaryHeader, binary.length, true);
  view.setUint32(binaryHeader + 4, 0x004e4942, true); // "BIN"
  glb.set(binary, binaryHeader + 8);
  return glb;
}

function align4(length: number): number {
  return Math.ceil(length / 4) * 4;
}

/**
 * A 3MF is a Zip package, and the repository has no Zip writer outside the
 * Shapr3D importer's dependency. Stored (uncompressed) entries need no
 * deflate, so a valid package is a header, a body and a directory per file.
 */
function storedZip(
  entries: readonly { name: string; data: Uint8Array }[],
  deflated: readonly Uint8Array[] | null = null
): Uint8Array {
  const local: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const [index, entry] of entries.entries()) {
    const name = encoder.encode(entry.name);
    const crc = crc32(entry.data);
    const body = deflated?.[index] ?? entry.data;
    const method = deflated ? 8 : 0;
    const header = new Uint8Array(30 + name.length);
    const headerView = new DataView(header.buffer);
    headerView.setUint32(0, 0x04034b50, true);
    headerView.setUint16(4, 20, true); // version needed
    headerView.setUint16(8, method, true);
    headerView.setUint32(14, crc, true);
    headerView.setUint32(18, body.length, true);
    headerView.setUint32(22, entry.data.length, true);
    headerView.setUint16(26, name.length, true);
    header.set(name, 30);
    local.push(header, body);

    const directory = new Uint8Array(46 + name.length);
    const directoryView = new DataView(directory.buffer);
    directoryView.setUint32(0, 0x02014b50, true);
    directoryView.setUint16(4, 20, true); // version made by
    directoryView.setUint16(6, 20, true); // version needed
    directoryView.setUint16(10, method, true);
    directoryView.setUint32(16, crc, true);
    directoryView.setUint32(20, body.length, true);
    directoryView.setUint32(24, entry.data.length, true);
    directoryView.setUint16(28, name.length, true);
    directoryView.setUint32(42, offset, true);
    directory.set(name, 46);
    central.push(directory);
    offset += header.length + body.length;
  }
  const centralSize = central.reduce((total, part) => total + part.length, 0);
  const end = new Uint8Array(22);
  const endView = new DataView(end.buffer);
  endView.setUint32(0, 0x06054b50, true);
  endView.setUint16(8, entries.length, true);
  endView.setUint16(10, entries.length, true);
  endView.setUint32(12, centralSize, true);
  endView.setUint32(16, offset, true);
  return concat([...local, ...central, end]);
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(
    parts.reduce((total, part) => total + part.length, 0)
  );
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export const MESH_FIXTURE_BUILDERS: {
  readonly [K in MeshImportFormat]: (count?: number) => Uint8Array;
} = {
  '3mf': (count = 1) => threeMfBox({ objects: count }),
  obj: objFixture,
  glb: glbFixture,
  ply: plyFixture
};

/**
 * The fixture box in one format, `count` copies of it, each clear of the last.
 *
 * Several copies is the case the import has to get right rather than refuse:
 * the copies are separate shells, and whether separate shells become one body
 * is the kernel's answer, not a count's.
 */
export function meshFixture(
  format: MeshImportFormat,
  count = 1
): Uint8Array {
  return MESH_FIXTURE_BUILDERS[format](count);
}

const COMMITTED_MESH_FIXTURE_PATHS: Readonly<Record<MeshImportFormat, string>> =
  {
    '3mf': '../fixtures/mesh-import/box.3mf.b64',
    obj: '../fixtures/mesh-import/box.obj',
    glb: '../fixtures/mesh-import/box.glb.b64',
    ply: '../fixtures/mesh-import/box.ply'
  };

/**
 * Read the committed per-format parity payload, independent of the builders
 * above. Base64 keeps the binary GLB and 3MF fixtures source-only and easy to
 * review; the production importer still receives their decoded bytes.
 */
export function committedMeshFixture(format: MeshImportFormat): Uint8Array {
  const source = readFileSync(
    new URL(COMMITTED_MESH_FIXTURE_PATHS[format], import.meta.url)
  );
  if (format === '3mf' || format === 'glb') {
    return Uint8Array.from(
      Buffer.from(source.toString('ascii').trim(), 'base64')
    );
  }
  return Uint8Array.from(source);
}
