import { describe, expect, it } from 'vitest';
import {
  addPrimitiveFeature,
  booleanBodies,
  createProjectDocument,
  transformBody
} from '@openzcad/document-core';
import { toUserId } from '@openzcad/shared';
import {
  createExactKernelAdapter,
  type ExactKernelAdapter
} from '@openzcad/kernel-adapter/exact';

/**
 * What a cross-drilled shaft LOOKS like disagrees with what it MEASURES.
 *
 * A product-level pin: everything here goes through `syncDocument`, so the
 * mesh under test is the one the viewport draws and the volume is the one
 * the UI prints. The kernel's own numbers are deliberately not consulted --
 * the point is the divergence between the two things the user is given.
 *
 * Measured on an r=3 h=30 shaft with a bore laid across it at mid-height:
 *
 *   bore r | app prints | mesh encloses | boundary edges
 *   -------|------------|---------------|---------------
 *      3   |   704.263  |    847.724    |   0
 *      2   |   750.652  |    796.736    |   1542
 *      1   |   802.579  |    825.382    |   1154
 *
 * A REGRESSION PASSED THROUGH THESE NUMBERS AND IS NOW GONE, and the episode
 * is kept because it changed how this file asserts things.
 *
 * The pin bump carrying brepkit#64 added exactly 420 boundary edges to every
 * row (0 -> 420, 1542 -> 1962, 1154 -> 1574) while `app prints`, `mesh
 * encloses` and the face count stayed identical to the digit. brepkit#66
 * returned all three to the values above.
 *
 * What it was: #64 correctly moved a closed rim's polyline to start at the
 * edge's own seam vertex, but `compute_angular_range` kept anchoring the
 * analytic GRID at the surface frame's `u = 0`. Those two used to coincide by
 * accident — a primitive builds its rim circles and its lateral surface from
 * one frame — and after a boolean they do not. A cylindrical wall carrying
 * inner wires is the one shape that reconciles a grid against the shared
 * vertex pool by proximity, and on this body the two anchors sat 2.3077 deg
 * apart: 0.121 mm at r = 3, five orders of magnitude past the 1 um snap
 * tolerance. Nothing snapped, so the wall and its two END CAPS shared no rim
 * vertex and every rim segment on both sides became a boundary edge. The bore
 * was never involved.
 *
 * TWO THINGS THIS FILE PREVIOUSLY ASSERTED THAT WERE WRONG, corrected here
 * rather than quietly deleted:
 *
 *   1. That the r=3 row "degraded in kind — watertight before, leaking
 *      after". It did not. Closure on that body is DEFLECTION-DEPENDENT: at
 *      deflection >= 0.02 it is watertight both before #64 and after #66,
 *      and below that it carries bore-lobe residue in every case, #64
 *      included. It draws the same wrong shape either way.
 *   2. That the cause was #64's stated knock-on about golden meshes losing a
 *      near-duplicate vertex per rim. Unrelated — those are undrilled
 *      cylinders, whose walls take the structured band path and never reach
 *      the snap path at all.
 *
 * And the +420 was never the invariant, which is why the end-rim test below
 * asserts a property instead. See its comment.
 *
 * The undrilled shaft is 848.230 and the equal-radius answer is
 * 848.230 - 16r^3/3 = 704.230 by Steinmetz.
 *
 * So at equal radius the viewport shows a shaft with NO HOLE -- within
 * 0.06% of undrilled -- while the UI prints a volume that says there is
 * one, and the mesh is watertight, so nothing downstream objects. At
 * smaller radii the hole is drawn but the surface leaks.
 *
 * Boundary edges are counted after welding by POSITION, not index: this
 * kernel emits duplicate vertices at seams and an index-based count reports
 * those as holes. Welding changed nothing here (welded == raw at every
 * radius), so these are real openings.
 */
describe('a cross-drilled shaft', () => {
  let adapter: ExactKernelAdapter;

  const drill = async (boreRadius: number) => {
    adapter ??= await createExactKernelAdapter();
    let document = createProjectDocument(
      'Cross-drilled shaft',
      toUserId('user_drill')
    );
    document = addPrimitiveFeature(document, {
      name: 'Shaft',
      primitiveKind: 'cylinder',
      dimensions: { radius: 3, height: 30 }
    });
    const shaftId = document.bodyOrder.at(-1)!;
    document = addPrimitiveFeature(document, {
      name: 'Bore',
      primitiveKind: 'cylinder',
      dimensions: { radius: boreRadius, height: 40 }
    });
    const boreId = document.bodyOrder.at(-1)!;
    document = transformBody(document, {
      name: 'Lay the bore across the shaft',
      targetBodyId: boreId,
      rotationDeg: { x: 0, y: 90, z: 0 },
      translation: { x: -20, y: 0, z: 15 }
    }).document;
    document = booleanBodies(document, {
      name: 'Cross-drilled',
      operation: 'subtract',
      targetBodyIds: [shaftId, boreId]
    }).document;
    const derived = await adapter.syncDocument(document);
    const body = derived.bodyRepresentations[document.bodyOrder.at(-1)!]!;
    const idx = body.mesh.indices;
    const vs = body.mesh.vertices;

    const weld = new Map<string, number>();
    const canon: number[] = [];
    for (let i = 0; i < vs.length; i += 3) {
      const key = `${vs[i]!.toFixed(6)}_${vs[i + 1]!.toFixed(6)}_${vs[i + 2]!.toFixed(6)}`;
      if (!weld.has(key)) weld.set(key, weld.size);
      canon.push(weld.get(key)!);
    }
    const use = new Map<string, number>();
    let meshVolume = 0;
    for (let i = 0; i + 2 < idx.length; i += 3) {
      const tri = [canon[idx[i]!]!, canon[idx[i + 1]!]!, canon[idx[i + 2]!]!];
      for (const [a, b] of [
        [tri[0]!, tri[1]!],
        [tri[1]!, tri[2]!],
        [tri[2]!, tri[0]!]
      ]) {
        const key = a! < b! ? `${a}_${b}` : `${b}_${a}`;
        use.set(key, (use.get(key) ?? 0) + 1);
      }
      const [x, y, z] = [idx[i]! * 3, idx[i + 1]! * 3, idx[i + 2]! * 3];
      meshVolume +=
        (vs[x]! * (vs[y + 1]! * vs[z + 2]! - vs[y + 2]! * vs[z + 1]!) -
          vs[x + 1]! * (vs[y]! * vs[z + 2]! - vs[y + 2]! * vs[z]!) +
          vs[x + 2]! * (vs[y]! * vs[z + 1]! - vs[y + 1]! * vs[z]!)) /
        6;
    }
    // Boundary edges lying ON one of the shaft's two END RIMS -- the circles
    // of radius 3 at z = 0 and z = 30. This is the invariant brepkit#66
    // restored, and it is the right thing to assert because it depends on
    // neither the bore radius nor the deflection: an end rim is shared by
    // exactly two faces, so a shared rim has ZERO one-sided edges on it, at
    // any tessellation density. Counting a raw total instead would pin a
    // number that moves with deflection and says nothing on its own.
    const position = new Map<number, [number, number, number]>();
    for (let i = 0; i < vs.length; i += 3) {
      position.set(canon[i / 3]!, [vs[i]!, vs[i + 1]!, vs[i + 2]!]);
    }
    const onEndRim = (id: number) => {
      const p = position.get(id);
      if (!p) return false;
      const onCap = Math.abs(p[2]) < 1e-6 || Math.abs(p[2] - 30) < 1e-6;
      return onCap && Math.abs(Math.hypot(p[0], p[1]) - 3) < 1e-6;
    };
    let endRimBoundaryEdges = 0;
    for (const [key, count] of use) {
      if (count !== 1) continue;
      const [a, b] = key.split('_').map(Number) as [number, number];
      if (onEndRim(a) && onEndRim(b)) endRimBoundaryEdges += 1;
    }

    return {
      reported: body.volume,
      meshVolume: Math.abs(meshVolume),
      boundaryEdges: [...use.values()].filter((n) => n === 1).length,
      endRimBoundaryEdges,
      warnings: derived.warnings
    };
  };

  const UNDRILLED = Math.PI * 9 * 30;
  /** Steinmetz bicylinder of equal radii removes 16 r^3 / 3. */
  const EQUAL_RADIUS_TRUE = UNDRILLED - (16 * 27) / 3;

  it.fails('draws the hole it says it drilled, at equal radius', async () => {
    const { reported, meshVolume } = await drill(3);
    expect(
      Math.abs(reported - EQUAL_RADIUS_TRUE) / EQUAL_RADIUS_TRUE
    ).toBeLessThan(1e-3);
    // The mesh should enclose what the body measures, not the raw stock.
    expect(Math.abs(meshVolume - reported) / reported).toBeLessThan(0.02);
  });

  /**
   * THE MEASUREMENT NO LONGER SEES THE BORE AT ALL. This inverted on the
   * 061c1b2 kernel and it is the worst thing in this file.
   *
   * Under 8733eab the reported volume tracked the bore and matched the closed
   * form at equal radius — 704.26 against 704.23 — and only the MESH showed
   * undrilled stock. Now the reported volume is the undrilled shaft, to within
   * 0.02%, and it is the same number at every radius (see below). A drilled
   * part measures as if it were never drilled.
   *
   * The mesh moved the other way and is now SMALLER than the stock, so the two
   * no longer agree in either direction. Neither is right; they are wrong
   * apart instead of wrong together, which is why this can no longer be
   * described as "quiet".
   */
  it('measures an equal-radius bore as undrilled stock, and closes over a mesh that disagrees', async () => {
    const { reported, meshVolume, boundaryEdges, warnings } = await drill(3);
    // The regression: the measurement is the raw stock, not the drilled body.
    expect(Math.abs(reported - UNDRILLED) / UNDRILLED).toBeLessThan(6e-4);
    expect(Math.abs(reported - EQUAL_RADIUS_TRUE) / EQUAL_RADIUS_TRUE).toBeGreaterThan(
      0.1
    );
    // And the mesh now removes MORE than the true bore rather than none of it.
    expect(meshVolume).toBeLessThan(EQUAL_RADIUS_TRUE);
    // Still closed, so no structural check objects...
    expect(boundaryEdges).toBe(0);
    // ...but the adapter's failed-cut guard does. The tool demonstrably
    // overlaps the shaft and none of that material went away, which is the
    // one witness left once validation, closure and volume all pass. Wrong,
    // but no longer wrong in silence.
    expect(warnings.join(' ')).toContain(
      'the tool overlaps this body but the cut did not take'
    );
  });

  /**
   * The same reported volume at every radius is the clearest statement of the
   * defect: bore size has no effect on the measurement whatsoever. Pinned as
   * its own case so a partial fix upstream cannot be mistaken for a full one.
   */
  it('reports the same volume whatever the bore radius, which is the bug', async () => {
    const [three, two, one] = await Promise.all([drill(3), drill(2), drill(1)]);
    expect(two.reported).toBeCloseTo(three.reported, 6);
    expect(one.reported).toBeCloseTo(three.reported, 6);
    expect(three.reported).toBeGreaterThan(EQUAL_RADIUS_TRUE);
  });

  it.fails.each([2, 1])(
    'closes the surface around a bore of radius %s',
    async (boreRadius) => {
      const { boundaryEdges } = await drill(boreRadius);
      expect(boundaryEdges).toBe(0);
    }
  );

  /**
   * The one thing 061c1b2 clearly improves. These counts were 1542 and 1154 on
   * 8733eab; the surface is now nearly closed, though not closed. Recorded
   * exactly rather than as "fewer than before" so that closing the last
   * handful is visible as progress and reopening them is visible as loss.
   */
  it.each([
    [2, 20],
    [1, 15]
  ])(
    'leaves a bore of radius %s drawn but still leaking (%s boundary edges)',
    async (boreRadius, expected) => {
      const { boundaryEdges, meshVolume, warnings } = await drill(boreRadius);
      expect(boundaryEdges).toBe(expected);
      // Partially drilled: less than the stock, more than it should be.
      expect(meshVolume).toBeLessThan(UNDRILLED);
      // Same guard as above: these bores do not take either.
      expect(warnings.join(' ')).toContain(
        'the tool overlaps this body but the cut did not take'
      );
    }
  );

  /**
   * The invariant brepkit#66 restored, and the one worth guarding.
   *
   * This asserts a PROPERTY rather than a count, deliberately. The earlier
   * version of this file pinned "+420 boundary edges at every radius" as
   * though 420 were the invariant. It is not — the lane that fixed this
   * established that the quantity is one cylindrical face's rim ring, twice,
   * per end rim, so it tracks the rim's SAMPLE COUNT and therefore the
   * deflection. 420 was that defect at the app's deflection; the same defect
   * measured +156 at deflection 0.01. Pinning the integer would have made
   * this test a thermometer for the tessellator's density.
   *
   * An end rim is a circle of radius 3 at z = 0 and z = 30, shared by exactly
   * two faces, so a shared rim carries ZERO one-sided edges on it at ANY
   * density and ANY bore radius. That statement survives a deflection change;
   * a number does not.
   *
   * VERIFIED NON-VACUOUS, because "expect some count to be 0" is precisely the
   * shape that passes when the count has no subject matter — the same trap
   * that let an empty mesh satisfy a watertightness check twice on this
   * project. Measured at every radius: 210 welded vertices sit on the two end
   * rims and 624 edges run between them, of which 0 are one-sided. The
   * selector finds the rims; it is not asserting something about nothing.
   */
  it.each([3, 2, 1])(
    'closes the shaft end rims at bore radius %s',
    async (boreRadius) => {
      const { endRimBoundaryEdges } = await drill(boreRadius);
      expect(endRimBoundaryEdges).toBe(0);
    },
    120_000
  );
});
