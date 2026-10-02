import { describe, expect, it } from 'vitest';
import {
  sanitizeBinaryPly,
  sanitizeBinaryStl,
  sanitizeThreeMfModel
} from '../packages/kernel-adapter/src/mesh-export-sanitize';

function binaryStl(triangles: readonly (readonly number[])[]): Uint8Array {
  const bytes = new Uint8Array(84 + triangles.length * 50);
  const view = new DataView(bytes.buffer);
  view.setUint32(80, triangles.length, true);
  triangles.forEach((positions, triangle) => {
    expect(positions).toHaveLength(9);
    positions.forEach((value, coordinate) =>
      view.setFloat32(84 + triangle * 50 + 12 + coordinate * 4, value, true)
    );
  });
  return bytes;
}

/** One binary little-endian PLY with xyz + normal float properties. */
function binaryPly(
  vertices: readonly (readonly [number, number, number])[],
  faces: readonly (readonly [number, number, number])[]
): Uint8Array {
  const header =
    'ply\n' +
    'format binary_little_endian 1.0\n' +
    `element vertex ${vertices.length}\n` +
    'property float x\n' +
    'property float y\n' +
    'property float z\n' +
    'property float nx\n' +
    'property float ny\n' +
    'property float nz\n' +
    `element face ${faces.length}\n` +
    'property list uchar int vertex_indices\n' +
    'end_header\n';
  const headerBytes = new TextEncoder().encode(header);
  const bytes = new Uint8Array(
    headerBytes.length + vertices.length * 24 + faces.length * 13
  );
  bytes.set(headerBytes, 0);
  const view = new DataView(bytes.buffer);
  vertices.forEach(([x, y, z], vertex) => {
    const base = headerBytes.length + vertex * 24;
    view.setFloat32(base, x, true);
    view.setFloat32(base + 4, y, true);
    view.setFloat32(base + 8, z, true);
  });
  faces.forEach(([a, b, c], face) => {
    const base = headerBytes.length + vertices.length * 24 + face * 13;
    view.setUint8(base, 3);
    view.setInt32(base + 1, a, true);
    view.setInt32(base + 5, b, true);
    view.setInt32(base + 9, c, true);
  });
  return bytes;
}

function readPlyCounts(bytes: Uint8Array): {
  vertices: number;
  faces: number;
  positions: number[][];
  indices: number[][];
} {
  const ascii = new TextDecoder().decode(bytes.subarray(0, 512));
  const headerEnd = ascii.indexOf('end_header\n') + 'end_header\n'.length;
  const header = ascii.slice(0, headerEnd);
  const headerLength = new TextEncoder().encode(header).length;
  const vertices = Number(header.match(/element vertex (\d+)/)?.[1]);
  const faces = Number(header.match(/element face (\d+)/)?.[1]);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // Vertices are compacted in sorted order, so read back the positions.
  const positions: number[][] = [];
  for (let vertex = 0; vertex < vertices; vertex++) {
    const base = headerLength + vertex * 24;
    positions.push([
      view.getFloat32(base, true),
      view.getFloat32(base + 4, true),
      view.getFloat32(base + 8, true)
    ]);
  }
  const indices: number[][] = [];
  let offset = headerLength + vertices * 24;
  for (let face = 0; face < faces; face++) {
    expect(view.getUint8(offset)).toBe(3);
    indices.push([
      view.getInt32(offset + 1, true),
      view.getInt32(offset + 5, true),
      view.getInt32(offset + 9, true)
    ]);
    offset += 13;
  }
  expect(offset).toBe(bytes.length);
  return { vertices, faces, positions, indices };
}

describe('exact mesh export sanitizing', () => {
  it('removes only zero-area binary STL facets', () => {
    const bytes = sanitizeBinaryStl(
      binaryStl([
        [0, 0, 0, 1, 0, 0, 0, 1, 0],
        [0, 0, 0, 1, 0, 0, 0, 0, 0],
        [0, 0, 0, 1, 0, 0, 0, 1e-12, 0]
      ])
    );

    expect(new DataView(bytes.buffer).getUint32(80, true)).toBe(2);
    expect(bytes).toHaveLength(84 + 2 * 50);
  });

  it('removes only zero-area 3MF facets and preserves its unit', () => {
    const model =
      '<model unit="millimeter"><resources><object id="1"><mesh>' +
      '<vertices>' +
      '<vertex x="0" y="0" z="0"/>' +
      '<vertex x="1" y="0" z="0"/>' +
      '<vertex x="0" y="1" z="0"/>' +
      '<vertex x="0" y="0.000000000001" z="0"/>' +
      '</vertices><triangles>' +
      '<triangle v1="0" v2="1" v3="2"/>' +
      '<triangle v1="0" v2="1" v3="0"/>' +
      '<triangle v1="0" v2="1" v3="3"/>' +
      '</triangles></mesh></object></resources></model>';

    const sanitized = sanitizeThreeMfModel(model);

    expect(sanitized).toContain('<model unit="millimeter">');
    expect(sanitized.match(/<triangle\b/g)).toHaveLength(2);
    expect(sanitized).not.toContain('v3="0"');
  });

  it('removes only zero-area binary PLY faces and compacts vertices', () => {
    const bytes = sanitizeBinaryPly(
      binaryPly(
        [
          [0, 0, 0],
          [1, 0, 0],
          [0, 1, 0],
          [9, 9, 9]
        ],
        [
          [3, 2, 1],
          [3, 3, 3],
          [0, 1, 1]
        ]
      )
    );

    // One live face survives; vertices are compacted in sorted order (old
    // 1, 2, 3 become 0, 1, 2) and the orphaned vertex 0 is gone.
    const counts = readPlyCounts(bytes);
    expect(counts.vertices).toBe(3);
    expect(counts.faces).toBe(1);
    expect(counts.indices).toEqual([[2, 1, 0]]);
    expect(counts.positions).toEqual([
      [1, 0, 0],
      [0, 1, 0],
      [9, 9, 9]
    ]);
    const ascii = new TextDecoder().decode(bytes.subarray(0, 512));
    expect(ascii).toContain('element vertex 3');
    expect(ascii).toContain('element face 1');
  });

  it('refuses a binary PLY with no non-degenerate triangle', () => {
    expect(() =>
      sanitizeBinaryPly(
        binaryPly(
          [
            [0, 0, 0],
            [1, 0, 0]
          ],
          [[0, 1, 1]]
        )
      )
    ).toThrow(/zero non-degenerate triangles/);
  });

  it('refuses a non-binary or truncated PLY', () => {
    const ascii = binaryPly(
      [
        [0, 0, 0],
        [1, 0, 0],
        [0, 1, 0]
      ],
      [[0, 1, 2]]
    );
    const asciiHeader = new TextDecoder()
      .decode(ascii)
      .replace('binary_little_endian', 'ascii');
    expect(() =>
      sanitizeBinaryPly(new TextEncoder().encode(asciiHeader))
    ).toThrow(/non-binary PLY/);
    expect(() => sanitizeBinaryPly(ascii.subarray(0, 100))).toThrow(/PLY/);
  });
});
