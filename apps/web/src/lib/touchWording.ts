/**
 * A pointer instruction worded for a finger (U12): "click" becomes "tap",
 * keeping its case and its ending ("Click" → "Tap", "clicking" → "tapping",
 * "double-click" → "double-tap"). The compact workspace words its prompts
 * this way; the regular workspace keeps the text it was given.
 */
export function tapWording(text: string): string {
  return text.replace(
    /\b([Cc])lick(s|ed|ing)?\b/g,
    (_match, initial: string, ending: string | undefined) =>
      `${initial === 'C' ? 'T' : 't'}ap${
        ending === 'ed' ? 'ped' : ending === 'ing' ? 'ping' : (ending ?? '')
      }`
  );
}
