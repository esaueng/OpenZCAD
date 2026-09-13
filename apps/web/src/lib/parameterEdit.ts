import { growingHolderHistories } from '@openzcad/command-system';
import { getParameterScope } from '@openzcad/document-core';
import type { DerivedState, ProjectDocument } from '@openzcad/shared';

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

/** Existing imported-source advisories must not prevent repairing a project. */
export function parameterBuildError(
  base: ProjectDocument,
  derived: DerivedState
): string | null {
  const existing = new Set(base.derived.warnings);
  const warning = derived.warnings.find((message) => !existing.has(message));
  if (warning) return warning;
  for (const id of base.derived.exportableBodyIds) {
    if (!derived.bodyRepresentations[id])
      return 'The edit did not rebuild an existing result body.';
  }
  return null;
}
