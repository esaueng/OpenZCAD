import { describe, expect, it } from 'vitest';
import { RemusKernel } from './remus-runtime';
import { kernelRefusalCategoryOf } from './kernel-refusal';
import {
  SolidValidationRefusal,
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
