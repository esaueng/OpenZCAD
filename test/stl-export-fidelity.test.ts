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
 * What `exportStl` writes, measured from the downloaded ASCII facets rather
 * than from the in-memory body. The controls pin physical unit conversion,
 * watertightness, and agreement with independent closed-form or integrated
 * volumes without treating a tessellator's incidental facet count as shape.
 */
describe('what STL export actually writes', () => {
  let adapter: ExactKernelAdapter;

  /** Parse ASCII STL facets, weld by position, and measure the solid. */
  const measureStl = (stl: string) => {
    const vertices: [number, number, number][] = [];
    const pattern = /vertex\s+(\S+)\s+(\S+)\s+(\S+)/g;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(stl)) !== null) {
      vertices.push([Number(match[1]), Number(match[2]), Number(match[3])]);
    }
    const ids = new Map<string, number>();
    const canon = vertices.map((v) => {
      const key = v.map((c) => Math.round(c * 1e6)).join(',');
      if (!ids.has(key)) ids.set(key, ids.size);
      return ids.get(key)!;
    });
    const use = new Map<string, number>();
    let volume = 0;
    for (let i = 0; i + 2 < canon.length; i += 3) {
      const tri = [canon[i]!, canon[i + 1]!, canon[i + 2]!];
      for (let k = 0; k < 3; k++) {
        const a = tri[k]!;
        const b = tri[(k + 1) % 3]!;
        const key = a < b ? `${a}_${b}` : `${b}_${a}`;
        use.set(key, (use.get(key) ?? 0) + 1);
      }
      const [p, q, r] = [vertices[i]!, vertices[i + 1]!, vertices[i + 2]!];
      volume +=
        (p[0] * (q[1] * r[2] - q[2] * r[1]) -
          p[1] * (q[0] * r[2] - q[2] * r[0]) +
          p[2] * (q[0] * r[1] - q[1] * r[0])) /
        6;
    }
    return {
      facets: Math.floor(vertices.length / 3),
      openEdges: [...use.values()].filter((n) => n === 1).length,
      volume: Math.abs(volume)
    };
  };

  /** r=3 h=30 shaft with a bore laid across it at mid-height. */
  const drillAndExport = async (boreRadius: number) => {
    adapter ??= await createExactKernelAdapter();
    let document = createProjectDocument('Shaft', toUserId('user_stl'));
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
    const bodyId = document.bodyOrder.at(-1)!;
    return {
      printed: derived.bodyRepresentations[bodyId]!.volume,
      warnings: derived.warnings,
      stl: measureStl(await adapter.exportStl(document, [bodyId]))
    };
  };

  const TRUE_VOLUMES = {
    3: 704.2300164692424,
    2: 777.293907481907,
    1: 829.6460290446158
  } as const;

  it('exports a box exactly, so STL itself is not the problem', async () => {
    // The control, and the reason everything below counts as a defect rather
    // than a limitation of the format.
    adapter ??= await createExactKernelAdapter();
    let document = createProjectDocument('Box', toUserId('user_stl'));
    document = addPrimitiveFeature(document, {
      name: 'Box',
      primitiveKind: 'box',
      dimensions: { width: 20, height: 20, depth: 20 }
    });
    const stl = measureStl(
      await adapter.exportStl(document, [document.bodyOrder.at(-1)!])
    );
    expect(stl.volume).toBeCloseTo(8000, 6);
    expect(stl.facets).toBe(12);
    expect(stl.openEdges).toBe(0);
  }, 120_000);

  /**
   * Units are SOUND, and this pins the one line that makes them so.
   *
   * The model is "units are a label on the numbers": geometry is built in raw
   * document units, `volume` is reported in cubic document units — a 10-cube
   * measures 1000 whatever the setting — and only EXPORT converts, because an
   * STL carries no unit field and millimetres are the de-facto convention.
   * Changing a document's units therefore REINTERPRETS the model rather than
   * converting it, at exactly 25.4x for mm -> inch. That is the standard
   * document-unit behaviour and is not a defect.
   *
   * It is pinned because `exportStl`'s conversion is a single multiplication
   * by `UNIT_TO_MM[document.units]`, and losing it is the most expensive kind
   * of silent failure this codebase can have: an inch document would export
   * 25.4x too small, the file would be perfectly well formed, every check
   * here and in the app would pass, and the first sign of trouble would be a
   * physical part. No number in the app would look wrong, because `volume`
   * is in document units and stays 1000 either way.
   */
  it.each([
    ['mm', 20],
    ['cm', 200],
    ['m', 20000],
    ['inch', 508]
  ] as const)(
    'exports a 20-unit cube as %s at the right physical size',
    async (units, expectedMm) => {
      adapter ??= await createExactKernelAdapter();
      let document = createProjectDocument('Cube', toUserId('user_stl'));
      document = { ...document, units };
      document = addPrimitiveFeature(document, {
        name: 'Box',
        primitiveKind: 'box',
        dimensions: { width: 20, height: 20, depth: 20 }
      });
      const bodyId = document.bodyOrder.at(-1)!;
      const derived = await adapter.syncDocument(document);
      // The measurement is unit-agnostic: 20^3 document units, always.
      expect(derived.bodyRepresentations[bodyId]!.volume).toBe(8000);
      // The file is not: it is millimetres, so it must carry the conversion.
      //
      // RELATIVE, not absolute. These volumes span 8e3 mm^3 to 8e12 mm^3, and
      // an absolute tolerance that is generous at one end is below the float64
      // noise floor at the other — 8e12 carries about 1.8e-3 of representation
      // error, so `toBeCloseTo(_, 3)` fails on the metre row for arithmetic
      // reasons that have nothing to do with the export. Asserting an absolute
      // bound on a quantity that ranges over nine orders of magnitude is the
      // same dimensional mistake this project keeps finding in the kernel.
      const stl = measureStl(await adapter.exportStl(document, [bodyId]));
      const exact = expectedMm ** 3;
      expect(Math.abs(stl.volume - exact) / exact).toBeLessThan(1e-12);
      expect(stl.openEdges).toBe(0);
    },
    120_000
  );

  it.each([3, 2, 1] as const)(
    'exports a closed cross-bore of radius %s at the measured volume',
    async (boreRadius) => {
      const result = await drillAndExport(boreRadius);
      const expected = TRUE_VOLUMES[boreRadius];
      expect(Math.abs(result.printed - expected) / expected).toBeLessThan(1e-3);
      expect(
        Math.abs(result.stl.volume - result.printed) / result.printed
      ).toBeLessThan(0.02);
      expect(result.stl.facets).toBeGreaterThan(0);
      expect(result.stl.openEdges).toBe(0);
      expect(result.warnings).toEqual([]);
    },
    120_000
  );

  it('exports a watertight file for an exact capped sphere', async () => {
    // A ball with its cap cut off exercises tessellation across a spherical
    // seam and the new planar cap.
    adapter ??= await createExactKernelAdapter();
    let document = createProjectDocument('Ball', toUserId('user_stl'));
    document = addPrimitiveFeature(document, {
      name: 'Ball',
      primitiveKind: 'sphere',
      dimensions: { radius: 10 }
    });
    const ballId = document.bodyOrder.at(-1)!;
    document = addPrimitiveFeature(document, {
      name: 'Tool',
      primitiveKind: 'box',
      dimensions: { width: 40, height: 40, depth: 40 }
    });
    const toolId = document.bodyOrder.at(-1)!;
    document = transformBody(document, {
      name: 'Slice the cap off',
      targetBodyId: toolId,
      translation: { x: -20, y: -20, z: 5 }
    }).document;
    document = booleanBodies(document, {
      name: 'Cut',
      operation: 'subtract',
      targetBodyIds: [ballId, toolId]
    }).document;
    const derived = await adapter.syncDocument(document);
    const bodyId = document.bodyOrder.at(-1)!;

    /** Sphere less the cap above z = 5: pi h^2 (3r - h) / 3, h = 5. */
    const CAPPED = (4 / 3) * Math.PI * 1000 - (Math.PI * 25 * (3 * 10 - 5)) / 3;
    // The body is right.
    expect(
      Math.abs(derived.bodyRepresentations[bodyId]!.volume - CAPPED) / CAPPED
    ).toBeLessThan(1e-12);
    // The exported mesh stays closed as well.
    const stl = measureStl(await adapter.exportStl(document, [bodyId]));
    expect(stl.openEdges).toBe(0);
    expect(stl.facets).toBe(3234);
    expect(derived.warnings).toEqual([]);
  }, 120_000);
});
