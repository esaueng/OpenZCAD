import type { FeatureId, FeatureWarning } from '@openzcad/shared';
import type { CommandDiagnostic } from './interaction/machine';

/** Returns a kernel warning attributed to one named feature, without its prefix. */
export function warningForFeature(
  featureName: string,
  warnings: readonly string[]
): string | null {
  const prefix = `Feature "${featureName}":`;
  const match = warnings.find((warning) => warning.startsWith(prefix));
  if (!match) {
    return null;
  }
  return (
    match.replace(/^Feature "[^"]+":\s*/, '').trim() ||
    'This operation does not produce valid geometry.'
  );
}

export interface ValidatedFeatureVerdictInput {
  featureName: string;
  /** Identifies the feature so a refusal can offer to open it. */
  featureId?: FeatureId;
  warnings: readonly string[];
  /**
   * Attribution for `warnings`, when the rebuild supplied it. Absent for an
   * older rebuild result, in which case the name match below is all there is.
   */
  featureWarnings?: readonly FeatureWarning[];
  bodyPresent: boolean;
  documentMoved: boolean;
}

/**
 * The warning that refuses this feature, or null.
 *
 * A name prefix cannot answer this on its own. It repeats across features, and
 * the rebuild loop writes the same `Feature "<name>":` shape whether a feature
 * FAILED to build or was deliberately SKIPPED because it is suppressed — so a
 * gate reading strings refused an edit whenever some unrelated feature was
 * suppressed under a colliding name, and blamed the wrong feature whenever a
 * name repeated. Attribution decides both.
 *
 * What it does NOT yet decide is whether a warning raised inside a BUILDER is
 * a refusal or an advisory. Those are pushed straight onto the string list by
 * the builders themselves, with no record here, and several of them accompany
 * a body that was produced perfectly well. Those still fall through to the
 * name match, and still over-refuse; classifying them is a separate change.
 */
export function refusingWarning(
  featureName: string,
  warnings: readonly string[],
  featureWarnings?: readonly FeatureWarning[],
  featureId?: FeatureId
): string | null {
  if (!featureWarnings) {
    return warningForFeature(featureName, warnings);
  }
  const failure = featureWarnings.find(
    (entry) =>
      entry.kind === 'build-failed' &&
      (featureId
        ? entry.featureId === featureId
        : entry.featureName === featureName)
  );
  if (failure) {
    return (
      failure.message.replace(/^Feature "[^"]+":\s*/, '').trim() ||
      'This operation does not produce valid geometry.'
    );
  }
  // Everything the loop attributed is now accounted for — including a
  // suppression, which is a status and never a refusal. What is left is
  // builder-raised, and only the name can speak for it.
  const accounted = new Set(featureWarnings.map((entry) => entry.message));
  return warningForFeature(
    featureName,
    warnings.filter((warning) => !accounted.has(warning))
  );
}

/**
 * Why the rebuild refused, and what the user can do about it.
 *
 * The kernel attributes its warning to a feature by name, which is how a new
 * edit learns that an *existing* feature is what could not be rebuilt. That
 * feature is the thing to go and change, so it travels with the message
 * rather than being described in it.
 */
export function validatedFeatureRejection(
  input: ValidatedFeatureVerdictInput
): CommandDiagnostic | null {
  const warning = refusingWarning(
    input.featureName,
    input.warnings,
    input.featureWarnings,
    input.featureId
  );
  if (warning) {
    return {
      message: warning,
      ...(input.featureId
        ? {
            culprit: {
              featureId: input.featureId,
              featureName: input.featureName
            }
          }
        : {})
    };
  }
  if (!input.bodyPresent) {
    return { message: 'The operation did not produce its result body.' };
  }
  if (input.documentMoved) {
    return { message: 'The document changed while the operation validated.' };
  }
  return null;
}
