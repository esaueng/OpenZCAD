import { describe, expect, it, vi } from 'vitest';
import { createProjectDocument, importStepBody } from '@openzcad/document-core';
import { createExactKernelAdapter } from '@openzcad/kernel-adapter/exact';
import { toUserId } from '@openzcad/shared';
import {
  brepEdgeDisplayRole,
  brepSmoothEdges
} from '../packages/kernel-adapter/src/exact-brep';
import { drawingSectionOfShape } from '../packages/kernel-adapter/src/exact-drawing-section';
import { edgeWitnessOf } from '../packages/kernel-adapter/src/exact-witnesses';
import { topologyHashOfWitness } from '../packages/kernel-adapter/src/topology-lineage';
import {
  RemusKernel,
  loadRemusTranslators
} from '../packages/kernel-adapter/src/remus-runtime';

describe('spline self-seam display roles', () => {
  it.each(['bspline', 'nurbs'])(
    'requires an affirmative kernel G1 verdict on %s',
    (surfaceType) => {
      const kernel = {
        getSurfaceType: () => surfaceType,
        getSolidSmoothEdges: vi.fn(() => Uint32Array.of(7)),
        // Even closed spline faces can have a crease at their self-seam.
        getNurbsSurfaceDataParity: vi.fn(() =>
          JSON.stringify({ isPeriodicU: true, isPeriodicV: true })
        )
      } as unknown as RemusKernel;
      const owners = { '7': [10, 10], '8': [10, 10] };
      const smooth = brepSmoothEdges(kernel, 1);
      expect(brepEdgeDisplayRole(kernel, 7, owners, smooth?.has(7))).toBe(
        'seam'
      );
      expect(brepEdgeDisplayRole(kernel, 8, owners, smooth?.has(8))).toBe(
        'feature'
      );
      expect(brepEdgeDisplayRole(kernel, 7, owners)).toBe('feature');
      expect(kernel.getNurbsSurfaceDataParity).not.toHaveBeenCalled();
      expect(kernel.getSolidSmoothEdges).toHaveBeenCalledExactlyOnceWith(1);

      kernel.getSolidSmoothEdges = () => {
        throw new Error('G1 unavailable');
      };
      const unknown = brepSmoothEdges(kernel, 1);
      expect(unknown).toBeUndefined();
      expect(brepEdgeDisplayRole(kernel, 7, owners, unknown?.has(7))).toBe(
        'feature'
      );
    }
  );

  it.each([undefined, [], [10], [10, 11], [10, 10, 11]])(
    'keeps a smooth spline edge with owners %j visible unless it is self-owned twice',
    (owners) => {
      const kernel = {
        getSurfaceType: () => 'bspline'
      } as unknown as RemusKernel;
      const map: Record<string, number[]> = owners ? { '7': owners } : {};
      expect(brepEdgeDisplayRole(kernel, 7, map, true)).toBe('feature');
    }
  );

  it('accepts repeated self-incidence and preserves the analytic and sphere rules', () => {
    for (const surfaceType of [
      'cylinder',
      'cone',
      'sphere',
      'torus',
      'plane',
      'bspline'
    ]) {
      const kernel = {
        getSurfaceType: () => surfaceType
      } as unknown as RemusKernel;
      for (const verdict of [true, false, undefined]) {
        expect(
          brepEdgeDisplayRole(kernel, 7, { '7': [10, 10, 10] }, verdict)
        ).toBe(
          surfaceType === 'plane' ||
            (surfaceType === 'bspline' && verdict !== true)
            ? 'feature'
            : 'seam'
        );
      }
    }
    const kernel = {
      getSurfaceType: () => 'sphere',
      getAnalyticSurfaceParams: () =>
        JSON.stringify({ center: [0, 0, 0], radius: 2 })
    } as unknown as RemusKernel;
    expect(brepEdgeDisplayRole(kernel, 7, { '7': [10, 11] }, false)).toBe(
      'seam'
    );
    kernel.getAnalyticSurfaceParams = (face) =>
      JSON.stringify({ center: [0, 0, 0], radius: face });
    expect(brepEdgeDisplayRole(kernel, 7, { '7': [10, 11] }, true)).toBe(
      'feature'
    );
  });
});

/** A rational ellipse extruded as one B-spline wall, with matching seam tangents. */
function splineTube(kernel: RemusKernel): number {
  const edge = kernel.makeNurbsEdge(
    2,
    0,
    0,
    2,
    0,
    0,
    2,
    Float64Array.of(0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 4),
    Float64Array.of(
      2,
      0,
      0,
      2,
      1,
      0,
      0,
      1,
      0,
      -2,
      1,
      0,
      -2,
      0,
      0,
      -2,
      -1,
      0,
      0,
      -1,
      0,
      2,
      -1,
      0,
      2,
      0,
      0
    ),
    Float64Array.of(
      1,
      Math.SQRT1_2,
      1,
      Math.SQRT1_2,
      1,
      Math.SQRT1_2,
      1,
      Math.SQRT1_2,
      1
    )
  );
  const face = kernel.makePlanarFaceFromWire(
    kernel.makeWire(Uint32Array.of(edge), true)
  );
  return kernel.extrude(face, 0, 0, 1, 5);
}

function selfSeam(kernel: RemusKernel, solid: number): number {
  const map = JSON.parse(kernel.edgeToFaceMap(solid)) as Record<
    string,
    number[]
  >;
  const selfOwned = Array.from(kernel.getSolidEdges(solid)).filter((edge) => {
    const owners = map[String(edge)]!;
    return owners.length >= 2 && new Set(owners).size === 1;
  });
  expect(selfOwned).toHaveLength(1);
  expect(kernel.getSurfaceType(map[String(selfOwned[0]!)]![0]!)).toBe(
    'bspline'
  );
  return selfOwned[0]!;
}

async function importedTube(kernel: RemusKernel, solid: number) {
  const io = await loadRemusTranslators();
  return importStepBody(
    createProjectDocument('Spline tube', toUserId('user_test')),
    {
      name: 'Spline tube',
      artifactId: 'artifact_spline_tube',
      sourceName: 'spline-tube.step',
      stepText: new TextDecoder().decode(
        io.exportStep(kernel.serializeSolid(solid))
      )
    }
  );
}

describe('published spline self-seams', () => {
  it('pins the current Remus omission: a real smooth self-seam stays a feature', async () => {
    const kernel = new RemusKernel();
    const adapter = await createExactKernelAdapter();
    try {
      const solid = splineTube(kernel);
      const seam = selfSeam(kernel, solid);
      // RemusKernel.getSolidSmoothEdges currently excludes self-owned edges.
      // These expectations flip once Remus reports their G1 verdict (#1623),
      // so the automated pin bump must inspect this newly hidden edge.
      expect(Array.from(kernel.getSolidSmoothEdges(solid))).not.toContain(seam);
      const hash = topologyHashOfWitness('edge', edgeWitnessOf(kernel, seam));
      const imported = await importedTube(kernel, solid);
      const result = await adapter.syncDocument(imported.document);
      expect(result.warnings).toEqual([]);
      const body = result.bodyRepresentations[imported.bodyId]!;
      expect(body.faceCount).toBe(3);
      expect(body.topology!.edges).toHaveLength(3);
      expect(
        body.topology!.edges.find((edge) => edge.hash === hash)
      ).toMatchObject({
        displayRole: 'feature',
        isSmooth: false
      });
      expect(body.topology!.edges.map((edge) => edge.displayRole)).toEqual([
        'feature',
        'feature',
        'feature'
      ]);
    } finally {
      adapter.dispose();
      kernel.free();
    }
  });

  it('threads an affirmative G1 verdict through body and drawing publication without changing identity', async () => {
    const kernel = new RemusKernel();
    const beforeAdapter = await createExactKernelAdapter();
    const afterAdapter = await createExactKernelAdapter();
    try {
      const solid = splineTube(kernel);
      const seam = selfSeam(kernel, solid);
      const hash = topologyHashOfWitness('edge', edgeWitnessOf(kernel, seam));
      const imported = await importedTube(kernel, solid);
      const before = (await beforeAdapter.syncDocument(imported.document))
        .bodyRepresentations[imported.bodyId]!.topology!;
      const plane = { normal: { x: 0, y: 0, z: 1 }, depth: -1 };
      const beforeDrawing = drawingSectionOfShape(
        kernel,
        { solids: [solid] },
        plane
      );
      if (!beforeDrawing) throw new Error('The section must keep the tube.');
      const continuity = vi
        .spyOn(RemusKernel.prototype, 'getSolidSmoothEdges')
        .mockImplementation(function (this: RemusKernel, handle) {
          return Uint32Array.of(selfSeam(this, handle));
        });
      try {
        const result = await afterAdapter.syncDocument(imported.document);
        expect(result.warnings).toEqual([]);
        const after = result.bodyRepresentations[imported.bodyId]!.topology!;
        expect(after).toEqual({
          ...before,
          edges: before.edges.map((edge) =>
            edge.hash === hash
              ? { ...edge, displayRole: 'seam', isSmooth: true }
              : edge
          )
        });
        const afterDrawing = drawingSectionOfShape(
          kernel,
          { solids: [solid] },
          plane
        );
        if (!afterDrawing) throw new Error('The section must keep the tube.');
        expect(afterDrawing.edgeTopology).toEqual(
          beforeDrawing.edgeTopology.map((edge) =>
            edge.hash === hash ? { ...edge, displayRole: 'seam' } : edge
          )
        );
        expect(afterDrawing.edges).toEqual(
          beforeDrawing.edges.filter((points) =>
            // The self-seam is the only longitudinal line (all z are not equal).
            points.every(
              (value, index) => index % 3 !== 2 || value === points[2]
            )
          )
        );
        expect(afterDrawing.edges).toHaveLength(2);
        expect(afterDrawing.faces).toEqual(beforeDrawing.faces);
      } finally {
        continuity.mockRestore();
      }
    } finally {
      beforeAdapter.dispose();
      afterAdapter.dispose();
      kernel.free();
    }
  });
});
