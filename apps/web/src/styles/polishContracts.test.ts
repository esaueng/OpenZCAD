import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Layout rules the happy-dom suite cannot see by rendering: it computes no
 * layout, so these read the stylesheets for the declarations that fixed each
 * defect (UI polish pass, 4 Oct 2026).
 */
const components = resolve(__dirname, 'components');

function sheet(name: string): string {
  return readFileSync(join(components, name), 'utf8').replace(
    /\/\*[\s\S]*?\*\//g,
    ''
  );
}

/** The declarations of the first top-level rule for exactly `selector`. */
function rule(css: string, selector: string): string {
  const at = css.indexOf(`\n${selector} {`);
  if (at < 0) {
    throw new Error(`No rule for ${selector}`);
  }
  const open = css.indexOf('{', at);
  return css.slice(open + 1, css.indexOf('}', open));
}

describe('start shelf grid', () => {
  it('gives every tile a definite maximum, so a column never stretches the cards', () => {
    // `minmax(236px, 1fr)` stretched each tile to fill its row, so adding or
    // dropping a column swung the card size by a quarter or more.
    const columns = rule(sheet('start-screen.css'), '.start-tile-grid').match(
      /grid-template-columns:\s*([^;]+);/
    )?.[1];
    expect(columns).toMatch(/auto-fill/);
    expect(columns).not.toMatch(/\dfr\b/);
  });

  it('puts the part picture on a surface token, not the viewport stage', () => {
    const thumb = rule(sheet('start-screen.css'), '.start-tile-thumb');
    expect(thumb).toMatch(/background:\s*var\(--color-bg\)/);
    expect(thumb).not.toMatch(/--color-viewport-bg/);
  });
});

describe('chrome text floor', () => {
  it('sizes the File menu sublabels explicitly instead of inheriting "smaller"', () => {
    expect(rule(sheet('topbar.css'), '.topbar-menu-item small')).toMatch(
      /font-size:\s*var\(--fs-mini\)/
    );
  });
});

describe('keycaps', () => {
  it('never wraps inside a keycap on the Shortcuts page or in the overlay', () => {
    const page = rule(sheet('settings.css'), '.settings-control-keys kbd');
    const overlay = rule(sheet('modals.css'), '.shortcut-key-sequence kbd');
    for (const kbd of [page, overlay]) {
      expect(kbd).toMatch(/white-space:\s*nowrap/);
      expect(kbd).not.toMatch(/overflow-wrap:\s*anywhere/);
    }
  });

  it('shares one key column per group so labels line up beside one-line bindings', () => {
    expect(rule(sheet('settings.css'), '.settings-control-group dl')).toMatch(
      /grid-template-columns:\s*max-content/
    );
    expect(rule(sheet('modals.css'), '.shortcuts-grid dl')).toMatch(
      /grid-template-columns:\s*max-content/
    );
  });
});

describe('settings pages', () => {
  it('centres every page in one frame, so each starts at the same left edge', () => {
    const css = sheet('settings.css');
    expect(rule(css, '.settings-section')).toMatch(/margin:\s*0 auto/);
    // A wide page used to centre itself at its own width.
    expect(css).not.toMatch(/\.settings-section\.settings-section-wide\s*{/);
    expect(rule(css, '.settings-content')).toMatch(
      /scrollbar-gutter:\s*stable/
    );
  });
});

describe('theme switch', () => {
  it('turns transitions off while the palette changes', () => {
    expect(sheet('motion.css')).toMatch(
      /:root\[data-theme-switching\] \*[\s\S]*?transition:\s*none !important/
    );
  });

  it('never transitions every property', () => {
    for (const name of readdirSync(components)) {
      if (name.endsWith('.css')) {
        expect(sheet(name), name).not.toMatch(
          /transition(-property)?:\s*all\b/
        );
      }
    }
  });
});
