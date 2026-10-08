import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * 'System' is resolved by the stylesheet, not by script.
 *
 * The root carries the Appearance setting itself, and tokens.css paints the
 * light palette for `data-theme='light'` and, under a light OS, for
 * `data-theme='system'`. A script resolver with a change listener used to
 * decide instead, and a page that was hidden when the OS appearance changed
 * painted its old palette until the listener caught up — the workspace read
 * dark under a light OS while the start screen had been light.
 */
const tokens = readFileSync(resolve(__dirname, './tokens.css'), 'utf8');
const html = readFileSync(resolve(__dirname, '../../index.html'), 'utf8');

function declarations(from: number): Record<string, string> {
  const open = tokens.indexOf('{', from);
  const close = tokens.indexOf('}', open);
  const block = tokens.slice(open + 1, close).replace(/\/\*[\s\S]*?\*\//g, '');
  return Object.fromEntries(
    [...block.matchAll(/(--[\w-]+):\s*([^;]+);/g)].map((m) => [
      m[1]!,
      m[2]!.trim()
    ])
  );
}

describe('system theme', () => {
  const explicit = declarations(tokens.indexOf(":root[data-theme='light'] {"));
  const media = tokens.indexOf('@media (prefers-color-scheme: light) {');
  const system = declarations(
    tokens.indexOf(":root[data-theme='system'] {", media)
  );

  it('paints the light palette under a light OS', () => {
    expect(media).toBeGreaterThan(-1);
    expect(Object.keys(explicit).length).toBeGreaterThan(10);
    expect(system).toEqual(explicit);
  });

  it('nests the system block inside the media query', () => {
    const systemAt = tokens.indexOf(":root[data-theme='system'] {");
    expect(systemAt).toBeGreaterThan(media);
    // Nothing paints 'system' light outside the media query.
    expect(tokens.indexOf(":root[data-theme='system']")).toBe(systemAt);
  });

  it('tells the browser which scheme to draw native control parts in', () => {
    // Spin buttons, select popups, scrollbars and checkbox glyphs ignore the
    // tokens; without color-scheme they were drawn light on the dark theme.
    const scheme = (from: number) => {
      const open = tokens.indexOf('{', from);
      return /color-scheme:\s*(\w+);/.exec(
        tokens.slice(open + 1, tokens.indexOf('}', open))
      )?.[1];
    };
    expect(scheme(tokens.indexOf(':root {'))).toBe('dark');
    expect(scheme(tokens.indexOf(":root[data-theme='light'] {"))).toBe('light');
    expect(
      scheme(tokens.indexOf(":root[data-theme='system'] {", media))
    ).toBe('light');
  });

  it('keeps checkboxes and radios out of the text-field box', () => {
    // The global 30px bordered field turned a checkbox into a tall bar with
    // its glyph floating above the label.
    const field = /\n([^{}]+)\{\s*font-family: inherit;\s*font-size: inherit;\s*color: var\(--color-text\);/.exec(
      tokens
    )?.[1];
    expect(field).toContain(
      "input:where(:not([type='checkbox'], [type='radio']))"
    );
    expect(field).not.toMatch(/(^|,)\s*input\s*,/);
  });

  it('follows the OS from the first paint, before the app runs', () => {
    expect(html).toMatch(/<html lang="en" data-theme="system">/);
  });
});
