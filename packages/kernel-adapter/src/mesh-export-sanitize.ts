import { unzipSync, zipSync } from 'fflate';

function triangleHasArea(
  positions: readonly number[],
  a: number,
  b: number,
  c: number
): boolean {
  const vertexCount = Math.floor(positions.length / 3);
  for (const index of [a, b, c]) {
    if (!Number.isInteger(index) || index < 0 || index >= vertexCount)
      throw new Error(`Mesh export contains invalid vertex index ${index}.`);
  }
  const ax = positions[a * 3]!;
  const ay = positions[a * 3 + 1]!;
  const az = positions[a * 3 + 2]!;
  const ux = positions[b * 3]! - ax;
  const uy = positions[b * 3 + 1]! - ay;
  const uz = positions[b * 3 + 2]! - az;
  const vx = positions[c * 3]! - ax;
  const vy = positions[c * 3 + 1]! - ay;
  const vz = positions[c * 3 + 2]! - az;
  const cross = [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx];
  if (![ax, ay, az, ux, uy, uz, vx, vy, vz, ...cross].every(Number.isFinite))
    throw new Error('Mesh export contains a non-finite coordinate.');
  return cross.some((component) => component !== 0);
}

/** Remove exact zero-area records from the already-quantized binary STL. */
export function sanitizeBinaryStl(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  if (bytes.length < 84)
    throw new Error('Mesh export produced an invalid binary STL.');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const declared = view.getUint32(80, true);
  if (bytes.length !== 84 + declared * 50)
    throw new Error('Mesh export produced an invalid binary STL length.');
  const kept: Uint8Array[] = [];
  for (let triangle = 0; triangle < declared; triangle++) {
    const record = 84 + triangle * 50;
    const positions: number[] = [];
    for (let coordinate = 0; coordinate < 9; coordinate++)
      positions.push(view.getFloat32(record + 12 + coordinate * 4, true));
    if (triangleHasArea(positions, 0, 1, 2))
      kept.push(bytes.subarray(record, record + 50));
  }
  if (kept.length === 0)
    throw new Error(
      'Mesh export tessellated to zero non-degenerate triangles.'
    );
  const result = new Uint8Array(84 + kept.length * 50);
  result.set(bytes.subarray(0, 80));
  new DataView(result.buffer).setUint32(80, kept.length, true);
  kept.forEach((record, index) => result.set(record, 84 + index * 50));
  return result;
}

/** Remove exact zero-area facets from the generated 3MF model part. */
export function sanitizeThreeMfModel(model: string): string {
  return model.replace(/<mesh>([\s\S]*?)<\/mesh>/g, (meshTag, body: string) => {
    const positions = [...body.matchAll(/<vertex\b[^>]*\/>/g)].flatMap(
      ([tag]) =>
        ['x', 'y', 'z'].map((name) => {
          const value = tag.match(new RegExp(`\\b${name}="([^"]+)"`))?.[1];
          return Number(value);
        })
    );
    let kept = 0;
    const filtered = meshTag.replace(/<triangle\b[^>]*\/>/g, (tag: string) => {
      const indices = ['v1', 'v2', 'v3'].map((name) =>
        Number(tag.match(new RegExp(`\\b${name}="([^"]+)"`))?.[1])
      );
      if (!triangleHasArea(positions, indices[0]!, indices[1]!, indices[2]!))
        return '';
      kept++;
      return tag;
    });
    if (kept === 0)
      throw new Error(
        'Mesh export tessellated to zero non-degenerate triangles.'
      );
    return filtered;
  });
}

/** Remove exact zero-area facets from the generated 3MF model part. */
export function sanitizeThreeMf(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const files = unzipSync(bytes);
  const path = '3D/3dmodel.model';
  const model = files[path];
  if (!model)
    throw new Error('Mesh export produced a 3MF without a model part.');
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const sanitized = sanitizeThreeMfModel(decoder.decode(model));
  files[path] = encoder.encode(sanitized);
  return new Uint8Array(zipSync(files));
}

const PLY_SCALAR_SIZES: Record<string, number> = {
  char: 1,
  uchar: 1,
  int8: 1,
  uint8: 1,
  short: 2,
  ushort: 2,
  int16: 2,
  uint16: 2,
  int: 4,
  uint: 4,
  int32: 4,
  uint32: 4,
  float: 4,
  float32: 4,
  double: 8,
  float64: 8
};

/**
 * Remove exact zero-area triangles from a binary little-endian PLY mesh
 * export, the PLY analogue of {@link sanitizeBinaryStl}. Faces that survive
 * keep their order; vertices are compacted so no face points at a dropped
 * vertex, and both element counts are rewritten. Anything that is not the
 * tessellator's `x y z` float positions plus one triangle index list fails
 * closed rather than shipping a guessed reinterpretation.
 */
export function sanitizeBinaryPly(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const marker = new TextEncoder().encode('end_header\n');
  let headerLength = -1;
  for (let i = 0; i + marker.length <= bytes.length; i++) {
    if (marker.every((code, offset) => bytes[i + offset] === code)) {
      headerLength = i + marker.length;
      break;
    }
  }
  if (headerLength === -1)
    throw new Error('Mesh export produced a PLY without a header.');
  const header = new TextDecoder().decode(bytes.subarray(0, headerLength));
  const lines = header.split('\n');
  if (lines[0] !== 'ply' || lines[1] !== 'format binary_little_endian 1.0')
    throw new Error('Mesh export produced a non-binary PLY.');
  let vertexCount: number | null = null;
  let faceCount: number | null = null;
  let vertexStride = 0;
  let vertexProperties = 0;
  let positionsFirst = true;
  let inVertices = false;
  let inFaces = false;
  let seenElements = 0;
  for (const line of lines.slice(2)) {
    if (line === '' || line.startsWith('comment ') || line === 'end_header')
      continue;
    const element = line.match(/^element (\S+) (\d+)$/);
    if (element) {
      inVertices = element[1] === 'vertex';
      inFaces = element[1] === 'face';
      if (!inVertices && !inFaces)
        throw new Error(
          `Mesh export produced an unexpected PLY element ${element[1]}.`
        );
      seenElements++;
      if (element[1] === 'vertex') vertexCount = Number(element[2]);
      else faceCount = Number(element[2]);
      continue;
    }
    const property = line.match(/^property (\S+)(?: (\S+))? (\S+)$/);
    if (inFaces) {
      if (line !== 'property list uchar int vertex_indices')
        throw new Error('Mesh export produced an unexpected PLY layout.');
      continue;
    }
    if (!property) throw new Error('Mesh export produced an invalid PLY.');
    if (inVertices) {
      const size = PLY_SCALAR_SIZES[property[1]!];
      if (size === undefined)
        throw new Error('Mesh export produced an unexpected PLY layout.');
      // Positions must lead the vertex record as little-endian float32, so
      // the area check reads them at a known offset; anything else (normals
      // included) follows untouched.
      const expected = ['x', 'y', 'z'][vertexProperties];
      if (
        vertexProperties < 3 &&
        (line !== `property float ${expected}` || size !== 4)
      )
        positionsFirst = false;
      vertexProperties++;
      vertexStride += size;
    } else {
      throw new Error('Mesh export produced an invalid PLY.');
    }
  }
  if (
    vertexCount === null ||
    faceCount === null ||
    seenElements !== 2 ||
    !positionsFirst ||
    vertexProperties < 3 ||
    vertexStride <= 0
  )
    throw new Error('Mesh export produced an unexpected PLY layout.');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const positions: number[] = new Array<number>(vertexCount * 3);
  for (let vertex = 0; vertex < vertexCount; vertex++) {
    for (let coordinate = 0; coordinate < 3; coordinate++) {
      positions[vertex * 3 + coordinate] = view.getFloat32(
        headerLength + vertex * vertexStride + coordinate * 4,
        true
      );
    }
  }
  const keptFaces: [number, number, number][] = [];
  let offset = headerLength + vertexCount * vertexStride;
  for (let face = 0; face < faceCount; face++) {
    if (offset + 1 > bytes.length)
      throw new Error('Mesh export produced an invalid PLY length.');
    const corners = view.getUint8(offset);
    offset += 1;
    if (corners !== 3)
      throw new Error('Mesh export produced a non-triangular PLY face.');
    if (offset + 12 > bytes.length)
      throw new Error('Mesh export produced an invalid PLY length.');
    const triangle = [
      view.getInt32(offset, true),
      view.getInt32(offset + 4, true),
      view.getInt32(offset + 8, true)
    ] as [number, number, number];
    offset += 12;
    if (triangle.some((index) => index < 0 || index >= vertexCount))
      throw new Error('Mesh export produced a PLY face index out of range.');
    if (triangleHasArea(positions, triangle[0], triangle[1], triangle[2]))
      keptFaces.push(triangle);
  }
  if (offset !== bytes.length)
    throw new Error('Mesh export produced an invalid PLY length.');
  if (keptFaces.length === 0)
    throw new Error(
      'Mesh export tessellated to zero non-degenerate triangles.'
    );
  const used = new Set(keptFaces.flat());
  const remap = new Map<number, number>();
  for (const old of [...used].sort((a, b) => a - b))
    remap.set(old, remap.size);
  const rewritten = header
    .replace(/^element vertex \d+$/m, `element vertex ${remap.size}`)
    .replace(/^element face \d+$/m, `element face ${keptFaces.length}`);
  const headerBytes = new TextEncoder().encode(rewritten);
  const result = new Uint8Array(
    headerBytes.length + remap.size * vertexStride + keptFaces.length * 13
  );
  result.set(headerBytes, 0);
  for (const [old, fresh] of remap)
    result.set(
      bytes.subarray(
        headerLength + old * vertexStride,
        headerLength + (old + 1) * vertexStride
      ),
      headerBytes.length + fresh * vertexStride
    );
  const faceView = new DataView(result.buffer);
  let faceOffset = headerBytes.length + remap.size * vertexStride;
  for (const triangle of keptFaces) {
    faceView.setUint8(faceOffset, 3);
    triangle.forEach((old, corner) =>
      faceView.setInt32(faceOffset + 1 + corner * 4, remap.get(old)!, true)
    );
    faceOffset += 13;
  }
  return result;
}
