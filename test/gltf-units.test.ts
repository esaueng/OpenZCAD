import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CommandManager, commandFactories } from '@openzcad/command-system';
import {
  createProjectDocument,
  getLatestBodyId
} from '@openzcad/document-core';
import {
  createExactKernelAdapter,
  importMeshFile,
  type ExactKernelAdapter
} from '@openzcad/kernel-adapter/exact';
import { toUserId, type UnitSystem } from '@openzcad/shared';
import {
  GLTF_ROOT_NAME,
  glbPlacement
} from '../packages/kernel-adapter/src/glb-scene';
import { glbFixture } from './support/mesh-import-fixtures';

/**
 * glTF states its units and axes: metres, +Y up, +Z the front. Production QA
 * CAD-01 found the GLB export writing model millimetres with a bare
 * `{ mesh: 0 }` node, so a 65 mm part arrived in every glTF viewer as 65 m.
 *
 * These read the exported file independently of the writer: parse the GLB,
 * walk the scene's node hierarchy applying every transform, and measure the
 * world-space box the positions occupy. A valid header or POSITION bounds
 * alone say nothing about the size a viewer shows.
 */

interface GltfNode {
  mesh?: number;
  children?: number[];
  matrix?: number[];
  translation?: number[];
  rotation?: number[];
  scale?: number[];
}

interface ParsedGlb {
  json: {
    scene?: number;
    scenes: { nodes: number[] }[];
    nodes: GltfNode[];
    meshes: { primitives: { attributes: { POSITION: number } }[] }[];
    accessors: {
      bufferView: number;
      byteOffset?: number;
      count: number;
    }[];
    bufferViews: { byteOffset?: number; byteStride?: number }[];
  };
  bin: DataView;
}

function parseGlb(bytes: Uint8Array): ParsedGlb {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  expect(view.getUint32(0, true)).toBe(0x46546c67);
  expect(view.getUint32(8, true)).toBe(bytes.byteLength);
  const jsonLength = view.getUint32(12, true);
  const json = JSON.parse(
    new TextDecoder().decode(bytes.subarray(20, 20 + jsonLength))
  ) as ParsedGlb['json'];
  const binStart = 20 + jsonLength;
  const binLength = view.getUint32(binStart, true);
  return {
    json,
    bin: new DataView(bytes.buffer, bytes.byteOffset + binStart + 8, binLength)
  };
}

type Mat4 = number[];

function multiply(a: Mat4, b: Mat4): Mat4 {
  const out: number[] = [];
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

/** glTF's T · R · S, written out independently of the adapter's. */
function nodeMatrix(node: GltfNode): Mat4 {
  if (node.matrix) {
    return node.matrix;
  }
  const [tx, ty, tz] = node.translation ?? [0, 0, 0];
  const [qx, qy, qz, qw] = node.rotation ?? [0, 0, 0, 1];
  const [sx, sy, sz] = node.scale ?? [1, 1, 1];
  const r = [
    [
      1 - 2 * (qy! ** 2 + qz! ** 2),
      2 * (qx! * qy! - qz! * qw!),
      2 * (qx! * qz! + qy! * qw!)
    ],
    [
      2 * (qx! * qy! + qz! * qw!),
      1 - 2 * (qx! ** 2 + qz! ** 2),
      2 * (qy! * qz! - qx! * qw!)
    ],
    [
      2 * (qx! * qz! - qy! * qw!),
      2 * (qy! * qz! + qx! * qw!),
      1 - 2 * (qx! ** 2 + qy! ** 2)
    ]
  ];
  const s = [sx!, sy!, sz!];
  const m = new Array<number>(16).fill(0);
  for (let column = 0; column < 3; column += 1) {
    for (let row = 0; row < 3; row += 1) {
      m[column * 4 + row] = r[row]![column]! * s[column]!;
    }
  }
  m[12] = tx!;
  m[13] = ty!;
  m[14] = tz!;
  m[15] = 1;
  return m;
}

/** The world-space box every positioned vertex of the scene occupies. */
function worldBounds(bytes: Uint8Array) {
  const { json, bin } = parseGlb(bytes);
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  const visit = (index: number, parent: Mat4) => {
    const node = json.nodes[index]!;
    const world = multiply(parent, nodeMatrix(node));
    if (node.mesh !== undefined) {
      for (const primitive of json.meshes[node.mesh]!.primitives) {
        const accessor = json.accessors[primitive.attributes.POSITION]!;
        const bufferView = json.bufferViews[accessor.bufferView]!;
        const stride = bufferView.byteStride ?? 12;
        const base = (bufferView.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
        for (let i = 0; i < accessor.count; i += 1) {
          const p = [0, 1, 2].map((axis) =>
            bin.getFloat32(base + i * stride + axis * 4, true)
          );
          for (let row = 0; row < 3; row += 1) {
            const value =
              world[row]! * p[0]! +
              world[4 + row]! * p[1]! +
              world[8 + row]! * p[2]! +
              world[12 + row]!;
            min[row] = Math.min(min[row]!, value);
            max[row] = Math.max(max[row]!, value);
          }
        }
      }
    }
    for (const child of node.children ?? []) {
      visit(child, world);
    }
  };
  const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  for (const root of json.scenes[json.scene ?? 0]!.nodes) {
    visit(root, identity);
  }
  return { min, max };
}

/** Tolerance in metres: float32 positions, well under a micron. */
const METRE_TOLERANCE = 1e-7;

function expectBox(
  actual: { min: number[]; max: number[] },
  expected: { min: number[]; max: number[] }
) {
  for (const corner of ['min', 'max'] as const) {
    expected[corner].forEach((value, axis) => {
      expect(Math.abs(actual[corner][axis]! - value)).toBeLessThan(
        METRE_TOLERANCE
      );
    });
  }
}

let kernel: ExactKernelAdapter;

beforeAll(async () => {
  kernel = await createExactKernelAdapter();
});

afterAll(() => {
  kernel.dispose();
});

function boxDocument(
  units: UnitSystem,
  dimensions: { width: number; height: number; depth: number },
  translation?: { x: number; y: number; z: number }
) {
  const manager = new CommandManager(
    createProjectDocument('Units', toUserId('user_gltf'), units)
  );
  manager.execute(
    commandFactories.addPrimitive({
      name: 'Box',
      primitiveKind: 'box',
      dimensions
    })
  );
  if (translation) {
    manager.execute(
      commandFactories.transformBody({
        name: 'Move',
        targetBodyId: getLatestBodyId(manager.document)!,
        translation
      })
    );
  }
  return manager.document;
}

async function exportGlb(document: ReturnType<typeof boxDocument>) {
  return kernel.exportMesh(document, [...document.bodyOrder], {
    format: 'glb',
    deflection: 0.08
  });
}

/**
 * Model millimetres, +Z up, to glTF metres, +Y up: (x, y, z) mm becomes
 * (x, z, −y) / 1000 m, so the model's top faces glTF's up and its front
 * (−Y) faces glTF's front (+Z).
 */
function gltfBox(minMm: number[], maxMm: number[]) {
  const corners = [minMm, maxMm].map(([x, y, z]) => [
    x! / 1000,
    z! / 1000,
    -y! / 1000
  ]);
  return {
    min: [0, 1, 2].map((axis) =>
      Math.min(corners[0]![axis]!, corners[1]![axis]!)
    ),
    max: [0, 1, 2].map((axis) =>
      Math.max(corners[0]![axis]!, corners[1]![axis]!)
    )
  };
}

describe('GLB export in glTF units', { timeout: 30_000 }, () => {
  it('places a 65 × 30 × 20 mm box at 0.065 × 0.030 × 0.020 m, the right way up', async () => {
    const document = boxDocument('mm', { width: 65, height: 30, depth: 20 });
    const derivedBox = (await kernel.syncDocument(document))
      .bodyRepresentations[document.bodyOrder[0]!]!.bbox;
    const glb = await exportGlb(document);

    const { json } = parseGlb(glb);
    const root = json.nodes[json.scenes[json.scene ?? 0]!.nodes[0]!] as {
      name?: string;
    };
    expect(root.name).toBe(GLTF_ROOT_NAME);

    const bounds = worldBounds(glb);
    expectBox(
      bounds,
      gltfBox(
        [derivedBox.min.x, derivedBox.min.y, derivedBox.min.z],
        [derivedBox.max.x, derivedBox.max.y, derivedBox.max.z]
      )
    );
    const extents = [0, 1, 2].map(
      (axis) => bounds.max[axis]! - bounds.min[axis]!
    );
    // Whatever the box's own axis naming, its size in metres is the part's.
    expect(extents.map((v) => Math.round(v * 1e6) / 1e6).sort()).toEqual(
      [0.02, 0.03, 0.065].sort()
    );
  });

  it('gives an inch document the same physical size as its millimetre twin', async () => {
    const inch = await exportGlb(
      boxDocument('inch', { width: 1, height: 2, depth: 0.5 })
    );
    const mm = await exportGlb(
      boxDocument('mm', { width: 25.4, height: 50.8, depth: 12.7 })
    );
    expectBox(worldBounds(inch), worldBounds(mm));
    const { min, max } = worldBounds(inch);
    expect(max[0]! - min[0]!).toBeCloseTo(0.0254, 7);
  });

  it('keeps a moved body where the model put it', async () => {
    const document = boxDocument(
      'mm',
      { width: 10, height: 10, depth: 10 },
      { x: 100, y: -40, z: 25 }
    );
    const box = (await kernel.syncDocument(document)).bodyRepresentations[
      document.bodyOrder[0]!
    ]!.bbox;
    expect(box.min.x).toBeCloseTo(100, 6);
    expectBox(
      worldBounds(await exportGlb(document)),
      gltfBox(
        [box.min.x, box.min.y, box.min.z],
        [box.max.x, box.max.y, box.max.z]
      )
    );
  });

  it('comes back from its own GLB at the size and place it left', async () => {
    const document = boxDocument(
      'mm',
      { width: 65, height: 30, depth: 20 },
      { x: 5, y: 7, z: 9 }
    );
    const box = (await kernel.syncDocument(document)).bodyRepresentations[
      document.bodyOrder[0]!
    ]!.bbox;
    const mesh = await importMeshFile('glb', await exportGlb(document), 'mm');
    expect(mesh.sourceUnit).toBe('meter');
    const along = (axis: number) =>
      mesh.vertices.filter((_v, index) => index % 3 === axis);
    for (const [axis, key] of [
      [0, 'x'],
      [1, 'y'],
      [2, 'z']
    ] as const) {
      expect(Math.min(...along(axis))).toBeCloseTo(box.min[key], 3);
      expect(Math.max(...along(axis))).toBeCloseTo(box.max[key], 3);
    }
  });
});

describe('GLB import placement', () => {
  /** The 2 × 3 × 4 fixture box with its scene rewritten. */
  function withScene(
    mutate: (json: {
      nodes: Record<string, unknown>[];
      meshes: unknown[];
      scenes: { nodes: number[] }[];
    }) => void,
    count = 1
  ): Uint8Array {
    const glb = glbFixture(count);
    const view = new DataView(glb.buffer, glb.byteOffset, glb.byteLength);
    const jsonLength = view.getUint32(12, true);
    const json = JSON.parse(
      new TextDecoder().decode(glb.subarray(20, 20 + jsonLength))
    ) as Parameters<typeof mutate>[0];
    mutate(json);
    let text = JSON.stringify(json);
    while (text.length % 4) {
      text += ' ';
    }
    const encoded = new TextEncoder().encode(text);
    const rest = glb.subarray(20 + jsonLength);
    const out = new Uint8Array(20 + encoded.length + rest.length);
    const outView = new DataView(out.buffer);
    outView.setUint32(0, 0x46546c67, true);
    outView.setUint32(4, 2, true);
    outView.setUint32(8, out.length, true);
    outView.setUint32(12, encoded.length, true);
    outView.setUint32(16, 0x4e4f534a, true);
    out.set(encoded, 20);
    out.set(rest, 20 + encoded.length);
    return out;
  }

  const apply = (t: readonly number[], [x, y, z]: number[]) => [
    x! * t[0]! + y! * t[3]! + z! * t[6]! + t[9]!,
    x! * t[1]! + y! * t[4]! + z! * t[7]! + t[10]!,
    x! * t[2]! + y! * t[5]! + z! * t[8]! + t[11]!
  ];

  it('reads metres with +Y up into millimetres with +Z up', () => {
    const t = glbPlacement(withScene(() => {}));
    expect(apply(t, [1, 0, 0])).toEqual([1000, 0, 0]);
    expect(apply(t, [0, 1, 0]).map((v) => v + 0)).toEqual([0, 0, 1000]);
    expect(apply(t, [0, 0, 1]).map((v) => v + 0)).toEqual([0, -1000, 0]);
  });

  it('honours the scene’s own scale and placement', () => {
    const t = glbPlacement(
      withScene((json) => {
        json.nodes[0]!.translation = [0.5, 0, 0];
        json.nodes.push({ children: [0], scale: [0.01, 0.01, 0.01] });
        json.scenes[0]!.nodes = [json.nodes.length - 1];
      })
    );
    // A centimetre file: 1 unit is 10 mm, placed 0.5 units along +X.
    expect(apply(t, [0, 0, 0])[0]).toBeCloseTo(5, 9);
    expect(apply(t, [1, 0, 0])[0]).toBeCloseTo(15, 9);
  });

  it('refuses what the merged reader cannot honour, by name', () => {
    expect(() =>
      glbPlacement(
        withScene((json) => {
          json.nodes.push({ mesh: 0, translation: [5, 0, 0] });
          json.scenes[0]!.nodes.push(json.nodes.length - 1);
        })
      )
    ).toThrow(/shows a mesh more than once/);
    expect(() =>
      glbPlacement(
        withScene((json) => {
          json.nodes[1]!.translation = [5, 0, 0];
        }, 2)
      )
    ).toThrow(/places its meshes with different transforms/);
    expect(() =>
      glbPlacement(
        withScene((json) => {
          json.scenes[0]!.nodes = [0];
        }, 2)
      )
    ).toThrow(/holds 2 meshes but its scene shows 1/);
  });
});
