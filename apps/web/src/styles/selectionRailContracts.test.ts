import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Layout rules of the pick's readout the happy-dom suite cannot see by
 * rendering: it applies no cascade across stylesheets, so these read the
 * stylesheets for the declarations that hold each case.
 */
const read = (file: string) =>
  readFileSync(join(resolve(__dirname, 'components'), file), 'utf8').replace(
    /\/\*[\s\S]*?\*\//g,
    ''
  );
const rail = read('selection-rail.css');
const stage = read('quiet-stage.css');

/** The declarations of the first top-level rule for exactly `selector`. */
function rule(css: string, selector: string): string {
  const at = `\n${css}`.indexOf(`\n${selector} {`);
  if (at < 0) {
    throw new Error(`No rule for ${selector}`);
  }
  const open = css.indexOf('{', at);
  return css.slice(open + 1, css.indexOf('}', open));
}

describe('the pick in the bar', () => {
  it('still names the pick while the assistant is docked', () => {
    // The docked stream hides the whole guidance line, and with it the
    // readout: the rail carries icons only and the viewer no name label,
    // so the pick went unnamed everywhere (PR #997 review).
    expect(rule(stage, '.workspace.with-assistant .workspace-hint')).toMatch(
      /display:\s*none/
    );
    expect(
      rule(
        rail,
        '.workspace.with-assistant .workspace-hint:has(> .selection-readout)'
      )
    ).toMatch(/display:\s*flex/);
    // Only the guidance makes way for the prompt.
    expect(
      rule(
        rail,
        '.workspace.with-assistant .workspace-hint > .workspace-hint-text'
      )
    ).toMatch(/display:\s*none/);
  });

  it('steps aside once a question is typed', () => {
    expect(
      rule(
        rail,
        '.command-bar-lane:has(.command-bar-input:not(:placeholder-shown))\n  > .workspace-hint'
      )
    ).toMatch(/display:\s*none/);
  });

  it('keeps the name ahead of the guidance in a narrow bar', () => {
    expect(rule(rail, '.selection-readout')).toMatch(/flex:\s*0 0 auto/);
    expect(rule(rail, '.workspace-hint-text')).toMatch(/flex:\s*1 1 0/);
  });
});
