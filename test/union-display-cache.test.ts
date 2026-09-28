import { afterEach, expect, it, vi } from 'vitest';
import { CommandManager, commandFactories } from '@openzcad/command-system';
import {
  addPrimitiveFeature,
  createProjectDocument,
  transformBody
} from '@openzcad/document-core';
import { RemusKernel } from '../packages/kernel-adapter/src/remus-runtime';
import {
  createExactKernelAdapter,
  type ExactKernelAdapter
} from '../packages/kernel-adapter/src/exact';
import {
  inspectTriangleMeshClosure,
  isClosedConsistentlyOrientedMesh
} from '../packages/kernel-adapter/src/boolean-result-validation';
import { unifyUnionFaces } from '../packages/kernel-adapter/src/exact-boolean-helpers';
import { transformMatrix } from '../packages/kernel-adapter/src/exact-math';
import { toUserId } from '@openzcad/shared';

afterEach(() => {
  vi.restoreAllMocks();
});

it('measures an accepted boolean from its closure tessellation and matches a fresh exact oracle', async () => {
  const withBase = addPrimitiveFeature(
    createProjectDocument(
      'Union mesh cache',
      toUserId('user_union_mesh_cache')
    ),
    {
      name: 'Base plate',
      primitiveKind: 'box',
      dimensions: { width: 40, height: 30, depth: 6 }
    }
  );
  const withWall = addPrimitiveFeature(withBase, {
    name: 'Wall plate',
    primitiveKind: 'box',
    dimensions: { width: 40, height: 6, depth: 24 }
  });
  const wallId = withWall.bodyOrder.at(-1)!;
  const positioned = transformBody(withWall, {
    name: 'Seat wall on base',
    targetBodyId: wallId,
    translation: { x: 0, y: 24, z: 5.5 },
    rotationDeg: { x: 0, y: 0, z: 0 }
  }).document;
  const document = new CommandManager(positioned).execute(
    commandFactories.booleanBodies({
      name: 'Union',
      operation: 'union',
      targetBodyIds: [positioned.bodyOrder[0]!, wallId]
    })
  );

  const tessellatedMeshes: {
    solid: number;
    positions: number[];
    indices: number[];
    groups: number;
  }[] = [];
  const original = RemusKernel.prototype.tessellateSolidGroupedBinary;
  vi.spyOn(
    RemusKernel.prototype,
    'tessellateSolidGroupedBinary'
  ).mockImplementation(function (this: RemusKernel, solid, ...args) {
    const mesh = original.call(this, solid, ...args);
    tessellatedMeshes.push({
      solid,
      positions: Array.from(mesh.positions),
      indices: Array.from(mesh.indices),
      groups: mesh.faceOffsets.length - 1
    });
    return mesh;
  });

  let adapter: ExactKernelAdapter | undefined;
  try {
    adapter = await createExactKernelAdapter();
    const derived = await adapter.syncDocument(document);
    const resultId = document.bodyOrder.at(-1)!;
    const body = derived.bodyRepresentations[resultId];

    expect(derived.warnings).toEqual([]);
    expect(body?.volume).toBeCloseTo(12_840, 5);
    expect(body?.faceCount).toBe(8);
    expect(body?.mesh.indices.length).toBeGreaterThan(0);
    expect(
      isClosedConsistentlyOrientedMesh(
        inspectTriangleMeshClosure(
          new Float32Array(body!.mesh.vertices),
          new Uint32Array(body!.mesh.indices)
        )
      )
    ).toBe(true);

    // Identify the final measured group's exact vertex stream among the
    // kernel calls. It must have been tessellated once, by closure checking.
    const matchingMeshes = tessellatedMeshes.filter(
      (mesh) =>
        mesh.positions.length === body!.mesh.vertices.length &&
        mesh.positions.every(
          (value, index) => value === body!.mesh.vertices[index]
        ) &&
        mesh.indices.length === body!.mesh.indices.length &&
        mesh.indices.every(
          (value, index) => value === body!.mesh.indices[index]
        ) &&
        mesh.groups === body!.faceCount
    );
    expect(matchingMeshes).toHaveLength(1);

    const oracle = new RemusKernel();
    try {
      const base = oracle.makeBox(40, 30, 6);
      const wall = oracle.copyAndTransformSolid(
        oracle.makeBox(40, 6, 24),
        transformMatrix({ x: 0, y: 24, z: 5.5 }, { x: 0, y: 0, z: 0 })
      );
      const freshUnion = unifyUnionFaces(
        oracle,
        oracle.fuseAll(Uint32Array.from([base, wall]))
      );
      expect(oracle.validateSolid(freshUnion)).toBe(0);
      expect(oracle.volume(freshUnion, 0.1)).toBeCloseTo(body!.volume, 5);
      expect(oracle.getSolidFaces(freshUnion)).toHaveLength(body!.faceCount);
    } finally {
      oracle.free();
    }
  } finally {
    adapter?.dispose();
  }
});
