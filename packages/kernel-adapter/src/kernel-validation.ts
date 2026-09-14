/**
 * The typed validation and healing reports.
 *
 * `validateSolid` answers "how many errors" and nothing else, so every caller
 * that had to tell a person what was wrong could only say "did not produce a
 * valid solid" — and the app then guessed at the cause from the sentence.
 * `validateSolidDetailed` answers the same question and adds the validator's
 * own issue list, so the refusal can name the defect.
 *
 * Measured on the pin across the whole parity corpus (21 files, 23 solids):
 * `validateSolidDetailed(s).errorCount === validateSolid(s)` for every one of
 * them, including `f-hostile-open-shell`, the only member with errors (2, and
 * the two issues name the Euler characteristic and the 4 boundary edges). So
 * adopting the detailed twin changes what a failure SAYS and nothing about
 * which solids pass — the distrust guards keep their bar exactly.
 *
 * `unifyFacesChecked` is the healing half. The pinned doc is explicit that it
 * performs the same merge with the same acceptance rule as `unifyFaces` and
 * reports the strict validations it already ran, so "a caller that would
 * otherwise validate the raw and the unified solid again can read both
 * verdicts here instead". Measured on a box-minus-cylinder and on a two-box
 * union: `facesMerged` equals what `unifyFaces` returned, `inputErrors` equals
 * `validateSolid` before, and `resultErrors` equals `validateSolid` after — so
 * the pair of calls collapses into one without moving the gate. On an open
 * shell it reports `inputErrors: 2` rather than throwing.
 */
import type { RemusKernel } from './remus-runtime';
import {
  KernelRefusal,
  kernelPayloadCount,
  readKernelPayload
} from './kernel-refusal';

/** One diagnostic from the operations validator. */
export interface KernelValidationIssue {
  severity: 'error' | 'warning';
  description: string;
}

/** `validateSolidDetailed`, read into a checked shape. */
export interface KernelValidationReport {
  errorCount: number;
  warningCount: number;
  issues: readonly KernelValidationIssue[];
}

/** The subset of the kernel this module needs, so tests can supply a double. */
export interface ValidatingKernel {
  validateSolidDetailed(solid: number): unknown;
}

/** The subset of the kernel the unify-and-check helper needs. */
export interface UnifyingKernel {
  unifyFacesChecked(solid: number): unknown;
}

function readIssues(payload: Record<string, unknown>): KernelValidationIssue[] {
  const raw = payload['issues'];
  if (!Array.isArray(raw)) {
    throw new Error(
      "The kernel's validation result is missing its issue list."
    );
  }
  return raw.map((entry) => {
    const record =
      typeof entry === 'object' && entry !== null
        ? (entry as Record<string, unknown>)
        : {};
    const description = record['description'];
    return {
      // Anything the validator does not call a warning is treated as an
      // error: a severity this adapter cannot read must not downgrade a
      // defect into an advisory.
      severity: record['severity'] === 'warning' ? 'warning' : 'error',
      description:
        typeof description === 'string' && description.length > 0
          ? description
          : 'the validator gave no description'
    };
  });
}

/**
 * The validator's full report for one solid.
 *
 * Raises for an invalid handle exactly as `validateSolid` does — measured on
 * the pin, both throw `invalid solid handle: index N is out of bounds` — so
 * this is not a place a programming error becomes a soft verdict.
 */
export function validationReport(
  kernel: ValidatingKernel,
  solid: number
): KernelValidationReport {
  const payload = readKernelPayload(
    kernel.validateSolidDetailed(solid),
    'validation'
  );
  return {
    errorCount: kernelPayloadCount(payload, 'errorCount', 'validation'),
    warningCount: kernelPayloadCount(payload, 'warningCount', 'validation'),
    issues: readIssues(payload)
  };
}

/** The error-severity issue descriptions, longest-standing order preserved. */
export function validationErrorDescriptions(
  report: KernelValidationReport
): string[] {
  return report.issues
    .filter((issue) => issue.severity === 'error')
    .map((issue) => issue.description);
}

/**
 * The validator's complaints as one detail line, or null when it had none.
 *
 * A count without a reason is what the old sentence could offer; this is the
 * reason. It goes after the refusal's newline, where the app already collapses
 * technical detail behind a disclosure.
 */
export function validationDetail(
  report: KernelValidationReport
): string | null {
  const descriptions = validationErrorDescriptions(report);
  if (descriptions.length === 0) {
    return null;
  }
  return `Validator: ${descriptions.join('; ')}.`;
}

/**
 * A body that failed the strict validator, refused by name.
 *
 * `invalid_topology` is the kernel's own category for this class, so a
 * consumer branches on the same field it branches on for a refused boolean.
 * The count is the kernel's; the issues are the kernel's; only the heading is
 * the product's.
 */
export class SolidValidationRefusal extends KernelRefusal {
  readonly errorCount: number;
  readonly issues: readonly KernelValidationIssue[];

  constructor(init: {
    /**
     * The whole product sentence, as the call site already wrote it. Taken
     * verbatim rather than composed here: the wording each operation uses is
     * its own, and this migration changes what a refusal CARRIES, not what a
     * user reads.
     */
    headline: string;
    report: KernelValidationReport;
    cause?: unknown;
  }) {
    const detail = validationDetail(init.report);
    super({
      family: 'validation',
      category: 'invalid_topology',
      kernelCode: 'solid_validation_failed',
      kernelMessage:
        validationErrorDescriptions(init.report).join('; ') ||
        'the strict validator reported no description',
      reason: init.headline,
      message: init.headline + (detail ? `\n${detail}` : ''),
      ...(init.cause === undefined ? {} : { cause: init.cause })
    });
    this.name = 'SolidValidationRefusal';
    this.errorCount = init.report.errorCount;
    this.issues = init.report.issues;
  }
}

/**
 * Validate a solid and refuse by name when it does not pass.
 *
 * Replaces `if (kernel.validateSolid(s) !== 0) throw new Error('… does not
 * produce a valid solid.')`. Same bar, same handle-error behaviour, same
 * headline; what changes is that the refusal now carries the kernel's
 * category and the validator's own words.
 */
export function requireValidSolid(
  kernel: ValidatingKernel,
  solid: number,
  headline: string
): KernelValidationReport {
  const report = validationReport(kernel, solid);
  if (report.errorCount !== 0) {
    throw new SolidValidationRefusal({ headline, report });
  }
  return report;
}

/** `unifyFacesChecked`, read into a checked shape. */
export interface KernelUnifyReport {
  /** Faces removed by unification; zero when nothing merged or it reverted. */
  facesMerged: number;
  /** Strict error count before unification. */
  inputErrors: number;
  /** Strict error count of the solid the caller now holds. */
  resultErrors: number;
  /** The merge was rolled back because the candidate failed strict checks. */
  reverted: boolean;
}

/**
 * Merge co-surface face fragments and read back both validator verdicts.
 *
 * One kernel call in place of `unifyFaces` followed by `validateSolid`. The
 * caller keeps its own gate — this returns the numbers, it does not decide.
 */
export function unifyFacesReport(
  kernel: UnifyingKernel,
  solid: number
): KernelUnifyReport {
  const payload = readKernelPayload(
    kernel.unifyFacesChecked(solid),
    'face unification'
  );
  return {
    facesMerged: kernelPayloadCount(payload, 'facesMerged', 'face unification'),
    inputErrors: kernelPayloadCount(payload, 'inputErrors', 'face unification'),
    resultErrors: kernelPayloadCount(
      payload,
      'resultErrors',
      'face unification'
    ),
    reverted: payload['reverted'] === true
  };
}

/**
 * Unify a boolean result's faces, then refuse unless it validates strictly.
 *
 * The two guards the adapter ran separately, now answered by the kernel in one
 * pass. `resultErrors` describes the solid the caller holds, which is the
 * merged candidate when the merge was kept and the untouched input when it was
 * reverted — so the gate reads the same body it did before.
 */
export function unifyAndRequireValidSolid(
  kernel: UnifyingKernel & ValidatingKernel,
  solid: number,
  headline: string
): KernelUnifyReport {
  const report = unifyFacesReport(kernel, solid);
  if (report.resultErrors !== 0) {
    // The counts alone do not say what is wrong, and the validator will. One
    // extra call, only on the failing path.
    throw new SolidValidationRefusal({
      headline,
      report: validationReport(kernel, solid)
    });
  }
  return report;
}

/**
 * The strict and relaxed error counts an imported solid is diagnosed by, plus
 * the validator's reasons for the strict one.
 *
 * `validateSolidRelaxed` has no detailed twin on the pin, so it stays a bare
 * count. The strict half is where an import refusal gets its wording, and that
 * is the half this reports in full.
 */
export function importedSolidValidation(
  kernel: RemusKernel,
  solid: number
): { strict: KernelValidationReport; relaxedErrorCount: number } {
  return {
    strict: validationReport(kernel, solid),
    relaxedErrorCount: kernel.validateSolidRelaxed(solid)
  };
}
