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
    return {
      reported: body.volume,
      meshVolume: Math.abs(meshVolume),
      boundaryEdges: [...use.values()].filter((n) => n === 1).length,
      warnings: derived.warnings
    };
  };

  const UNDRILLED = Math.PI * 9 * 30;
  /** Steinmetz bicylinder of equal radii removes 16 r^3 / 3. */
  const EQUAL_RADIUS_TRUE = UNDRILLED - (16 * 27) / 3;

  it.fails('draws the hole it says it drilled, at equal radius', async () => {
    const { reported, meshVolume } = await drill(3);
    expect(Math.abs(reported - EQUAL_RADIUS_TRUE) / EQUAL_RADIUS_TRUE)
      .toBeLessThan(1e-3);
    // The mesh should enclose what the body measures, not the raw stock.
    expect(Math.abs(meshVolume - reported) / reported).toBeLessThan(0.02);
  });

  it('renders an equal-radius bore as undrilled stock, and closes over it', async () => {
    const { reported, meshVolume, boundaryEdges, warnings } = await drill(3);
    // The measurement knows about the bore.
    expect(reported).toBeCloseTo(EQUAL_RADIUS_TRUE, 1);
    // The mesh does not: it is the undrilled shaft to within 0.06%.
    expect(Math.abs(meshVolume - UNDRILLED) / UNDRILLED).toBeLessThan(6e-4);
    // And it is closed, so no watertightness check objects to the hole
    // being absent. That is what makes this quiet rather than loud.
    expect(boundaryEdges).toBe(0);
    expect(warnings).toEqual([]);
  });

  it.fails.each([2, 1])(
    'closes the surface around a bore of radius %s',
    async (boreRadius) => {
      const { boundaryEdges } = await drill(boreRadius);
      expect(boundaryEdges).toBe(0);
    }
  );

  it.each([
    [2, 1542],
    [1, 1154]
  ])(
    'leaves a bore of radius %s drawn but leaking (%s boundary edges)',
    async (boreRadius, expected) => {
      const { boundaryEdges, meshVolume, warnings } = await drill(boreRadius);
      expect(boundaryEdges).toBe(expected);
      // Partially drilled: less than the stock, more than it should be.
      expect(meshVolume).toBeLessThan(UNDRILLED);
      expect(warnings).toEqual([]);
    }
  );
});
