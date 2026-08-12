import { describe, expect, it } from 'vitest';
import {
  addPrimitiveFeature,
  booleanBodies,
  createProjectDocument,
  offsetSolidBody,
  transformBody
} from '@openzcad/document-core';
import { toUserId } from '@openzcad/shared';
import {
  createExactKernelAdapter,
  type ExactKernelAdapter
} from '@openzcad/kernel-adapter/exact';

/**
 * Two operations a user can reach from the toolbar both went wrong on a
 * sphere, and on nothing else. brepkit#65 fixed both, and this file was
 * flipped from a pair of `it.fails` tripwires to positive pins.
 *
 * PRODUCT-level: everything runs through `syncDocument`, so the volume is the
 * one the UI prints and the mesh is the one the viewport draws. Every
 * expectation is a closed form written out here. `mass_properties` is never
 * the reference — it shares `integrate_face` with `solid_volume`, so their
 * agreement is structurally blind and has hidden real errors on this project.
 *
 * WHAT WAS WRONG, kept because it explains why the assertions are as tight as
 * they are:
 *
 *   cut(sphere r10, box parked 1000 away)  ->  4176.8262 against 4188.7902,
 *   i.e. -0.2856%, with both spherical faces replaced by 2588 PLANES.
 *   Identical at seg = 16, 32 and 64, which is what said it was not a
 *   tessellation-resolution story.
 *
 *   offset(sphere r10, +2)  ->  measured 7238.2295 exactly right and drew
 *   ZERO triangles. A body in the tree, measuring perfectly, invisible. No
 *   watertightness check objected, because zero boundary edges is vacuously
 *   true of an empty mesh.
 *
 * ROOT CAUSE of the offset half, worth keeping because it is a trap this
 * project keeps walking into. `offset/src/loops.rs::try_direct_chain` fixed a
 * loop's traversal sense by walking from an arbitrary start edge. On a bounded
 * face that is harmless; on a CLOSED surface the sense IS the region, so both
 * offset faces came out as the NORTHERN hemisphere, one flagged `reversed`.
 * `dedupe_coincident_triangles` then did its job correctly and cancelled 6903
 * coincident opposite-wound triangles to nothing. The volume was right for the
 * WRONG REASON — two hemispheres' contributions to the divergence integral
 * summed to the number the real sphere would give. A closed form agreeing to
 * 1e-15 on a body that does not exist is the same trap as two routes agreeing
 * through a shared integrator.
 *
 * The controls remain the argument for scope: box, cylinder and torus go
 * through the identical path in the same run. The torus matters most — closed,
 * seamed, doubly periodic — so none of this was ever about curvature,
 * periodicity or seams.
 */
describe('a sphere under boolean and offset', () => {
  let adapter: ExactKernelAdapter;

  const SPHERE_R = 10;
  /** 4/3 pi r^3, computed here rather than read back from the kernel. */
  const SPHERE = (4 / 3) * Math.PI * SPHERE_R ** 3;

  /** Edges used by other than exactly two triangles — 0 iff watertight. */
  const openEdgeCount = (mesh: { indices: number[] }) => {
    const counts = new Map<string, number>();
    for (let i = 0; i < mesh.indices.length; i += 3) {
      const tri = [
        mesh.indices[i]!,
        mesh.indices[i + 1]!,
        mesh.indices[i + 2]!
      ];
      for (let k = 0; k < 3; k++) {
        const a = tri[k]!;
        const b = tri[(k + 1) % 3]!;
        const key = a < b ? `${a}_${b}` : `${b}_${a}`;
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
    }
    return [...counts.values()].filter((count) => count !== 2).length;
  };

  const read = async (
    document: ReturnType<typeof createProjectDocument>,
    kernel: ExactKernelAdapter
  ) => {
    const derived = await kernel.syncDocument(document);
    const body = derived.bodyRepresentations[document.bodyOrder.at(-1)!]!;
    return {
      volume: body.volume,
      faces: body.topology?.faces.length ?? 0,
      surfaces: new Set(
        (body.topology?.faces ?? []).map((face) => face.geometry?.surfaceType)
      ),
      triangles: Math.floor(body.mesh.indices.length / 3),
      openEdges: openEdgeCount(body.mesh),
      mesh: body.mesh,
      warnings: derived.warnings
    };
  };

  /** Subtract a tool that sits 1000 units away, so it touches nothing. */
  const cutWithDisjointTool = async (
    primitiveKind: 'sphere' | 'box' | 'cylinder',
    dimensions: Record<string, number>
  ) => {
    adapter ??= await createExactKernelAdapter();
    let document = createProjectDocument('Disjoint cut', toUserId('user_sph'));
    document = addPrimitiveFeature(document, {
      name: 'Target',
      primitiveKind,
      dimensions
    });
    const targetId = document.bodyOrder.at(-1)!;
    document = addPrimitiveFeature(document, {
      name: 'Tool',
      primitiveKind: 'box',
      dimensions: { width: 20, height: 20, depth: 20 }
    });
    const toolId = document.bodyOrder.at(-1)!;
    document = transformBody(document, {
      name: 'Park the tool far away',
      targetBodyId: toolId,
      translation: { x: 1000, y: 0, z: 0 }
    }).document;
    document = booleanBodies(document, {
      name: 'Subtract',
      operation: 'subtract',
      targetBodyIds: [targetId, toolId]
    }).document;
    return read(document, adapter);
  };

  const offset = async (
    primitiveKind: 'sphere' | 'box' | 'cylinder' | 'torus',
    dimensions: Record<string, number>,
    distance: number
  ) => {
    adapter ??= await createExactKernelAdapter();
    let document = createProjectDocument('Offset', toUserId('user_sph'));
    document = addPrimitiveFeature(document, {
      name: 'Target',
      primitiveKind,
      dimensions
    });
    const targetId = document.bodyOrder.at(-1)!;
    document = offsetSolidBody(document, {
      name: 'Offset',
      targetBodyId: targetId,
      distance
    }).document;
    return read(document, adapter);
  };

  describe('subtracting a tool that touches nothing', () => {
    it('is an exact identity, to the last bit', async () => {
      // Not `toBeCloseTo`. The reading is byte-identical to the closed form,
      // and asserting that is the point: an identity operation that returns
      // anything other than its input is the defect this file was opened for.
      const { volume } = await cutWithDisjointTool('sphere', {
        radius: SPHERE_R
      });
      expect(volume).toBe(SPHERE);
    }, 120_000);

    it('keeps the sphere analytic instead of standing a polyhedron in for it', async () => {
      // The second half, kept a separate test rather than a second assertion
      // on the first. Losing 0.29% of the volume and replacing the analytic
      // sphere with 2588 planes were independent symptoms with independent
      // fixes, so they keep independent pins and a half-regression cannot
      // hide behind the other half still passing.
      const { faces, surfaces, triangles, warnings } =
        await cutWithDisjointTool('sphere', { radius: SPHERE_R });
      expect(surfaces).toEqual(new Set(['sphere']));
      // Two hemispheres, which is how BrepKit builds a sphere.
      expect(faces).toBe(2);
      // And it uses the kernel's tolerance-driven analytic-sphere mesh, not
      // the 2588-plane polyhedron the old path substituted.
      expect(triangles).toBe(24_964);
      expect(warnings).toEqual([]);
    }, 120_000);

    it.each([
      ['box', { width: 20, height: 20, depth: 20 }, 8000, 'plane'],
      ['cylinder', { radius: 10, height: 20 }, Math.PI * 100 * 20, 'cylinder']
    ] as const)(
      'leaves a %s untouched, as it always did',
      async (primitiveKind, dimensions, exact, keptSurface) => {
        const { volume, surfaces, warnings } = await cutWithDisjointTool(
          primitiveKind,
          dimensions
        );
        expect(Math.abs(volume - exact) / exact).toBeLessThan(1e-9);
        expect(surfaces.has(keptSurface)).toBe(true);
        expect(warnings).toEqual([]);
      },
      120_000
    );
  });

  describe('offsetting a solid', () => {
    it('draws the offset sphere it correctly measures', async () => {
      const { volume, triangles, openEdges } = await offset(
        'sphere',
        { radius: SPHERE_R },
        2
      );
      const exact = (4 / 3) * Math.PI * 12 ** 3;
      expect(Math.abs(volume - exact) / exact).toBeLessThan(1e-15);
      // The measurement and tolerance-driven analytic mesh agree.
      expect(triangles).toBe(24_964);
      // And it is a CLOSED surface, not merely a non-empty one. The old
      // defect passed every watertightness check by drawing nothing at all,
      // so "zero boundary edges" only means something alongside a mesh.
      expect(openEdges).toBe(0);
    }, 120_000);

    it('does the same at a distance far too small to blame on tolerance', async () => {
      const { volume, triangles, openEdges } = await offset(
        'sphere',
        { radius: SPHERE_R },
        0.001
      );
      expect(volume).toBe((4 / 3) * Math.PI * 10.001 ** 3);
      expect(triangles).toBe(24_964);
      expect(openEdges).toBe(0);
    }, 120_000);

    it.each([
      ['box', { width: 20, height: 20, depth: 20 }, 2, 24 ** 3],
      ['cylinder', { radius: 5, height: 10 }, 2, Math.PI * 49 * 14],
      [
        'torus',
        { majorRadius: 10, minorRadius: 3 },
        1,
        2 * Math.PI ** 2 * 10 * 16
      ]
    ] as const)(
      'offsets a %s correctly and draws it',
      async (primitiveKind, dimensions, distance, exact) => {
        const { volume, triangles, warnings } = await offset(
          primitiveKind,
          dimensions,
          distance
        );
        expect(Math.abs(volume - exact) / exact).toBeLessThan(1e-6);
        expect(triangles).toBeGreaterThan(0);
        expect(warnings).toEqual([]);
      },
      120_000
    );
  });

  /**
   * Keep the former overlapping-sphere tessellation regression pinned. Both
   * the exact B-rep and its viewport mesh must remain correct and closed.
   */
  describe('an overlapping cut remains exact and watertight', () => {
    const overlappingCut = async () => {
      adapter ??= await createExactKernelAdapter();
      let document = createProjectDocument('Overlap', toUserId('user_sph'));
      document = addPrimitiveFeature(document, {
        name: 'Sphere',
        primitiveKind: 'sphere',
        dimensions: { radius: SPHERE_R }
      });
      const sphereId = document.bodyOrder.at(-1)!;
      document = addPrimitiveFeature(document, {
        name: 'Tool',
        primitiveKind: 'box',
        dimensions: { width: 40, height: 40, depth: 40 }
      });
      const toolId = document.bodyOrder.at(-1)!;
      // Boxes are corner-at-origin, so this puts the tool's floor at z = 5 and
      // spans it well past the sphere in x and y: everything above z = 5 is
      // removed and nothing else is touched.
      document = transformBody(document, {
        name: 'Slice the cap off',
        targetBodyId: toolId,
        translation: { x: -20, y: -20, z: 5 }
      }).document;
      document = booleanBodies(document, {
        name: 'Subtract',
        operation: 'subtract',
        targetBodyIds: [sphereId, toolId]
      }).document;
      return read(document, adapter);
    };

    /** Sphere less the cap above z = 5: pi h^2 (3r - h) / 3 with h = 5. */
    const CAPPED = SPHERE - (Math.PI * 25 * (3 * SPHERE_R - 5)) / 3;

    it('measures the truncated sphere against its closed form', async () => {
      const { volume, faces, surfaces, warnings } = await overlappingCut();
      expect(Math.abs(volume - CAPPED) / CAPPED).toBeLessThan(1e-12);
      // Two hemispheres plus the flat disc the cut leaves.
      expect(faces).toBe(3);
      expect(surfaces).toEqual(new Set(['plane', 'sphere']));
      expect(warnings).toEqual([]);
    }, 120_000);

    it('hands the viewport a closed mesh', async () => {
      const { openEdges, triangles, warnings } = await overlappingCut();
      expect(openEdges).toBe(0);
      expect(triangles).toBe(65_792);
      expect(warnings).toEqual([]);
    }, 120_000);

    it('does not leak vertices into the removed region', async () => {
      // The boolean must not leave any tessellated material above the cut.
      const { mesh } = await overlappingCut();
      let above = 0;
      for (let i = 0; i < mesh.vertices.length; i += 3) {
        if (mesh.vertices[i + 2]! > 5 + 1e-9) above++;
      }
      expect(above).toBe(0);
    }, 120_000);
  });
});
