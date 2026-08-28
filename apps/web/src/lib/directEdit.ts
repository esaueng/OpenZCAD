/**
 * Gatekeeping for direct edits.
 *
 * A direct edit is validated against the exact kernel before it is allowed
 * into the document, because the kernel can accept a command and still
 * produce something the gesture did not mean. These are the checks that
 * decide whether a rebuilt preview is safe to commit — kept pure and apart
 * from the async orchestration so each rejection has a test.
 */

import { refusingWarning } from './featureValidation';
import type { FeatureWarning } from '@openzcad/shared';

export interface DirectEditVerdictInput {
  /** The feature label, as it appears in a derived warning's prefix. */
  label: string;
  warnings: readonly string[];
  /** Attribution for `warnings`, when the rebuild supplied it. */
  featureWarnings?: readonly FeatureWarning[];
  /** Whether the rebuild still produced the body the edit targets. */
  bodyPresent: boolean;
  /** Whether the document changed while the rebuild was in flight. */
  documentMoved: boolean;
}

/**
 * Returns why the edit must be rejected, or null when it is safe to commit.
 *
 * Order matters. The kernel's own warning is the most specific explanation
 * available, so it wins over the generic checks; a missing body is more
 * informative than a stale document, because it says the edit itself was
 * wrong rather than merely late.
 */
export function directEditRejection(
  input: DirectEditVerdictInput
): string | null {
  const warning = refusingWarning(
    input.label,
    input.warnings,
    input.featureWarnings
  );
  if (warning) {
    return warning;
  }
  if (!input.bodyPresent) {
    return 'Direct edit did not produce the selected body.';
  }
  if (input.documentMoved) {
    return 'The document changed while the edit was validating.';
  }
  return null;
}
