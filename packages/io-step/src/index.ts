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

function stepString(value: string): string {
  return value.replaceAll("'", "''");
}

/**
 * Replaces the FILE_NAME path/name field in the Part 21 header before a local
 * import source can be persisted or archived. Geometry and DATA records are
 * byte-for-byte unchanged apart from the unavoidable re-encoding of text.
 */
export function sanitizeStepHeaderPrivacy(
  text: string,
  safeFileName: string
): string {
  const headerStart = text.indexOf('HEADER;');
  const headerEnd = text.indexOf('ENDSEC;', headerStart + 7);
  if (headerStart < 0 || headerEnd < 0) {
    throw new Error('STEP file has no complete HEADER section.');
  }
  const fileNameStart = text.indexOf('FILE_NAME(', headerStart + 7);
  if (fileNameStart < 0 || fileNameStart >= headerEnd) {
    throw new Error('STEP header has no FILE_NAME record.');
  }
  const quoteStart = text.indexOf("'", fileNameStart + 'FILE_NAME('.length);
  if (quoteStart < 0 || quoteStart >= headerEnd) {
    throw new Error('STEP FILE_NAME record is malformed.');
  }
  let quoteEnd = quoteStart + 1;
  while (quoteEnd < headerEnd) {
    if (text[quoteEnd] !== "'") {
      quoteEnd += 1;
      continue;
    }
    if (text[quoteEnd + 1] === "'") {
      quoteEnd += 2;
      continue;
    }
    break;
  }
  if (quoteEnd >= headerEnd) {
    throw new Error('STEP FILE_NAME string is unterminated.');
  }
  const baseName = safeFileName.replaceAll('\\', '/').split('/').at(-1) ?? '';
  const safeBaseName = [...baseName]
    .map((character) => {
      const code = character.codePointAt(0) ?? 0;
      return character === '/' ||
        character === '\\' ||
        code <= 0x1f ||
        code === 0x7f
        ? '_'
        : character;
    })
    .join('')
    .slice(0, 240);
  if (!safeBaseName) {
    throw new Error('STEP file name is empty after privacy sanitization.');
  }
  return `${text.slice(0, quoteStart + 1)}${stepString(safeBaseName)}${text.slice(quoteEnd)}`;
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
