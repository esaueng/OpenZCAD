import type { FeatureId } from '@openzcad/shared';
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
  bodyPresent: boolean;
  documentMoved: boolean;
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
  const warning = warningForFeature(input.featureName, input.warnings);
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
