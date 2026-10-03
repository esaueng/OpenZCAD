import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  auditGlyphCoverage,
  describeAudit,
  sourceTexts,
  stylesheetTexts,
  unicodeRange,
  woff2CodePoints
} from '../scripts/check-glyph-coverage.mjs';

const font = (name: string) =>
  readFileSync(new URL(`../apps/web/src/theme/fonts/${name}`, import.meta.url));

describe('glyph coverage extraction', () => {
  it('reads rendered text and skips comments and module specifiers', () => {
    const texts = sourceTexts(
      `import { x } from './⌘-not-text';
       // A comment's ⌀ never renders.
       const hint = 'Hole ⌀';
       const label = \`R \${radius} · ⌀ \${diameter}\`;
       export const Badge = () => <kbd>⌘K</kbd>;`,
      'badge.tsx'
    ).map((entry) => entry.text);

    expect(texts).toContain('Hole ⌀');
    expect(texts).toContain('R ');
    expect(texts).toContain(' · ⌀ ');
    expect(texts).toContain('⌘K');
    expect(texts.join('')).not.toContain('not-text');
    expect(texts.join('')).not.toContain('never renders');
  });

  it('reads CSS content strings, escapes included, and nothing else', () => {
    const texts = stylesheetTexts(`
      /* content: '⚠'; is commented out */
      .a::after { content: '\\2318 K'; }
      .b::before { content: attr(data-label); }
      .c { font-family: 'Geist ∠'; }
    `).map((entry) => entry.text);

    expect(texts).toEqual(['⌘K']);
  });

  it('expands unicode ranges', () => {
    expect([...unicodeRange('U+2318, U+25A0-25A2')]).toEqual([
      0x2318, 0x25a0, 0x25a1, 0x25a2
    ]);
  });

  it('reads the code points a WOFF2 font maps', () => {
    const keys = woff2CodePoints(font('openzcad-symbols-keys.woff2'));
    expect(keys.has(0x2318)).toBe(true); // ⌘
    expect(keys.has(0x26a0)).toBe(true); // ⚠
    expect(keys.has(0x2300)).toBe(false); // ⌀ lives in the math face
  });
});

describe('glyph coverage', () => {
  it('draws every interface glyph with a bundled face', () => {
    const audit = auditGlyphCoverage();

    // Compared as text so a failure prints the offending strings.
    expect(describeAudit(audit)).toBe('');
  });

  it('scans the files it claims to', () => {
    const audit = auditGlyphCoverage();

    // A guard that silently reads nothing passes forever. Floors, not counts:
    // 345 files, some 22,000 strings and 552 code points when this landed.
    expect(audit.fileCount).toBeGreaterThan(200);
    expect(audit.textCount).toBeGreaterThan(10_000);
    expect(audit.coveredCount).toBeGreaterThan(500);
  });
});
