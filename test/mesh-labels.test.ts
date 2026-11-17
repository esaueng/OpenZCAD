import { expect, it } from 'vitest';
import {
  addPrimitiveFeature,
  createProjectDocument,
  setNodeMetadata,
  transformBody
} from '@openzcad/document-core';
import { createExactKernelAdapter } from '@openzcad/kernel-adapter/exact';
import {
  BODY_COLOR_CHOSEN_METADATA_KEY,
  BODY_COLOR_METADATA_KEY,
  toUserId,
  type ProjectDocument
} from '@openzcad/shared';
import { mergeObjBodies } from '../packages/kernel-adapter/src/obj-labels';
import { zipTextEntries } from './support/zip-entries';

/** The parts of a glTF document these tests read. */
interface GltfShape {
  meshes: {
    name: string;
    primitives: {
      attributes: Record<string, number>;
      indices: number;
      material: number;
    }[];
  }[];
  materials: {
    name: string;
    pbrMetallicRoughness: { baseColorFactor: number[] };
  }[];
  accessors: unknown[];
  bufferViews: { byteOffset: number; byteLength: number }[];
  buffers: { byteLength: number }[];
}

/** I04: glTF and OBJ name each body, and carry its display colour. */
async function twoBodies() {
  const adapter = await createExactKernelAdapter();
  let document = createProjectDocument('Labels', toUserId('user_i04'));
  document = addPrimitiveFeature(document, {
    name: 'Block',
    primitiveKind: 'box',
    dimensions: { width: 20, height: 10, depth: 5 }
  });
  document = addPrimitiveFeature(document, {
    name: 'Pin',
    primitiveKind: 'cylinder',
    dimensions: { radius: 5, height: 10 }
  });
  document = transformBody(document, {
    name: 'Move pin',
    targetBodyId: document.bodyOrder.at(-1)!,
    translation: { x: 40, y: 0, z: 0 },
    rotationDeg: { x: 0, y: 0, z: 0 }
  }).document;
  const pin = Object.values(document.nodes).find(
    (node) => node.kind === 'body' && node.bodyId === document.bodyOrder.at(-1)
  )!;
  document = setNodeMetadata(document, {
    nodeId: pin.id,
    metadata: {
      [BODY_COLOR_METADATA_KEY]: '#ff0000',
      [BODY_COLOR_CHOSEN_METADATA_KEY]: true
    }
  });
  const derived = await adapter.syncDocument(document);
  const synced: ProjectDocument = { ...document, derived };
  const ids = [...derived.exportableBodyIds];
  const names = ids.map((id) => derived.bodyRepresentations[id]!.name);
  return { adapter, synced, ids, names };
}

it('writes each body as its own named, coloured glTF node and mesh', async () => {
  const { adapter, synced, ids, names } = await twoBodies();
  try {
    const glb = await adapter.exportMesh(synced, ids, {
      format: 'glb',
      deflection: 0.1
    });
    const view = new DataView(glb.buffer, glb.byteOffset, glb.byteLength);
    const json = JSON.parse(
      new TextDecoder().decode(glb.subarray(20, 20 + view.getUint32(12, true)))
    ) as GltfShape;
    expect(json.meshes.map((mesh) => mesh.name)).toEqual(names);
    const red = json.materials.find((material) => material.name === '#ff0000')!;
    expect(red.pbrMetallicRoughness.baseColorFactor).toEqual([1, 0, 0, 1]);
    // Every primitive's accessors point at real accessors and views.
    for (const mesh of json.meshes)
      for (const primitive of mesh.primitives) {
        for (const index of [
          ...Object.values(primitive.attributes),
          primitive.indices
        ])
          expect(json.accessors[index]).toBeDefined();
        expect(json.materials[primitive.material]).toBeDefined();
      }
    const binLength = new DataView(
      glb.buffer,
      glb.byteOffset + 20 + view.getUint32(12, true)
    ).getUint32(0, true);
    expect(json.buffers[0].byteLength).toBe(binLength);
    for (const bufferView of json.bufferViews)
      expect(bufferView.byteOffset + bufferView.byteLength).toBeLessThanOrEqual(
        binLength
      );
  } finally {
    adapter.dispose();
  }
}, 60_000);

it('packages OBJ colours as an OBJ and its MTL', async () => {
  const { adapter, synced, ids, names } = await twoBodies();
  try {
    const zip = await adapter.exportMesh(synced, ids, {
      format: 'obj',
      deflection: 0.1,
      objMaterials: { stem: 'Labels' }
    });
    const files = zipTextEntries(zip);
    expect(Object.keys(files).sort()).toEqual(['Labels.mtl', 'Labels.obj']);
    const obj = files['Labels.obj']!;
    const mtl = files['Labels.mtl']!;
    expect(obj).toContain('mtllib Labels.mtl');
    for (const name of names) expect(obj).toContain(`o ${name}`);
    expect(obj).toContain('usemtl color_ff0000');
    expect(mtl).toContain('newmtl color_ff0000\nKd 1.000000 0.000000 0.000000');
  } finally {
    adapter.dispose();
  }
}, 60_000);

it('renumbers OBJ vertices and normals across bodies', () => {
  const part = 'v 0 0 0\nv 1 0 0\nv 0 1 0\nvn 0 0 1\nf 1//1 2//1 3//1\n';
  const { obj } = mergeObjBodies(
    [
      { text: part, name: 'A', color: '#000000' },
      { text: part, name: 'B', color: '#ffffff' }
    ],
    'x.mtl'
  );
  expect(obj).toContain('o A\nusemtl color_000000');
  expect(obj.trim().split('\n').at(-1)).toBe('f 4//2 5//2 6//2');
});
