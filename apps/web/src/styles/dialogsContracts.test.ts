import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Dialog layout and focus rules the happy-dom suite cannot see by rendering:
 * it computes no layout, so these read modals.css for the declarations that
 * fixed each defect (dialog review, 8 Oct 2026).
 */
const css = readFileSync(
  join(resolve(__dirname, 'components'), 'modals.css'),
  'utf8'
).replace(/\/\*[\s\S]*?\*\//g, '');

/** The declarations of the first top-level rule for exactly `selector`. */
function rule(selector: string): string {
  const at = css.indexOf(`\n${selector} {`);
  if (at < 0) {
    throw new Error(`No rule for ${selector}`);
  }
  const open = css.indexOf('{', at);
  return css.slice(open + 1, css.indexOf('}', open));
}

describe('dialog layout', () => {
  it.each(['.conflict-dialog', '.cloud-deletion-dialog'])(
    'bounds %s to the window and scrolls it, so its actions stay reachable',
    (selector) => {
      const declarations = rule(selector);
      expect(declarations).toMatch(/max-height:\s*calc\(100dvh/);
      expect(declarations).toMatch(/overflow-y:\s*auto/);
    }
  );

  it.each(['.save-revision-dialog', '.export-dialog-group', '.palette-list'])(
    'clamps the %s track so unbroken text cannot widen it past its box',
    (selector) => {
      expect(rule(selector)).toMatch(
        /grid-template-columns:\s*minmax\(0, 1fr\)/
      );
    }
  );
});

describe('dialog focus', () => {
  it('draws a focus indicator on the borderless sharing invite field', () => {
    // `.sharing-invite input:focus` strips border, shadow and outline.
    expect(rule('.sharing-invite input:focus-visible')).toMatch(
      /box-shadow:\s*inset 0 -2px 0 var\(--color-accent\)/
    );
  });
});
