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
 * Product-level overlapping-pattern volume and topology. The true linear
 * union is a hand closed form, not a kernel reading. Two parallel
 * cylinders of radius r whose axes are d apart share a prism over the
 * circular lens
 *
 *   lens(d) = 2 r^2 acos(d / 2r) - (d/2) sqrt(4 r^2 - d^2),  d < 2r
 *
 * so three in a row remove two adjacent lenses, plus the first-to-third lens
 * once 2d < 2r.
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
      axis: 'x',
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

  it.each([9, 6])(
    'reports the material once at spacing %s',
    async (spacing) => {
      const { volume } = await patterned(spacing);
      const expected = trueUnion(spacing);
      expect(Math.abs(volume - expected) / expected).toBeLessThan(1e-3);
    },
    120_000
  );

  it.fails.each([3, 0.5])(
    'reports the material once at spacing %s',
    async (spacing) => {
      const { volume } = await patterned(spacing);
      const expected = trueUnion(spacing);
      expect(Math.abs(volume - expected) / expected).toBeLessThan(1e-3);
    },
    120_000
  );

  it.each([9, 6, 3, 0.5])(
    'merges overlapping cylinders at spacing %s without a warning',
    async (spacing) => {
      const result = await patterned(spacing);
      expect(result.faces).toBe(6);
      expect(result.warnings).toEqual([]);
    },
    120_000
  );

  /**
   * Not a linear-pattern quirk. A CIRCULAR pattern does the same thing, which
   * matters to whoever fixes this: the gap is in `pattern` itself, not in the
   * linear arm.
   *
   * Six r5 cylinders seated 6 from the axis put adjacent centres
   * 2 * 6 * sin(30deg) = 6 apart, so every neighbour overlaps. Twelve puts
   * them 2 * 6 * sin(15deg) = 3.106 apart, which is heavy overlap.
   *
   *   count   sum       union      result faces
   *   6       4712.389  3370.503   14
   *   12      9424.778  3666.177   26
   *
   * The closed form for the true union of a ring is not written out, so these
   * pin the measured result, broad physical bounds, topology, and silence
   * without pretending to an independent accuracy reference.
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
      axis: 'z',
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

  it.each([
    [6, 3370.503, 14],
    [12, 3666.177, 26]
  ])(
    'folds a circular pattern of %s overlapping instances too',
    async (count, measured, faces) => {
      const result = await circular(count);
      expect(result.volume).toBeCloseTo(measured, 2);
      // Well under the sum, so the ring genuinely merged...
      expect(result.volume).toBeLessThan(count * ONE * 0.8);
      // ...and above one instance, so nothing was dropped on the way. Both
      // bounds matter: an operation that returned a single blade would also
      // be "less than the sum".
      expect(result.volume).toBeGreaterThan(ONE);
      // No longer three faces per instance.
      expect(result.faces).toBe(faces);
      expect(result.faces).not.toBe(3 * count);
    },
    120_000
  );

  it.each([6, 12])(
    'leaves the merged %s-instance ring unwarned',
    async (count) => {
      const { warnings } = await circular(count);
      expect(warnings).toEqual([]);
    },
    120_000
  );
});
