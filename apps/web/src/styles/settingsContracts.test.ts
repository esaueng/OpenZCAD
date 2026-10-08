import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Settings rules the happy-dom suite cannot see by rendering: it computes no
 * layout or cascade, so these read settings.css for the declarations that
 * fixed each defect (Settings review, 8 Oct 2026).
 */
const css = readFileSync(
  join(resolve(__dirname, 'components'), 'settings.css'),
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

describe('settings switches', () => {
  it('draws the focus ring at the app-wide two pixels', () => {
    expect(rule('.settings-toggle input:focus-visible + span')).toMatch(
      /outline:\s*2px solid var\(--color-accent\)/
    );
  });

  it('dims a disabled switch and field instead of drawing them live', () => {
    expect(css).toMatch(
      /\.settings-toggle input:disabled \+ span,\s*\.settings-page :is\(input:not\(\[type='checkbox'\]\), select, textarea\):disabled \{\s*opacity:\s*0\.45;/
    );
  });
});

describe('settings sign-in rows', () => {
  it('wraps instead of pushing its action over the code field', () => {
    expect(rule('.settings-sign-in-warning')).toMatch(/flex-wrap:\s*wrap/);
    const action = rule('.settings-sign-in-warning > button');
    expect(action).toMatch(/flex:\s*none/);
    expect(action).toMatch(/white-space:\s*nowrap/);
  });
});

describe('settings destructive text', () => {
  it('uses the error text token, which clears 4.5:1 on the card', () => {
    // The first `.danger-ghost {` closes a shared sizing list; the colour
    // is in the rule of its own.
    const own = [...css.matchAll(/\n\.danger-ghost \{([^}]*)\}/g)].map(
      (match) => match[1]
    );
    expect(own.join('')).toMatch(/color:\s*var\(--color-error-text\)/);
    expect(own.join('')).not.toMatch(/color:\s*var\(--color-error\);/);
  });
});
