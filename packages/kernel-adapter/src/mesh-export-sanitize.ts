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
