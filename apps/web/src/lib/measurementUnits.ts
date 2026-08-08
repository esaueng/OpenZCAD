/**
 * Length formatting for people who read drawings rather than floats.
 *
 * Decimal inches are the right answer for machining and the wrong one almost
 * everywhere else: stock, fasteners, tape measures and shop drawings are all
 * fractional, and "0.40625 in" is a number nobody can find on a rule. This
 * module adds the two notations that were missing — fractional inches and
 * feet-inches — without touching how values are stored. Everything here is
 * display only; `convertedValue` in `measurements.ts` still owns the maths.
 */

export type LengthNotation =
  /** What the app has always done: a fixed number of decimal places. */
  | 'decimal'
  /** 1/2, 3/8, 13/16 — snapped to a denominator. */
  | 'fractional'
  /** 2' 6 1/2" — fractional inches with a feet part. */
  | 'feet-inches';

/**
 * Denominators a rule actually carries. A measured value almost never lands on
 * one exactly, so formatting SNAPS to the nearest and the result is an
 * approximation of the stored number — which is why the formatter reports
 * whether it was exact rather than leaving the reader to assume.
 */
export const INCH_DENOMINATORS = [2, 4, 8, 16, 32, 64] as const;

export type InchDenominator = (typeof INCH_DENOMINATORS)[number];

export interface FormattedLength {
  text: string;
  /**
   * False when snapping moved the value. A fractional reading is a rounding of
   * the measurement, and a measurement tool that hides its own rounding is the
   * thing this whole overhaul is trying to stop being.
   */
  exact: boolean;
}

/** Below this, a snapped fraction is treated as landing on the mark. */
const SNAP_EPSILON = 1e-9;

function greatestCommonDivisor(first: number, second: number): number {
  let a = Math.abs(first);
  let b = Math.abs(second);
  while (b > 0) {
    const remainder = a % b;
    a = b;
    b = remainder;
  }
  return a;
}

/**
 * Splits a positive inch value into whole inches plus a reduced fraction,
 * carrying into the whole part when the fraction rounds up to 1.
 */
function splitInches(
  inches: number,
  denominator: InchDenominator
): { whole: number; numerator: number; denominator: number } {
  const totalSixtyFourths = Math.round(inches * denominator);
  let whole = Math.floor(totalSixtyFourths / denominator);
  let numerator = totalSixtyFourths - whole * denominator;
  // Widened deliberately: reducing 8/16 to 1/2 leaves a denominator that is
  // still a rule marking, but reducing 16/16 leaves 1, which is not one.
  let reducedDenominator: number = denominator;
  if (numerator === 0) {
    return { whole, numerator: 0, denominator: 1 };
  }
  const divisor = greatestCommonDivisor(numerator, reducedDenominator);
  numerator /= divisor;
  reducedDenominator /= divisor;
  // A fraction that reduced to 1/1 is a whole inch that rounded up.
  if (numerator === reducedDenominator) {
    whole += 1;
    numerator = 0;
    reducedDenominator = 1;
  }
  return { whole, numerator, denominator: reducedDenominator };
}

/**
 * Formats a value already converted to inches.
 *
 * Negative values keep their sign on the outside — `-1 1/2"` rather than
 * `-1 -1/2"` — because a distance component along an axis can be negative and
 * a drawing writes it that way.
 */
export function formatInches(
  inches: number,
  notation: Exclude<LengthNotation, 'decimal'>,
  denominator: InchDenominator = 16
): FormattedLength {
  if (!Number.isFinite(inches)) {
    return { text: '—', exact: false };
  }
  const sign = inches < 0 ? '-' : '';
  const magnitude = Math.abs(inches);
  const {
    whole,
    numerator,
    denominator: reduced
  } = splitInches(magnitude, denominator);
  const exact =
    Math.abs(magnitude - (whole + numerator / reduced)) <= SNAP_EPSILON;

  if (notation === 'feet-inches') {
    const feet = Math.floor(whole / 12);
    const inchPart = whole - feet * 12;
    const inchText =
      numerator === 0
        ? `${inchPart}"`
        : inchPart === 0
          ? `${numerator}/${reduced}"`
          : `${inchPart} ${numerator}/${reduced}"`;
    // Below a foot there is no feet part to write; writing 0' would be noise.
    const text =
      feet === 0 ? `${sign}${inchText}` : `${sign}${feet}' ${inchText}`;
    return { text, exact };
  }

  if (numerator === 0) {
    return { text: `${sign}${whole}"`, exact };
  }
  const text =
    whole === 0
      ? `${sign}${numerator}/${reduced}"`
      : `${sign}${whole} ${numerator}/${reduced}"`;
  return { text, exact };
}

/**
 * True when a notation applies to the given unit. Fractions are an inch
 * convention; asking for sixteenths of a millimetre is a category error, and
 * silently honouring it would put "3/16 mm" on screen.
 */
export function notationAppliesTo(
  notation: LengthNotation,
  unit: string
): boolean {
  return notation === 'decimal' || unit === 'inch';
}
