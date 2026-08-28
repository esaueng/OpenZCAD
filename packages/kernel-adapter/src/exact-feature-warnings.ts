import type { FeatureId, FeatureWarning } from '@openzcad/shared';
import type { ExactBuildResult } from './exact-types';

/** The part of a feature node a warning needs to name its author. */
interface WarningFeature {
  featureId: FeatureId;
  name: string;
}

/**
 * Raises one warning against a feature, and records what it means.
 *
 * `warnings` is what a user reads and its wording is unchanged by this. The
 * parallel record is what the app's commit gate decides from, because the
 * string cannot carry the decision: a name repeats across features, and the
 * same `Feature "<name>":` shape is used for a failure, a refusal, an
 * advisory and a suppression.
 *
 * Returns the index of the pushed string, for the one caller that amends its
 * own warning after the fact.
 */
export function raiseFeatureWarning(
  result: ExactBuildResult,
  feature: WarningFeature,
  reason: string,
  kind: FeatureWarning['kind']
): number {
  const message = `Feature "${feature.name}": ${reason}`;
  const index = result.warnings.length;
  result.warnings.push(message);
  (result.featureWarnings ??= []).push({
    featureId: feature.featureId,
    featureName: feature.name,
    message,
    kind
  });
  return index;
}

/**
 * Appends a remedy to a warning already raised, keeping the record in step.
 *
 * The boolean builder probes for a move that would clear its refusal and
 * appends the answer to the sentence it already pushed. The record holds the
 * same string, and the gate matches on it to tell an accounted warning from an
 * unattributed one — so amending only the display copy would leave the record
 * naming a sentence that no longer exists anywhere.
 */
export function amendFeatureWarning(
  result: ExactBuildResult,
  index: number,
  suffix: string
): void {
  const amended = `${result.warnings[index]!} ${suffix}`;
  const previous = result.warnings[index]!;
  result.warnings[index] = amended;
  const record = result.featureWarnings?.find(
    (entry) => entry.message === previous
  );
  if (record) {
    record.message = amended;
  }
}
