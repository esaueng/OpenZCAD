import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The compact workspace (U12) repaints the shell softer — rounder radii, warm
 * neutrals, a tinted selection, larger sentence-case type — and the regular
 * workspace must not move at all. Every compact override therefore lives in
 * a rule scoped to `[data-shell='compact']`, and the regular :root keeps the
 * values the compact override replaces.
 */
const root = resolve(__dirname, '..');
const tokens = readFileSync(resolve(__dirname, './tokens.css'), 'utf8');

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return walk(path);
    return entry.name.endsWith('.css') ? [path] : [];
  });
}

const stylesheets = walk(root).map((path) => ({
  name: path.slice(root.length + 1),
  css: readFileSync(path, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
}));

/** Every innermost rule: the selector list and its declarations. */
function rules(css: string): { selector: string; body: string }[] {
  return [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({
    selector: m[1]!.trim(),
    body: m[2]!
  }));
}

/** A selector list split at its top-level commas, not those inside :not(). */
function selectorList(selector: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < selector.length; index += 1) {
    const char = selector[index];
    if (char === '(') depth += 1;
    else if (char === ')') depth -= 1;
    else if (char === ',' && depth === 0) {
      parts.push(selector.slice(start, index));
      start = index + 1;
    }
  }
  return [...parts, selector.slice(start)];
}

function declarations(selector: string, from = 0): Record<string, string> {
  const start = tokens.indexOf(selector, from);
  const open = tokens.indexOf('{', start);
  const block = tokens
    .slice(open + 1, tokens.indexOf('}', open))
    .replace(/\/\*[\s\S]*?\*\//g, '');
  return Object.fromEntries(
    [...block.matchAll(/(--[\w-]+):\s*([^;]+);/g)].map((m) => [
      m[1]!,
      m[2]!.replace(/\s+/g, ' ').trim()
    ])
  );
}

const COMPACT = "[data-shell='compact'] {";
const COMPACT_LIGHT = ":root[data-theme='light'] [data-shell='compact'] {";
const COMPACT_SYSTEM = ":root[data-theme='system'] [data-shell='compact'] {";

describe('compact token scope', () => {
  it('scopes every selector that names the shell to the compact shell', () => {
    const loose: string[] = [];
    for (const { name, css } of stylesheets) {
      for (const { selector } of rules(css)) {
        if (!selector.includes('data-shell')) continue;
        for (const part of selectorList(selector)) {
          if (!/\[data-shell=(['"])compact\1\]/.test(part)) {
            loose.push(`${name}: ${part.trim()}`);
          }
        }
      }
    }
    expect(loose).toEqual([]);
  });

  it('keeps the compact theme blocks out of the regular :root blocks', () => {
    for (const selector of [
      ':root {',
      ":root[data-theme='light'] {",
      ":root[data-theme='system'] {"
    ]) {
      const start = tokens.indexOf(selector);
      const block = tokens.slice(start, tokens.indexOf('}', start));
      expect(block, selector).not.toContain('data-shell');
    }
    // The compact blocks follow the regular ones, so the regular light and
    // system lookups (systemTheme.test.ts, contrast.test.ts) find theirs.
    expect(tokens.indexOf(COMPACT)).toBeGreaterThan(
      tokens.indexOf(":root[data-theme='system'] {")
    );
  });

  it('declares every compact token only under the compact shell', () => {
    // Any rule outside the compact scope that re-declared one of these would
    // move the regular workspace.
    const compactTokens = new Set(Object.keys(declarations(COMPACT)));
    const outside: string[] = [];
    for (const { name, css } of stylesheets) {
      for (const { selector, body } of rules(css)) {
        if (selector.includes('data-shell')) continue;
        if (/^:root(\[data-theme='(light|system)'\])?$/.test(selector)) {
          continue;
        }
        for (const m of body.matchAll(/(--[\w-]+)\s*:/g)) {
          if (compactTokens.has(m[1]!)) {
            outside.push(`${name}: ${selector} ${m[1]}`);
          }
        }
      }
    }
    expect(outside).toEqual([]);
  });

  it('leaves the regular radius, type and eyebrow values where they were', () => {
    const regular = declarations(':root {');
    expect(regular).toMatchObject({
      '--radius-sm': '2px',
      '--radius-md': '3px',
      '--radius-lg': '4px',
      // New, and the same as --radius-lg on the regular workspace.
      '--radius-xl': '4px',
      '--fs-mini': '12px',
      '--fs-xs': '12px',
      '--fs-sm': '13px',
      '--fs-base': '14px',
      '--fs-md': '15px',
      '--fw-medium': '500',
      '--ls-eyebrow': '0.14em',
      // New: the literal values the eyebrow rules carried before.
      '--tt-eyebrow': 'uppercase',
      '--ls-eyebrow-scale': '1'
    });
    // No later plain `:root` rule anywhere may re-declare them either.
    for (const { name, css } of stylesheets) {
      for (const { selector, body } of rules(css)) {
        if (selector !== ':root') continue;
        for (const m of body.matchAll(
          /(--(?:radius|fs|fw|ls|tt)-[\w-]+)\s*:\s*([^;]+);/g
        )) {
          if (m[1]! in regular) {
            expect(m[2]!.trim(), `${name}: ${m[1]}`).toBe(regular[m[1]!]);
          }
        }
      }
    }
    const light = declarations(":root[data-theme='light'] {");
    for (const name of ['--radius-sm', '--radius-xl', '--tt-eyebrow']) {
      expect(light, name).not.toHaveProperty(name);
    }
  });

  it('applies the compact radius, type and eyebrow scale', () => {
    expect(declarations(COMPACT)).toMatchObject({
      '--radius-sm': '8px',
      '--radius-md': '12px',
      '--radius-lg': '16px',
      '--radius-xl': '24px',
      '--fs-base': '17px',
      '--fs-sm': '15px',
      '--fs-xs': '13px',
      '--fs-mini': '13px',
      '--fw-medium': '600',
      '--fw-bold': '600',
      '--ls-eyebrow': '0',
      '--ls-eyebrow-scale': '0',
      '--tt-eyebrow': 'none'
    });
  });

  it('re-declares every compact colour and shadow for the light theme', () => {
    // The base compact block carries the dark palette and also applies under
    // the light theme, so a colour the light blocks missed would paint dark.
    const themed = Object.keys(declarations(COMPACT)).filter((name) =>
      /^--(color|shadow)-/.test(name)
    );
    // Composed from other tokens, so they follow the light values by
    // themselves.
    const composed = new Set([
      '--color-surface-1',
      '--color-surface-raised',
      '--shadow-popover'
    ]);
    const light = declarations(COMPACT_LIGHT);
    expect(
      themed.filter((name) => !composed.has(name) && !(name in light))
    ).toEqual([]);
  });

  it('paints the same compact light palette for the system theme under a light OS', () => {
    const media = tokens.lastIndexOf('@media (prefers-color-scheme: light) {');
    const systemAt = tokens.indexOf(COMPACT_SYSTEM);
    expect(systemAt).toBeGreaterThan(media);
    expect(media).toBeGreaterThan(tokens.indexOf(COMPACT_LIGHT));
    expect(declarations(COMPACT_SYSTEM)).toEqual(declarations(COMPACT_LIGHT));
  });

  it('re-resolves the tokens :root composes from others', () => {
    // A var() resolves where it is declared: the :root copies would keep the
    // regular border colour and popover shadow inside the compact shell.
    const regular = declarations(':root {');
    const composed = Object.keys(regular).filter((name) =>
      /var\(--(color|shadow)-/.test(regular[name]!)
    );
    expect(composed.length).toBeGreaterThan(0);
    const compact = declarations(COMPACT);
    for (const name of composed) {
      expect(compact[name], name).toBe(regular[name]);
    }
  });

  it('leaves viewport lookdev and construction colours to U10', () => {
    const owned =
      /^--(color-(viewport|stage|cube|handle)-|color-(select|preselect|preview|construction|datum)$|stage-|thumbnail-)/;
    for (const selector of [COMPACT, COMPACT_LIGHT, COMPACT_SYSTEM]) {
      expect(
        Object.keys(declarations(selector)).filter((name) => owned.test(name)),
        selector
      ).toEqual([]);
    }
  });
});

describe('compact reach', () => {
  // Literal radii and eyebrow capitals do not follow the tokens, so the
  // compact override would miss them.
  it('draws 2, 3 and 4px corners from the radius tokens', () => {
    // A whole-value literal equal to a token's regular value. Mixed corners
    // (the comment bubbles' tails) stay as they are.
    const literal = stylesheets.flatMap(({ name, css }) =>
      [...css.matchAll(/border-radius:\s*([^;]+);/g)]
        .filter((m) => /^[234]px$/.test(m[1]!.trim()))
        .map((m) => `${name}: ${m[1]}`)
    );
    expect(literal).toEqual([]);
  });

  it('sets tracked capitals through the eyebrow tokens', () => {
    // The start screen is never compact; a hex value and the Dev tag are
    // capitals by content, not eyebrows.
    const exempt = ['.color-picker-hex', '.channel-tag'];
    const literal = stylesheets
      .filter(({ name }) => !name.endsWith('start-screen.css'))
      .flatMap(({ name, css }) =>
        rules(css)
          .filter(
            ({ selector, body }) =>
              /text-transform:\s*uppercase/.test(body) &&
              /letter-spacing:/.test(body) &&
              !exempt.some((e) => selector.endsWith(e))
          )
          .map(({ selector }) => `${name}: ${selector}`)
      );
    expect(literal).toEqual([]);
  });
});
