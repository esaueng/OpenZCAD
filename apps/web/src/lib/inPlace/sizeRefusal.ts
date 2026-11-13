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
const BUILDS_HERE =
  /Try a smaller (radius|distance): \1 (-?\d+(?:\.\d+)?(?:e-?\d+)?) builds here\./u;

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
    .replace(
      /\bwith (radius|distance) (-?\d+(?:\.\d+)?)(?=[.\s])/u,
      `with $1 $2 ${unit}`
    )
    .replace(
      /: (radius|distance) (-?\d+(?:\.\d+)?(?:e-?\d+)?) builds here\./u,
      `: $1 $2 ${unit} builds here.`
    );
}
