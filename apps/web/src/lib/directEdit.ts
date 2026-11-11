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
import type { FeatureId, FeatureWarning } from '@openzcad/shared';

/**
 * Said up front, on the handle, when an offset is about to be pinned by
 * geometry alone. A hash-only face — the result of a boolean, a pattern, a
 * shell, or an imported body — has no name a rebuild can find again, so the
 * edit applies now but drops out with a diagnostic the moment an earlier
 * feature changes that face. Saying so before the drag beats explaining it
 * after the model has quietly lost the edit.
 */
export const UNSTABLE_FACE_OFFSET_REASON =
  'Anchored by geometry only: this face has no identity a rebuild can find again, so the offset will not follow later changes to earlier features and will need re-picking if they move it.';

/**
 * The feature a single feature-creating command adds, read from the ids it
 * carries, so preview and commit can attribute warnings to that feature
 * alone. Undefined for a composite or id-less command, which keeps the
 * name-based attribution.
 */
export function createdFeatureId(command: {
  readonly payload: unknown;
}): FeatureId | undefined {
  const payload = command.payload;
  if (typeof payload !== 'object' || payload === null) return undefined;
  if (Array.isArray(payload)) return undefined;
  const ids: unknown = (payload as { ids?: unknown }).ids;
  if (typeof ids !== 'object' || ids === null) return undefined;
  const featureId: unknown = (ids as { featureId?: unknown }).featureId;
  return typeof featureId === 'string' && featureId.length > 0
    ? (featureId as FeatureId)
    : undefined;
}

export interface DirectEditVerdictInput {
  /** The feature label, as it appears in a derived warning's prefix. */
  label: string;
  warnings: readonly string[];
  /** Attribution for `warnings`, when the rebuild supplied it. */
  featureWarnings?: readonly FeatureWarning[];
  /**
   * The feature this edit adds. Direct edits share their label ("Offset
   * face"), so with attribution present only this feature's own records may
   * refuse it — never an earlier, already failed edit of the same name.
   */
  featureId?: FeatureId;
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
    input.featureWarnings,
    input.featureId
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
