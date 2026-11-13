import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * A touch phone held upright (phone-stage.css). happy-dom computes no
 * layout, so the live stage is measured by `test/e2e/phone-stage.spec.ts`;
 * these pin what that layout rests on and a refactor could quietly undo.
 */
const stylesDir = resolve(__dirname);
const stripComments = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, '');
const css = stripComments(
  readFileSync(join(stylesDir, 'components', 'phone-stage.css'), 'utf8')
);
const PHONE = '(pointer: coarse) and (max-width: 520px) and (min-height: 541px)';

/** The body of the first `@media` block whose prelude is exactly `query`. */
function mediaBlock(query: string): string {
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

describe('the phone stage', () => {
  it('folds the rail under the same query the toolbar draws its toggle for', () => {
    const toolbar = readFileSync(
      resolve(stylesDir, '..', 'components', 'ViewerToolbar.tsx'),
      'utf8'
    );
    const query = /PHONE_RAIL_QUERY =\s*'([^']+)'/.exec(toolbar)?.[1];
    expect(query).toBe(PHONE);
    // The toggle is drawn only there, and only there is anything hidden.
    expect(css).toContain(`@media ${PHONE} {`);
  });

  it('applies to an upright touch phone and nothing else', () => {
    // A rule outside these would reach a tablet, a mouse or a phone on its
    // side, whose rails have their own layouts.
    const queries = [...css.matchAll(/@media ([^{]+)\{/g)].map((match) =>
      match[1]!.trim()
    );
    expect(queries.length).toBeGreaterThan(0);
    for (const query of queries) {
      // The same phone, from 541px tall or a taller band of it.
      const height =
        /^\(pointer: coarse\) and \(max-width: 520px\) and \(min-height: (\d+)px\)/.exec(
          query
        )?.[1];
      expect(Number(height), query).toBeGreaterThanOrEqual(541);
    }
    const outside = css.replace(/@media[^{]+\{(?:[^{}]|\{[^{}]*\})*\}/g, '');
    expect(outside.trim()).toBe('');
  });

  it('follows target-size.css, whose touch grids it undoes', () => {
    const app = readFileSync(join(stylesDir, 'app.css'), 'utf8');
    const order = [...app.matchAll(/@import '\.\/components\/([\w-]+)\.css'/g)]
      .map((match) => match[1]!);
    expect(order.indexOf('phone-stage')).toBeGreaterThan(
      order.indexOf('target-size')
    );
    expect(order.indexOf('phone-stage')).toBeGreaterThan(
      order.indexOf('quiet-stage')
    );
  });

  it('hides tools only while the toggle that brings them back is closed', () => {
    // Every rule that hides part of the instrument rail is conditioned on
    // the toggle, so nothing can be hidden with no way to reach it.
    const hiding = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
      .map((match) => ({
        selector: match[1]!.replace(/@media[^{]*$/, '').trim(),
        body: match[2]!
      }))
      .filter(
        ({ selector, body }) =>
          /display:\s*none/.test(body) && selector.includes('.instrument-rail')
      );
    expect(hiding.length).toBeGreaterThan(0);
    for (const { selector } of hiding) {
      // One selector a line; a comma inside `:is()` is not a new selector.
      for (const part of selector.split(/,\s*\n/)) {
        expect(part).toMatch(
          /:has\(\.rail-more-toggle\[aria-expanded='true'\]\)/
        );
      }
    }
  });

  it('keeps one column and Tools at the rail’s foot from 621px', () => {
    const block = mediaBlock(`${PHONE.replace('541px', '621px')}`);
    expect(block).toMatch(/--column-w:\s*var\(--rail-w\)/);
    expect(block).toMatch(
      /--lane-end:\s*calc\(\s*var\(--rail-w\) \+ var\(--island-gap\) \* 2 \+ var\(--right-panels-w\)\s*\)/
    );
    expect(block).toMatch(
      /nav\.command-rail \.command-more \{[^}]*position:\s*sticky;[^}]*bottom:\s*0/
    );
    // Sticky, Tools would otherwise become the catalog's containing block.
    expect(block).toMatch(
      /\.command-more > \.command-flyout \{[^}]*position:\s*fixed/
    );
  });
});
