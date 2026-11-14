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
  it('lets the invisible checkbox take every pointer hit on the switch', () => {
    // A 1px checkbox under the knob lost the hit on rows at some sub-pixel
    // offsets, so a click at its centre landed on the track instead.
    const input = rule('.settings-toggle input');
    expect(input).toMatch(/inset:\s*0/);
    expect(input).toMatch(/z-index:\s*1/);
    expect(input).toMatch(/width:\s*100%/);
    expect(input).toMatch(/height:\s*100%/);
  });

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

describe('settings notices', () => {
  it('wraps instead of pushing its action over the message', () => {
    expect(rule('.settings-notice')).toMatch(/flex-wrap:\s*wrap/);
    const action = rule('.settings-notice > button');
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

/** The declarations of `selector` inside the first `@media (max-width: N)`
 *  block that has a rule for it. */
function mediaRule(maxWidth: number, selector: string): string {
  const marker = `@media (max-width: ${maxWidth}px) {`;
  let from = 0;
  for (;;) {
    const at = css.indexOf(marker, from);
    if (at < 0) {
      throw new Error(`No ${selector} under max-width ${maxWidth}px`);
    }
    // A media block ends at the first closing brace on a line of its own.
    const end = css.indexOf('\n}', at);
    const block = css.slice(at, end);
    // The rule for exactly `selector`, not the last line of a selector list.
    for (
      let found = block.indexOf(`\n  ${selector} {`);
      found >= 0;
      found = block.indexOf(`\n  ${selector} {`, found + 1)
    ) {
      if (/[{}]\s*$/.test(block.slice(0, found))) {
        const open = block.indexOf('{', found);
        return block.slice(open + 1, block.indexOf('}', open));
      }
    }
    from = end;
  }
}

describe('settings at narrow windows (Settings review, 14 Nov 2026)', () => {
  it('keeps the OpenZCAD wordmark that the workspace cuts below 1200px', () => {
    // responsive.css drops `.brand` to its mark under 1200px to make room
    // for a project name; the Settings column has none and showed a bare
    // logo with 140px to spare.
    const brand = rule('.settings-nav-head .brand');
    expect(brand).toMatch(/font-size:\s*var\(--fs-md\)/);
    expect(brand).toMatch(/gap:\s*7px/);
    expect(rule('.settings-nav-head .brand .beta-tag')).toMatch(
      /display:\s*inline-flex/
    );
  });

  it('wraps the head message to two lines before cutting it', () => {
    // One line cut "Cloud profile connected." to "Cloud profile connecte…"
    // in a 1000px window. Two lines at 1.35 fit the head's 40px, so the
    // message wraps without moving the rule under the head.
    const message = rule('.settings-head .settings-save-message');
    expect(message).toMatch(/white-space:\s*normal/);
    expect(message).toMatch(/-webkit-line-clamp:\s*2/);
    expect(message).toMatch(/line-height:\s*1\.35/);
    expect(message).not.toMatch(/flex:\s*1 0 100%/);
  });

  it('names each phone rail section whole or at a syllable', () => {
    // Encryption, the longest name that must not break, is 61px at the
    // rail's 12px; the button's inner width is the rail less 8px of
    // padding and borders. Appearance (69px) hyphenates.
    const layout = mediaRule(580, '.settings-layout');
    const width = Number(
      /grid-template-columns:\s*calc\(var\(--island-gap\) \+ (\d+)px\)/.exec(
        layout
      )?.[1]
    );
    expect(width - 8).toBeGreaterThanOrEqual(61);
    expect(mediaRule(580, '.settings-nav nav button span')).toMatch(
      /hyphens:\s*auto/
    );
  });

  it('keeps a segmented choice on one row at phone width', () => {
    const group = mediaRule(580, '.settings-segmented');
    expect(group).toMatch(/grid-auto-flow:\s*column/);
    expect(mediaRule(580, '.settings-segmented span')).toMatch(
      /white-space:\s*normal/
    );
  });

  it('lets the keymap bar and rows wrap rather than overrun the card', () => {
    expect(rule('.keymap-editor-bar')).toMatch(/flex-wrap:\s*wrap/);
    expect(rule('.keymap-editor-bar > button')).toMatch(
      /white-space:\s*nowrap/
    );
    expect(mediaRule(760, '.keymap-editor .settings-control-row dd')).toMatch(
      /flex-wrap:\s*wrap/
    );
  });
});
