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
 * What `exportStl` writes to a file, measured from the file itself.
 *
 * This is the end of the line for every mesh defect in this suite. The other
 * pins read `body.mesh` — what the viewport draws. This one parses the ASCII
 * STL the user actually downloads and hands to a slicer, which is a DIFFERENT
 * artifact: it goes through `kernel.exportStlAscii` at
 * `STL_EXPORT_DEFLECTION`, coarser than the viewport, so the facet counts and
 * the errors are its own.
 *
 * `exportStl` performs NO mesh validation. It tessellates and writes.
 *
 * A mesh check DOES exist elsewhere in the adapter — `syncDocument` runs
 * `inspectTriangleMeshClosure` and warns "Union produced an open,
 * non-manifold, or inconsistently oriented result." But it is gated on
 * `requiresStrictUnionValidation`, i.e. `featureKind === 'boolean' &&
 * operation === 'union'`, so it runs for union results and nothing else. Every
 * body below is a SUBTRACT, which that gate excludes, and the export path
 * consults nothing at all regardless. So everything here leaves as a
 * well-formed file with no warning.
 *
 * That the machinery already exists and is already proven is the useful part:
 * the gap is reach, not absence.
 *
 * THE HEADLINE, and it is worth stating in user terms rather than in
 * millimetres. Drill a shaft with an equal-radius cross bore and export it:
 *
 *   the UI prints             848.040   (WRONG — Steinmetz says 704.230)
 *   the STL file encloses     652.318   (-23.1% against what the UI printed)
 *   the STL is watertight     0 open edges
 *
 * The file is valid. A slicer will accept it without complaint and print a
 * part that matches neither the design nor the number the UI showed. Nothing
 * anywhere says so — not a warning, not a validation error, not the file
 * itself. Watertight is exactly what makes it dangerous: the one check a
 * slicer does perform, it passes.
 *
 * WHAT CHANGED ON THE 061c1b2 KERNEL, because the shape of this defect
 * inverted and the old table is misleading if read as still current.
 *
 * The UI figure used to be RIGHT and the file wrong by +18%. Now the UI
 * figure is wrong: 848.040 is the undrilled stock, and it is the same number
 * at every bore radius — the measurement no longer sees the bore at all (see
 * cross-drilled-render.test.ts, which pins that directly). The file
 * meanwhile under-encloses rather than over-encloses. The two errors used to
 * point the same way and now point apart.
 *
 * Leakage improved a great deal in the same move, so this is not a uniform
 * regression: open edges at r=2 went 60 -> 2 and at r=1 went 120 -> 15.
 *
 *   bore r | UI prints | STL encloses |  error  | facets | STL open edges
 *   -------|-----------|--------------|---------|--------|----------------
 *      3   |  848.040  |   652.318    | -23.1%  |  3256  |   0
 *      2   |  848.040  |   657.540    | -22.5%  |   662  |   2
 *      1   |  848.040  |   328.084    | -61.3%  |   722  |  15
 *
 * (was, on 8733eab: 704.263/831.109/+18.0%/68/0, 750.652/804.284/+7.1%/210/60,
 * 802.579/818.248/+2.0%/266/120)
 *
 * And a body whose B-REP IS EXACT still exports a leaking file — a ball with
 * its cap cut off measures 3534.2917 against a closed form of 3534.2917, and
 * exports 116 open edges. Correct geometry is not sufficient for a correct
 * file.
 *
 * The control is what makes all of this a defect rather than a property of
 * the format: a plain box exports 12 facets enclosing exactly 8000 with zero
 * open edges. STL can represent these bodies correctly. This pipeline does
 * not.
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

  const UNDRILLED = Math.PI * 9 * 30;
  /** Steinmetz: two equal perpendicular cylinders share 16 r^3 / 3. */
  const TRUE_EQUAL = UNDRILLED - (16 * 27) / 3;

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

  it.fails(
    'exports the drilled shaft the UI says it drilled',
    async () => {
      const { printed, stl } = await drillAndExport(3);
      expect(Math.abs(printed - TRUE_EQUAL) / TRUE_EQUAL).toBeLessThan(1e-3);
      // The file should enclose what the app measured.
      expect(Math.abs(stl.volume - printed) / printed).toBeLessThan(0.02);
    },
    120_000
  );

  it('instead exports a watertight file that matches neither the design nor the printed figure', async () => {
    // The headline. This is the dangerous one precisely BECAUSE the file is
    // well formed: zero open edges means a slicer accepts it and prints it,
    // and the only thing wrong is that it is the wrong solid.
    const { printed, stl, warnings } = await drillAndExport(3);
    // 848.040 is the undrilled stock. The bore is absent from the measurement.
    expect(printed).toBeCloseTo(848.04, 2);
    expect(stl.volume).toBeCloseTo(652.318, 2);
    // The file now encloses 23% LESS than the app said, where it used to
    // enclose 18% more. The sign of this error is the thing that flipped.
    expect((stl.volume - printed) / printed).toBeLessThan(-0.22);
    // Nor is it the true drilled body: it under-cuts that too.
    expect(stl.volume).toBeLessThan(704.23);
    expect(stl.openEdges).toBe(0);
    expect(stl.facets).toBe(3256);
    expect(warnings).toEqual([]);
  }, 120_000);

  // Leakage is much better here — 60 -> 2 and 120 -> 15 open edges — while the
  // printed figure is the same undrilled stock at both radii.
  it.each([
    [2, 848.04, 657.54, 662, 2],
    [1, 848.04, 328.084, 722, 15]
  ])(
    'exports a leaking file at bore radius %s',
    async (boreRadius, printed, enclosed, facets, openEdges) => {
      const result = await drillAndExport(boreRadius);
      expect(result.printed).toBeCloseTo(printed, 2);
      expect(result.stl.volume).toBeCloseTo(enclosed, 2);
      expect(result.stl.facets).toBe(facets);
      // Not watertight, so a slicer must guess or repair.
      expect(result.stl.openEdges).toBe(openEdges);
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
