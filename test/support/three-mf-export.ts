import { inflateRawSync } from 'node:zlib';

/** Read the model part emitted by our exporter, independently of Remus import.
 * This test helper accepts generated single-part ZIPs, not arbitrary uploads.
 */
function exportedModel(bytes: Uint8Array): string {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const end = bytes.length - 22;
  if (view.getUint32(end, true) !== 0x06054b50)
    throw new Error('Missing ZIP directory');
  let offset = view.getUint32(end + 16, true);
  for (let i = 0; i < view.getUint16(end + 10, true); i++) {
    if (view.getUint32(offset, true) !== 0x02014b50)
      throw new Error('Invalid ZIP entry');
    const length = view.getUint16(offset + 28, true);
    const name = new TextDecoder().decode(
      bytes.subarray(offset + 46, offset + 46 + length)
    );
    if (name === '3D/3dmodel.model') {
      const local = view.getUint32(offset + 42, true);
      const start =
        local +
        30 +
        view.getUint16(local + 26, true) +
        view.getUint16(local + 28, true);
      const body = bytes.subarray(
        start,
        start + view.getUint32(offset + 20, true)
      );
      const method = view.getUint16(offset + 10, true);
      if (method !== 0 && method !== 8)
        throw new Error('Unsupported ZIP compression');
      return new TextDecoder().decode(
        method === 8 ? inflateRawSync(body) : body
      );
    }
    offset +=
      46 +
      length +
      view.getUint16(offset + 30, true) +
      view.getUint16(offset + 32, true);
  }
  throw new Error('Missing 3MF model');
}

/** Read the length unit declared by the generated 3MF model part. */
export function threeMfExportUnit(bytes: Uint8Array): string {
  const model = exportedModel(bytes);
  const unit = model.match(/<model\b[^>]*\bunit="([^"]+)"/)?.[1];
  if (!unit) throw new Error('Missing 3MF model unit');
  return unit;
}

/** Measure the indexed triangles actually written, without import-time welding. */
export function measureThreeMfExport(bytes: Uint8Array) {
  const xml = exportedModel(bytes);
  return [...xml.matchAll(/<mesh>([\s\S]*?)<\/mesh>/g)].map((match) => {
    const attributes = (tag: string, names: string[]) =>
      names.map((name) => {
        const value = tag.match(new RegExp(`\\b${name}="([^"]+)"`))?.[1];
        if (value === undefined || !Number.isFinite(Number(value)))
          throw new Error('Invalid mesh coordinate or index');
        return Number(value);
      });
    const vertices = [...match[1]!.matchAll(/<vertex\b[^>]*\/>/g)].map(
      ([tag]) => attributes(tag, ['x', 'y', 'z'])
    );
    const triangles = [...match[1]!.matchAll(/<triangle\b[^>]*\/>/g)].map(
      ([tag]) => attributes(tag, ['v1', 'v2', 'v3'])
    );
    const canonicalIds = new Map<string, number>();
    const canonical = vertices.map((vertex) => {
      const key = vertex.join(',');
      if (!canonicalIds.has(key)) canonicalIds.set(key, canonicalIds.size);
      return canonicalIds.get(key)!;
    });
    const edges = new Map<string, number[]>();
    let volume = 0;
    let degenerateTriangles = 0;
    for (const indices of triangles) {
      if (
        indices.some(
          (i) => !Number.isInteger(i) || i < 0 || i >= vertices.length
        )
      )
        throw new Error('Invalid triangle index');
      const [a, b, c] = indices.map((i) => vertices[i]!);
      const welded = indices.map((i) => canonical[i]!);
      if (new Set(welded).size !== 3) degenerateTriangles++;
      volume +=
        (a![0]! * (b![1]! * c![2]! - b![2]! * c![1]!) -
          a![1]! * (b![0]! * c![2]! - b![2]! * c![0]!) +
          a![2]! * (b![0]! * c![1]! - b![1]! * c![0]!)) /
        6;
      for (let i = 0; i < 3; i++) {
        const x = welded[i]!,
          y = welded[(i + 1) % 3]!;
        const key = x < y ? `${x}:${y}` : `${y}:${x}`;
        const uses = edges.get(key) ?? [];
        uses.push(x < y ? 1 : -1);
        edges.set(key, uses);
      }
    }
    return {
      triangles: triangles.length,
      volume,
      degenerateTriangles,
      invalidEdges: [...edges.values()].filter(
        (uses) => uses.length !== 2 || uses[0]! + uses[1]! !== 0
      ).length
    };
  });
}
