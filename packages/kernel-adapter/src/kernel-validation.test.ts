import { describe, expect, it } from 'vitest';
import { RemusKernel } from './remus-runtime';
import { kernelRefusalCategoryOf } from './kernel-refusal';
import {
  SolidValidationRefusal,
  healPipelineSolid,
  requireValidSolid,
  unifyAndRequireValidSolid,
  unifyFacesReport,
  validationDetail,
  validationErrorDescriptions,
  validationReport
} from './kernel-validation';

/** Row-major rigid translation, matching `copyAndTransformSolid`. */
function translation(x: number, y: number, z: number): Float64Array {
  return Float64Array.of(1, 0, 0, x, 0, 1, 0, y, 0, 0, 1, z, 0, 0, 0, 1);
}

describe('validateSolidDetailed against the pinned kernel', () => {
  /**
   * The load-bearing equivalence for this migration: the detailed twin must
   * report the same error count as the bare validator, or the swap would move
   * a distrust gate rather than reword a refusal.
   */
  it('reports the same error count as validateSolid on a clean solid', () => {
    const kernel = new RemusKernel();
    const box = kernel.makeBox(10, 10, 10);
    const report = validationReport(kernel, box);
    expect(report.errorCount).toBe(kernel.validateSolid(box));
    expect(report).toEqual({ errorCount: 0, warningCount: 0, issues: [] });
    expect(validationDetail(report)).toBeNull();
  });

  it('reports the same error count on a boolean result', () => {
    const kernel = new RemusKernel();
    const box = kernel.makeBox(20, 20, 10);
    const tool = kernel.copyAndTransformSolid(
      kernel.makeCylinder(3, 30),
      translation(10, 10, -5)
    );
    const cut = kernel.cut(box, tool);
    expect(validationReport(kernel, cut).errorCount).toBe(
      kernel.validateSolid(cut)
    );
  });

  it('raises for an invalid handle exactly as validateSolid does', () => {
    const kernel = new RemusKernel();
    expect(() => validationReport(kernel, 9999)).toThrow(
      /invalid solid handle/
    );
    expect(() => kernel.validateSolid(9999)).toThrow(/invalid solid handle/);
  });

  it('passes a valid solid through requireValidSolid untouched', () => {
    const kernel = new RemusKernel();
    const box = kernel.makeBox(4, 4, 4);
    expect(requireValidSolid(kernel, box, 'The box').errorCount).toBe(0);
  });

  /**
   * The kernel's own words, carried. A stub stands in for a solid the strict
   * validator rejects: the corpus's one such body is an open shell, and the
   * import path refuses that structurally before it ever reaches here.
   */
  it('carries the validator issues onto the refusal', () => {
    const stub = {
      validateSolidDetailed: () =>
        JSON.stringify({
          errorCount: 2,
          warningCount: 1,
          issues: [
            { severity: 'error', description: 'Euler characteristic is 1' },
            { severity: 'error', description: '4 boundary edge(s) found' },
            { severity: 'warning', description: 'a face is very small' }
          ]
        })
    };
    let thrown: unknown;
    try {
      requireValidSolid(
        stub,
        1,
        'The hole cut does not produce a valid solid.'
      );
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(SolidValidationRefusal);
    const refused = thrown as SolidValidationRefusal;
    expect(refused.category).toBe('invalid_topology');
    expect(refused.family).toBe('validation');
    expect(refused.errorCount).toBe(2);
    // The headline the call site wrote is unchanged; the validator's reasons
    // arrive behind the newline the app already collapses into a disclosure.
    expect(refused.message.split('\n')[0]).toBe(
      'The hole cut does not produce a valid solid.'
    );
    expect(refused.message).toContain(
      'Validator: Euler characteristic is 1; 4 boundary edge(s) found.'
    );
    expect(
      validationErrorDescriptions({
        errorCount: refused.errorCount,
        warningCount: 1,
        issues: refused.issues
      })
    ).toEqual(['Euler characteristic is 1', '4 boundary edge(s) found']);
    expect(kernelRefusalCategoryOf(refused)).toBe('invalid_topology');
  });

  it('treats an unreadable severity as an error, never as a warning', () => {
    const stub = {
      validateSolidDetailed: () =>
        JSON.stringify({
          errorCount: 1,
          warningCount: 0,
          issues: [{ severity: 'catastrophe' }]
        })
    };
    const report = validationReport(stub, 1);
    expect(report.issues).toEqual([
      { severity: 'error', description: 'the validator gave no description' }
    ]);
  });

  it('raises when the issue list is missing', () => {
    const stub = {
      validateSolidDetailed: () =>
        JSON.stringify({ errorCount: 0, warningCount: 0 })
    };
    expect(() => validationReport(stub, 1)).toThrow(/missing its issue list/);
  });
});

describe('unifyFacesChecked against the pinned kernel', () => {
  /**
   * The healing half of the equivalence: one call must report exactly what
   * `unifyFaces` returned and what `validateSolid` would have said on either
   * side of it, or the swap would move a gate.
   */
  it('reports the merge and both validator verdicts in one call', () => {
    const build = (kernel: RemusKernel) => {
      const box = kernel.makeBox(20, 20, 10);
      const tool = kernel.copyAndTransformSolid(
        kernel.makeCylinder(3, 30),
        translation(10, 10, -5)
      );
      return kernel.cut(box, tool);
    };

    const separate = new RemusKernel();
    const separateSolid = build(separate);
    const before = separate.validateSolid(separateSolid);
    const merged = separate.unifyFaces(separateSolid);
    const after = separate.validateSolid(separateSolid);

    const checked = new RemusKernel();
    const checkedSolid = build(checked);
    const report = unifyFacesReport(checked, checkedSolid);

    expect(report.facesMerged).toBe(merged);
    expect(report.inputErrors).toBe(before);
    expect(report.resultErrors).toBe(after);
    expect(report.reverted).toBe(false);
    expect(checked.getSolidFaces(checkedSolid).length).toBe(
      separate.getSolidFaces(separateSolid).length
    );
    expect(checked.volume(checkedSolid, 0.01)).toBeCloseTo(
      separate.volume(separateSolid, 0.01),
      9
    );
  });

  it('passes a unified valid solid through the gate', () => {
    const kernel = new RemusKernel();
    const box = kernel.makeBox(6, 6, 6);
    expect(
      unifyAndRequireValidSolid(kernel, box, 'The box is not valid.')
        .resultErrors
    ).toBe(0);
  });

  it('refuses with the validator reasons when the result is invalid', () => {
    const stub = {
      unifyFacesChecked: () =>
        JSON.stringify({
          facesMerged: 0,
          inputErrors: 2,
          resultErrors: 2,
          reverted: true
        }),
      validateSolidDetailed: () =>
        JSON.stringify({
          errorCount: 2,
          warningCount: 0,
          issues: [
            { severity: 'error', description: 'shell is not closed' },
            { severity: 'error', description: 'Euler characteristic is 1' }
          ]
        })
    };
    expect(() =>
      unifyAndRequireValidSolid(stub, 1, 'The hole cut is not valid.')
    ).toThrow(SolidValidationRefusal);
    try {
      unifyAndRequireValidSolid(stub, 1, 'The hole cut is not valid.');
    } catch (error) {
      expect(kernelRefusalCategoryOf(error)).toBe('invalid_topology');
      expect((error as Error).message).toContain('shell is not closed');
    }
  });

  it('raises on an unreadable unification payload rather than passing', () => {
    const stub = { unifyFacesChecked: () => 'not json' };
    expect(() => unifyFacesReport(stub, 1)).toThrow(
      /unreadable face unification result/
    );
  });
});

/**
 * The heal pipeline's two failure channels, which the mesh-import path leans
 * on. A refusal must keep the caller's body; an answer the adapter cannot read
 * must never be mistaken for one.
 */
describe('runHealPipeline against the pinned kernel', () => {
  /** The disjoint pair that `sewFaces` turns into one clean-validating solid. */
  function sewnDisjointPair(kernel: RemusKernel): number {
    const near = kernel.makeBox(2, 3, 4);
    const far = kernel.copyAndTransformSolid(
      kernel.makeBox(2, 3, 4),
      translation(10, 0, 0)
    );
    return kernel.sewFaces(
      Uint32Array.from([
        ...kernel.getSolidFaces(near),
        ...kernel.getSolidFaces(far)
      ]),
      1e-5
    );
  }

  it('reads back the committed solid when the pipeline runs', () => {
    const kernel = new RemusKernel();
    const box = kernel.makeBox(10, 10, 10);
    const sewn = kernel.sewFaces(kernel.getSolidFaces(box), 1e-5);
    const healed = healPipelineSolid(kernel, sewn, ['unify_same_domain']);
    expect(healed).not.toBeNull();
    expect(kernel.validateSolid(healed!)).toBe(0);
    expect(kernel.volume(healed!, 0.01)).toBeCloseTo(1000, 6);
  });

  /**
   * The case PR #336 restored. Two disjoint boxes sew into one solid the
   * strict validator passes with the summed volume, and the kernel then
   * refuses to unify its faces. The refusal is about the merge, so the body
   * survives it — rethrowing here threw a good import away.
   */
  it('reports a refused merge as null and leaves the input standing', () => {
    const kernel = new RemusKernel();
    const sewn = sewnDisjointPair(kernel);
    expect(kernel.validateSolid(sewn)).toBe(0);
    expect(kernel.volume(sewn, 0.01)).toBeCloseTo(2 * 3 * 4 * 2, 6);
    expect(() => {
      // The pin declares this `any`; the block body keeps the discarded
      // result from becoming an unsafe return out of the arrow.
      kernel.runHealPipeline(sewn, ['unify_same_domain']);
    }).toThrow(/healing result refused/);
    expect(healPipelineSolid(kernel, sewn, ['unify_same_domain'])).toBeNull();
    // Transactional: the handle the caller still holds is untouched.
    expect(kernel.validateSolid(sewn)).toBe(0);
    expect(kernel.volume(sewn, 0.01)).toBeCloseTo(2 * 3 * 4 * 2, 6);
  });

  /**
   * An open shell refuses the same way a clean one does, which is why the
   * import path no longer branches on the sewn shell's own validity.
   */
  it('reports a refusal for an open shell too, not only a closed one', () => {
    const kernel = new RemusKernel();
    const faces = kernel.getSolidFaces(kernel.makeBox(10, 10, 10));
    const sewn = kernel.sewFaces(
      Uint32Array.from([...faces].slice(0, faces.length - 1)),
      1e-5
    );
    expect(kernel.validateSolid(sewn)).not.toBe(0);
    expect(healPipelineSolid(kernel, sewn, ['unify_same_domain'])).toBeNull();
  });

  /**
   * The limit of the channel, recorded rather than papered over: the pin has
   * no detailed twin for the heal pipeline, so a misused call throws the same
   * bare `Error` a refusal does and reads back the same way. Callers keep it
   * unreachable by passing a handle the kernel just gave them and a literal
   * step list, which is what the mesh-import path does.
   */
  it('cannot tell a misused call from a refusal, and says so here', () => {
    const kernel = new RemusKernel();
    expect(() => {
      kernel.runHealPipeline(9999, ['unify_same_domain']);
    }).toThrow(/invalid solid handle/);
    expect(healPipelineSolid(kernel, 9999, ['unify_same_domain'])).toBeNull();
    const box = kernel.makeBox(1, 1, 1);
    expect(() => {
      kernel.runHealPipeline(box, ['not_a_step']);
    }).toThrow(/unknown operator/);
    expect(healPipelineSolid(kernel, box, ['not_a_step'])).toBeNull();
  });

  /**
   * The other invariant. A pipeline that RETURNED has committed, so a payload
   * with no readable handle in it is the adapter and the kernel disagreeing,
   * not the kernel declining — it must raise, never read as `null` and hand
   * the caller back its pre-merge handle.
   */
  it('raises on an unreadable payload rather than reading it as a refusal', () => {
    expect(() =>
      healPipelineSolid({ runHealPipeline: () => 'not json' }, 1, ['fix_shape'])
    ).toThrow(/unreadable heal pipeline result/);
    expect(() =>
      healPipelineSolid({ runHealPipeline: () => '[]' }, 1, ['fix_shape'])
    ).toThrow(/unreadable heal pipeline result/);
  });

  it('raises when the committed payload carries no solid handle', () => {
    for (const payload of [
      JSON.stringify({ steps: [], verified: true }),
      JSON.stringify({ solid: '4', steps: [], verified: true }),
      JSON.stringify({ solid: -1, steps: [], verified: true }),
      JSON.stringify({ solid: 1.5, steps: [], verified: true })
    ]) {
      expect(() =>
        healPipelineSolid({ runHealPipeline: () => payload }, 1, ['fix_shape'])
      ).toThrow(/missing its "solid" handle/);
    }
  });

  it('accepts an already-parsed payload, as the declared `any` allows', () => {
    expect(
      healPipelineSolid(
        { runHealPipeline: () => ({ solid: 7, steps: [], verified: true }) },
        1,
        ['fix_shape']
      )
    ).toBe(7);
  });
});
