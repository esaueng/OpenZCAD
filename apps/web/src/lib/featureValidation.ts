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
 * Builder-raised warnings now carry that judgement too. `advisory` means the
 * result is real and merely approximate — curves that came back faceted, a
 * pattern whose overlapping instances did not merge — and refusing those would
 * destroy work that succeeded. `refusal` means a shape was produced and is the
 * wrong one, which is what every union check reports.
 *
 * Anything with NO record still falls through to the name match, which refuses.
 * That is the deliberate direction to fail in: a site nobody classified then
 * blocks an edit, which the user sees at once, rather than committing geometry
 * the kernel objected to, which they may not discover until it is a STEP file
 * in someone else's hands.
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
      (entry.kind === 'build-failed' || entry.kind === 'refusal') &&
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
  // Everything the rebuild attributed is now accounted for — including an
  // advisory or suppression, neither of which refuses. What is left has no
  // classification, so only its name can speak for it and it fails closed.
  // Subtract attributed warnings by occurrence, not just by text. Duplicate
  // feature names can produce byte-identical messages; treating the records as
  // a set would let one advisory account for every matching string and could
  // hide an additional, unclassified warning that must still fail closed.
  const accounted = new Map<string, number>();
  for (const entry of featureWarnings) {
    accounted.set(entry.message, (accounted.get(entry.message) ?? 0) + 1);
  }
  return warningForFeature(
    featureName,
    warnings.filter((warning) => {
      const remaining = accounted.get(warning) ?? 0;
      if (remaining === 0) {
        return true;
      }
      if (remaining === 1) {
        accounted.delete(warning);
      } else {
        accounted.set(warning, remaining - 1);
      }
      return false;
    })
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
