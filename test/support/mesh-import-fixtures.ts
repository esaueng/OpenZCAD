import type { MeshImportFormat } from '@openzcad/kernel-adapter';

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

function objBox(): Uint8Array {
  const lines = [
    ...VERTICES.map((vertex) => `v ${vertex.join(' ')}`),
    ...TRIANGLES.map(
      (triangle) => `f ${triangle.map((index) => index + 1).join(' ')}`
    )
  ];
  return encoder.encode(`${lines.join('\n')}\n`);
}

function plyBox(): Uint8Array {
  const lines = [
    'ply',
    'format ascii 1.0',
    `element vertex ${VERTICES.length}`,
    'property float x',
    'property float y',
    'property float z',
    `element face ${TRIANGLES.length}`,
    'property list uchar int vertex_index',
    'end_header',
    ...VERTICES.map((vertex) => vertex.join(' ')),
    ...TRIANGLES.map((triangle) => `3 ${triangle.join(' ')}`)
  ];
  return encoder.encode(`${lines.join('\n')}\n`);
}

function threeMfBox(): Uint8Array {
  const vertices = VERTICES.map(
    ([x, y, z]) => `<vertex x="${x}" y="${y}" z="${z}"/>`
  ).join('');
  const triangles = TRIANGLES.map(
    ([a, b, c]) => `<triangle v1="${a}" v2="${b}" v3="${c}"/>`
  ).join('');
  const model =
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<model unit="millimeter" xml:lang="en-US" ' +
    'xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">' +
    '<resources><object id="1" type="model"><mesh>' +
    `<vertices>${vertices}</vertices><triangles>${triangles}</triangles>` +
    '</mesh></object></resources>' +
    '<build><item objectid="1"/></build></model>';
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
  return storedZip([
    { name: '[Content_Types].xml', data: encoder.encode(contentTypes) },
    { name: '_rels/.rels', data: encoder.encode(relationships) },
    { name: '3D/3dmodel.model', data: encoder.encode(model) }
  ]);
}

function glbBox(): Uint8Array {
  const positions = new Float32Array(VERTICES.flat());
  const indices = new Uint16Array(TRIANGLES.flat());
  const positionBytes = new Uint8Array(positions.buffer);
  const indexBytes = new Uint8Array(indices.buffer);
  const indexOffset = align4(positionBytes.length);
  const binary = new Uint8Array(align4(indexOffset + indexBytes.length));
  binary.set(positionBytes, 0);
  binary.set(indexBytes, indexOffset);
  const json = encoder.encode(
    JSON.stringify({
      asset: { version: '2.0' },
      scene: 0,
      scenes: [{ nodes: [0] }],
      nodes: [{ mesh: 0 }],
      meshes: [
        { primitives: [{ attributes: { POSITION: 0 }, indices: 1, mode: 4 }] }
      ],
      accessors: [
        {
          bufferView: 0,
          componentType: 5126, // FLOAT
          count: VERTICES.length,
          type: 'VEC3',
          min: [0, 0, 0],
          max: [FIXTURE_BOX.x, FIXTURE_BOX.y, FIXTURE_BOX.z]
        },
        {
          bufferView: 1,
          componentType: 5123, // UNSIGNED_SHORT
          count: TRIANGLES.length * 3,
          type: 'SCALAR'
        }
      ],
      bufferViews: [
        {
          buffer: 0,
          byteOffset: 0,
          byteLength: positionBytes.length,
          target: 34962
        },
        {
          buffer: 0,
          byteOffset: indexOffset,
          byteLength: indexBytes.length,
          target: 34963
        }
      ],
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
  entries: readonly { name: string; data: Uint8Array }[]
): Uint8Array {
  const local: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = encoder.encode(entry.name);
    const crc = crc32(entry.data);
    const header = new Uint8Array(30 + name.length);
    const headerView = new DataView(header.buffer);
    headerView.setUint32(0, 0x04034b50, true);
    headerView.setUint16(4, 20, true); // version needed
    headerView.setUint16(8, 0, true); // stored
    headerView.setUint32(14, crc, true);
    headerView.setUint32(18, entry.data.length, true);
    headerView.setUint32(22, entry.data.length, true);
    headerView.setUint16(26, name.length, true);
    header.set(name, 30);
    local.push(header, entry.data);

    const directory = new Uint8Array(46 + name.length);
    const directoryView = new DataView(directory.buffer);
    directoryView.setUint32(0, 0x02014b50, true);
    directoryView.setUint16(4, 20, true); // version made by
    directoryView.setUint16(6, 20, true); // version needed
    directoryView.setUint16(10, 0, true); // stored
    directoryView.setUint32(16, crc, true);
    directoryView.setUint32(20, entry.data.length, true);
    directoryView.setUint32(24, entry.data.length, true);
    directoryView.setUint16(28, name.length, true);
    directoryView.setUint32(42, offset, true);
    directory.set(name, 46);
    central.push(directory);
    offset += header.length + entry.data.length;
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
  readonly [K in MeshImportFormat]: () => Uint8Array;
} = {
  '3mf': threeMfBox,
  obj: objBox,
  glb: glbBox,
  ply: plyBox
};

export function meshFixture(format: MeshImportFormat): Uint8Array {
  return MESH_FIXTURE_BUILDERS[format]();
}
