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
  it('stretches the tiles to fill their row, so no gutter is left beside the last column', () => {
    // A fixed 248px maximum left up to a tile's width of dead space beside
    // the grid (184px at a 1000px window), ragged against the search field.
    const columns = rule(sheet('start-screen.css'), '.start-tile-grid').match(
      /grid-template-columns:\s*([^;]+);/
    )?.[1];
    expect(columns).toMatch(/auto-fill/);
    expect(columns).toMatch(
      /minmax\(min\(100%, var\(--start-tile-min\)\), 1fr\)/
    );
  });

  it('lets no narrower rule pin the grid to a single full-width column', () => {
    // A phone rule forced `minmax(0, 1fr)`, doubling the tile at 560px.
    const css = sheet('start-screen.css');
    const overrides = css.match(/\.start-tile-grid\s*\{[^}]*\}/g) ?? [];
    expect(overrides).toHaveLength(1);
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

  it('aligns settings bindings and gives reference groups one consistent key track', () => {
    expect(rule(sheet('settings.css'), '.settings-control-group dl')).toMatch(
      /grid-template-columns:\s*max-content/
    );
    expect(rule(sheet('modals.css'), '.shortcuts-grid dl')).toMatch(
      /grid-template-columns:\s*minmax\(0,\s*1fr\)\s+minmax\(180px,\s*300px\)/
    );
  });
});

describe('settings pages', () => {
  it('starts every page at one left edge, beside the sections', () => {
    const css = sheet('settings.css');
    expect(rule(css, '.settings-section')).toMatch(/margin:\s*0;/);
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

describe('in-place Options panel sections', () => {
  it('hides a folded section, though its grid sets its own display', () => {
    // `.in-place-params-grid { display: grid }` beat the `hidden` attribute,
    // so a collapsed section (a gear's Tooth form) never folded shut.
    expect(
      rule(sheet('quiet-stage.css'), '.in-place-params-grid[hidden]')
    ).toMatch(/display:\s*none/);
  });
});
