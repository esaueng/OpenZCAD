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
 * Two operations a user can reach from the toolbar both go wrong on a sphere,
 * and on nothing else.
 *
 * PRODUCT-level pins: everything runs through `syncDocument`, so the volume
 * is the one the UI prints and the mesh is the one the viewport draws.
 *
 * The controls are the point. Box, cylinder and torus are exercised through
 * the identical code path in the same run and are exact. The torus control
 * matters most: it is closed, seamed and doubly periodic, and it survives
 * both operations. So neither defect is about curvature, periodicity or
 * seams -- it is the sphere specifically.
 *
 * Measured through the adapter, and separately confirmed against the raw
 * kernel so the defect is BrepKit's rather than this adapter's:
 *
 *   kernel.cut(makeSphere(10, seg), boxTranslated1000Away)
 *     -> 4176.8262 against 4188.7902, i.e. -0.2856%
 *   identical at seg = 16, 32 and 64, while box and cylinder are exact.
 *
 * Segment-independence is why this is not a tessellation-resolution story.
 *
 * Do NOT verify any of this by comparing `mass_properties` against
 * `solid_volume` -- they share `integrate_face` and agree even when both are
 * wrong. Every expectation below is a closed form written out here.
 */
describe('a sphere under boolean and offset', () => {
  let adapter: ExactKernelAdapter;

  const SPHERE_R = 10;
  /** 4/3 pi r^3, computed here rather than read back from the kernel. */
  const SPHERE = (4 / 3) * Math.PI * SPHERE_R ** 3;

  const measure = (mesh: { vertices: number[]; indices: number[] }) => ({
    triangles: Math.floor(mesh.indices.length / 3)
  });

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
    const derived = await adapter.syncDocument(document);
    const body = derived.bodyRepresentations[document.bodyOrder.at(-1)!]!;
    const surfaces = new Set(
      (body.topology?.faces ?? []).map((face) => face.geometry?.surfaceType)
    );
    return {
      volume: body.volume,
      surfaces,
      ...measure(body.mesh),
      warnings: derived.warnings
    };
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
    const derived = await adapter.syncDocument(document);
    const body = derived.bodyRepresentations[document.bodyOrder.at(-1)!]!;
    return {
      volume: body.volume,
      ...measure(body.mesh),
      warnings: derived.warnings
    };
  };

  describe('subtracting a tool that touches nothing', () => {
    /**
     * These two are deliberately SEPARATE `it.fails` rather than one with two
     * assertions, and the reason is worth keeping.
     *
     * An `it.fails` only turns red when EVERY assertion inside it passes. Bundle
     * two independent symptoms together and a partial fix leaves the test green
     * — which is exactly the silent-success failure mode this whole file exists
     * to catch. Losing 0.29% of the volume and replacing the analytic sphere
     * with 2588 planes are separate symptoms with plausibly separate fixes, so
     * they get separate tripwires.
     */
    it.fails(
      'keeps the whole volume when the tool touches nothing',
      async () => {
        const { volume } = await cutWithDisjointTool('sphere', {
          radius: SPHERE_R
        });
        expect(Math.abs(volume - SPHERE) / SPHERE).toBeLessThan(1e-9);
      },
      120_000
    );

    it.fails(
      'keeps the sphere analytic rather than standing a polyhedron in for it',
      async () => {
        const { surfaces } = await cutWithDisjointTool('sphere', {
          radius: SPHERE_R
        });
        expect(surfaces).toEqual(new Set(['sphere']));
      },
      120_000
    );

    it('instead facets the sphere and loses 0.29% of it, silently', async () => {
      // The companion to the pin above. It records the specific wrong value so
      // a change that merely perturbs the number is distinguishable from one
      // that fixes the defect.
      const { volume, surfaces, triangles, warnings } =
        await cutWithDisjointTool('sphere', { radius: SPHERE_R });
      expect(volume).toBeCloseTo(4176.826, 2);
      expect(volume).toBeLessThan(SPHERE);
      expect((SPHERE - volume) / SPHERE).toBeGreaterThan(0.0028);
      // The exact spherical surface is gone -- every face is now a plane.
      expect(surfaces).toEqual(new Set(['plane']));
      // A sphere tessellates to ~140k triangles; the polyhedron is far coarser.
      expect(triangles).toBeLessThan(10_000);
      // And nothing tells the user any of this happened.
      expect(warnings).toEqual([]);
    }, 120_000);

    it.each([
      ['box', { width: 20, height: 20, depth: 20 }, 8000, 'plane'],
      ['cylinder', { radius: 10, height: 20 }, Math.PI * 100 * 20, 'cylinder']
    ] as const)(
      'leaves a %s untouched, as it must',
      async (primitiveKind, dimensions, exact, keptSurface) => {
        const { volume, surfaces, warnings } = await cutWithDisjointTool(
          primitiveKind,
          dimensions as Record<string, number>
        );
        expect(Math.abs(volume - exact) / exact).toBeLessThan(1e-9);
        // The analytic surface survives the same operation on these shapes.
        expect(surfaces.has(keptSurface)).toBe(true);
        expect(warnings).toEqual([]);
      },
      120_000
    );
  });

  describe('offsetting a solid', () => {
    it.fails(
      'draws the offset sphere it correctly measures',
      async () => {
        const { volume, triangles } = await offset(
          'sphere',
          { radius: SPHERE_R },
          2
        );
        // The measurement is already right; it is the mesh that is missing.
        expect(volume).toBeCloseTo((4 / 3) * Math.PI * 12 ** 3, 6);
        expect(triangles).toBeGreaterThan(0);
      },
      120_000
    );

    it('measures the offset sphere exactly and then draws nothing', async () => {
      const { volume, triangles, warnings } = await offset(
        'sphere',
        { radius: SPHERE_R },
        2
      );
      // Exactly r=12, so the offset itself is computed correctly.
      expect(volume).toBeCloseTo((4 / 3) * Math.PI * 12 ** 3, 6);
      // An empty mesh. `boundaryEdges === 0` is vacuously true of one, which
      // is why no watertightness check objects -- that is what makes this
      // silent rather than loud.
      expect(triangles).toBe(0);
      expect(warnings).toEqual([]);
    }, 120_000);

    it('does the same at a distance far too small to blame on tolerance', async () => {
      const { volume, triangles } = await offset(
        'sphere',
        { radius: SPHERE_R },
        0.001
      );
      expect(volume).toBeCloseTo((4 / 3) * Math.PI * 10.001 ** 3, 6);
      expect(triangles).toBe(0);
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
          dimensions as Record<string, number>,
          distance
        );
        expect(Math.abs(volume - exact) / exact).toBeLessThan(1e-6);
        expect(triangles).toBeGreaterThan(0);
        expect(warnings).toEqual([]);
      },
      120_000
    );
  });
});
