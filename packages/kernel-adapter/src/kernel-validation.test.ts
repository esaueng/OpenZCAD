import { describe, expect, it } from 'vitest';
import { RemusKernel } from './remus-runtime';
import { kernelRefusalCategoryOf } from './kernel-refusal';
import {
  SolidValidationRefusal,
  requireValidSolid,
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
