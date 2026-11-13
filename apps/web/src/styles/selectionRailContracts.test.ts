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

  it("gives the name the row, and cuts it only at the row's end", () => {
    // The chip is capped at the card's width and the name may shrink inside
    // it. A fixed cap on the name itself (180px) cut "Mounting Bracket ·
    // Front face" with a hundred pixels of the row unused.
    expect(rule(rail, '.selection-readout')).toMatch(/max-width:\s*100%/);
    const name = rule(rail, '.selection-readout .selection-callout-name');
    expect(name).toMatch(/flex:\s*0 1 auto/);
    expect(name).toMatch(/min-width:\s*0/);
    expect(name).toMatch(/text-overflow:\s*ellipsis/);
    // `none`, not absent: the viewport chip's 260px shares the class.
    expect(name).toMatch(/max-width:\s*none/);
    expect(name).not.toMatch(/max-width:\s*\d/);
    // The line never takes the pointer; a cut name does, for its tooltip.
    expect(name).not.toMatch(/pointer-events/);
    expect(
      rule(rail, '.selection-readout .selection-callout-name[data-cut]')
    ).toMatch(/pointer-events:\s*auto/);
  });
});

describe('guidance too long for the field', () => {
  it("stands on the pick's card, wrapping rather than cutting", () => {
    const card = rule(
      stage,
      '.workspace-hint.is-selection,\n.workspace-hint.is-raised'
    );
    expect(card).toMatch(/position:\s*static/);
    expect(card).toMatch(/white-space:\s*normal/);
    expect(
      rule(
        stage,
        '.workspace-hint.is-selection .workspace-hint-text,\n.workspace-hint.is-raised .workspace-hint-text'
      )
    ).toMatch(/white-space:\s*normal/);
  });

  it("is measured on a probe laid out as the field's line is", () => {
    // One rule for both, so the probe cannot drift from the line it stands
    // in for; hidden by visibility, never display, so it keeps its layout.
    const line = rule(stage, '.workspace-hint,\n.workspace-hint-probe');
    expect(line).toMatch(/position:\s*absolute/);
    expect(line).toMatch(/white-space:\s*nowrap/);
    expect(stage).toMatch(
      /\n\.workspace-hint-probe \{\s*visibility:\s*hidden;\s*\}/
    );
    expect(stage).not.toMatch(
      /\.workspace-hint-probe[^{]*\{[^}]*display:\s*none/
    );
  });
});
