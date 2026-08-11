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
import {
  BrepKernel,
  type FaceEvolutionPayloadV1
} from '../packages/kernel-adapter/node_modules/brepkit-wasm/brepkit_wasm.js';

interface BrepEvolution {
  solid: number;
  evolution: {
    modified: Record<string, number[]>;
    generated: Record<string, number[]>;
    deleted: number[];
    /**
     * Result faces the kernel could not trace to an input face, each listed
     * with the inputs that tied. A caller holding a persistent face reference
     * has to fail closed on these rather than guess between the candidates.
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
    unresolved: Record<string, number[]>;
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
      // Required for the same reason: a missing `unresolved` channel is a
      // kernel that stopped reporting its own doubt, not a kernel that has
      // none. Reading it as an empty map would silently upgrade every tied
      // face into a confidently traced one.
      unresolved: handleMap(evolution.unresolved, 'unresolved')
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

  // Checked before the coverage comparisons below, which an unresolved face
  // would also fail — but as a set difference nobody can read. Every face of
  // every result here is traceable, so doubt is the finding, not a mismatch.
  //
  // The two well-formedness checks run before the emptiness one so that a
  // regression reports itself as a REFUSAL rather than as an absence: without
  // them an unresolved face reaches the coverage equality as a result nothing
  // claims, and the failure reads "attributed by nothing" when the kernel in
  // fact recorded which sources it could not choose between. Those are
  // different defects with different fixes. They are vacuous while the map is
  // empty, which is the whole point — they exist for the day it is not.
  const { unresolved } = payload.evolution;
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

function verifyCompleteFaceEvolution(
  kernel: BrepKernel,
  sourceSolid: number,
  payload: FaceEvolutionPayloadV1
) {
  const sourceFaces = setOf(kernel.getSolidFaces(sourceSolid));
  const resultFaces = setOf(kernel.getSolidFaces(payload.result.solid));
  const modifiedSources = payload.evolution.modified.map(
    (relation) => relation.source
  );
  const modifiedResults = payload.evolution.modified.flatMap(
    (relation) => relation.results
  );
  const generatedResults = payload.evolution.generated.flatMap(
    (relation) => relation.results
  );
  const unresolvedResults = payload.evolution.unresolvedResults.map(
    (relation) => relation.result
  );

  expect(payload.schemaVersion).toBe(1);
  expect(payload.source.solid).toBe(sourceSolid);
  expectSameSet(payload.source.faces, sourceFaces);
  expectSameSet(payload.result.faces, resultFaces);
  expect(payload.evolution.provenance).toBe('construction');

  expect(
    payload.evolution.unresolvedResults.every(
      ({ result, candidates }) =>
        resultFaces.has(result) &&
        candidates.every((candidate) => sourceFaces.has(candidate))
    )
  ).toBe(true);
  expect(
    payload.evolution.unresolvedSources.every((source) =>
      sourceFaces.has(source)
    )
  ).toBe(true);
  expect(payload.evolution.unresolvedResults).toEqual([]);
  expect(payload.evolution.unresolvedSources).toEqual([]);

  expect(
    [...modifiedSources, ...payload.evolution.deleted].every((source) =>
      sourceFaces.has(source)
    )
  ).toBe(true);
  expect(
    modifiedSources.every(
      (source) => !payload.evolution.deleted.includes(source)
    )
  ).toBe(true);
  expectSameSet(
    [
      ...modifiedSources,
      ...payload.evolution.deleted,
      ...payload.evolution.unresolvedSources
    ],
    sourceFaces
  );
  expect(
    [...modifiedResults, ...generatedResults, ...unresolvedResults].every(
      (result) => resultFaces.has(result)
    )
  ).toBe(true);
  expectSameSet(
    [...modifiedResults, ...generatedResults, ...unresolvedResults],
    resultFaces
  );
}

describe('topology-lineage kernel spike', () => {
  it('pins the declared history surface and its type gaps', () => {
    const brepDeclarations = readFileSync(
      resolve(
        'packages/kernel-adapter/node_modules/brepkit-wasm/brepkit_wasm.d.ts'
      ),
      'utf8'
    );
    expect(brepDeclarations).toMatch(
      /export interface FaceEvolutionPayloadV1\s*{[^}]*schemaVersion: number;[^}]*source: EvolutionShapeV1;[^}]*result: EvolutionShapeV1;[^}]*evolution: FaceEvolutionClaimsV1;/s
    );
    expect(brepDeclarations).toContain(
      'export function decodeEvolutionPayload(json: string): FaceEvolutionPayloadV1;'
    );
    for (const method of [
      'fuseWithEvolution',
      'cutWithEvolution',
      'intersectWithEvolution'
    ]) {
      expect(brepDeclarations).toMatch(
        new RegExp(`${method}\\([^;]+\\): any;`)
      );
    }
    for (const method of ['filletWithEvolution', 'chamferWithEvolution']) {
      expect(brepDeclarations).toMatch(
        new RegExp(`${method}\\([^;]+\\): FaceEvolutionPayloadV1;`)
      );
      expect(
        (BrepKernel.prototype as unknown as Record<string, unknown>)[method]
      ).toBeTypeOf('function');
    }
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
      const fillet = kernel.filletWithEvolution(
        primitive,
        Uint32Array.from([selectedEdge]),
        1
      );
      verifyCompleteFaceEvolution(kernel, primitive, fillet);
      expect(kernel.validateSolidRelaxed(fillet.result.solid)).toBe(0);
      // The blend band is a new face, and the kernel names where it came from:
      // it arrives under GENERATED, listed against both faces the rounded edge
      // separated, because it was built between them and both are its origin.
      // `generated` is an adjacency record rather than an identity, so naming
      // two sources for one new face is the ordinary case.
      //
      // A band is deliberately never listed under MODIFIED: it is no input
      // face cut back, and a selection stored against one of those faces must
      // not silently acquire it.
      //
      // This assertion has been through three shapes, and the middle one was
      // wrong:
      //
      // 1. Originally generated with NO source — a face from nowhere.
      // 2. Then MODIFIED from both parents. That looked like an improvement
      //    and this test pinned it, but it was an artefact of a near-tie rule
      //    and actively harmful, for exactly the reason above: a selection
      //    stored against one parent silently acquired the cylinder.
      // 3. Now generated from both parents, which is what the walking builder
      //    and the wasm binding's own documentation always said. The two
      //    engines behind one operation had simply been disagreeing.
      //
      // Recording the count alone would say nothing about which of the three
      // is right, so the claim asserted is the attribution — checked against
      // the solid's own adjacency, not against another reading of the same
      // evolution record. `unresolved` being empty is enforced by
      // verifyCompleteBrepEvolution above — a refusal here is a defect, and is
      // how the regression that held the pin was found.
      const bandFaces = Array.from(
        kernel.getSolidFaces(fillet.result.solid)
      ).filter((face) => kernel.getSurfaceType(face) === 'cylinder');
      expect(bandFaces).toHaveLength(1);
      const band = bandFaces[0]!;
      const facesOnSelectedEdge = Array.from(
        kernel.getSolidFaces(primitive)
      ).filter((face) =>
        Array.from(kernel.getFaceEdges(face)).includes(selectedEdge)
      );
      expect(facesOnSelectedEdge).toHaveLength(2);
      const bandSources = fillet.evolution.generated
        .filter(({ results }) => results.includes(band))
        .map(({ source }) => source);
      expectSameSet(bandSources, facesOnSelectedEdge);
      // The band is the only face the fillet adds, and it is not any input
      // face's continuation.
      expectSameSet(
        fillet.evolution.generated.flatMap(({ results }) => results),
        [band]
      );
      expect(
        fillet.evolution.modified.flatMap(({ results }) => results)
      ).not.toContain(band);
      // Which faces are modified is already settled above, against the box's
      // own face list. What is asserted here is that rounding one edge trims
      // those faces without splitting any: each arrives as exactly one face.
      for (const { results } of fillet.evolution.modified) {
        expect(results).toHaveLength(1);
      }
      // No source face disappears when a single edge is rounded.
      expect(fillet.evolution.deleted).toEqual([]);

      const chamfer = kernel.chamferWithEvolution(
        primitive,
        Uint32Array.from([selectedEdge]),
        1
      );
      verifyCompleteFaceEvolution(kernel, primitive, chamfer);
      expect(kernel.validateSolidRelaxed(chamfer.result.solid)).toBe(0);
      expect(
        Array.from(kernel.getSolidFaces(chamfer.result.solid)).length
      ).toBeGreaterThan(6);
    } finally {
      kernel.free();
    }
  });
});
