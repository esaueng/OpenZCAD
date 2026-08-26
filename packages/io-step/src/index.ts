/**
 * STEP (ISO 10303-21) import-side helpers.
 *
 * Writing STEP is the kernel's job: the exact B-rep kernel emits real analytic
 * surfaces, so there is no JavaScript writer here to emit a faceted
 * approximation alongside it. What this package owns is the cheap textual scan
 * the UI runs on an uploaded file before any kernel is loaded.
 */

export interface ParsedStepMetadata {
  name: string;
  products: string[];
  colors: string[];
}

/**
 * Upper bound on collected labels. The scan feeds UI labels only, and a
 * crafted file could otherwise multiply a small pattern (PRODUCT('x')) into
 * millions of collected strings before the kernel ever sees the bytes.
 */
const MAX_METADATA_MATCHES = 1_000;

function collectMatches(
  text: string,
  pattern: RegExp,
  map: (match: RegExpExecArray) => string | undefined
): string[] {
  const collected: string[] = [];
  for (const match of text.matchAll(pattern)) {
    const value = map(match);
    if (value) {
      collected.push(value);
    }
    if (collected.length >= MAX_METADATA_MATCHES) {
      break;
    }
  }
  return collected;
}

/**
 * Lightweight metadata scan of a STEP file (product names and colors). The
 * geometry itself is imported by the kernel; this only reads the labels needed
 * to describe the file to the user.
 */
export function parseStepMetadata(
  fileName: string,
  text: string
): ParsedStepMetadata {
  const products = collectMatches(
    text,
    /PRODUCT\('([^']+)'/g,
    (match) => match[1]
  );
  const colors = collectMatches(text, /COLOUR_RGB\('([^']*)'/g, (match) =>
    match[1] ? match[1] : 'unnamed'
  );
  return { name: fileName, products, colors };
}
