/**
 * glTF's coordinate contract, on both sides of the GLB translators.
 *
 * glTF defines its linear unit as the metre and its up axis as +Y, with +Z
 * the front; the model space here is millimetres with +Z up and -Y the front.
 * The pinned translators ignore both: the writer emits the millimetre, Z-up
 * numbers with a bare `{ mesh: 0 }` node, so a 65 mm part arrived in every
 * glTF viewer as 65 m lying on its back, and the reader merges every mesh in
 * the file and drops the scene graph, so a file's own node transforms (its
 * scale, its placement) never reached the import.
 *
 * Both directions go through the node graph rather than the vertex data: the
 * export keeps the translator's millimetre tessellation and wraps the scene in
 * one root node that scales by 1/1000 and turns Z-up into Y-up, which every
 * reader that honours glTF composes back to metres; the import reads the
 * scene's world transform and composes it with the inverse, so a file written
 * here comes back exactly, and one written in metres by any other tool comes
 * in at its real size and the right way up.
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
  const json = JSON.parse(
    new TextDecoder().decode(data.subarray(20, 20 + jsonLength))
  ) as GltfJson;
  return { json, rest: data.subarray(20 + jsonLength) };
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

function localMatrix(node: GltfNode): Matrix4 {
  if (node.matrix) {
    if (node.matrix.length !== 16) {
      throw new Error('This GLB has a node matrix that is not 16 numbers.');
    }
    return [...node.matrix];
  }
  const [tx, ty, tz] = node.translation ?? [0, 0, 0];
  const [x, y, z, w] = node.rotation ?? [0, 0, 0, 1];
  const [sx, sy, sz] = node.scale ?? [1, 1, 1];
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
 * The pinned reader merges every mesh in the file into one solid and drops
 * the scene graph, so the import can honour one world transform, not one per
 * mesh: a file whose meshes are each shown once, all under the same
 * transform (the shape every single-object export has, this app's included),
 * imports at its stated size and place. A file that shows a mesh twice, or
 * places its meshes differently, is refused by name rather than imported with
 * its layout collapsed.
 */
export function glbPlacement(data: Uint8Array): readonly number[] {
  const { json } = readGlb(data);
  const nodes = json.nodes ?? [];
  const meshCount = json.meshes?.length ?? 0;
  const placed = new Map<number, Matrix4[]>();
  const visit = (index: number, parent: Matrix4, depth: number): void => {
    const node = nodes[index];
    if (!node || depth > nodes.length) {
      throw new Error('This GLB has a node tree that does not resolve.');
    }
    const world = multiply(parent, localMatrix(node));
    if (node.mesh !== undefined) {
      placed.set(node.mesh, [...(placed.get(node.mesh) ?? []), world]);
    }
    for (const child of node.children ?? []) {
      visit(child, world, depth + 1);
    }
  };
  for (const root of sceneRoots(json)) {
    visit(root, IDENTITY, 0);
  }

  let world: Matrix4 = IDENTITY;
  if (placed.size > 0) {
    const all = [...placed.values()];
    if (all.some((uses) => uses.length > 1)) {
      throw new Error(
        'This GLB shows a mesh more than once. The glTF reader imports each ' +
          'mesh a single time, so the copies would be lost; export the copies ' +
          'as separate meshes, or as one merged mesh.'
      );
    }
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
