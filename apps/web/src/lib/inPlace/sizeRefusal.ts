/**
 * A fillet's or chamfer's refusal as its command bar reads it. The exact
 * kernel's sentence is unit-free and opens with the feature's own name
 * ('Feature "Fillet": Fillet could not be created on 1 selected edge with
 * radius 50. Try a smaller radius: radius 6.25 builds here.'), which the bar
 * titled "Fillet" repeated and left the user to retype the size it named.
 */

/** The size a refused blend names as one that builds, when it names one. */
export interface SmallerSize {
  dimension: 'radius' | 'distance';
  size: number;
}

const FEATURE_PREFIX = /^Feature "[^"]*":\s*/u;
/**
 * A size as the adapter quotes it, which is how JavaScript prints a number:
 * plain, or in exponent notation for a very small or large one ("1.5e-9",
 * "1e+21"). Matched whole, so the unit never lands inside the exponent.
 */
const SIZE = String.raw`-?\d+(?:\.\d+)?(?:e[+-]?\d+)?`;
const BUILDS_HERE = new RegExp(
  String.raw`Try a smaller (radius|distance): \1 (${SIZE}) builds here\.`,
  'u'
);
// A size ends at a space, at the end, or at a full stop that ends the
// sentence: never at the decimal point of "1.5e-9".
const WITH_SIZE = new RegExp(
  String.raw`\bwith (radius|distance) (${SIZE})(?=\s|$|\.(?!\d))`,
  'u'
);
const QUOTED_SIZE = new RegExp(
  String.raw`: (radius|distance) (${SIZE}) builds here\.`,
  'u'
);

/** The proved size in a refusal ("radius 6.25 builds here"), if any. */
export function smallerSizeIn(refusal: string): SmallerSize | null {
  const match = BUILDS_HERE.exec(refusal);
  if (!match) return null;
  const size = Number(match[2]);
  return Number.isFinite(size) && size > 0
    ? { dimension: match[1] as SmallerSize['dimension'], size }
    : null;
}

/**
 * The refusal without the feature name the bar's title already gives, and
 * with the document's unit after every size it quotes.
 */
export function blendRefusalText(refusal: string, unit: string | null): string {
  const text = refusal.replace(FEATURE_PREFIX, '');
  if (!unit) return text;
  return text
    .replace(WITH_SIZE, `with $1 $2 ${unit}`)
    .replace(QUOTED_SIZE, `: $1 $2 ${unit} builds here.`);
}
