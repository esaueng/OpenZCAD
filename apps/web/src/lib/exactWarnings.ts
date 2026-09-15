import type { ProjectDocument } from '@openzcad/shared';

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
  if (derived.featureWarnings !== undefined) {
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
    return blocking.flatMap((warning) => {
      const key = `${warning.featureId} ${warning.kind} ${warning.message}`;
      const remaining = existing.get(key) ?? 0;
      if (remaining === 0) {
        return [warning.message];
      }
      if (remaining === 1) {
        existing.delete(key);
      } else {
        existing.set(key, remaining - 1);
      }
      return [];
    });
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
