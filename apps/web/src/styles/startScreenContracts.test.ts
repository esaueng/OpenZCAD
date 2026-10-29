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

describe('start screen list names', () => {
  // F016 (production QA, 29 Oct 2026): fixed 170px and 160px Status and
  // Edited columns left the name 135px at a 1050px window, so parts that
  // differ only in their ends read as the same "QA-20261028-Profil…".
  it('lets the secondary columns give way to the name', () => {
    const columns = rule(
      css,
      '.start-tile-grid.is-list .start-tile-open'
    ).match(/grid-template-columns:\s*([^;]*);/)?.[1];
    expect(columns).toBeDefined();
    expect(columns).toMatch(/minmax\(0,\s*1fr\)/);
    expect(columns).not.toMatch(/\b170px\s+160px\b/);
    expect(columns!.match(/clamp\(/g)).toHaveLength(2);
  });

  it('wraps a long name to two lines instead of one clipped line', () => {
    const name = rule(css, '.start-tile-grid.is-list .start-tile-name');
    expect(name).toMatch(/-webkit-line-clamp:\s*2/);
    expect(name).toMatch(/white-space:\s*normal/);
    expect(name).toMatch(/overflow-wrap:\s*anywhere/);
  });

  it('gives a phone row the whole width for the name', () => {
    const block = /@media\s*\(max-width:\s*680px\)\s*\{([\s\S]*?\})\s*\}/.exec(
      css
    )?.[1];
    expect(block).toBeDefined();
    expect(rule(block!, '.start-tile-grid.is-list .start-tile-open')).toMatch(
      /grid-template-columns:\s*44px\s+minmax\(0,\s*1fr\);/
    );
  });
});

describe('start screen tile actions', () => {
  it('shows the tile actions where there is no hover to reveal them', () => {
    // On a phone the pin and ••• buttons stayed at opacity 0, and a tap on
    // the tile opened the part instead, so Archive and Trash were
    // unreachable.
    const block = /@media\s*\(hover:\s*none\)\s*\{([\s\S]*?\})\s*\}/.exec(
      css
    )?.[1];
    expect(block).toBeDefined();
    expect(rule(block!, '.start-tile-action')).toMatch(/opacity:\s*1/);
  });
});

describe('start screen shelf line and Settings island', () => {
  // 29 Oct 2026: the shelf scrolled with its line, so cards slid under the
  // Settings island floating at the line's end.
  const island = readFileSync(
    join(resolve(__dirname, 'components'), 'corner-island.css'),
    'utf8'
  ).replace(/\/\*[\s\S]*?\*\//g, '');

  it('pins the line in the column layout and keeps the island above it', () => {
    const pinned = /\.start-toolbar\s*\{([^}]*position:\s*sticky[^}]*)\}/.exec(
      css
    );
    expect(pinned).not.toBeNull();
    const declarations = pinned![1]!;
    expect(declarations).toMatch(/top:\s*0/);
    expect(declarations).toMatch(/background:/);
    const lineLayer = Number(/z-index:\s*(\d+)/.exec(declarations)![1]);
    const islandLayer = Number(
      /z-index:\s*(\d+)/.exec(rule(island, '.corner-island'))![1]
    );
    expect(islandLayer).toBeGreaterThan(lineLayer);
  });
});
