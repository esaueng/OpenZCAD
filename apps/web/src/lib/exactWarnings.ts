import type { FeatureWarning, ProjectDocument } from '@openzcad/shared';

/**
 * Messages in `derived` that `base` did not already report.
 *
 * Kind-aware and occurrence-counted: only `build-failed`/`refusal` provenance
 * blocks (an `advisory` or `suppressed` delta is real work that succeeded, or
 * status — refusing it would destroy or misreport it), and keys carry
 * featureId/kind/message so one pre-existing warning cannot hide a newly
 * failing feature with identical text. Results from before the structured
 * provenance channel keep the string fallback, still counted by occurrence.
 *
 * Shared by AI preflight and the parameter-edit gate so the two never fork
 * the decision rule again.
 */
export function newExactWarnings(
  base: ProjectDocument,
  derived: ProjectDocument['derived']
): string[] {
  const attributed = newBlockingFeatureWarnings(base, derived);
  if (attributed !== undefined) {
    return attributed.map((warning) => warning.message);
  }

  // Compatibility for stored results from before structured warning
  // provenance. Subtract by occurrence: a Set would let one pre-existing
  // warning hide any number of newly failing features with identical text.
  const existing = new Map<string, number>();
  for (const warning of base.derived.warnings) {
    existing.set(warning, (existing.get(warning) ?? 0) + 1);
  }
  return derived.warnings.filter((warning) => {
    const remaining = existing.get(warning) ?? 0;
    if (remaining === 0) {
      return true;
    }
    if (remaining === 1) {
      existing.delete(warning);
    } else {
      existing.set(warning, remaining - 1);
    }
    return false;
  });
}

/**
 * The attributed warnings behind {@link newExactWarnings}, whole: what a
 * caller needs to keep a warning's typed record beside its sentence without
 * matching the sentence again. Undefined for a result from before structured
 * provenance, which has only strings.
 */
export function newBlockingFeatureWarnings(
  base: ProjectDocument,
  derived: ProjectDocument['derived']
): FeatureWarning[] | undefined {
  if (derived.featureWarnings === undefined) return undefined;
  const blocking = derived.featureWarnings.filter(
    (warning) => warning.kind === 'build-failed' || warning.kind === 'refusal'
  );
  const existing = new Map<string, number>();
  for (const warning of base.derived.featureWarnings ?? []) {
    if (warning.kind !== 'build-failed' && warning.kind !== 'refusal') {
      continue;
    }
    const key = `${warning.featureId} ${warning.kind} ${warning.message}`;
    existing.set(key, (existing.get(key) ?? 0) + 1);
  }
  return blocking.filter((warning) => {
    const key = `${warning.featureId} ${warning.kind} ${warning.message}`;
    const remaining = existing.get(key) ?? 0;
    if (remaining === 0) {
      return true;
    }
    if (remaining === 1) {
      existing.delete(key);
    } else {
      existing.set(key, remaining - 1);
    }
    return false;
  });
}

/**
 * Persisted projections omit attribution. Rebuild a warning-bearing baseline
 * before comparing failures by feature identity; display strings cannot prove
 * that two same-named features are the same failure.
 */
export async function exactWarningBaseline(
  base: ProjectDocument,
  derive: (document: ProjectDocument) => Promise<ProjectDocument['derived']>
): Promise<ProjectDocument> {
  if (
    base.derived.featureWarnings !== undefined ||
    !base.derived.warnings.length
  )
    return base;
  const derived = await derive(base);
  // A legacy worker still cannot attribute failures. Keep the conservative
  // comparison rather than treating its newly reported strings as baseline.
  if (derived.featureWarnings === undefined) return base;
  return {
    ...base,
    derived: {
      ...base.derived,
      warnings: derived.warnings,
      featureWarnings: derived.featureWarnings
    }
  };
}
