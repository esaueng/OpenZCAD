import { inflateRawSync } from 'node:zlib';

/** Read the model part emitted by our exporter, independently of Remus import.
 * This test helper accepts generated single-part ZIPs, not arbitrary uploads.
 */
export function exportedModel(bytes: Uint8Array): string {
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

function xmlAttribute(tag: string, name: string): string | null {
  const raw = new RegExp(`\\s${name}="([^"]*)"`).exec(tag)?.[1];
  return raw === undefined
    ? null
    : raw
        .replace(/&#(\d+);/g, (_, code: string) =>
          String.fromCharCode(Number(code))
        )
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&amp;/g, '&');
}

/** Each property group's colours by id: core `basematerials` and `m:colorgroup`. */
function threeMfColorGroups(xml: string) {
  const base = new Map<string, (string | null)[]>();
  for (const [, attributes, body] of xml.matchAll(
    /<basematerials\b([^>]*)>([\s\S]*?)<\/basematerials>/g
  )) {
    const id = xmlAttribute(attributes!, 'id');
    if (id === null) throw new Error('A basematerials group has no id');
    base.set(
      id,
      [...body!.matchAll(/<base\b[^>]*>/g)].map(([tag]) =>
        xmlAttribute(tag, 'displaycolor')
      )
    );
  }
  const color = new Map<string, (string | null)[]>();
  for (const [, attributes, body] of xml.matchAll(
    /<m:colorgroup\b([^>]*)>([\s\S]*?)<\/m:colorgroup>/g
  )) {
    const id = xmlAttribute(attributes!, 'id');
    if (id === null) throw new Error('An m:colorgroup has no id');
    color.set(
      id,
      [...body!.matchAll(/<m:color\b[^>]*>/g)].map(([tag]) =>
        xmlAttribute(tag, 'color')
      )
    );
  }
  return { base, color };
}

function objectProperty(tag: string) {
  return {
    name: xmlAttribute(tag, 'name'),
    pid: xmlAttribute(tag, 'pid'),
    pindex: Number(xmlAttribute(tag, 'pindex') ?? 0)
  };
}

/**
 * Each written object's name and colour, in document order, the way a 3MF
 * reader with the Materials extension resolves them: `name` on the object,
 * and the colour its `pid`/`pindex` select in a `basematerials` group or an
 * `m:colorgroup`. Independent of the writer, so a round trip compares two
 * separate readings of the format.
 */
export function threeMfObjectLabels(bytes: Uint8Array) {
  const xml = exportedModel(bytes);
  const { base, color } = threeMfColorGroups(xml);
  return [...xml.matchAll(/<object\b[^>]*>/g)].map(([tag]) => {
    const { name, pid, pindex } = objectProperty(tag);
    const group = pid === null ? undefined : (base.get(pid) ?? color.get(pid));
    if (pid !== null && group === undefined)
      throw new Error(`Object pid ${pid} names no colour group`);
    return { name, color: group?.[pindex] ?? null };
  });
}

/**
 * The filament each object starts on, as OrcaSlicer's 3MF importer assigns
 * it (`bbs_3mf.cpp`, main 2026-11-20): it reads only `m:colorgroup`, keeps
 * the LAST `m:color` of each group, numbers distinct colours 1, 2… in
 * ascending group id, and looks the object's `pid` up, ignoring `pindex`.
 * An object it cannot match stays on filament 1 (null here).
 */
export function orcaSlicerFilaments(bytes: Uint8Array) {
  const xml = exportedModel(bytes);
  const { color } = threeMfColorGroups(xml);
  const groupColor = new Map(
    [...color].map(([id, colors]) => [id, colors.at(-1) ?? null])
  );
  const filamentOf = new Map<string, number>();
  const groupFilament = new Map<string, number>();
  for (const id of [...groupColor.keys()].sort(
    (a, b) => Number(a) - Number(b)
  )) {
    const value = groupColor.get(id)!;
    if (value === null) continue;
    if (!filamentOf.has(value)) filamentOf.set(value, filamentOf.size + 1);
    groupFilament.set(id, filamentOf.get(value)!);
  }
  return [...xml.matchAll(/<object\b[^>]*>/g)].map(([tag]) => {
    const { pid } = objectProperty(tag);
    return pid === null ? null : (groupFilament.get(pid) ?? null);
  });
}

/**
 * The filament each object starts on, as Bambu Studio's importer assigns it
 * (`bbs_3mf.cpp`, main 2026-11-17): `basematerials` and `m:colorgroup`
 * entries alike, numbered by distinct colour in ascending group id then
 * entry order, looked up by the object's `pid` and `pindex` (an index out
 * of range reads entry 0).
 */
export function bambuStudioFilaments(bytes: Uint8Array) {
  const xml = exportedModel(bytes);
  const { base, color } = threeMfColorGroups(xml);
  const groups = new Map([...base, ...color]);
  const filamentOf = new Map<string, number>();
  const entryFilament = new Map<string, number>();
  for (const id of [...groups.keys()].sort((a, b) => Number(a) - Number(b))) {
    groups.get(id)!.forEach((value, index) => {
      if (value === null) return;
      if (!filamentOf.has(value)) filamentOf.set(value, filamentOf.size + 1);
      entryFilament.set(`${id}:${index}`, filamentOf.get(value)!);
    });
  }
  return [...xml.matchAll(/<object\b[^>]*>/g)].map(([tag]) => {
    const { pid, pindex } = objectProperty(tag);
    if (pid === null || !groups.get(pid)?.length) return null;
    const entries = groups.get(pid)!;
    const index = pindex >= 0 && pindex < entries.length ? pindex : 0;
    return entryFilament.get(`${pid}:${index}`) ?? null;
  });
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
