import { describe, expect, it, vi } from 'vitest';
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
import { RemusKernel } from '../packages/kernel-adapter/src/remus-runtime';

/**
 * A pattern whose instances INTERPENETRATE used to be counted twice.
 *
 * The pattern feature accumulates one solid per instance and hands the list on
 * unchanged. Everything downstream walks that list per solid and sums, so two
 * copies sharing volume were added whole: the Inspector's number, the STL
 * writer's enclosed volume and the viewport's mesh all counted the overlap
 * twice, and the mesh carried the interior walls.
 *
 * Nothing objected, and the reason is worth stating because it recurs on this
 * project: the reported volume and the enclosed MESH volume AGREED. They agree
 * because they sum the same list — so they were wrong by exactly the same
 * amount, and cross-checking one against the other could never have found it.
 * `validateSolid` is equally silent, since each instance is individually a
 * perfectly valid solid.
 *
 * Measured on two 20mm cubes patterned along x, before the fix and after:
 *
 *   spacing | before | after  | true  | tris before/after
 *   --------|--------|--------|-------|------------------
 *      30   | 16000  | 16000  | 16000 |  24 / 24   disjoint
 *      20   | 16000  | 16000  | 16000 |  24 / 24   touching
 *      10   | 16000  | 12000  | 12000 |  24 / 12
 *       5   | 16000  | 10000  | 10000 |  24 / 12
 *
 * The first two rows are the control and they are load-bearing: the fuse is
 * CONDITIONAL, so a disjoint or merely touching pattern must come through with
 * its topology and triangle count untouched. A fix that fused unconditionally
 * would pass every overlap assertion here and silently re-key lineage on every
 * pattern in every existing document.
 */
describe('a pattern whose instances overlap', () => {
  let adapter: ExactKernelAdapter;

  const CUBE = 20;
  const patterned = async (
    spacing: number
  ): Promise<{ volume: number; triangles: number; warnings: string[] }> => {
    adapter ??= await createExactKernelAdapter();
    let document = createProjectDocument('Pattern', toUserId('user_pattern'));
    document = addPrimitiveFeature(document, {
      name: 'Block',
      primitiveKind: 'box',
      dimensions: { width: CUBE, height: CUBE, depth: CUBE }
    });
    const targetBodyId = document.bodyOrder.at(-1)!;
    document = patternBody(document, {
      name: 'Row',
      patternKind: 'linear',
      targetBodyId,
      axis: 'x',
      count: 2,
      spacing
    }).document;
    const derived = await adapter.syncDocument(document);
    const body = derived.bodyRepresentations[document.bodyOrder.at(-1)!]!;
    return {
      volume: body.volume,
      triangles: body.mesh.indices.length / 3,
      warnings: derived.warnings
    };
  };

  /** Two cubes spaced `s < 20` apart occupy a box of `20 + s` along x. */
  const trueUnion = (spacing: number) =>
    (CUBE + Math.min(spacing, CUBE)) * CUBE * CUBE;

  it.each([10, 5])(
    'reports the union, not the sum, at spacing %s',
    async (spacing) => {
      const { volume, warnings } = await patterned(spacing);
      expect(volume).toBeCloseTo(trueUnion(spacing), 6);
      // Specifically NOT the sum of the instances.
      expect(volume).toBeLessThan(2 * CUBE ** 3 - 1);
      expect(warnings).toEqual([]);
    },
    120_000
  );

  it.each([10, 5])(
    'draws one solid without interior walls at spacing %s',
    async (spacing) => {
      const { triangles } = await patterned(spacing);
      // A single rectangular box: 6 faces, 2 triangles each. Two unfused
      // instances are 24, and that number is what the viewport used to draw.
      expect(triangles).toBe(12);
    },
    120_000
  );

  it.each([
    [30, 24],
    [20, 24]
  ])(
    'leaves a non-overlapping pattern exactly as it was (spacing %s)',
    async (spacing, triangles) => {
      const { volume, triangles: drawn, warnings } = await patterned(spacing);
      // Disjoint and touching both sum correctly already; the fuse must not
      // fire, so the instance count survives in the mesh.
      expect(volume).toBeCloseTo(2 * CUBE ** 3, 6);
      expect(drawn).toBe(triangles);
      expect(warnings).toEqual([]);
    },
    120_000
  );

  /**
   * The fuse above is fallible, and the build loop that calls it is not
   * transactional: `exact-build-loop` catches a feature's throw, records a
   * warning, and carries on with the same mutable result. So anything the
   * builder wrote before the throw survives the failure that cancelled it.
   *
   * The pattern builder used to mark its target consumed on the way in, ahead
   * of the fuse. A refused fuse then produced no pattern shape AND left the
   * input marked consumed, which hides it from the viewport, the parts list
   * and the STEP export scope. The user was left with an empty viewport, one
   * warning line, and their geometry still in the document but invisible and
   * unexportable. Every other consuming builder in that file leaves its input
   * on screen when it fails.
   */
  it('leaves the target body visible when the pattern fuse is refused', async () => {
    adapter ??= await createExactKernelAdapter();
    let document = createProjectDocument('Pattern', toUserId('user_pattern'));
    document = addPrimitiveFeature(document, {
      name: 'Block',
      primitiveKind: 'box',
      dimensions: { width: CUBE, height: CUBE, depth: CUBE }
    });
    const targetBodyId = document.bodyOrder.at(-1)!;
    // Spacing below the cube edge is what puts the instances into the
    // `shared > 0` branch, so the fuse actually runs. The disjoint controls
    // above skip it entirely and could not reach this at all.
    document = patternBody(document, {
      name: 'Row',
      patternKind: 'linear',
      targetBodyId,
      axis: 'x',
      count: 2,
      spacing: 10
    }).document;
    const patternBodyId = document.bodyOrder.at(-1)!;

    // `fuseAll` documents an "empty or non-manifold result" refusal, which is
    // exactly the throw this ordering mishandles. Injecting it pins the
    // failure without depending on finding geometry the kernel dislikes.
    const fuse = vi
      .spyOn(RemusKernel.prototype, 'fuseAll')
      .mockImplementation(() => {
        throw new Error('kernel refused the fuse');
      });
    let derived;
    try {
      derived = await adapter.syncDocument(document);
    } finally {
      fuse.mockRestore();
    }

    expect(derived.warnings).toContain(
      'Feature "Row": kernel refused the fuse'
    );
    // The pattern produced nothing, which is correct and is not what changed.
    expect(derived.bodyRepresentations[patternBodyId]).toBeUndefined();
    // Its input must therefore still be there. This is the assertion that
    // failed: the box was marked consumed by a feature that never delivered.
    expect(derived.bodyRepresentations[targetBodyId]!.consumed).toBe(false);
    expect(derived.exportableBodyIds).toContain(targetBodyId);
  }, 120_000);

  it('folds an overlapping CIRCULAR pattern too', async () => {
    adapter ??= await createExactKernelAdapter();
    let document = createProjectDocument('Fan', toUserId('user_pattern'));
    document = addPrimitiveFeature(document, {
      name: 'Blade',
      primitiveKind: 'box',
      dimensions: { width: 30, height: 4, depth: 4 }
    });
    const targetBodyId = document.bodyOrder.at(-1)!;
    // Straddle the origin so every rotated copy passes through the hub and
    // overlaps its neighbours there.
    document = transformBody(document, {
      name: 'Centre the blade',
      targetBodyId,
      translation: { x: -15, y: -2, z: 0 },
      rotationDeg: { x: 0, y: 0, z: 0 }
    }).document;
    document = patternBody(document, {
      name: 'Fan',
      patternKind: 'circular',
      targetBodyId,
      axis: 'z',
      count: 4,
      angleDeg: 360
    }).document;
    const derived = await adapter.syncDocument(document);
    const body = derived.bodyRepresentations[document.bodyOrder.at(-1)!]!;
    const oneBlade = 30 * 4 * 4;
    expect(derived.warnings).toEqual([]);
    // Four blades crossing at the hub: strictly less than four times one, and
    // strictly more than one, so neither operand was dropped.
    expect(body.volume).toBeLessThan(4 * oneBlade - 1);
    expect(body.volume).toBeGreaterThan(oneBlade);
  }, 120_000);

  it('refuses nested patterns that would expand past 100 solids', async () => {
    adapter ??= await createExactKernelAdapter();
    let document = createProjectDocument('Nested', toUserId('user_pattern'));
    document = addPrimitiveFeature(document, {
      name: 'Block',
      primitiveKind: 'box',
      dimensions: { width: 1, height: 1, depth: 1 }
    });
    document = patternBody(document, {
      name: 'First row',
      patternKind: 'linear',
      targetBodyId: document.bodyOrder.at(-1)!,
      axis: 'x',
      count: 10,
      spacing: 2
    }).document;
    document = patternBody(document, {
      name: 'Nested row',
      patternKind: 'linear',
      targetBodyId: document.bodyOrder.at(-1)!,
      axis: 'y',
      count: 11,
      spacing: 2
    }).document;

    const derived = await adapter.syncDocument(document);
    expect(derived.warnings).toContain(
      'Feature "Nested row": A pattern may produce at most 100 solids.'
    );
  }, 120_000);
});
