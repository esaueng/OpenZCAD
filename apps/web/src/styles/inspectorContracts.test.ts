import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Inspector form rules the happy-dom suite cannot see by rendering: it
 * computes no layout, so these read inspector.css for the declarations that
 * fixed each defect (inspector and forms review, Oct 2026).
 */
const css = readFileSync(
  join(resolve(__dirname, 'components'), 'inspector.css'),
  'utf8'
).replace(/\/\*[\s\S]*?\*\//g, '');

/** The declarations of the top-level rule for exactly `selector`. */
function rule(selector: string): string {
  const at = css.indexOf(`\n${selector} {`);
  if (at < 0) {
    throw new Error(`No rule for ${selector}`);
  }
  const open = css.indexOf('{', at);
  return css.slice(open + 1, css.indexOf('}', open));
}

describe('inspector form rules', () => {
  it('draws a field group without the browser fieldset box', () => {
    // Mirror, Draft, Hole, Shell, Thicken, Helical sweep and Loft groups had
    // a 2px grooved border with the legend notched into it.
    const group = rule('fieldset.field');
    expect(group).toMatch(/border:\s*0/);
    expect(group).toMatch(/padding:\s*0/);
    expect(group).toMatch(/min-width:\s*0/);
  });

  it('keeps a checkbox on one line with its label', () => {
    expect(rule('.field-check')).toMatch(/display:\s*flex/);
  });

  it('wraps a field error instead of cutting it off', () => {
    // "Unknown ident…" in a third-width Position cell.
    expect(rule('.expr-preview.error')).toMatch(/white-space:\s*normal/);
  });

  it('truncates only plain value cells in a key-value grid', () => {
    // On every descendant span the ellipsis clipped the material select,
    // the custom density unit and each inertia tensor row.
    expect(rule('.kv-grid span')).not.toMatch(/overflow:\s*hidden/);
    expect(rule('.kv-grid > span')).toMatch(/text-overflow:\s*ellipsis/);
    expect(rule('.kv-grid > span.kv-multiline')).toMatch(
      /white-space:\s*normal/
    );
    expect(css).toMatch(/\.kv-grid > span:has\(select, input\)\s*\{/);
  });
});
