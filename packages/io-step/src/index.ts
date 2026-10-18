import { boundedName } from '@openzcad/shared';
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

interface StepHeaderToken {
  kind: 'word' | 'string' | 'punctuation';
  value: string;
  start: number;
  end: number;
}

/** Scan only as far as HEADER's ENDSEC; comments and strings are opaque. */
function* stepHeaderTokens(
  text: string
): Generator<StepHeaderToken, undefined, unknown> {
  let index = 0;
  while (index < text.length) {
    if (/\s/.test(text[index]!)) {
      index++;
      continue;
    }
    if (text.startsWith('/*', index)) {
      const end = text.indexOf('*/', index + 2);
      if (end < 0) throw new Error('STEP header has an unterminated comment.');
      index = end + 2;
      continue;
    }
    const start = index;
    if (text[index] === "'") {
      index++;
      let closed = false;
      while (index < text.length) {
        if (text[index++] !== "'") continue;
        if (text[index] === "'") {
          index++;
          continue;
        }
        closed = true;
        break;
      }
      if (!closed) throw new Error('STEP header has an unterminated string.');
      yield { kind: 'string', value: '', start, end: index };
    } else if (/[A-Za-z_]/.test(text[index]!)) {
      while (index < text.length && /[A-Za-z_0-9]/.test(text[index]!)) index++;
      yield {
        kind: 'word',
        value: text.slice(start, index).toUpperCase(),
        start,
        end: index
      };
    } else {
      index++;
      yield { kind: 'punctuation', value: text[start]!, start, end: index };
    }
  }
}

function stepHeaderFileNameRange(text: string): [number, number] {
  const tokens = stepHeaderTokens(text);
  let inHeader = false;
  let depth = 0;
  let fileName: [number, number] | undefined;
  for (const token of tokens) {
    if (!inHeader) {
      if (token.kind === 'word' && token.value === 'HEADER') {
        if (tokens.next().value?.value !== ';')
          throw new Error('STEP HEADER is malformed.');
        inHeader = true;
      }
      continue;
    }
    if (depth === 0 && token.kind === 'word' && token.value === 'ENDSEC') {
      if (tokens.next().value?.value !== ';')
        throw new Error('STEP HEADER is incomplete.');
      if (!fileName) throw new Error('STEP header has no FILE_NAME record.');
      return fileName;
    }
    if (depth === 0 && token.kind === 'word' && token.value === 'FILE_NAME') {
      if (fileName)
        throw new Error('STEP header has multiple FILE_NAME records.');
      const opening = tokens.next().value;
      const name = tokens.next().value;
      if (opening?.value !== '(' || name?.kind !== 'string') {
        throw new Error('STEP FILE_NAME record is malformed.');
      }
      fileName = [name.start, name.end - 1];
      depth = 1;
      continue;
    }
    if (token.kind === 'punctuation' && token.value === '(') depth++;
    if (token.kind === 'punctuation' && token.value === ')') {
      if (depth === 0)
        throw new Error('STEP header parentheses are malformed.');
      depth--;
    }
  }
  throw new Error('STEP file has no complete HEADER section.');
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
  const [quoteStart, quoteEnd] = stepHeaderFileNameRange(text);
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
      collected.push(boundedName(value));
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
