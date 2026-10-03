/**
 * Guards the contract between the interface's text and the fonts it ships:
 * every character a string, JSX text or CSS `content` writes must be drawn by
 * a bundled face.
 *
 * The command bar's ⌘K badge rendered as a hex box reading "2318". Geist is
 * loaded as its latin subsets only, which have no ⌘, so the browser fell back
 * to the system's fonts; one that restricts which local fonts a page may use
 * found none and painted the missing-glyph box. Hole summaries (⌀), angle
 * measurements (∠), sketch constraints (∥ ⊥) and snap markers (⊕ □ ◇) leaned
 * on the same fallback, and no type checker or unit test can see a box where a
 * glyph belongs.
 *
 * The bundled faces are the Geist subsets main.tsx imports and the two
 * "OpenZCAD Symbols" faces tokens.css declares. Both font stacks end in Geist
 * Sans and then OpenZCAD Symbols before any system font, so a character is
 * covered when Geist Sans in every loaded weight, or a symbols face within
 * its declared unicode-range, draws it. Comments are not scanned; they never
 * render.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { brotliDecompressSync } from 'node:zlib';
import ts from 'typescript';

const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url));

/** The web app and the viewport package, whose HUD DOM the app styles. */
export const SCANNED_ROOTS = ['apps/web/src', 'packages/viewport/src'];

const ENTRY = 'apps/web/src/main.tsx';
const TOKENS = 'apps/web/src/theme/tokens.css';
const SYMBOLS_FAMILY = 'OpenZCAD Symbols';

// ── WOFF2 cmap ─────────────────────────────────────────────────────────────

function readBase128(bytes, at) {
  let value = 0;
  for (let i = 0; i < 5; i++) {
    const byte = bytes[at.offset++];
    value = value * 128 + (byte & 0x7f);
    if (!(byte & 0x80)) return value;
  }
  throw new Error('UIntBase128 longer than five bytes');
}

/**
 * The code points a WOFF2 font maps, read from its cmap (formats 4 and 12).
 * WOFF2 brotli-compresses every table into one stream laid end to end in
 * directory order; cmap is tag 0 and is never transformed.
 */
export function woff2CodePoints(buffer) {
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.length);
  if (view.getUint32(0) !== 0x774f4632) throw new Error('not a WOFF2 file');
  const numTables = view.getUint16(12);
  const compressedSize = view.getUint32(20);
  const at = { offset: 48 };
  let streamOffset = 0;
  let cmap = null;
  for (let i = 0; i < numTables; i++) {
    const flags = buffer[at.offset++];
    const tag = flags & 0x3f;
    if (tag === 0x3f) at.offset += 4;
    const transform = flags >> 6;
    const origLength = readBase128(buffer, at);
    // glyf (10) and loca (11) are transformed at version 0; every other table
    // only at a nonzero version.
    const transformed =
      tag === 10 || tag === 11 ? transform === 0 : transform !== 0;
    const length = transformed ? readBase128(buffer, at) : origLength;
    if (tag === 0) cmap = { offset: streamOffset, length };
    streamOffset += length;
  }
  if (!cmap) throw new Error('font has no cmap');
  const stream = brotliDecompressSync(
    buffer.subarray(at.offset, at.offset + compressedSize)
  );
  const table = new DataView(
    stream.buffer,
    stream.byteOffset + cmap.offset,
    cmap.length
  );
  const points = new Set();
  const subtables = table.getUint16(2);
  for (let i = 0; i < subtables; i++) {
    const platform = table.getUint16(4 + i * 8);
    const offset = table.getUint32(8 + i * 8);
    if (platform !== 0 && platform !== 3) continue;
    const format = table.getUint16(offset);
    if (format === 4) {
      const segments = table.getUint16(offset + 6) / 2;
      const ends = offset + 14;
      const starts = ends + segments * 2 + 2;
      const deltas = starts + segments * 2;
      const rangeOffsets = deltas + segments * 2;
      for (let s = 0; s < segments; s++) {
        const end = table.getUint16(ends + s * 2);
        const start = table.getUint16(starts + s * 2);
        const delta = table.getUint16(deltas + s * 2);
        const rangeOffset = table.getUint16(rangeOffsets + s * 2);
        for (let c = start; c <= end && c !== 0xffff; c++) {
          let glyph;
          if (rangeOffset === 0) glyph = (c + delta) & 0xffff;
          else {
            const at = rangeOffsets + s * 2 + rangeOffset + (c - start) * 2;
            glyph = table.getUint16(at);
            if (glyph !== 0) glyph = (glyph + delta) & 0xffff;
          }
          if (glyph !== 0) points.add(c);
        }
      }
    } else if (format === 12) {
      const groups = table.getUint32(offset + 12);
      for (let g = 0; g < groups; g++) {
        const group = offset + 16 + g * 12;
        const start = table.getUint32(group);
        const end = table.getUint32(group + 4);
        const glyph = table.getUint32(group + 8);
        for (let c = start; c <= end; c++)
          if (glyph + (c - start) !== 0) points.add(c);
      }
    }
  }
  return points;
}

// ── Bundled faces ──────────────────────────────────────────────────────────

const intersect = (sets) =>
  new Set([...sets[0]].filter((point) => sets.every((set) => set.has(point))));

/** Code points named by a CSS unicode-range value. */
export function unicodeRange(value) {
  const points = new Set();
  for (const part of value.split(',')) {
    const match = /U\+([0-9A-F]+)(?:-([0-9A-F]+))?/i.exec(part.trim());
    if (!match) continue;
    const start = parseInt(match[1], 16);
    const end = match[2] ? parseInt(match[2], 16) : start;
    for (let c = start; c <= end; c++) points.add(c);
  }
  return points;
}

/** Geist Sans as main.tsx loads it: the glyphs every imported weight has. */
function geistSansCoverage(repoRoot) {
  const entry = readFileSync(path.resolve(repoRoot, ENTRY), 'utf8');
  const require = createRequire(path.resolve(repoRoot, ENTRY));
  const weights = [
    ...entry.matchAll(/'@fontsource\/geist-sans\/latin-(\d+)\.css'/g)
  ].map((match) => match[1]);
  if (!weights.length) throw new Error(`${ENTRY} imports no Geist Sans face`);
  const root = path.dirname(
    require.resolve('@fontsource/geist-sans/package.json')
  );
  return intersect(
    weights.map((weight) =>
      woff2CodePoints(
        readFileSync(
          path.join(root, 'files', `geist-sans-latin-${weight}-normal.woff2`)
        )
      )
    )
  );
}

/**
 * The OpenZCAD Symbols faces in tokens.css, each limited to its declared
 * unicode-range, with any range code point the file cannot draw reported.
 */
function symbolsCoverage(repoRoot) {
  const css = readFileSync(path.resolve(repoRoot, TOKENS), 'utf8');
  const covered = new Set();
  const undrawn = [];
  for (const [block] of css.matchAll(/@font-face\s*{[^}]*}/g)) {
    if (!block.includes(`'${SYMBOLS_FAMILY}'`)) continue;
    const url = /url\('([^']+)'\)/.exec(block)?.[1];
    const range = /unicode-range:([^;]+);/.exec(block)?.[1];
    if (!url || !range) throw new Error(`incomplete ${SYMBOLS_FAMILY} face`);
    const file = path.posix.join(path.posix.dirname(TOKENS), url);
    const drawn = woff2CodePoints(readFileSync(path.resolve(repoRoot, file)));
    for (const point of unicodeRange(range)) {
      if (drawn.has(point)) covered.add(point);
      else undrawn.push({ file, point });
    }
  }
  return { covered, undrawn };
}

/** Both stacks must fall to Geist Sans and then the symbols before a system font. */
function stackFindings(repoRoot) {
  const css = readFileSync(path.resolve(repoRoot, TOKENS), 'utf8');
  const findings = [];
  for (const token of ['--font-ui', '--font-mono']) {
    const stack = new RegExp(`${token}:([^;]+);`).exec(css)?.[1] ?? '';
    const families = stack.split(',').map((family) => family.trim());
    const sans = families.indexOf("'Geist Sans'");
    const symbols = families.indexOf(`'${SYMBOLS_FAMILY}'`);
    if (sans < 0 || symbols !== sans + 1)
      findings.push(
        `${TOKENS}  ${token} must list 'Geist Sans' and then '${SYMBOLS_FAMILY}' before any system font`
      );
  }
  return findings;
}

// ── Interface text ─────────────────────────────────────────────────────────

/** Rendered text in a TS/TSX source: string literals, template parts, JSX text. */
export function sourceTexts(source, fileName = 'source.tsx') {
  const file = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
    fileName.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  );
  const texts = [];
  const visit = (node) => {
    if (
      ts.isImportDeclaration(node) ||
      ts.isExportDeclaration(node) ||
      ts.isImportTypeNode?.(node)
    )
      return;
    if (
      ts.isStringLiteral(node) ||
      ts.isNoSubstitutionTemplateLiteral(node) ||
      ts.isTemplateHead(node) ||
      ts.isTemplateMiddle(node) ||
      ts.isTemplateTail(node) ||
      ts.isJsxText(node)
    ) {
      texts.push({
        line: file.getLineAndCharacterOfPosition(node.getStart()).line + 1,
        text: node.text
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return texts;
}

/** Text a stylesheet renders: the strings in `content` declarations. */
export function stylesheetTexts(css) {
  const bare = css.replace(/\/\*[\s\S]*?\*\//g, (comment) =>
    comment.replace(/[^\n]/g, ' ')
  );
  const texts = [];
  for (const match of bare.matchAll(/content\s*:([^;}]+)/g)) {
    const line = bare.slice(0, match.index).split('\n').length;
    for (const string of match[1].matchAll(/(['"])((?:\\.|(?!\1).)*)\1/g))
      texts.push({
        line,
        text: string[2].replace(/\\([0-9a-fA-F]{1,6})\s?/g, (_, hex) =>
          String.fromCodePoint(parseInt(hex, 16))
        )
      });
  }
  return texts;
}

function filesUnder(repoRoot) {
  const found = [];
  for (const root of SCANNED_ROOTS) {
    let names;
    try {
      names = readdirSync(path.resolve(repoRoot, root), { recursive: true });
    } catch {
      continue;
    }
    for (const name of names) {
      const file = `${root}/${name.split(path.sep).join('/')}`;
      if (
        /\.(tsx?|css)$/.test(file) &&
        !/\.(test|spec)\.tsx?$/.test(file) &&
        !file.includes('/test/')
      )
        found.push(file);
    }
  }
  return found.sort();
}

const codePointLabel = (point) =>
  `U+${point.toString(16).toUpperCase().padStart(4, '0')}`;

// ── Audit ──────────────────────────────────────────────────────────────────

/** Every interface character no bundled face draws, and the counts behind it. */
export function auditGlyphCoverage(repoRoot = REPO_ROOT) {
  const sans = geistSansCoverage(repoRoot);
  const symbols = symbolsCoverage(repoRoot);
  const covered = new Set([...sans, ...symbols.covered]);

  const files = filesUnder(repoRoot);
  const findings = [];
  let textCount = 0;
  for (const file of files) {
    const source = readFileSync(path.resolve(repoRoot, file), 'utf8');
    const texts = file.endsWith('.css')
      ? stylesheetTexts(source)
      : sourceTexts(source, file);
    textCount += texts.length;
    for (const { line, text } of texts) {
      for (const char of new Set(text)) {
        const point = char.codePointAt(0);
        // Control characters and line breaks are layout, not glyphs.
        if (point < 0x20 || covered.has(point)) continue;
        findings.push({ file, line, char, point, text: text.trim() });
      }
    }
  }

  return {
    findings,
    undrawnRanges: symbols.undrawn,
    stackFindings: stackFindings(repoRoot),
    fileCount: files.length,
    textCount,
    coveredCount: covered.size
  };
}

/** The failure report shared by the CLI and the test. */
export function describeAudit(audit) {
  const lines = [...audit.stackFindings];
  for (const finding of audit.findings)
    lines.push(
      `${finding.file}:${finding.line}  ${finding.char} ${codePointLabel(finding.point)}  in ${JSON.stringify(finding.text.slice(0, 60))}`
    );
  for (const { file, point } of audit.undrawnRanges)
    lines.push(
      `${file}  ${codePointLabel(point)} is in its unicode-range but the file has no glyph for it`
    );
  return lines.join('\n');
}

if (process.argv[1]?.endsWith('check-glyph-coverage.mjs')) {
  const audit = auditGlyphCoverage();
  if (
    audit.findings.length ||
    audit.undrawnRanges.length ||
    audit.stackFindings.length
  ) {
    console.error(describeAudit(audit));
    console.error(
      '\nEach character above renders through system font fallback, which some browsers answer with a missing-glyph box. Use a character Geist draws, draw it as an icon, or add it to the OpenZCAD Symbols faces with scripts/build-symbol-font.sh.'
    );
    process.exit(1);
  }
  console.log(
    `Every interface glyph is bundled: ${audit.textCount} strings in ${audit.fileCount} files checked against ${audit.coveredCount} code points.`
  );
}
