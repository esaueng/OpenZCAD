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

/** The pre-sort index check, kept as an oracle for the typed-array pass. */
function mapIndexClosed(positionCount: number, indices: number[]): boolean {
  const vertexCount = Math.floor(positionCount / 3);
  const balance = new Map<number, number>();
  const uses = new Map<number, number>();
  let triangles = 0;
  for (let index = 0; index + 2 < indices.length; index += 3) {
    const corners = [indices[index]!, indices[index + 1]!, indices[index + 2]!];
    triangles += 1;
    for (let corner = 0; corner < 3; corner += 1) {
      const start = corners[corner]!;
      const end = corners[(corner + 1) % 3]!;
      if (start === end || start >= vertexCount || end >= vertexCount)
        return false;
      const key =
        start < end ? start * vertexCount + end : end * vertexCount + start;
      balance.set(key, (balance.get(key) ?? 0) + (start < end ? 1 : -1));
      uses.set(key, (uses.get(key) ?? 0) + 1);
    }
  }
  if (triangles === 0) return false;
  for (const [key, count] of uses)
    if (count !== 2 || balance.get(key) !== 0) return false;
  return true;
}

describe('display mesh closure index pass', () => {
  // An n-gon prism with shared corner indices: closed, outward wound.
  function prism(sides: number) {
    const positions: number[] = [];
    for (const z of [0, 1])
      for (let i = 0; i < sides; i += 1) {
        const angle = (2 * Math.PI * i) / sides;
        positions.push(Math.cos(angle), Math.sin(angle), z);
      }
    const indices: number[] = [];
    for (let i = 1; i + 1 < sides; i += 1) {
      indices.push(0, i + 1, i);
      indices.push(sides, sides + i, sides + i + 1);
    }
    for (let i = 0; i < sides; i += 1) {
      const next = (i + 1) % sides;
      indices.push(i, next, sides + next, i, sides + next, sides + i);
    }
    return { positions, indices };
  }

  it('agrees with the map-based check on closed and damaged meshes', () => {
    let seed = 7;
    const random = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    const cases: { positions: number[]; indices: number[] }[] = [
      { positions: CUBE_POSITIONS, indices: CUBE_INDICES }
    ];
    for (const sides of [3, 8, 33]) {
      const { positions, indices } = prism(sides);
      cases.push({ positions, indices });
      const triangle = Math.floor(random() * (indices.length / 3)) * 3;
      // Missing, flipped, duplicated, degenerate and out-of-range triangles.
      cases.push({
        positions,
        indices: [...indices.slice(0, triangle), ...indices.slice(triangle + 3)]
      });
      const flipped = [...indices];
      [flipped[triangle + 1], flipped[triangle + 2]] = [
        flipped[triangle + 2]!,
        flipped[triangle + 1]!
      ];
      cases.push({ positions, indices: flipped });
      cases.push({
        positions,
        indices: [...indices, ...indices.slice(triangle, triangle + 3)]
      });
      const degenerate = [...indices];
      degenerate[triangle + 1] = degenerate[triangle]!;
      cases.push({ positions, indices: degenerate });
      const outside = [...indices];
      outside[triangle] = positions.length / 3;
      cases.push({ positions, indices: outside });
      // Two copies of the closed mesh glued on no edge: still closed.
      const offset = positions.length / 3;
      cases.push({
        positions: [...positions, ...positions],
        indices: [...indices, ...indices.map((index) => index + offset)]
      });
      // The same edge used four times, twice each way: non-manifold.
      cases.push({ positions, indices: [...indices, ...indices] });
    }
    for (const { positions, indices } of cases) {
      const closed = isClosedConsistentlyOrientedMesh(
        inspectDisplayMeshClosure(
          new Float32Array(positions),
          new Uint32Array(indices)
        )
      );
      // The fast pass decides every closed case; anything it rejects goes
      // to the welded check, which these shared-index meshes cannot rescue.
      expect(closed).toBe(mapIndexClosed(positions.length, indices));
    }
  });

  it('counts the triangles of a closed mesh', () => {
    const { positions, indices } = prism(12);
    expect(
      inspectDisplayMeshClosure(
        new Float32Array(positions),
        new Uint32Array(indices)
      )
    ).toEqual({
      boundaryEdges: 0,
      nonManifoldEdges: 0,
      inconsistentWindingEdges: 0,
      triangles: indices.length / 3
    });
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
      // A later sync that reuses the retained (gapped) measurement keeps the
      // verdict, which is remembered with the measurement. With the spy
      // gone, a fresh tessellation would be closed and silence it.
      spy.mockRestore();
      const edited = addPrimitiveFeature(document, {
        name: 'Other',
        primitiveKind: 'box',
        dimensions: { width: 5, height: 5, depth: 5 }
      });
      const reused = await fresh.syncDocument(edited);
      expect(reused.bodyRepresentations[bodyId]!.mesh.indices).toEqual(
        derived.bodyRepresentations[bodyId]!.mesh.indices
      );
      expect(
        advisories(reused.featureWarnings).map((warning) => warning.featureName)
      ).toEqual(['Box']);
    } finally {
      fresh.dispose();
      spy.mockRestore();
    }
  });
});
