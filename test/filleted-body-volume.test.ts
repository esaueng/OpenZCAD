import { describe, expect, it } from 'vitest';
import {
  addPrimitiveFeature,
  booleanBodies,
  chamferEdges,
  createProjectDocument,
  filletEdges,
  transformBody
} from '@openzcad/document-core';
import { toUserId } from '@openzcad/shared';
import {
  createExactKernelAdapter,
  type ExactKernelAdapter
} from '@openzcad/kernel-adapter/exact';

/**
 * A filleted body is the one ordinary shape whose volume is not exact, and the
 * size of the error is set by dimensions the fillet has nothing to do with.
 *
 * PRODUCT-level: everything goes through `syncDocument`, so `volume` is the
 * number the UI prints. Every expectation is a closed form written out in this
 * file — `mass_properties` is never used as the reference, since it shares
 * `integrate_face` with `solid_volume` and their agreement is structurally
 * blind.
 *
 * The controls are the whole argument, and they are unusually tight here. A
 * box with a cylindrical THROUGH BORE has the same face count (7), the same
 * surface mix (`cylinder` + `plane`), the same everything — and it is exact to
 * the last bit. So this is not "curved", not "a boolean result", not "seven
 * faces", not "an analytic quadric in the body". Measured in one run:
 *
 *   box 20^3                        rel = 0          EXACT
 *   cylinder r10 h20                rel = 0          EXACT
 *   box + chamfer 2 (all planes)    rel = 0          EXACT
 *   box with a through bore r4      rel = 0          EXACT   <- 7 faces, cyl+plane
 *   two boxes fused                 rel = 0          EXACT
 *   box + FILLET r2                 rel = -4.197e-6          <- 7 faces, cyl+plane
 *
 * The error is scale-INVARIANT under similarity — identically -4.197e-6 at
 * S = 0.2, 2, 20 and 200 — so it is not the absolute-length defect class this
 * project keeps finding. It is the mirror image of it: something relative to
 * the wrong length.
 *
 * That "wrong length" is the whole part. Hold the fillet fixed (r = 2 on a
 * z-edge of a W x 20 x 20 block, so the filleted edge is geometrically
 * IDENTICAL in every row) and stretch W:
 *
 *   width      removed      exact        over
 *      20    17.201651    17.168147     0.1952 %
 *     200    17.356369    17.168147     1.0963 %
 *    2000    17.763456    17.168147     3.4675 %
 *
 * The same 2 mm fillet measures 0.2 % over on a 20 mm block and 3.5 % over on
 * a 2 m beam. Nothing about the fillet changed.
 *
 * The likely mechanism, from Remus's own source rather than inferred here:
 * `measure/volume.rs::volume_tessellation_deflection` clamps the caller's
 * deflection to `diag * 5e-5`, where `diag` is the bounding-box diagonal of
 * the WHOLE SOLID. Tessellation error on a face is governed by that face's own
 * curvature radius, not by how large the rest of the part is, so tying the two
 * together makes a small feature measure worse the bigger its neighbours get.
 * OpenZCAD's side of it is `MEASUREMENT_DEFLECTION = 0.08` in
 * `packages/kernel-adapter/src/exact.ts`, one hardcoded figure passed to every
 * `kernel.volume` call and shared in spirit with `STL_EXPORT_DEFLECTION`.
 *
 * Severity, stated honestly rather than at its most alarming: at BODY level
 * this is small — 4.2e-6 on the cube, 7.4e-7 on the 2 m beam, because the
 * fillet is a small part of a large part. It matters at FEATURE level, where
 * it is percent-scale; it matters for anything summing many fillets; and it
 * matters because it breaks a property users assume without checking, that
 * editing one dimension does not change the measured contribution of a feature
 * elsewhere on the part.
 *
 * And it is silent: no warning fires at any of these sizes.
 */
describe('a filleted body', () => {
  let adapter: ExactKernelAdapter;

  const midOf = (p: number[]) => {
    const n = p.length;
    return [
      (p[n - 3]! + p[0]!) / 2,
      (p[n - 2]! + p[1]!) / 2,
      (p[n - 1]! + p[2]!) / 2
    ];
  };
  const axisOf = (p: number[]) => {
    const n = p.length;
    const d = [p[n - 3]! - p[0]!, p[n - 2]! - p[1]!, p[n - 1]! - p[2]!];
    const abs = d.map(Math.abs);
    return 'xyz'[abs.indexOf(Math.max(...abs))]!;
  };

  const box = (w: number, h: number, d: number) => {
    let doc = createProjectDocument('Block', toUserId('user_fil'));
    doc = addPrimitiveFeature(doc, {
      name: 'Block',
      primitiveKind: 'box',
      dimensions: { width: w, height: h, depth: d }
    });
    return doc;
  };

  /**
   * Break the z-edge on the origin corner. Boxes are built corner-at-origin,
   * so this edge sits at x = y = 0 and does NOT move when `width` changes —
   * which is what makes the stretch sweep below a controlled comparison rather
   * than a comparison of two different fillets.
   */
  const breakOriginEdge = async (
    doc: ReturnType<typeof createProjectDocument>,
    kind: 'fillet' | 'chamfer',
    size: number
  ) => {
    const target = doc.bodyOrder.at(-1)!;
    const derived = await adapter.syncDocument(doc);
    const edges = derived.bodyRepresentations[target]!.topology?.edges ?? [];
    const edge = edges.find((e) => {
      const m = midOf(e.points);
      return (
        axisOf(e.points) === 'z' &&
        Math.abs(m[0]!) < 1e-9 &&
        Math.abs(m[1]!) < 1e-9
      );
    })!;
    expect(edge).toBeDefined();
    const op = kind === 'fillet' ? filletEdges : chamferEdges;
    return op(doc, {
      name: 'Break',
      targetBodyId: target,
      edgeHashes: [edge.hash],
      size
    }).document;
  };

  const measure = async (
    document: ReturnType<typeof createProjectDocument>
  ) => {
    adapter ??= await createExactKernelAdapter();
    const derived = await adapter.syncDocument(document);
    const b = derived.bodyRepresentations[document.bodyOrder.at(-1)!]!;
    return {
      volume: b.volume,
      faces: b.topology?.faces.length ?? 0,
      surfaces: new Set(
        (b.topology?.faces ?? []).map((f) => f.geometry?.surfaceType)
      ),
      warnings: derived.warnings
    };
  };

  /** Filleting one convex 90 deg edge removes a prism over r^2 - pi r^2/4. */
  const filletCut = (r: number, length: number) =>
    r * r * (1 - Math.PI / 4) * length;

  it.fails(
    'measures exactly, as every other analytic body does',
    async () => {
      adapter ??= await createExactKernelAdapter();
      const doc = await breakOriginEdge(box(20, 20, 20), 'fillet', 2);
      const { volume } = await measure(doc);
      const exact = 8000 - filletCut(2, 20);
      expect(Math.abs(volume - exact) / exact).toBeLessThan(1e-12);
    },
    120_000
  );

  it('instead reads 4.2e-6 low, and the fillet itself 0.2% over', async () => {
    // The companion to the pin above. It records the specific wrong values so
    // a change that merely perturbs them is distinguishable from one that
    // fixes the defect.
    adapter ??= await createExactKernelAdapter();
    const doc = await breakOriginEdge(box(20, 20, 20), 'fillet', 2);
    const { volume, faces, surfaces, warnings } = await measure(doc);
    const exact = 8000 - filletCut(2, 20);
    expect(volume).toBeCloseTo(7982.79834915, 7);
    expect(volume).toBeLessThan(exact);
    expect((volume - exact) / exact).toBeCloseTo(-4.197e-6, 9);
    // Over-removed, i.e. the fillet arc is inscribed rather than exact.
    expect(8000 - volume).toBeGreaterThan(filletCut(2, 20));
    // Seven faces, cylinder + plane — the same shape of body as the bored box
    // below, which is exact.
    expect(faces).toBe(7);
    expect(surfaces).toEqual(new Set(['cylinder', 'plane']));
    expect(warnings).toEqual([]);
  }, 120_000);

  it.fails(
    'measures a fillet the same wherever else the part grows',
    async () => {
      // The sharp one. The filleted edge is IDENTICAL in both rows: same
      // radius, same length, same position, on the corner the stretch does not
      // touch. Only `width` differs, and only on the far side of the block.
      adapter ??= await createExactKernelAdapter();
      const small = await measure(
        await breakOriginEdge(box(20, 20, 20), 'fillet', 2)
      );
      const large = await measure(
        await breakOriginEdge(box(2000, 20, 20), 'fillet', 2)
      );
      const removedSmall = 20 * 400 - small.volume;
      const removedLarge = 2000 * 400 - large.volume;
      expect(Math.abs(removedLarge - removedSmall) / removedSmall).toBeLessThan(
        1e-9
      );
    },
    120_000
  );

  it.each([
    [20, 17.20165085, 0.1952],
    [200, 17.356369039, 1.0963],
    [2000, 17.763455517, 3.4675]
  ])(
    'instead over-removes by more as the far dimension reaches %s',
    async (width, removed, overPercent) => {
      adapter ??= await createExactKernelAdapter();
      const { volume, warnings } = await measure(
        await breakOriginEdge(box(width, 20, 20), 'fillet', 2)
      );
      const exact = filletCut(2, 20);
      expect(width * 400 - volume).toBeCloseTo(removed, 6);
      expect(((width * 400 - volume) / exact - 1) * 100).toBeCloseTo(
        overPercent,
        3
      );
      expect(warnings).toEqual([]);
    },
    120_000
  );

  describe('the controls, which are the argument', () => {
    it('measures a plain box and a plain cylinder exactly', async () => {
      adapter ??= await createExactKernelAdapter();
      const b = await measure(box(20, 20, 20));
      expect(b.volume).toBe(8000);

      let doc = createProjectDocument('Cyl', toUserId('user_fil'));
      doc = addPrimitiveFeature(doc, {
        name: 'Cyl',
        primitiveKind: 'cylinder',
        dimensions: { radius: 10, height: 20 }
      });
      const c = await measure(doc);
      expect(c.volume).toBe(Math.PI * 100 * 20);
    }, 120_000);

    it('measures a CHAMFERED box exactly — same edge, same size', async () => {
      // Chamfer instead of fillet on the identical edge. Every face is planar,
      // so there is nothing to tessellate and the answer is exact. This is
      // what says the defect is about the fillet's curved face and not about
      // breaking an edge at all.
      adapter ??= await createExactKernelAdapter();
      const { volume, faces, surfaces } = await measure(
        await breakOriginEdge(box(20, 20, 20), 'chamfer', 2)
      );
      // A 45 deg chamfer of size 2 removes a right triangle of legs 2 and 2.
      expect(volume).toBe(8000 - ((2 * 2) / 2) * 20);
      expect(faces).toBe(7);
      expect(surfaces).toEqual(new Set(['plane']));
    }, 120_000);

    it('measures a box with a THROUGH BORE exactly — 7 faces, cylinder + plane', async () => {
      // The tightest control in the file. Same face count as the filleted box,
      // same surface types, also a boolean result, also carrying an analytic
      // quadric — and exact to the last bit. Whatever the filleted body is
      // missing, it is not "an exact path for cylinders and planes"; one
      // exists and this body reaches it.
      adapter ??= await createExactKernelAdapter();
      let doc = box(20, 20, 20);
      const outer = doc.bodyOrder.at(-1)!;
      doc = addPrimitiveFeature(doc, {
        name: 'Bore',
        primitiveKind: 'cylinder',
        dimensions: { radius: 4, height: 40 }
      });
      const bore = doc.bodyOrder.at(-1)!;
      // Cylinders span z in [0, h] about their axis; boxes are corner-at-
      // origin. Centre the bore in x/y and overshoot in z so it goes clean
      // through rather than leaving a blind floor.
      doc = transformBody(doc, {
        name: 'Centre and overshoot',
        targetBodyId: bore,
        translation: { x: 10, y: 10, z: -10 }
      }).document;
      doc = booleanBodies(doc, {
        name: 'Drill',
        operation: 'subtract',
        targetBodyIds: [outer, bore]
      }).document;
      const { volume, faces, surfaces, warnings } = await measure(doc);
      expect(volume).toBe(8000 - Math.PI * 16 * 20);
      expect(faces).toBe(7);
      expect(surfaces).toEqual(new Set(['cylinder', 'plane']));
      expect(warnings).toEqual([]);
    }, 120_000);

    it('measures two fused boxes exactly', async () => {
      adapter ??= await createExactKernelAdapter();
      let doc = box(20, 20, 20);
      const a = doc.bodyOrder.at(-1)!;
      doc = addPrimitiveFeature(doc, {
        name: 'Cap',
        primitiveKind: 'box',
        dimensions: { width: 10, height: 10, depth: 10 }
      });
      const b = doc.bodyOrder.at(-1)!;
      doc = transformBody(doc, {
        name: 'Stack',
        targetBodyId: b,
        translation: { x: 0, y: 0, z: 20 }
      }).document;
      doc = booleanBodies(doc, {
        name: 'Fuse',
        operation: 'union',
        targetBodyIds: [a, b]
      }).document;
      const { volume } = await measure(doc);
      expect(volume).toBe(9000);
    }, 120_000);
  });
});
