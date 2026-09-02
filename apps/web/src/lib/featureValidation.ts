import type { FeatureId, FeatureWarning } from '@openzcad/shared';
import type { CommandDiagnostic } from './interaction/machine';

/**
 * A refusal in the two pieces the card shows: the sentence a person reads,
 * and the machinery behind a disclosure.
 *
 * The kernel adapter writes a refusal as `<sentence>\n<detail>` when it has
 * numbers worth keeping — face counts, what became what — and as a plain
 * sentence otherwise. Splitting here, once, is what lets every adapter string
 * lead with the cause without the card ever having to guess where the prose
 * ends and the census begins.
 */
export function splitRefusal(
  text: string
): Pick<CommandDiagnostic, 'message' | 'detail'> {
  const separator = text.indexOf('\n');
  if (separator < 0) {
    return { message: text.trim() };
  }
  const message = text.slice(0, separator).trim();
  const detail = text.slice(separator + 1).trim();
  return detail ? { message, detail } : { message };
}

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
 * A present provenance channel is complete, including when it is empty. Only
 * `build-failed` and `refusal` records may reject a modern rebuild. Results
 * from an older adapter that lack the channel retain the name-based fallback.
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
  return null;
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
      ...splitRefusal(warning),
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
