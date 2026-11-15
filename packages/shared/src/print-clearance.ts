import { MAX_EXPRESSION_LENGTH } from './document-validation';

/**
 * L09 document print clearance (schema v59): the stored shape, and how a
 * gear turns it into tooth thinning. Resolving the stored value against the
 * parameters is document-core's `documentPrintClearance`.
 */

/**
 * Why a stored `printClearance` cannot be kept, or null. A number is a
 * length in document units and may not be negative; a string is an
 * expression, judged when it is resolved.
 */
export function printClearanceError(value: unknown): string | null {
  if (typeof value === 'number') {
    return Number.isFinite(value) && value >= 0
      ? null
      : 'The print clearance must be a length of zero or more.';
  }
  if (typeof value === 'string') {
    return value.trim().length > 0 && value.length <= MAX_EXPRESSION_LENGTH
      ? null
      : 'The print clearance must be a length or an expression.';
  }
  return 'The print clearance must be a length or an expression.';
}

/**
 * The tooth thinning, at the pitch circle, that offsets each flank of a gear
 * by `clearance` along its normal: an involute moved by `c` along its normal
 * turns by `c / r_b`, which is `c / cos α` of arc at the pitch circle, once
 * per flank. Exact for spur gears and racks, whose pressure angle is the
 * transverse one; for a helical gear the declared (normal) angle is used.
 */
export function gearBacklashForClearance(
  clearance: number,
  pressureAngleDeg: number
): number {
  return (2 * clearance) / Math.cos((pressureAngleDeg * Math.PI) / 180);
}
