import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Sketch-mode layout rules happy-dom cannot see by rendering: it computes no
 * layout, so these read the stylesheets for the declarations that fixed each
 * defect (sketch UI review, 8 Oct 2026).
 */
const components = resolve(__dirname, 'components');

function sheet(name: string): string {
  return readFileSync(join(components, name), 'utf8').replace(
    /\/\*[\s\S]*?\*\//g,
    ''
  );
}

/** The declarations of the first rule for exactly `selector`. */
function rule(css: string, selector: string): string {
  const at = css.indexOf(`${selector} {`);
  if (at < 0) {
    throw new Error(`No rule for ${selector}`);
  }
  const open = css.indexOf('{', at);
  return css.slice(open + 1, css.indexOf('}', open));
}

describe('circle type strip', () => {
  it('is one row as wide as its tiles, bounded by the right lane', () => {
    // Positioned past the 40px rail with only a left edge, the strip shrank
    // to min-content and stacked every tile in a column. Its right edge is
    // the right lane's, so a phone wraps the tiles short of the rails.
    const strip = rule(
      sheet('direct-manipulation.css'),
      '\n.sketch-type-strip'
    );
    expect(strip).toMatch(/width:\s*fit-content/);
    expect(strip).toMatch(/right:\s*calc\([^;]*var\(--lane-end\)[^;]*\)/);
  });
});

describe('sketch flyouts', () => {
  it('end above the readout reserve, not at the window edge', () => {
    const flyouts = rule(
      sheet('quiet-stage.css'),
      '.viewer-area .workspace-column-float :is(.command-flyout, .sketch-flyouts)'
    );
    const maxHeight = flyouts.match(/max-height:\s*([^;]+);/)?.[1] ?? '';
    // Both terms stop at the column's own foot: the centred float's room
    // less the reserve, or the lifted float's height.
    expect(maxHeight).toMatch(/-\s*var\(--readout-reserve\)/);
    expect(maxHeight).not.toMatch(/\+\s*var\(--readout-reserve\)/);
    expect(maxHeight).not.toMatch(/var\(--readout-reserve\)\s*\+/);
  });

  it('run on to the window edge in a short window, where the palette needs it', () => {
    const css = sheet('quiet-stage.css');
    const selector =
      '.viewer-area .workspace-column-float :is(.command-flyout, .sketch-flyouts)';
    const short = css.slice(css.indexOf('@media (max-height: 600px)'));
    const maxHeight =
      rule(short, selector).match(/max-height:\s*([^;]+);/)?.[1] ?? '';
    expect(css.indexOf('@media (max-height: 600px)')).toBeGreaterThan(
      css.indexOf(`${selector} {`)
    );
    expect(maxHeight).toMatch(/var\(--readout-reserve\)\s*\+/);
    expect(maxHeight).not.toMatch(/-\s*var\(--readout-reserve\)/);
  });
});

describe('relations rail', () => {
  it('hides the inline names once the relations wrap into two columns', () => {
    const css = sheet('quiet-stage.css');
    const block = css.slice(
      css.indexOf('@media (max-height: 540px)'),
      css.length
    );
    expect(
      rule(block, '.instrument-rail > .sketch-relations .sketch-relation-name')
    ).toMatch(/display:\s*none/);
  });
});

describe('sketch palette and labels', () => {
  it('cases the tool readout in markup, not with text-transform', () => {
    expect(
      rule(sheet('sketch-mode.css'), '\n.sketch-workflow-context span')
    ).not.toMatch(/text-transform/);
  });

  it('rings a focused driving dimension in a viewport colour', () => {
    // The ring stands on the always-dark stage; --color-text is near-black
    // in the light theme.
    const focus = rule(
      sheet('sketch-mode.css'),
      '.sketch-dimension-label:focus-visible'
    );
    expect(focus).toMatch(/outline:\s*2px solid var\(--color-preselect\)/);
  });
});
