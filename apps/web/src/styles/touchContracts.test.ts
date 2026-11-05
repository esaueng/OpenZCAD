import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * L02 slice 1 (docs/plans/ipad-touch-plan-2026-11-05.md): screen scaling and
 * touch sizing rules that happy-dom cannot see, since it computes no layout.
 */
const stylesDir = resolve(__dirname);
const componentsDir = join(stylesDir, 'components');
const srcDir = resolve(__dirname, '..');

const stripComments = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, '');
const read = (path: string) => stripComments(readFileSync(path, 'utf8'));

function filesUnder(dir: string, extension: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return filesUnder(path, extension);
    return entry.name.endsWith(extension) && !entry.name.includes('.test.')
      ? [path]
      : [];
  });
}

const stylesheets = [
  ...filesUnder(stylesDir, '.css'),
  ...filesUnder(join(srcDir, 'theme'), '.css')
].map((path) => ({ path, css: read(path) }));

/** The body of the first `@media` block whose prelude is exactly `query`. */
function mediaBlock(css: string, query: string): string {
  const at = css.indexOf(`@media ${query} {`);
  if (at < 0) throw new Error(`No @media ${query}`);
  let depth = 0;
  for (let index = css.indexOf('{', at); index < css.length; index += 1) {
    if (css[index] === '{') depth += 1;
    if (css[index] === '}' && --depth === 0) {
      return css.slice(css.indexOf('{', at) + 1, index);
    }
  }
  throw new Error(`Unclosed @media ${query}`);
}

/** Leaf rules as [selector, declarations]; at-rule preludes are skipped. */
function leafRules(css: string): Array<[string, string]> {
  return [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((match) => [
    match[1]!.replace(/@media[^{]*$/, '').trim(),
    match[2]!
  ]);
}

/** Every px value a custom property is given anywhere in the stylesheets. */
function customPropertyPx(name: string, seen = new Set<string>()): number[] {
  if (seen.has(name)) return [];
  seen.add(name);
  const pattern = new RegExp(`${name}:\\s*([^;]+);`, 'g');
  return stylesheets.flatMap(({ css }) =>
    [...css.matchAll(pattern)].flatMap((match) => fontSizePx(match[1]!, seen))
  );
}

function fontSizePx(value: string, seen = new Set<string>()): number[] {
  const px = /^(\d+(?:\.\d+)?)px$/.exec(value.trim());
  if (px) return [Number(px[1])];
  const variable = /^var\((--[\w-]+)\)$/.exec(value.trim());
  return variable ? customPropertyPx(variable[1]!, seen) : [];
}

/** Class names given to a text field in the components. */
function fieldClassNames(): Set<string> {
  const names = new Set<string>();
  const sources = [
    ...filesUnder(join(srcDir, 'components'), '.tsx'),
    join(srcDir, 'App.tsx')
  ];
  for (const path of sources) {
    const source = readFileSync(path, 'utf8');
    for (const field of source.matchAll(
      /<(?:input|textarea|select)\b([^>]*?)>/gs
    )) {
      const className = /className=\{?["'`]([^"'`]+)/.exec(field[1]!);
      for (const name of className?.[1]?.split(/\s+/) ?? []) {
        if (/^[a-z][\w-]*$/.test(name)) names.add(name);
      }
    }
  }
  return names;
}

describe('screen scaling', () => {
  it('sizes to the dynamic viewport, which Safari keeps clear of its toolbars', () => {
    const large = stylesheets
      .filter(({ css }) => /\b100vh\b/.test(css))
      .map(({ path }) => path);
    expect(large).toEqual([]);
  });
});

describe('touch targets', () => {
  const targetSize = read(join(componentsDir, 'target-size.css'));

  it('draws coarse-pointer rail, command and Done/Cancel targets at 44 px', () => {
    const block = mediaBlock(targetSize, '(pointer: coarse)');
    const sizes = [
      ...block.matchAll(/(?:min-)?(?:width|height):\s*(\d+)px/g)
    ].map((match) => Number(match[1]));
    expect(sizes.length).toBeGreaterThan(0);
    expect(Math.min(...sizes)).toBe(44);
    expect(block).toMatch(/--rail-w:\s*52px/);
  });

  it('keeps the split instrument rail columns as wide as its buttons', () => {
    expect(
      mediaBlock(targetSize, '(pointer: coarse) and (max-height: 900px)')
    ).toMatch(/grid-template-columns:\s*repeat\(2, 44px\)/);
  });
});

describe('touch browser behaviour', () => {
  const touch = read(join(componentsDir, 'touch.css'));
  const coarse = mediaBlock(touch, '(pointer: coarse)');

  it('loads after every sizing rule', () => {
    const app = read(join(stylesDir, 'app.css'));
    const imports = [
      ...app.matchAll(/@import '\.\/components\/([\w-]+)\.css'/g)
    ].map((match) => match[1]);
    expect(imports.at(-1)).toBe('touch');
  });

  it('stops the page rubber-banding under a gesture', () => {
    expect(touch).toMatch(/html,\s*body\s*\{\s*overscroll-behavior:\s*none;/);
  });

  it('keeps press-and-hold on the model from selecting text, and fields editable', () => {
    expect(coarse).toMatch(
      /\.viewer-host\s*\{[^}]*-webkit-touch-callout:\s*none;[^}]*-webkit-user-select:\s*none;[^}]*user-select:\s*none;/
    );
    expect(coarse).toMatch(
      /\.viewer-host\s*:is\(input, textarea,[^)]*\)\)?\s*\{[^}]*-webkit-user-select:\s*text;/
    );
  });

  it('draws touch fields at 16 px, the size iOS does not zoom into', () => {
    expect(coarse).toMatch(
      /input:not\([^)]*\),\s*select,\s*textarea\s*\{\s*font-size:\s*16px !important;/
    );
  });

  it('only ever raises a field: no field rule is drawn above 16 px', () => {
    const fieldClasses = [...fieldClassNames()];
    const fieldRule = (selector: string) =>
      /(?:^|[\s,>+~(])(?:input|select|textarea)\b/.test(selector) ||
      fieldClasses.some((name) =>
        new RegExp(`\\.${name}(?![\\w-])`).test(selector)
      );
    const larger = stylesheets.flatMap(({ path, css }) =>
      leafRules(css).flatMap(([selector, declarations]) => {
        const size = /font-size:\s*([^;!]+)/.exec(declarations)?.[1];
        if (!size || !fieldRule(selector)) return [];
        return fontSizePx(size).some((px) => px > 16)
          ? [`${path}: ${selector} (${size.trim()})`]
          : [];
      })
    );
    expect(fieldClasses.length).toBeGreaterThan(0);
    expect(larger).toEqual([]);
  });
});
