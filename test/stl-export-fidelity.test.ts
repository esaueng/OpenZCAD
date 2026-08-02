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
 * `exportStl` performs NO mesh validation. It tessellates and writes. The
 * app's only body check is `validateSolid`, which inspects the B-rep and
 * never looks at triangles — see the plan's "The app has no mesh-level check"
 * section. So everything below leaves as a well-formed file with no warning.
 *
 * THE HEADLINE, and it is worth stating in user terms rather than in
 * millimetres. Drill a shaft with an equal-radius cross bore and export it:
 *
 *   the UI prints             704.263   (correct — Steinmetz says 704.230)
 *   the STL file encloses     831.109   (+18.0% of material that is not there)
 *   the STL is watertight     0 open edges
 *
 * The file is valid. A slicer will accept it without complaint and print a
 * shaft that is 18% heavier than the part the user designed, with the hole
 * missing. Nothing anywhere says so — not a warning, not a validation error,
 * not the file itself. Watertight is exactly what makes it dangerous: the one
 * check a slicer does perform, it passes.
 *
 * At smaller bore radii the hole IS drawn and the file leaks instead, which a
 * slicer may or may not repair silently:
 *
 *   bore r | UI prints | STL encloses |  error  | facets | STL open edges
 *   -------|-----------|--------------|---------|--------|----------------
 *      3   |  704.263  |   831.109    | +18.0%  |    68  |   0
 *      2   |  750.652  |   804.284    |  +7.1%  |   210  |  60
 *      1   |  802.579  |   818.248    |  +2.0%  |   266  | 120
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

  it('instead exports a watertight file of a shaft with no hole', async () => {
    // The headline. This is the dangerous one precisely BECAUSE the file is
    // well formed: zero open edges means a slicer accepts it and prints it,
    // and the only thing wrong is that it is the wrong solid.
    const { printed, stl, warnings } = await drillAndExport(3);
    expect(printed).toBeCloseTo(704.263, 2);
    expect(stl.volume).toBeCloseTo(831.109, 2);
    // 18% more material than the app said the part contains.
    expect((stl.volume - printed) / printed).toBeGreaterThan(0.17);
    // And most of the way back to the undrilled stock.
    expect(stl.volume / UNDRILLED).toBeGreaterThan(0.97);
    expect(stl.openEdges).toBe(0);
    expect(stl.facets).toBe(68);
    expect(warnings).toEqual([]);
  }, 120_000);

  it.each([
    [2, 750.652, 804.284, 210, 60],
    [1, 802.579, 818.248, 266, 120]
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

  it('exports a leaking file even when the B-rep is EXACT', async () => {
    // A ball with its cap cut off. The measurement is right to 1e-14 — this
    // is not a case of bad geometry producing a bad file. Correct geometry is
    // simply not sufficient.
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
    // The file is not.
    const stl = measureStl(await adapter.exportStl(document, [bodyId]));
    expect(stl.openEdges).toBe(116);
    expect(stl.facets).toBe(4232);
    expect(derived.warnings).toEqual([]);
  }, 120_000);
});
