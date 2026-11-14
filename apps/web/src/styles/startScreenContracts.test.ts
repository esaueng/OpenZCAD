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

describe('start screen shelf line and Settings', () => {
  // 29 Oct 2026: the shelf scrolled with its line, so cards slid under the
  // Settings button placed at the line's end.
  const slot = readFileSync(
    join(resolve(__dirname, 'components'), 'corner-slot.css'),
    'utf8'
  ).replace(/\/\*[\s\S]*?\*\//g, '');

  it('keeps the head separate from a bounded scrolling shelf', () => {
    // A sticky head bounced independently of page-anchored Settings on macOS.
    // The section now owns a fixed head row and a shrinkable scrolling body.
    expect(rule(css, '.start-stage')).toMatch(/grid-area:\s*body/);
    expect(rule(css, '.start-section')).toMatch(
      /grid-template-rows:\s*auto\s+minmax\(0,\s*1fr\)/
    );
    const body = rule(css, '.start-body');
    expect(body).toMatch(/min-height:\s*0/);
    expect(body).toMatch(/overflow-y:\s*auto/);
    expect(body).toMatch(/overflow-x:\s*hidden/);
    // Preview mounts must not undo wheel scrolling or reload restoration.
    expect(body).toMatch(/overflow-anchor:\s*none/);
  });

  it('ends Settings where the line and cards end, past any scrollbar', () => {
    // 29 Oct 2026: placed against the window, Settings sat on Firefox's
    // 15px shelf scrollbar and ran past the line's rule and the card grid.
    expect(rule(slot, '.corner-slot')).toMatch(
      /right:\s*calc\(var\(--island-gap\)\s*\+\s*var\(--corner-scrollbar-w/
    );
  });

  it('lets the last row scroll clear of the selection bar', () => {
    // 29 Oct 2026: the floating bar covered the shelf's last rows.
    expect(rule(css, '.start-screen.is-selecting .start-body')).toMatch(
      /padding-bottom:\s*calc\(/
    );
  });
});

describe('start screen column and shelf edge', () => {
  it('runs the column flush to the window edge, without an island gap', () => {
    // 31 Oct 2026: a 10px gap and a floating island framed the column.
    expect(rule(css, '.start-screen')).toMatch(
      /grid-template-columns:\s*var\(--start-column-w\)\s+minmax\(0,\s*1fr\)/
    );
    const panel = rule(css, '.start-screen::before');
    expect(panel).not.toMatch(/margin:/);
    expect(panel).not.toMatch(/border-radius:/);
    expect(panel).toMatch(/border-right:/);
  });

  it('fades cards out under the line once the shelf scrolls', () => {
    // 31 Oct 2026: cards were sliced off on a hard edge under the tabs.
    expect(
      rule(css, '.start-section[data-scrolled] .start-toolbar::after')
    ).toMatch(/opacity:\s*1/);
  });
});

describe('workspace reveal', () => {
  it('hides the loading workspace without taking it out of layout', () => {
    // 31 Oct 2026: `display: none` here left a new project's workspace
    // blank for good, since the ready state only restores visibility.
    for (const selector of [
      '.workspace-reveal',
      ".workspace-reveal[aria-hidden='true']"
    ]) {
      const declarations = rule(css, selector);
      expect(declarations).toMatch(/visibility:\s*hidden/);
      expect(declarations).not.toMatch(/display:\s*none/);
    }
  });
});

describe('start screen card names and flags', () => {
  // 5 Nov 2026 review: series names ("PRM-0401-2026-1…") were cut to one
  // line, so they read alike; a conflict and a failed save were a bare dot
  // told apart by colour alone.
  it('gives a card name two lines', () => {
    const name = rule(css, '.start-tile-name');
    expect(name).toMatch(/-webkit-line-clamp:\s*2/);
    expect(name).toMatch(/white-space:\s*normal/);
  });

  it('keeps the warning icon on a grid card that needs a decision', () => {
    expect(css).not.toMatch(
      /\.start-tile-grid:not\(\.is-list\)\s+\.start-tile-badge\.is-(?:conflict|sync-failed)\s+svg\s*\{[^}]*display:\s*none/
    );
    expect(
      rule(
        css,
        '.start-tile-grid:not(.is-list) .start-tile-badge.is-sync-failed'
      )
    ).not.toMatch(/width:\s*8px/);
  });
});

describe('start screen shelf groups', () => {
  it('styles the Pinned and Projects labels as the column eyebrow', () => {
    // 5 Nov 2026: the groups were unlabelled, so a short Pinned row read as
    // a gap in the grid.
    const label = rule(css, '.start-group-label');
    expect(label).toMatch(/font-family:\s*var\(--font-mono\)/);
    expect(label).toMatch(/text-transform:\s*uppercase/);
    // A negative bottom margin would put a folder's 7px tab on the label.
    expect(label).toMatch(/margin:\s*0;/);
  });
});

describe('start screen shelf clip', () => {
  // 5 Nov 2026: the scroller clipped a first-row folder's tab, so a pinned
  // folder lost it, and the last column ran flush into the scrollbar.
  it('keeps a folder tab and focus rings inside the scroller', () => {
    const tab = rule(css, '.start-tile-folder::before');
    const tabHeight = Number(/height:\s*(\d+)px/.exec(tab)?.[1]);
    expect(tab).toMatch(new RegExp(`top:\\s*-${tabHeight}px`));
    const body = rule(css, '.start-body');
    const inset = Number(/--start-shelf-inset:\s*(\d+)px/.exec(body)?.[1]);
    expect(inset).toBeGreaterThan(tabHeight);
    for (const side of ['top', 'right', 'left']) {
      expect(body).toMatch(
        new RegExp(`padding-${side}:\\s*var\\(--start-shelf-inset\\)`)
      );
    }
    // The left inset is cancelled so the cards keep the toolbar's line.
    expect(body).toMatch(
      /margin-left:\s*calc\(-1\s*\*\s*var\(--start-shelf-inset\)\)/
    );
  });
});

describe('start screen review follow-ups', () => {
  // 5 Nov 2026 review of the Projects page.
  it("clips a recovery copy's date before its time", () => {
    expect(rule(css, '.start-tile-meta time')).toMatch(
      /text-overflow:\s*ellipsis/
    );
    expect(rule(css, '.start-tile-clock')).toMatch(/flex:\s*none/);
  });

  it('does not dim a recovery copy as if it were disabled', () => {
    expect(css).not.toMatch(/\.is-recovery\s+\.start-tile-name\s*\{/);
  });

  it('draws the recovery-copies count as a chip, not accent text', () => {
    const chip = rule(css, '.start-tile-copies');
    expect(chip).toMatch(/border:/);
    expect(chip).not.toMatch(/color:\s*var\(--color-accent\)/);
  });

  it('keeps the Needs attention amber for a decision', () => {
    expect(
      rule(css, '.start-filter.is-attention.is-urgent .start-filter-count')
    ).toMatch(/color:\s*var\(--color-warning\)/);
    expect(css).not.toMatch(
      /\.start-filter\.is-attention\s+\.start-filter-count\s*\{/
    );
  });

  it("puts a folder's pin beside its count in the column", () => {
    expect(rule(css, '.start-folder-link-pin')).toMatch(/margin-left:\s*auto/);
  });
});

describe('start screen first-run polish', () => {
  // UI review, 12 Nov 2026, at 1440 x 900 with no projects.
  const demos = readFileSync(
    join(resolve(__dirname, 'components'), 'start-screen-demos.css'),
    'utf8'
  ).replace(/\/\*[\s\S]*?\*\//g, '');

  it("puts the demo cards on the shelf's own edges", () => {
    // The cards started 14px left of the Projects block and ended 8px right
    // of it: the island gap on both sides, where the shelf has the stage's
    // gutter on the left and its own inset inside the gap on the right.
    const stageLeft =
      /padding:\s*0\s+var\(--island-gap\)\s+0\s+(var\(--sp-\d\))/.exec(
        rule(css, '.start-stage')
      )?.[1];
    expect(stageLeft).toBeDefined();
    const inset = /--start-shelf-inset:\s*(\d+px)/.exec(
      rule(css, '.start-body')
    )?.[1];
    expect(inset).toBeDefined();
    const padding = /padding:\s*([^;]+);/.exec(
      rule(css, '.start-screen.is-fresh .start-learn')
    )?.[1];
    expect(padding?.replace(/\s+/g, ' ')).toBe(
      `var(--sp-4) calc(var(--island-gap) + ${inset}) var(--island-gap) ${stageLeft}`
    );
  });

  it('pins Open demo to the foot of every card', () => {
    // Scissors has no revision walk, so in a three-row grid its action sat
    // in the stretching middle row, mid-card.
    const card = rule(demos, '.demo-card');
    expect(card).toMatch(/display:\s*flex/);
    expect(card).toMatch(/flex-direction:\s*column/);
    expect(rule(demos, '.demo-card-cta')).toMatch(/margin-top:\s*auto/);
  });

  it('keeps a resting pin only where pinned and unpinned cards mix', () => {
    expect(
      rule(
        css,
        '.start-tile-grid:not(.is-all-pinned) .start-tile.is-pinned .start-tile-pin'
      )
    ).toMatch(/opacity:\s*1/);
    expect(css).not.toMatch(/^\.start-tile\.is-pinned \.start-tile-pin\s*\{/m);
  });
});
