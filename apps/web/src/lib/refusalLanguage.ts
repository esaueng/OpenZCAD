/**
 * One plain sentence for a refusal, with the kernel's own words kept behind
 * it.
 *
 * The reference states a refusal as a single sentence naming the cause and
 * nothing else. Our adapter writes its own refusals that way, but a failure
 * raised inside the kernel arrives as the kernel's diagnostic — lowercase,
 * tagged, counted (`exact-only policy: the exact boolean pipeline could not
 * produce this result…`, `boolean result has degenerate topology (F=…`) — and
 * that used to be the headline. The translation is a fixed table, so every
 * sentence a person reads here was written by a person; the kernel text is
 * never discarded, it moves into the detail the card shows on request.
 */
export interface PlainRefusal {
  message: string;
  detail?: string;
}

const TRANSLATIONS: ReadonlyArray<{ pattern: RegExp; sentence: string }> = [
  {
    pattern: /through-hole diameter .* does not fit/i,
    sentence: 'The hole does not fit this body.'
  },
  {
    pattern: /removing the selected face failed/i,
    sentence: 'The selected face could not be removed.'
  },
  {
    pattern: /could not be sewn into a shell/i,
    sentence: 'This mesh could not be made into a solid.'
  },
  {
    pattern:
      /\[object WebAssembly\.Exception\]|RuntimeError|unreachable|panicked|memory access out of bounds|out of memory/i,
    sentence: 'The exact kernel crashed on this operation.'
  },
  {
    pattern: /exact-only policy|approximate fallback/i,
    sentence: 'The exact kernel could not build this result.'
  },
  {
    pattern: /self-intersect/i,
    sentence: 'The resulting body would intersect itself.'
  },
  {
    pattern:
      /non-manifold|degenerate topology|boolean result has|empty result|produced no (?:output |offset )?(?:faces|vertices|solids)|would leave only|would empty|no faces could be assembled/i,
    sentence: "The resulting body wouldn't be valid."
  },
  {
    pattern:
      /does not fit on the recovered sharp feature|chamfer setback does not fit|blend band touches a freeform|fillet contact map|fillet reconstruction|fillet stitch/i,
    sentence: 'The blend does not fit here. Try a smaller size.'
  },
  {
    pattern: /radius must be positive/i,
    sentence: 'The radius must be greater than zero.'
  },
  {
    pattern: /degenerate/i,
    sentence: 'The geometry collapses to nothing at this value.'
  },
  {
    pattern:
      /intersection failed|face splitting failed|failed to build|failed to (?:add|create|encode)|face has (?:no|empty)|face wire has no edges/i,
    sentence: 'The exact kernel could not build the result surfaces.'
  },
  {
    pattern: /names (?:face|vertex) handle|not among this solid/i,
    sentence: 'The kernel returned inconsistent topology for this body.'
  },
  {
    pattern: /exact geometry failed|unknown kernel error|the kernel rejected/i,
    sentence: 'The exact kernel could not build this feature.'
  }
];

const GENERIC = 'The exact kernel could not build this result.';

/**
 * A sentence the kernel wrote rather than the adapter: it opens lowercase or
 * carries an identifier, a tag, or a count in the kernel's own notation.
 */
function looksLikeKernelText(sentence: string): boolean {
  return (
    /^[a-z]/.test(sentence) ||
    /::|\bwasm\b|\[object |\(F=|\bhandle \d|_[a-z]+:/i.test(sentence)
  );
}

/**
 * Splits `<sentence>\n<detail>` and translates the sentence when the kernel
 * wrote it.
 */
export function plainRefusal(text: string): PlainRefusal {
  const separator = text.indexOf('\n');
  const sentence = (separator < 0 ? text : text.slice(0, separator)).trim();
  const tail = separator < 0 ? '' : text.slice(separator + 1).trim();
  // A lost selection is read by the card to know that no value can help; a
  // parse error names the entity of the file that is broken. Both stay.
  if (/no longer exists|^parse error:/.test(sentence)) {
    return tail ? { message: sentence, detail: tail } : { message: sentence };
  }
  const translation = TRANSLATIONS.find(({ pattern }) =>
    pattern.test(sentence)
  );
  const plain = translation
    ? translation.sentence
    : looksLikeKernelText(sentence)
      ? GENERIC
      : null;
  if (plain === null) {
    return tail ? { message: sentence, detail: tail } : { message: sentence };
  }
  const detail = [sentence, tail].filter(Boolean).join('\n');
  return { message: plain, detail };
}
