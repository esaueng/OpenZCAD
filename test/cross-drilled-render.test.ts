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
 * Product-level cross-drill fidelity: the UI measurement and viewport mesh
 * both come through `syncDocument`, while the reference volumes below are
 * independent perpendicular-cylinder intersection integrals. Boundary edges
 * are counted after welding by position so duplicate seam vertices cannot be
 * mistaken for holes.
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

  const TRUE_VOLUMES = {
    3: 704.2300164692424,
    2: 777.293907481907,
    1: 829.6460290446158
  } as const;

  it.each([3, 2, 1] as const)(
    'draws a closed bore of radius %s at the measured volume',
    async (boreRadius) => {
      const { reported, boundaryEdges, meshVolume, warnings } =
        await drill(boreRadius);
      const expected = TRUE_VOLUMES[boreRadius];
      expect(Math.abs(reported - expected) / expected).toBeLessThan(1e-3);
      expect(Math.abs(meshVolume - reported) / reported).toBeLessThan(0.02);
      expect(boundaryEdges).toBe(0);
      expect(meshVolume).toBeGreaterThan(0);
      expect(warnings).toEqual([]);
    },
    120_000
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
