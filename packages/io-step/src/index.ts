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
 * Lightweight metadata scan of a STEP file (product names and colors). The
 * geometry itself is imported by the kernel; this only reads the labels needed
 * to describe the file to the user.
 */
export function parseStepMetadata(
  fileName: string,
  text: string
): ParsedStepMetadata {
  const products = Array.from(
    text.matchAll(/PRODUCT\('([^']+)'/g),
    (match) => match[1]
  ).filter((value): value is string => Boolean(value));
  const colors = Array.from(text.matchAll(/COLOUR_RGB\('([^']*)'/g), (match) =>
    match[1] ? match[1] : 'unnamed'
  );
  return { name: fileName, products, colors };
}
