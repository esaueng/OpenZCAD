import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  addPrimitiveFeature,
  createProjectDocument
} from '@openzcad/document-core';
import {
  createExactKernelAdapter,
  type ExactKernelAdapter
} from '@openzcad/kernel-adapter/exact';
import { toUserId, type FeatureWarning } from '@openzcad/shared';
import {
  inspectDisplayMeshClosure,
  isClosedConsistentlyOrientedMesh
} from '../packages/kernel-adapter/src/boolean-result-validation';
import { RemusKernel } from '../packages/kernel-adapter/src/remus-runtime';

// Unit cube, outward-wound, sharing its eight corner indices.
const CUBE_POSITIONS = [
  0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0, 0, 0, 1, 1, 0, 1, 1, 1, 1, 0, 1, 1
];
const CUBE_INDICES = [
  0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 2, 3, 7, 2, 7, 6, 1, 2,
  6, 1, 6, 5, 0, 4, 7, 0, 7, 3
];

describe('display mesh closure', () => {
  it('accepts a closed mesh from shared indices', () => {
    expect(
      isClosedConsistentlyOrientedMesh(
        inspectDisplayMeshClosure(CUBE_POSITIONS, CUBE_INDICES)
      )
    ).toBe(true);
  });

  it('still accepts a closed mesh whose faces do not share indices', () => {
    // Every triangle gets its own copies of its corners, as a per-face
    // tessellation would emit; only the welded fallback can prove it closed.
    const positions: number[] = [];
    const indices: number[] = [];
    for (const corner of CUBE_INDICES) {
      indices.push(positions.length / 3);
      positions.push(...CUBE_POSITIONS.slice(corner * 3, corner * 3 + 3));
    }
    expect(
      isClosedConsistentlyOrientedMesh(
        inspectDisplayMeshClosure(positions, indices)
      )
    ).toBe(true);
  });

  it('reports a missing triangle and a flipped triangle', () => {
    const missing = inspectDisplayMeshClosure(
      CUBE_POSITIONS,
      CUBE_INDICES.slice(3)
    );
    expect(missing.boundaryEdges).toBe(3);
    const flipped = [...CUBE_INDICES];
    [flipped[1], flipped[2]] = [flipped[2]!, flipped[1]!];
    expect(
      inspectDisplayMeshClosure(CUBE_POSITIONS, flipped)
        .inconsistentWindingEdges
    ).toBeGreaterThan(0);
  });
});

describe('open display mesh advisory', { timeout: 120_000 }, () => {
  let adapter: ExactKernelAdapter;
  const document = addPrimitiveFeature(
    createProjectDocument('Open display mesh', toUserId('user_fixture')),
    {
      name: 'Box',
      primitiveKind: 'box',
      dimensions: { width: 20, height: 10, depth: 15 }
    }
  );
  const bodyId = document.bodyOrder[0]!;
  const advisories = (warnings: readonly FeatureWarning[] | undefined) =>
    (warnings ?? []).filter(
      (warning) =>
        warning.kind === 'advisory' &&
        warning.message.includes('display mesh has gaps')
    );

  beforeAll(async () => {
    adapter = await createExactKernelAdapter();
  });
  afterAll(() => adapter.dispose());

  it('stays quiet for a watertight body', async () => {
    const derived = await adapter.syncDocument(document);
    expect(derived.warnings).toEqual([]);
    expect(advisories(derived.featureWarnings)).toEqual([]);
  });

  it('flags a valid solid whose kernel tessellation has holes', async () => {
    // Reproduces the Remus defect behind the filleted-union glitch: a valid
    // B-rep whose grouped tessellation leaves a face's triangles out.
    const original = RemusKernel.prototype.tessellateSolidGroupedBinary;
    const spy = vi
      .spyOn(RemusKernel.prototype, 'tessellateSolidGroupedBinary')
      .mockImplementation(function (this: RemusKernel, ...args) {
        const mesh = original.apply(this, args);
        try {
          const positions = mesh.positions.slice();
          const offsets = mesh.faceOffsets.slice();
          const last = offsets.length - 1;
          const indices = mesh.indices.slice(0, offsets[last - 1]);
          offsets[last] = offsets[last - 1]!;
          return {
            positions,
            indices,
            faceOffsets: offsets,
            free() {}
          } as unknown as ReturnType<typeof original>;
        } finally {
          mesh.free();
        }
      });
    const fresh = await createExactKernelAdapter();
    try {
      const derived = await fresh.syncDocument(document);
      const flagged = advisories(derived.featureWarnings);
      expect(flagged).toHaveLength(1);
      expect(flagged[0]!.featureName).toBe('Box');
      // Advisory only: the exact body is still published and measured.
      expect(derived.bodyRepresentations[bodyId]!.volume).toBeCloseTo(
        20 * 10 * 15,
        6
      );
    } finally {
      fresh.dispose();
      spy.mockRestore();
    }
  });
});
