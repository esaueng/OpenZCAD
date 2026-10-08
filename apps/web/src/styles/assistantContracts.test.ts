import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Layout rules of the assistant stream the happy-dom suite cannot see by
 * rendering: it computes no layout, so these read the stylesheet for the
 * declarations that fixed each defect (assistant UI review, 8 Oct 2026).
 */
const css = readFileSync(
  join(resolve(__dirname, 'components'), 'assistant.css'),
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

describe('assistant stream width', () => {
  it('holds the panel and its footer to one column the panel’s own width', () => {
    // An implicit auto column sized to the foot line's min-content (332px)
    // overflowed a 292px panel at 1024px, and the mask clipped "hide".
    for (const selector of ['.assistant-panel', '.assistant-actions']) {
      expect(rule(selector), selector).toMatch(
        /grid-template-columns:\s*minmax\(0, 1fr\)/
      );
    }
  });
});

describe('jump to latest', () => {
  it('stands on the thread’s own foot, not a fixed offset over the footer', () => {
    // `bottom: 48px` from the panel put it on the verified recipes whenever
    // the footer held more than the foot line.
    expect(rule('.assistant-thread')).toMatch(/grid-area:\s*1 \/ 1/);
    expect(rule('.assistant-actions')).toMatch(/grid-area:\s*2 \/ 1/);
    const jump = rule('.assistant-jump');
    expect(jump).toMatch(/grid-area:\s*1 \/ 1/);
    expect(jump).toMatch(/align-self:\s*end/);
    expect(jump).not.toMatch(/position:\s*absolute/);
  });
});

describe('age fading', () => {
  it('never fades a turn in scrollback, and counts age across the thread', () => {
    const fades = css.match(/[^{}]*\.age-[123][^{}]*\{/g) ?? [];
    expect(fades).toHaveLength(3);
    for (const selector of fades) {
      expect(selector).toMatch(/\.assistant-panel:not\(\.scrollback\)/);
    }
    // Counting per `.assistant-day` left yesterday's last turns at full ink.
    expect(css).not.toMatch(/\.assistant-turn:nth-last-child/);
  });
});
