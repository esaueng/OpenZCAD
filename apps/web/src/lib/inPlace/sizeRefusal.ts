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

/**
 * Some `Feature "<name>": ` lead, removed for display only. The name is
 * the user's and can hold quotes and `": ` (`Rough": Chamfer could not be
 * created … with distance 2.`), so this can stop inside it: text it leaves
 * is never given units (`withoutFeatureLead`).
 */
const ANY_FEATURE_LEAD = /^Feature "(?:[^"]|"(?!:\s))*":\s*/u;
/**
 * A size as the adapter quotes it, which is how JavaScript prints a number:
 * plain, or in exponent notation for a very small or large one ("1.5e-9",
 * "1e+21"). Matched whole, so the unit never lands inside the exponent.
 */
const SIZE = String.raw`-?\d+(?:\.\d+)?(?:e[+-]?\d+)?`;
/** A size that already has a document unit after it is left alone. */
const NO_UNIT_YET = String.raw`(?!\s+(?:mm|cm|m|in)\b)`;
const BUILDS_HERE = new RegExp(
  String.raw`Try a smaller (radius|distance): \1 (${SIZE}) builds here\.`,
  'u'
);
/**
 * The adapter's own sentence, from its first word: "Chamfer could not be
 * created on 1 selected edge with distance 0.5." Anchored, so a number in
 * text the user wrote (a feature name the lead above could not strip) is
 * never mistaken for the refused size. A size ends at a space, at the end,
 * or at a full stop that ends the sentence: never at the decimal point of
 * "1.5e-9".
 */
const LEAD = String.raw`^([A-Z][a-z]+ could not be created on (?:the selected closed edge|\d+ selected (?:closed )?edges?) with (radius|distance) )(${SIZE})`;
const ADAPTER_SENTENCE = new RegExp(LEAD, 'u');
/** The refused size, where it has no unit yet. */
const BARE_REFUSED_SIZE = new RegExp(
  String.raw`${LEAD}${NO_UNIT_YET}(?=\s|$|\.(?!\d))`,
  'u'
);
/** The size that builds, where it has no unit yet ("0.985 builds here."). */
const BARE_QUOTED_SIZE = new RegExp(
  String.raw`(: (radius|distance) )(${SIZE}) builds here\.`,
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
 * A refusal without its `Feature "<name>": ` lead, and whether what is left
 * is the adapter's own text. It is when the lead was removed as the known
 * feature name, exactly, or when there was no lead at all. A lead removed
 * any other way may have stopped inside a name that holds `": `, leaving
 * the user's words in front, so that text is shown but never given units.
 */
export function withoutFeatureLead(
  refusal: string,
  featureName?: string | null
): { text: string; adapterText: boolean } {
  if (featureName != null) {
    const lead = `Feature "${featureName}": `;
    if (refusal.startsWith(lead)) {
      return { text: refusal.slice(lead.length), adapterText: true };
    }
  }
  const text = refusal.replace(ANY_FEATURE_LEAD, '');
  return { text, adapterText: text === refusal };
}

/**
 * The document's unit after each size the adapter's blend sentence quotes:
 * the refused one and the one that builds, each on its own, and neither
 * when it already has a unit. Only text that opens with that sentence is
 * changed, so pass the adapter's own text (`withoutFeatureLead`).
 */
export function blendSizesWithUnit(adapterText: string, unit: string): string {
  if (!ADAPTER_SENTENCE.test(adapterText)) return adapterText;
  return adapterText
    .replace(BARE_REFUSED_SIZE, `$1$3 ${unit}`)
    .replace(BARE_QUOTED_SIZE, `$1$3 ${unit} builds here.`);
}

/**
 * The refusal without the feature name the bar's title already gives, and
 * with the document's unit after every size it quotes. Units are written
 * only into the adapter's own text: pass the refusing feature's name when
 * the caller knows it, or a lead the name may have spoofed leaves the sizes
 * bare.
 */
export function blendRefusalText(
  refusal: string,
  unit: string | null,
  featureName?: string | null
): string {
  const { text, adapterText } = withoutFeatureLead(refusal, featureName);
  return unit && adapterText ? blendSizesWithUnit(text, unit) : text;
}
