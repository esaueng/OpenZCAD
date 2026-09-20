import { growingHolderHistories } from '@openzcad/command-system';
import { getParameterScope, listParameters } from '@openzcad/document-core';
import type { DerivedState, ProjectDocument } from '@openzcad/shared';
import { newExactWarnings } from './exactWarnings';

/** Only advertise bounds from a construction whose stored history still matches. */
export function parameterMinimums(
  document: ProjectDocument
): Record<string, number> {
  const minimums: Record<string, number> = {};
  for (const { recipe } of growingHolderHistories(document)) {
    minimums[recipe.parameter] = Math.max(
      minimums[recipe.parameter] ?? -Infinity,
      recipe.minimumOpening
    );
    if (recipe.height) {
      const { parameter, minimumHeight } = recipe.height;
      minimums[parameter] = Math.max(
        minimums[parameter] ?? -Infinity,
        minimumHeight
      );
    }
  }
  return minimums;
}

/** A cheap refusal before any worker work, including edits to driving aliases. */
export function parameterInputError(
  base: ProjectDocument,
  candidate: ProjectDocument
): string | null {
  const before = getParameterScope(base).scope;
  const { scope, errors } = getParameterScope(candidate);
  if (errors.length) return errors[0]!;
  for (const [name, minimum] of Object.entries(parameterMinimums(candidate))) {
    if (
      before[name] !== scope[name] &&
      scope[name] !== undefined &&
      scope[name] < minimum
    ) {
      return `${name} must be at least ${minimum} ${candidate.units}.`;
    }
  }
  return null;
}

/**
 * The parameter-edit commit gate: refuses when the candidate rebuild reports
 * a warning the base did not already carry. Shares newExactWarnings with AI
 * preflight, so both gates agree on which provenance blocks (build-failed
 * and refusal only — a new advisory is successful work, not a failure) and
 * subtract by occurrence with feature identity (a Set would let one
 * pre-existing warning hide a newly failing same-named feature).
 */
export function parameterBuildError(
  base: ProjectDocument,
  derived: DerivedState
): string | null {
  const warning = newExactWarnings(base, derived)[0];
  if (warning) return warning;
  for (const id of base.derived.exportableBodyIds) {
    if (!derived.bodyRepresentations[id])
      return 'The edit did not rebuild an existing result body.';
  }
  return null;
}

/**
 * Whether an edit typed against `base` can be re-checked against `live`: the
 * named parameter reads the same in both, so nothing but the edit itself would
 * change it. Absent from both counts — the edit is the one creating it.
 */
export function parameterUntouchedSince(
  base: ProjectDocument,
  live: ProjectDocument,
  name: string
): boolean {
  const expressionIn = (document: ProjectDocument) =>
    listParameters(document).find((parameter) => parameter.name === name)
      ?.expression ?? null;
  return expressionIn(base) === expressionIn(live);
}
