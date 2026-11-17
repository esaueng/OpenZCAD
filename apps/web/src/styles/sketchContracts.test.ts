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

/** Match the complete media block, without borrowing later rules outside it. */
function mediaBlocks(css: string, query: string) {
  const marker = `@media ${query} {`;
  const blocks: { at: number; css: string }[] = [];
  let at = css.indexOf(marker);
  while (at >= 0) {
    const start = at + marker.length;
    let end = start;
    let depth = 1;
    while (end < css.length && depth > 0) {
      if (css[end] === '{') depth++;
      if (css[end] === '}') depth--;
      end++;
    }
    if (depth !== 0) throw new Error(`Unclosed media block: ${query}`);
    blocks.push({ at, css: css.slice(start, end - 1) });
    at = css.indexOf(marker, end);
  }
  return blocks;
}

it('keeps stylesheet contracts inside their owning media block', () => {
  const blocks = mediaBlocks(
    '@media (max-height: 600px) { .other { height: 1px; } } ' +
      '.flyout { max-height: 2px; } ' +
      '@media (max-height: 600px) { .flyout { max-height: 3px; } } ' +
      '.flyout { max-height: 4px; }',
    '(max-height: 600px)'
  );
  expect(blocks).toHaveLength(2);
  expect(() => rule(blocks[0]!.css, '.flyout')).toThrow('No rule');
  expect(rule(blocks[1]!.css, '.flyout')).toMatch(/max-height:\s*3px/);
  expect(() => mediaBlocks('@media (short) { .flyout {', '(short)')).toThrow(
    'Unclosed media block'
  );
});

describe('circle type strip', () => {
  it('is one column beside the rail as wide as its tiles, bounded by the right lane', () => {
    // I37: a row of tiles ran across the middle of the canvas and took the
    // first drawing click, so the strip is a column against the rail. With
    // only a left edge it shrank to min-content; fit-content keeps each
    // tile's label whole, and the right lane still bounds it on a phone.
    const strip = rule(
      sheet('direct-manipulation.css'),
      '\n.sketch-type-strip'
    );
    expect(strip).toMatch(/flex-direction:\s*column/);
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
    const overrides = mediaBlocks(css, '(max-height: 600px)').filter((block) =>
      block.css.includes(`${selector} {`)
    );
    expect(overrides).toHaveLength(1);
    const short = overrides[0]!;
    const maxHeight =
      rule(short.css, selector).match(/max-height:\s*([^;]+);/)?.[1] ?? '';
    expect(short.at).toBeGreaterThan(css.indexOf(`${selector} {`));
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

describe('sketch state chip', () => {
  it('wraps a two-digit count inside the chip instead of overflowing it', () => {
    // "12 DOF" is wider than the 30px chip; on one line it ran out past the
    // border (13 November review recheck, I38).
    const chip = rule(
      sheet('quiet-stage.css'),
      '.workspace-column .sketch-rail button.sketch-dof-chip'
    );
    expect(chip).toMatch(/white-space:\s*normal/);
    expect(chip).not.toMatch(/white-space:\s*nowrap/);
    // Two lines fit the chip's 20px inside its border.
    expect(chip).toMatch(/height:\s*22px/);
    expect(chip).toMatch(/line-height:\s*10px/);
  });
});
