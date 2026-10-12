import { resolveParamValue } from '@openzcad/document-core';
import type { ParamValue, UnitSystem } from '@openzcad/shared';
import { evalParamValue } from '../model';

/** Mixed sketch geometry carries lengths, angles and counts in one resolver. */
export function sketchValueResolver(
  scope: Record<string, number>,
  documentUnits: UnitSystem
): (value: unknown) => number {
  return (value) =>
    evalParamValue(value as ParamValue, scope, documentUnits) ?? 0;
}

/** Strict resolution for modeling drafts; missing unit context still refuses. */
export function requiredValueResolver(
  scope: Record<string, number>,
  documentUnits?: UnitSystem
): (value: ParamValue) => number {
  return (value) => resolveParamValue(value, scope, undefined, documentUnits);
}
