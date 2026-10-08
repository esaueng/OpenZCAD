import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Start screen layout rules the happy-dom suite cannot see by rendering: it
 * computes no layout and matches no media queries, so these read the
 * stylesheet for the declarations that fixed each defect (start screen
 * review, 8 Oct 2026).
 */
const css = readFileSync(
  join(resolve(__dirname, 'components'), 'start-screen.css'),
  'utf8'
).replace(/\/\*[\s\S]*?\*\//g, '');

/** The declarations of the first rule for exactly `selector`, at any depth. */
function rule(source: string, selector: string): string {
  const match = new RegExp(
    `(?:^|[}\\n])\\s*${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`
  ).exec(source);
  if (!match) {
    throw new Error(`No rule for ${selector}`);
  }
  return match[1]!;
}

describe('start screen sync failures', () => {
  it('keeps every row, and its Retry, inside the list', () => {
    // An implicit auto column grew to the longest name's min-content, so the
    // list scrolled sideways and every Retry sat past its clip edge.
    expect(rule(css, '.start-sync-failures')).toMatch(
      /grid-template-columns:\s*minmax\(0,\s*1fr\)/
    );
  });
});

describe('start screen tile actions', () => {
  it('shows the tile actions where there is no hover to reveal them', () => {
    // On a phone the pin, reorder and ••• buttons stayed at opacity 0, and a
    // tap on the tile opened the part instead, so Archive and Trash were
    // unreachable.
    const block = /@media\s*\(hover:\s*none\)\s*\{([\s\S]*?\})\s*\}/.exec(
      css
    )?.[1];
    expect(block).toBeDefined();
    expect(rule(block!, '.start-tile-actions')).toMatch(/opacity:\s*1/);
  });
});
