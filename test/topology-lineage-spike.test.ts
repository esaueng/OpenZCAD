/**
 * BrepKit's topology-history surface, characterized against the pinned kernel.
 *
 * `verifyCompleteBrepEvolution` is the load-bearing assertion here and it is
 * deliberately a SET equality, not a count: the failure it exists to catch is
 * a result face claimed by neither `modified` nor `generated`, and every
 * count-based and topological check passes while that hole is open. Do not
 * relax it to counts.
 *
 * Z5 removed the OCCT half of this file with the rest of the second kernel.
 * What it pinned — that the OCCT bridge exposes typed `*WithHistory` entry
 * points, and that its fillet leaves one result face unclaimed — described a
 * kernel the app no longer builds on.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
// Note this reaches the kernel by relative path rather than by the
// `brepkit-wasm` specifier, so `vitest.config.ts`'s `BREPKIT_WASM_PKG`
// override does NOT apply here — running this file against a candidate pin
// needs the pin actually installed. Worth knowing before trusting a green
// run as evidence about a pin you thought you had swapped in.
import { BrepKernel } from '../packages/kernel-adapter/node_modules/brepkit-wasm/brepkit_wasm.js';

interface BrepEvolution {
  solid: number;
  evolution: {
    modified: Record<string, number[]>;
    generated: Record<string, number[]>;
    deleted: number[];
    /**
     * Result faces the kernel declined to attribute, mapped to the source
     * faces it could not choose between. Optional because it postdates the
     * three fields above.
     *
     * Decoding it is not optional, and that is the point. This file once
     * reported a blend band as attributed by nothing, when the kernel had in
     * fact recorded `unresolved: {band: [both parents]}` — an explicit
     * refusal naming both candidates. Reading only the original three fields
     * turned "refused, with the fact available" into "silently absent", which
     * is a different defect with a different fix. A completeness check must
     * read every field the record has, or it reports the right failure for
     * the wrong reason.
     */
    unresolved?: Record<string, number[]>;
  };
}

function integerArray(value: unknown, label: string): number[] {
  if (
    !Array.isArray(value) ||
    value.some((candidate) => !Number.isInteger(candidate) || candidate < 0)
  ) {
    throw new Error(`${label} must be an array of non-negative integers.`);
  }
  return value as number[];
}

function handleMap(value: unknown, label: string): Record<string, number[]> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  const result: Record<string, number[]> = {};
  for (const [key, handles] of Object.entries(value)) {
    if (!/^\d+$/.test(key)) {
      throw new Error(`${label} contains a non-handle key.`);
    }
    result[key] = integerArray(handles, `${label}.${key}`);
  }
  return result;
}

/** Strictly decode the runtime contract that the generated BrepKit types omit. */
function parseBrepEvolution(value: unknown): BrepEvolution {
  if (typeof value !== 'string') {
    throw new Error('BrepKit evolution must be returned as JSON text.');
  }
  const parsed: unknown = JSON.parse(value);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('BrepKit evolution must be an object.');
  }
  const root = parsed as Record<string, unknown>;
  if (!Number.isInteger(root.solid) || (root.solid as number) < 0) {
    throw new Error('BrepKit evolution has no result solid handle.');
  }
  if (!root.evolution || typeof root.evolution !== 'object') {
    throw new Error('BrepKit evolution has no evolution record.');
  }
  const evolution = root.evolution as Record<string, unknown>;
  return {
    solid: root.solid as number,
    evolution: {
      modified: handleMap(evolution.modified, 'modified'),
      generated: handleMap(evolution.generated, 'generated'),
      // This is deliberately required. Missing `deleted` is a contract error,
      // not evidence that every source face survived.
      deleted: integerArray(evolution.deleted, 'deleted'),
      // Optional because it postdates the three above, but decoded whenever
      // present — see the field's doc comment for why reading it matters.
      unresolved:
        evolution.unresolved === undefined
          ? undefined
          : handleMap(evolution.unresolved, 'unresolved')
    }
  };
}

function setOf(values: Iterable<number>): Set<number> {
  return new Set(values);
}

function expectSameSet(actual: Iterable<number>, expected: Iterable<number>) {
  expect([...setOf(actual)].sort((a, b) => a - b)).toEqual(
    [...setOf(expected)].sort((a, b) => a - b)
  );
}

function verifyCompleteBrepEvolution(
  kernel: BrepKernel,
  sourceSolids: number[],
  payload: BrepEvolution
) {
  const sourceFaces = setOf(
    sourceSolids.flatMap((solid) => Array.from(kernel.getSolidFaces(solid)))
  );
  const resultFaces = setOf(kernel.getSolidFaces(payload.solid));
  const modifiedSources = Object.keys(payload.evolution.modified).map(Number);
  const modifiedResults = Object.values(payload.evolution.modified).flat();
  const generatedResults = Object.values(payload.evolution.generated).flat();

  // Checked before the set equality below, so a refusal reports itself as a
  // refusal. Without this, an unresolved face reaches the equality as a
  // result nothing claims, and the failure reads as "attributed by nothing"
  // when the kernel in fact recorded which sources it could not choose
  // between. Those are different defects with different fixes.
  const unresolved = payload.evolution.unresolved ?? {};
  expect(
    Object.keys(unresolved).every((handle) => resultFaces.has(Number(handle)))
  ).toBe(true);
  expect(
    Object.values(unresolved)
      .flat()
      .every((handle) => sourceFaces.has(handle))
  ).toBe(true);
  expect(unresolved).toEqual({});

  expect(modifiedSources.every((handle) => sourceFaces.has(handle))).toBe(true);
  expect(
    payload.evolution.deleted.every((handle) => sourceFaces.has(handle))
  ).toBe(true);
  expect(
    modifiedSources.every(
      (handle) => !payload.evolution.deleted.includes(handle)
    )
  ).toBe(true);
  expectSameSet(
    [...modifiedSources, ...payload.evolution.deleted],
    sourceFaces
  );
  expect(
    [...modifiedResults, ...generatedResults].every((handle) =>
      resultFaces.has(handle)
    )
  ).toBe(true);
  expectSameSet([...modifiedResults, ...generatedResults], resultFaces);
}

describe('topology-lineage kernel spike', () => {
  it('pins the declared history surface and its type gaps', () => {
    const brepDeclarations = readFileSync(
      resolve(
        'packages/kernel-adapter/node_modules/brepkit-wasm/brepkit_wasm.d.ts'
      ),
      'utf8'
    );
    const declaredEvolution =
      /export interface EvolutionResult\s*{([^}]*)}/.exec(
        brepDeclarations
      )?.[1] ?? '';

    expect(declaredEvolution).toContain('modified: number[]');
    expect(declaredEvolution).not.toContain('deleted');
    for (const method of [
      'fuseWithEvolution',
      'cutWithEvolution',
      'intersectWithEvolution',
      'filletWithEvolution'
    ]) {
      expect(brepDeclarations).toMatch(
        new RegExp(`${method}\\([^;]+\\): any;`)
      );
    }
    expect(
      (BrepKernel.prototype as unknown as Record<string, unknown>)[
        'chamferWithEvolution'
      ]
    ).toBeUndefined();
  });

  it('characterizes primitive, sweep, transform, boolean, fillet, and chamfer behavior in BrepKit', () => {
    const kernel = new BrepKernel();
    try {
      const primitive = kernel.makeBox(10, 10, 10);
      expect(Array.from(kernel.getSolidFaces(primitive))).toHaveLength(6);
      expect(kernel.volume(primitive, 0.08)).toBeCloseTo(1_000, 6);

      const profile = kernel.makeRectangle(4, 5);
      const sweep = kernel.extrude(profile, 0, 0, 1, 6);
      expect(Array.from(kernel.getSolidFaces(sweep))).toHaveLength(6);
      expect(kernel.volume(sweep, 0.08)).toBeCloseTo(120, 6);

      const primitiveBounds = kernel.boundingBox(primitive);
      const transformed = kernel.copyAndTransformSolid(
        primitive,
        new Float64Array([1, 0, 0, 6, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1])
      );
      const transformedBounds = kernel.boundingBox(transformed);
      expect(transformedBounds[0]! - primitiveBounds[0]!).toBeCloseTo(6, 8);

      const booleanEvolution = [
        parseBrepEvolution(kernel.fuseWithEvolution(primitive, transformed)),
        parseBrepEvolution(kernel.cutWithEvolution(primitive, transformed)),
        parseBrepEvolution(
          kernel.intersectWithEvolution(primitive, transformed)
        )
      ];
      for (const payload of booleanEvolution) {
        verifyCompleteBrepEvolution(kernel, [primitive, transformed], payload);
        expect(kernel.validateSolidRelaxed(payload.solid)).toBe(0);
        expect(payload.evolution.deleted.length).toBeGreaterThan(0);
      }

      // OpenZCAD currently uses `fuseAll`, whose same-domain unification is
      // part of the production topology. The evolution variant returns the
      // raw 14-face fragment layout instead of that 6-face result, so merely
      // swapping calls would be a production-geometry behavior change.
      const productionUnion = kernel.fuseAll(
        Uint32Array.from([primitive, transformed])
      );
      expect(kernel.getSolidFaces(booleanEvolution[0]!.solid)).toHaveLength(14);
      expect(kernel.getSolidFaces(productionUnion)).toHaveLength(6);

      const selectedEdge = Array.from(kernel.getSolidEdges(primitive))[0]!;
      const fillet = parseBrepEvolution(
        kernel.filletWithEvolution(
          primitive,
          Uint32Array.from([selectedEdge]),
          1
        )
      );
      verifyCompleteBrepEvolution(kernel, [primitive], fillet);
      expect(kernel.validateSolidRelaxed(fillet.solid)).toBe(0);
      // The blend band used to arrive as one GENERATED face with no source.
      // Under GFA face provenance it is reported as a MODIFIED result of both
      // faces the rounded edge separated, and nothing is generated at all.
      // Recording the count alone would say nothing about whether the new
      // attribution is right, so the claim asserted is the attribution: the
      // band's face is listed under exactly the two source faces that shared
      // the selected edge, and under no others.
      const bandFaces = Array.from(kernel.getSolidFaces(fillet.solid)).filter(
        (face) => kernel.getSurfaceType(face) === 'cylinder'
      );
      expect(bandFaces).toHaveLength(1);
      const band = bandFaces[0]!;
      const facesOnSelectedEdge = Array.from(
        kernel.getSolidFaces(primitive)
      ).filter((face) =>
        Array.from(kernel.getFaceEdges(face)).includes(selectedEdge)
      );
      expect(facesOnSelectedEdge).toHaveLength(2);
      const bandSources = Object.entries(fillet.evolution.modified)
        .filter(([, results]) => results.includes(band))
        .map(([source]) => Number(source));
      expectSameSet(bandSources, facesOnSelectedEdge);
      expect(Object.values(fillet.evolution.generated).flat()).toHaveLength(0);
      // No source face disappears when a single edge is rounded.
      expect(fillet.evolution.deleted).toEqual([]);

      const chamfer = kernel.chamfer(
        primitive,
        Uint32Array.from([selectedEdge]),
        1
      );
      expect(kernel.validateSolidRelaxed(chamfer)).toBe(0);
      expect(Array.from(kernel.getSolidFaces(chamfer)).length).toBeGreaterThan(
        6
      );
    } finally {
      kernel.free();
    }
  });
});
