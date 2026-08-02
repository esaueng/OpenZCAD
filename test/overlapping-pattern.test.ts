import { describe, expect, it } from 'vitest';
import {
  addPrimitiveFeature,
  createProjectDocument,
  patternBody,
  transformBody
} from '@openzcad/document-core';
import { toUserId } from '@openzcad/shared';
import {
  createExactKernelAdapter,
  type ExactKernelAdapter
} from '@openzcad/kernel-adapter/exact';

/**
 * A linear pattern whose instances OVERLAP reports the sum of the instances
 * rather than the volume of the material, and never fuses them.
 *
 * PRODUCT-level: everything goes through `syncDocument`, so the volume is the
 * one the UI prints and the mesh is the one the viewport draws. Overlapping
 * patterns are routine in CAD — rib arrays, perforation grids, any feature
 * deliberately stepped closer than its own width.
 *
 * Measured on three r5 h10 cylinders patterned along x. Every reading is
 * IDENTICAL at every spacing from 30 (fully separate) down to 0.5 (almost
 * coincident):
 *
 *   spacing   app prints   true union   mesh encloses  triangles  faces
 *   30        2356.194     2356.194     2354.959       1332       9
 *   12        2356.194     2356.194     2354.959       1332       9
 *   10        2356.194     2356.194     2354.959       1332       9
 *    9        2356.194     2297.469     2354.959       1332       9
 *    6        2356.194     1908.899     2354.959       1332       9
 *    3        2356.194     1152.625     2354.959       1332       9
 *    0.5      2356.194      199.791     2354.959       1332       9
 *
 * At spacing 0.5 the app is 11.8x over. Nine faces is three cylinders' worth
 * (side + two caps each), so the instances are never fused: the body is three
 * interpenetrating solids, which is not a valid solid at all.
 *
 * The true union is a hand closed form, not a kernel reading. Two parallel
 * cylinders of radius r whose axes are d apart share a prism over the
 * circular lens
 *
 *   lens(d) = 2 r^2 acos(d / 2r) - (d/2) sqrt(4 r^2 - d^2),  d < 2r
 *
 * so three in a row remove two adjacent lenses, plus the first-to-third lens
 * once 2d < 2r.
 *
 * Nothing objects. No warning is raised at any spacing, and exact B-Rep
 * validation passes — `measureShape` reports the body valid, so the
 * "failed exact B-rep validation" warning never fires on a body that
 * self-intersects.
 *
 * Whether `pattern` OUGHT to fuse is a product decision. Reporting a volume
 * that double-counts shared material is wrong under either answer, and so is
 * handing the viewport and STL export a self-intersecting shell in silence.
 */
describe('a linear pattern whose instances overlap', () => {
  let adapter: ExactKernelAdapter;

  const RADIUS = 5;
  const HEIGHT = 10;
  const ONE = Math.PI * RADIUS * RADIUS * HEIGHT;

  /** Prism over the circular lens two parallel cylinders share. */
  const lens = (d: number) =>
    d >= 2 * RADIUS
      ? 0
      : 2 * RADIUS * RADIUS * Math.acos(d / (2 * RADIUS)) -
        (d / 2) * Math.sqrt(4 * RADIUS * RADIUS - d * d);

  /** Three in a row: two adjacent overlaps, plus first-to-third if it reaches. */
  const trueUnion = (d: number) =>
    3 * ONE - 2 * lens(d) * HEIGHT - lens(2 * d) * HEIGHT;

  const patterned = async (spacing: number) => {
    adapter ??= await createExactKernelAdapter();
    let document = createProjectDocument('Pattern', toUserId('user_pattern'));
    document = addPrimitiveFeature(document, {
      name: 'Cylinder',
      primitiveKind: 'cylinder',
      dimensions: { radius: RADIUS, height: HEIGHT }
    });
    const id = document.bodyOrder.at(-1)!;
    document = patternBody(document, {
      name: 'Patterned',
      targetBodyId: id,
      patternKind: 'linear',
      count: 3,
      axis: { x: 1, y: 0, z: 0 },
      spacing
    }).document;
    const derived = await adapter.syncDocument(document);
    const body = derived.bodyRepresentations[document.bodyOrder.at(-1)!]!;
    return {
      volume: body.volume,
      faces: body.topology?.faces.length ?? 0,
      triangles: Math.floor(body.mesh.indices.length / 3),
      warnings: derived.warnings
    };
  };

  it('is correct while the instances stay apart', async () => {
    // The control. At spacing 30 there is no overlap, so summing IS the union
    // and the reading is right for the right reason.
    const { volume, warnings } = await patterned(30);
    expect(Math.abs(volume - trueUnion(30)) / trueUnion(30)).toBeLessThan(1e-9);
    expect(volume).toBeCloseTo(3 * ONE, 9);
    expect(warnings).toEqual([]);
  }, 120_000);

  it.fails.each([9, 6, 3, 0.5])(
    'reports the material once at spacing %s',
    async (spacing) => {
      const { volume } = await patterned(spacing);
      const expected = trueUnion(spacing);
      expect(Math.abs(volume - expected) / expected).toBeLessThan(1e-3);
    },
    120_000
  );

  it.each([
    [9, 1.025],
    [6, 1.234],
    [3, 2.044],
    [0.5, 11.79]
  ])(
    'instead sums three whole instances at spacing %s',
    async (spacing, overstatement) => {
      const { volume, faces, triangles, warnings } = await patterned(spacing);
      // The app prints three whole cylinders regardless of the overlap.
      expect(volume).toBeCloseTo(3 * ONE, 9);
      // Against the closed form above — the ratio is pinned rather than the
      // absolute, since `trueUnion` already states the closed form once and
      // restating it as a literal only risks transcribing it wrong.
      expect(volume / trueUnion(spacing)).toBeCloseTo(overstatement, 2);
      // Nine faces is three unfused cylinders, so the body interpenetrates.
      expect(faces).toBe(9);
      expect(triangles).toBe(1332);
      // Silently.
      expect(warnings).toEqual([]);
    },
    120_000
  );

  it('is most wrong where the instances nearly coincide', async () => {
    // Worst case in the sweep, kept as its own assertion because the ratio is
    // the part that makes this dangerous rather than merely imprecise.
    const { volume } = await patterned(0.5);
    expect(volume / trueUnion(0.5)).toBeGreaterThan(11.7);
  }, 120_000);

  /**
   * Not a linear-pattern quirk. A CIRCULAR pattern does the same thing, which
   * matters to whoever fixes this: the gap is in `pattern` itself, not in the
   * linear arm.
   *
   * Six r5 cylinders seated 6 from the axis put adjacent centres
   * 2 * 6 * sin(30deg) = 6 apart, so every neighbour overlaps. Twelve puts
   * them 2 * 6 * sin(15deg) = 3.106 apart, which is heavy overlap.
   *
   *   count   app prints   sum of instances   faces
   *   6       4712.389     4712.389           18
   *   12      9424.778     9424.778           36
   *
   * Faces are exactly three per instance in both, so nothing is fused here
   * either. The closed form for the true union of a ring of overlapping
   * cylinders is not written out, so these assert the sum and the face count
   * rather than the error -- enough to show the same gap without pretending
   * to a reference this file does not derive.
   */
  const circular = async (count: number) => {
    adapter ??= await createExactKernelAdapter();
    let document = createProjectDocument('Circular', toUserId('user_pattern'));
    document = addPrimitiveFeature(document, {
      name: 'Cylinder',
      primitiveKind: 'cylinder',
      dimensions: { radius: RADIUS, height: HEIGHT }
    });
    const id = document.bodyOrder.at(-1)!;
    document = transformBody(document, {
      name: 'Seat it off the axis',
      targetBodyId: id,
      translation: { x: 6, y: 0, z: 0 }
    }).document;
    document = patternBody(document, {
      name: 'Patterned',
      targetBodyId: id,
      patternKind: 'circular',
      count,
      axis: { x: 0, y: 0, z: 1 },
      angleDeg: 360
    }).document;
    const derived = await adapter.syncDocument(document);
    const body = derived.bodyRepresentations[document.bodyOrder.at(-1)!]!;
    return {
      volume: body.volume,
      faces: body.topology?.faces.length ?? 0,
      warnings: derived.warnings
    };
  };

  it.each([6, 12])(
    'sums a circular pattern of %s overlapping instances too',
    async (count) => {
      const { volume, faces, warnings } = await circular(count);
      expect(volume).toBeCloseTo(count * ONE, 6);
      // Three faces per instance: side plus two caps, none of them merged.
      expect(faces).toBe(3 * count);
      expect(warnings).toEqual([]);
    },
    120_000
  );
});
