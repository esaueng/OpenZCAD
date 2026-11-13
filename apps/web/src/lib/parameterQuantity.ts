import { getExpressionDimensions } from '@openzcad/document-core';
import type { ParameterKind, UnitSystem } from '@openzcad/shared';

/**
 * The quantity a new parameter's expression states with its own units:
 * `40 mm` is a length and `15 deg` an angle, so `width = 40 mm` is added
 * as a length rather than as a unitless 40 that the table then marks as
 * untyped. Anything without a unit (`40`, or `w / 2` over the plain
 * numbers parameters evaluate to) states none, and stays unitless as
 * before. A mixed or unreadable expression states none either; the add
 * itself then reports what is wrong with it.
 */
export function quantityTypedIn(
  expression: string,
  scope: Record<string, number>,
  documentUnits: UnitSystem
): ParameterKind | undefined {
  let dimensions: { length: number; angle: number };
  try {
    dimensions = getExpressionDimensions(expression, scope, { documentUnits });
  } catch {
    return undefined;
  }
  if (dimensions.length === 1 && dimensions.angle === 0) return 'length';
  if (dimensions.angle === 1 && dimensions.length === 0) return 'angle';
  return undefined;
}
