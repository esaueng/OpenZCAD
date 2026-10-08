import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * --color-text-dim is 3.0–3.8:1 on the chrome surfaces in both themes: fine
 * for disabled controls and icon glyphs, under AA for text someone has to
 * read. These rules carry such text and use --color-text-subtle, which
 * contrast.test.ts holds at 4.5:1 on every surface.
 */
const components = resolve(__dirname, 'components');

function rule(sheet: string, selector: string): string {
  const css = readFileSync(join(components, sheet), 'utf8').replace(
    /\/\*[\s\S]*?\*\//g,
    ''
  );
  const at = css.indexOf(`\n${selector} {`);
  if (at < 0) {
    throw new Error(`No rule for ${selector} in ${sheet}`);
  }
  const open = css.indexOf('{', at);
  return css.slice(open + 1, css.indexOf('}', open));
}

const READABLE: readonly [string, string][] = [
  ['quiet-stage.css', '.command-bar-keys'],
  ['quiet-stage.css', '.command-flyout-heading'],
  ['direct-manipulation.css', '.keypad-expr-preview'],
  ['direct-manipulation.css', '.sketch-entity-editor .eyebrow'],
  ['direct-manipulation.css', '.sketch-entity-constraints .eyebrow'],
  ['direct-manipulation.css', '.field-hint'],
  ['direct-manipulation.css', '.sketch-plane-prompt small'],
  ['direct-manipulation.css', '.sketch-plane-offset-units'],
  ['assistant.css', '.assistant-day-rule'],
  ['assistant.css', '.assistant-turn-time'],
  ['assistant.css', '.assistant-pending-hint'],
  ['assistant.css', '.assistant-foot'],
  ['assistant.css', '.assistant-foot-action']
];

describe('readable text contrast', () => {
  it.each(READABLE)(
    '%s %s reads in the subtle shade, not dim',
    (sheet, selector) => {
      const body = rule(sheet, selector);
      expect(body).toMatch(/color:\s*var\(--color-text-subtle\)/);
      expect(body).not.toMatch(/var\(--color-text-dim\)/);
    }
  );
});
