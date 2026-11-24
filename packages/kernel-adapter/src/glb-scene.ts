/**
 * glTF's coordinate contract, on both sides of the GLB translators.
 *
 * glTF defines its linear unit as the metre and its up axis as +Y, with +Z
 * the front; the model space here is millimetres with +Z up and -Y the front.
 * The pinned writer ignores both: it emits the millimetre, Z-up numbers with
 * a bare `{ mesh: 0 }` node, so a 65 mm part arrived in every glTF viewer as
 * 65 m lying on its back. The pinned reader (Remus 2026.1.161 and later)
 * places the selected scene's mesh instances itself, but welds the placed
 * vertices at its fixed 1e-7 tolerance, and places a scene-less file's meshes
 * at identity even when its parentless nodes carry a transform. So the import
 * hands the reader the file with every node transform at identity, so it
 * reads and welds each mesh in the units it was authored in, exactly as the
 * reader did before it placed instances, and applies the scene's one world
 * transform here afterwards.
 *
 * Both directions go through the node graph rather than the vertex data: the
 * export keeps the translator's millimetre tessellation and wraps the scene in
 * one root node that scales by 1/1000 and turns Z-up into Y-up, which every
 * reader that honours glTF composes back to metres; the import reads the
 * scene's world transform and composes it with the inverse, so a file written
 * here comes back exactly, and one written in
 * metres by any other tool comes in at its real size and the right way up.
 */

/** Millimetres per glTF unit. */
const MILLIMETRES_PER_METRE = 1000;

const GLB_MAGIC = 0x46546c67; // "glTF"
const CHUNK_JSON = 0x4e4f534a; // "JSON"

/** The writer's extra root: millimetres to metres, then Z-up to Y-up. */
export const GLTF_ROOT_NAME = 'OpenZCAD millimetres, Z up';

/** -90° about X, as an [x, y, z, w] quaternion: model +Z becomes glTF +Y. */
const Z_UP_TO_Y_UP: readonly number[] = [-Math.SQRT1_2, 0, 0, Math.SQRT1_2];

interface GlbChunks {
  readonly json: GltfJson;
  readonly jsonSource: string;
  /** Everything after the JSON chunk, byte for byte (the BIN chunk). */
  readonly rest: Uint8Array;
}

interface GltfNode {
  name?: string;
  mesh?: number;
  children?: number[];
  matrix?: number[];
  translation?: number[];
  rotation?: number[];
  scale?: number[];
}

interface GltfJson {
  scene?: number;
  scenes?: { nodes?: number[] }[];
  nodes?: GltfNode[];
  meshes?: unknown[];
  [key: string]: unknown;
}

function readGlb(data: Uint8Array): GlbChunks {
  if (data.byteLength < 20) {
    throw new Error('This file is too short to be a GLB.');
  }
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  if (view.getUint32(0, true) !== GLB_MAGIC) {
    throw new Error('This file is not a GLB: it does not start with "glTF".');
  }
  const jsonLength = view.getUint32(12, true);
  if (
    view.getUint32(16, true) !== CHUNK_JSON ||
    20 + jsonLength > data.byteLength
  ) {
    throw new Error('This GLB has no readable JSON chunk.');
  }
  const jsonSource = new TextDecoder('utf-8', {
    fatal: true,
    ignoreBOM: true
  }).decode(data.subarray(20, 20 + jsonLength));
  const json = JSON.parse(jsonSource) as GltfJson;
  return { json, jsonSource, rest: data.subarray(20 + jsonLength) };
}

function writeGlb(json: GltfJson, rest: Uint8Array): Uint8Array<ArrayBuffer> {
  const text = new TextEncoder().encode(JSON.stringify(json));
  // Chunks are 4-byte aligned; the JSON chunk pads with spaces.
  const jsonLength = Math.ceil(text.length / 4) * 4;
  const out = new Uint8Array(12 + 8 + jsonLength + rest.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, GLB_MAGIC, true);
  view.setUint32(4, 2, true);
  view.setUint32(8, out.length, true);
  view.setUint32(12, jsonLength, true);
  view.setUint32(16, CHUNK_JSON, true);
  out.fill(0x20, 20, 20 + jsonLength);
  out.set(text, 20);
  out.set(rest, 20 + jsonLength);
  return out;
}

/** The scene a reader shows: the declared one, else the first. */
function sceneRoots(json: GltfJson): number[] {
  const nodes = json.nodes ?? [];
  const scenes = json.scenes ?? [];
  if (scenes.length > 0) {
    return [...(scenes[json.scene ?? 0]?.nodes ?? [])];
  }
  // No scene: every node no other node claims as a child.
  const children = new Set(nodes.flatMap((node) => node.children ?? []));
  return nodes.map((_node, index) => index).filter((i) => !children.has(i));
}

/**
 * Wraps a GLB's scene in the root that states its units and up axis.
 *
 * The vertices stay the translator's millimetres; only the scene graph
 * changes, so the tessellation and its deflection are exactly the ones the
 * other mesh formats write.
 */
export function orientGlbForGltf(data: Uint8Array): Uint8Array<ArrayBuffer> {
  const { json, rest } = readGlb(data);
  const nodes = (json.nodes ??= []);
  const root: GltfNode = {
    name: GLTF_ROOT_NAME,
    rotation: [...Z_UP_TO_Y_UP],
    scale: [1, 1, 1].map((one) => one / MILLIMETRES_PER_METRE),
    children: sceneRoots(json)
  };
  nodes.push(root);
  const scenes = (json.scenes ??= [{}]);
  scenes[json.scene ?? 0] = {
    ...scenes[json.scene ?? 0],
    nodes: [nodes.length - 1]
  };
  json.scene ??= 0;
  return writeGlb(json, rest);
}

/** A column-major 4×4, glTF's own layout. */
type Matrix4 = number[];

const IDENTITY: Matrix4 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

function multiply(a: Matrix4, b: Matrix4): Matrix4 {
  const out = new Array<number>(16).fill(0);
  for (let column = 0; column < 4; column += 1) {
    for (let row = 0; row < 4; row += 1) {
      let sum = 0;
      for (let k = 0; k < 4; k += 1) {
        sum += a[k * 4 + row]! * b[column * 4 + k]!;
      }
      out[column * 4 + row] = sum;
    }
  }
  return out;
}

/** A node property as `length` finite numbers, or a refusal naming it. */
function nodeNumbers(value: unknown, length: number, what: string): number[] {
  if (
    !Array.isArray(value) ||
    value.length !== length ||
    !value.every((entry) => typeof entry === 'number' && Number.isFinite(entry))
  ) {
    throw new Error(
      `This GLB has a node ${what} that is not ${length} numbers.`
    );
  }
  return value as number[];
}

/**
 * A node's local transform. The reader never sees these (the import hands it
 * identity nodes), so the checks it made on them are made here instead: an
 * affine matrix alone, finite numbers, and a unit quaternion within the
 * reader's 1e-4, normalised as the reader normalises it.
 */
function localMatrix(node: GltfNode): Matrix4 {
  if (node.matrix != null) {
    const m = nodeNumbers(node.matrix, 16, 'matrix');
    if (
      node.translation != null ||
      node.rotation != null ||
      node.scale != null ||
      m[3] !== 0 ||
      m[7] !== 0 ||
      m[11] !== 0 ||
      m[15] !== 1
    ) {
      throw new Error(
        'This GLB has a node matrix that is not an affine placement.'
      );
    }
    return [...m];
  }
  const [tx, ty, tz] =
    node.translation == null
      ? [0, 0, 0]
      : nodeNumbers(node.translation, 3, 'translation');
  const quaternion =
    node.rotation == null
      ? [0, 0, 0, 1]
      : nodeNumbers(node.rotation, 4, 'rotation');
  const norm = Math.hypot(...quaternion);
  if (Math.abs(norm - 1) > 1e-4) {
    throw new Error(
      'This GLB has a node rotation that is not a unit quaternion.'
    );
  }
  const [x, y, z, w] = quaternion.map((value) => value / norm);
  const [sx, sy, sz] =
    node.scale == null ? [1, 1, 1] : nodeNumbers(node.scale, 3, 'scale');
  // T · R · S, the order glTF defines.
  return [
    (1 - 2 * (y! * y! + z! * z!)) * sx!,
    2 * (x! * y! + z! * w!) * sx!,
    2 * (x! * z! - y! * w!) * sx!,
    0,
    2 * (x! * y! - z! * w!) * sy!,
    (1 - 2 * (x! * x! + z! * z!)) * sy!,
    2 * (y! * z! + x! * w!) * sy!,
    0,
    2 * (x! * z! + y! * w!) * sz!,
    2 * (y! * z! - x! * w!) * sz!,
    (1 - 2 * (x! * x! + y! * y!)) * sz!,
    0,
    tx!,
    ty!,
    tz!,
    1
  ];
}

/** glTF space (metres, +Y up) to model space (millimetres, +Z up). */
const GLTF_TO_MODEL: Matrix4 = [
  MILLIMETRES_PER_METRE,
  0,
  0,
  0,
  0,
  0,
  MILLIMETRES_PER_METRE,
  0,
  0,
  -MILLIMETRES_PER_METRE,
  0,
  0,
  0,
  0,
  0,
  1
];

function sameMatrix(a: Matrix4, b: Matrix4): boolean {
  const scale = Math.max(1, ...a.map(Math.abs), ...b.map(Math.abs));
  return a.every((value, index) => Math.abs(value - b[index]!) <= 1e-9 * scale);
}

/**
 * Where a GLB places its geometry, in model millimetres, as the twelve-number
 * row-major placement the 3MF path already applies.
 *
 * The reader is handed {@link glbWithIdentityNodes}, so it merges every mesh
 * at the place it was authored and the import can honour one world transform,
 * not one per mesh: a file whose meshes are each shown once, all under the
 * same transform (the shape every single-object export has, this app's
 * included), imports at its stated size and place. The scene is the declared
 * one, else the first, else (a file with no scenes) every parentless node. A
 * file that shows a mesh twice, places its meshes differently, hides some, or
 * places them with a transform that cannot be inverted is refused by name
 * rather than imported with its layout collapsed.
 */
export function glbPlacement(data: Uint8Array): readonly number[] {
  const { json } = readGlb(data);
  const nodes = json.nodes ?? [];
  const meshCount = json.meshes?.length ?? 0;
  const placed = new Map<number, Matrix4[]>();
  const visited = new Set<number>();
  const pending = sceneRoots(json).map((index) => ({
    index,
    parent: IDENTITY
  }));
  const MAX_SCENE_NODES = 100_000;
  if (nodes.length > MAX_SCENE_NODES || pending.length > MAX_SCENE_NODES) {
    throw new Error('This GLB exceeds the scene node limit.');
  }
  while (pending.length) {
    const { index, parent } = pending.pop()!;
    const node = nodes[index];
    if (!Number.isInteger(index) || !node || visited.has(index)) {
      throw new Error(
        'This GLB has a node tree that does not resolve (cycle or repeated node).'
      );
    }
    visited.add(index);
    const world = multiply(parent, localMatrix(node));
    if (node.mesh !== undefined) {
      if (placed.has(node.mesh)) {
        throw new Error(
          'This GLB shows a mesh more than once. The glTF reader imports each ' +
            'mesh a single time, so the copies would be lost; export the copies ' +
            'as separate meshes, or as one merged mesh.'
        );
      }
      placed.set(node.mesh, [world]);
    }
    const children = node.children ?? [];
    if (
      !Array.isArray(children) ||
      children.length + pending.length + visited.size > MAX_SCENE_NODES
    ) {
      throw new Error('This GLB exceeds the scene node limit.');
    }
    for (const child of children) pending.push({ index: child, parent: world });
  }

  let world: Matrix4 = IDENTITY;
  if (placed.size > 0) {
    const all = [...placed.values()];
    if (placed.size !== meshCount) {
      throw new Error(
        `This GLB holds ${meshCount} meshes but its scene shows ${placed.size}. ` +
          'The glTF reader imports every mesh in the file, so the hidden ones ' +
          'would come in too; remove them, or export only the visible scene.'
      );
    }
    world = all[0]![0]!;
    if (all.some((uses) => !sameMatrix(uses[0]!, world))) {
      throw new Error(
        'This GLB places its meshes with different transforms. The glTF ' +
          'reader merges them into one before placing them, so the layout ' +
          'would collapse; export the scene as one merged mesh.'
      );
    }
    const determinant =
      world[0]! * (world[5]! * world[10]! - world[9]! * world[6]!) -
      world[4]! * (world[1]! * world[10]! - world[9]! * world[2]!) +
      world[8]! * (world[1]! * world[6]! - world[5]! * world[2]!);
    if (
      !world.every(Number.isFinite) ||
      !Number.isFinite(determinant) ||
      determinant === 0
    ) {
      throw new Error(
        'This GLB places its meshes with a transform that flattens them or ' +
          'cannot be represented, so there is no shape to import.'
      );
    }
  }
  const m = multiply(GLTF_TO_MODEL, world);
  return [
    m[0]!,
    m[1]!,
    m[2]!,
    m[4]!,
    m[5]!,
    m[6]!,
    m[8]!,
    m[9]!,
    m[10]!,
    m[12]!,
    m[13]!,
    m[14]!
  ];
}

const NODE_TRANSFORM_LENGTHS = new Map([
  ['matrix', 16],
  ['translation', 3],
  ['rotation', 4],
  ['scale', 3]
]);

/** Locate only numeric transform arrays on nodes in validated JSON. */
function identityNodeJson(source: string): string | null {
  const tokens = /"[^"\\]*(?:\\[\s\S][^"\\]*)*"|[{}[\]]/g;
  const arrayProperty = /[ \t\n\r]*:[ \t\n\r]*\[/y;
  const numberArray = /\[[ \t\n\r,0-9.eE+-]*\]/y;
  const parts: string[] = [];
  let copiedThrough = 0;
  let depth = 0;
  let nodesArrayStart = -1;
  let insideNodes = false;

  for (const { 0: token, index } of source.matchAll(tokens)) {
    if (token === '[' || token === '{') {
      if (depth === 1 && index === nodesArrayStart) insideNodes = true;
      depth += 1;
    } else if (token === ']' || token === '}') {
      depth -= 1;
      if (depth === 1) insideNodes = false;
    } else if (depth === 1 || (insideNodes && depth === 3)) {
      arrayProperty.lastIndex = index + token.length;
      if (!arrayProperty.test(source)) continue;
      const start = arrayProperty.lastIndex - 1;
      const name = JSON.parse(token) as string;
      if (depth === 1) {
        if (name === 'nodes') nodesArrayStart = start;
        continue;
      }
      const length = NODE_TRANSFORM_LENGTHS.get(name);
      if (length === undefined) continue;
      numberArray.lastIndex = start;
      if (!numberArray.test(source)) continue;
      const end = numberArray.lastIndex;
      const values = JSON.parse(source.slice(start, end)) as number[];
      if (values.length !== length || !values.every(Number.isFinite)) continue;

      // Null is the reader's default transform. Keep the key and its byte
      // width so duplicate fields and the rest of the file reach it intact.
      parts.push(
        source.slice(copiedThrough, start),
        'null'.padEnd(end - start)
      );
      copiedThrough = end;
    }
  }
  if (parts.length === 0) return null;
  parts.push(source.slice(copiedThrough));
  return parts.join('');
}

/**
 * The GLB the reader is handed: the same file with each numeric node transform
 * reset to identity, so each mesh is read, and its vertices welded, in
 * the units it was authored in. {@link glbPlacement} then applies the
 * scene's one world transform to the result, so the transform is applied
 * once and after welding, which keeps the reader's fixed 1e-7 weld relative to
 * the authored geometry rather than to wherever a scene scale puts it.
 *
 * Only numeric transform values change. The reader still parses the original
 * header, property names, all other values, and BIN chunk. A file this cannot
 * read as a version-2 GLB is returned unchanged, for the reader's own named
 * refusal. A second JSON chunk is
 * refused here: the reader takes the last JSON chunk and this the first, so
 * the two would otherwise disagree about what the scene is.
 */
export function glbWithIdentityNodes(data: Uint8Array): Uint8Array {
  let chunks: GlbChunks;
  try {
    chunks = readGlb(data);
  } catch {
    return data;
  }
  const { json, jsonSource, rest } = chunks;
  const header = new DataView(data.buffer, data.byteOffset, data.byteLength);
  if (header.getUint32(4, true) !== 2) {
    return data;
  }
  const trailing = new DataView(rest.buffer, rest.byteOffset, rest.byteLength);
  for (let offset = 0; offset + 8 <= rest.byteLength;) {
    const length = trailing.getUint32(offset, true);
    if (trailing.getUint32(offset + 4, true) === CHUNK_JSON) {
      throw new Error('This GLB has more than one JSON chunk.');
    }
    offset += 8 + length;
  }
  if (
    typeof json !== 'object' ||
    json === null ||
    Array.isArray(json) ||
    !Array.isArray(json.nodes) ||
    !json.nodes.every(
      (node) =>
        typeof node === 'object' && node !== null && !Array.isArray(node)
    )
  ) {
    return data;
  }
  const identitySource = identityNodeJson(jsonSource);
  if (identitySource === null) return data;
  const identityGlb = new Uint8Array(data);
  new TextEncoder().encodeInto(
    identitySource,
    identityGlb.subarray(20, data.length - rest.length)
  );
  return identityGlb;
}

/** One body's GLB from the translator, with what to call and colour it. */
export interface GlbBodyPart {
  bytes: Uint8Array;
  name: string;
  /** `#rrggbb` sRGB. */
  color: string;
}

/** An sRGB channel in [0, 1] as glTF's linear base colour factor. */
function linearChannel(srgb: number): number {
  return srgb <= 0.04045 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4;
}

function binChunk(rest: Uint8Array): Uint8Array {
  if (rest.byteLength < 8) return new Uint8Array();
  const view = new DataView(rest.buffer, rest.byteOffset, rest.byteLength);
  const length = view.getUint32(0, true);
  return rest.subarray(8, 8 + length);
}

/**
 * I04: one GLB holding every body as its own named node and mesh, each mesh
 * in a material of its body's display colour (one material per colour).
 * The parts are the translator's per-body GLBs in model millimetres; the
 * result is millimetres too, for {@link orientGlbForGltf} to wrap.
 */
export function mergeGlbBodies(
  parts: readonly GlbBodyPart[]
): Uint8Array<ArrayBuffer> {
  type Accessor = { bufferView?: number; [key: string]: unknown };
  type View = { buffer: number; byteOffset?: number; [key: string]: unknown };
  type Primitive = {
    attributes: Record<string, number>;
    indices?: number;
    material?: number;
    [key: string]: unknown;
  };
  const accessors: Accessor[] = [];
  const bufferViews: View[] = [];
  const meshes: { name?: string; primitives: Primitive[] }[] = [];
  const nodes: GltfNode[] = [];
  const materials: Record<string, unknown>[] = [];
  const materialIndex = new Map<string, number>();
  const chunks: Uint8Array[] = [];
  let binLength = 0;
  for (const part of parts) {
    const { json, rest } = readGlb(part.bytes);
    const bin = binChunk(rest);
    const viewOffset = bufferViews.length;
    const accessorOffset = accessors.length;
    for (const view of (json['bufferViews'] ?? []) as View[]) {
      bufferViews.push({
        ...view,
        buffer: 0,
        byteOffset: (view.byteOffset ?? 0) + binLength
      });
    }
    for (const accessor of (json['accessors'] ?? []) as Accessor[]) {
      accessors.push({
        ...accessor,
        ...(accessor.bufferView === undefined
          ? {}
          : { bufferView: accessor.bufferView + viewOffset })
      });
    }
    const color = part.color.toLowerCase();
    let material = materialIndex.get(color);
    if (material === undefined) {
      const match = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/.exec(color);
      const channels = match
        ? match.slice(1).map((hex) => linearChannel(parseInt(hex, 16) / 255))
        : [0.8, 0.8, 0.8];
      materials.push({
        name: color,
        pbrMetallicRoughness: {
          baseColorFactor: [...channels, 1],
          metallicFactor: 0,
          roughnessFactor: 1
        }
      });
      material = materials.length - 1;
      materialIndex.set(color, material);
    }
    for (const mesh of (json.meshes ?? []) as {
      primitives: Primitive[];
    }[]) {
      meshes.push({
        name: part.name,
        primitives: mesh.primitives.map((primitive) => ({
          ...primitive,
          attributes: Object.fromEntries(
            Object.entries(primitive.attributes).map(([key, index]) => [
              key,
              index + accessorOffset
            ])
          ),
          ...(primitive.indices === undefined
            ? {}
            : { indices: primitive.indices + accessorOffset }),
          material
        }))
      });
      nodes.push({ name: part.name, mesh: meshes.length - 1 });
    }
    chunks.push(bin);
    binLength += bin.byteLength;
    // Every view starts 4-byte aligned, as glTF requires of accessors.
    const pad = (4 - (binLength % 4)) % 4;
    if (pad) {
      chunks.push(new Uint8Array(pad));
      binLength += pad;
    }
  }
  const bin = new Uint8Array(binLength);
  let at = 0;
  for (const chunk of chunks) {
    bin.set(chunk, at);
    at += chunk.byteLength;
  }
  const rest = new Uint8Array(8 + binLength);
  const view = new DataView(rest.buffer);
  view.setUint32(0, binLength, true);
  view.setUint32(4, 0x004e4942, true); // "BIN\0"
  rest.set(bin, 8);
  const json: GltfJson = {
    asset: { version: '2.0', generator: 'OpenZCAD' },
    scene: 0,
    scenes: [{ nodes: nodes.map((_node, index) => index) }],
    nodes,
    meshes,
    materials,
    accessors,
    bufferViews,
    buffers: [{ byteLength: binLength }]
  };
  return writeGlb(json, rest);
}
