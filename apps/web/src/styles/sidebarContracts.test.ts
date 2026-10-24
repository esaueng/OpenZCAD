import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Model panel layout rules the happy-dom suite cannot see by rendering: it
 * computes no layout, so these read the stylesheets for the declarations
 * that fixed each defect (sidebar and history review, 8 Oct 2026).
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

/** The body of the first `@media (hover: none)` block in a sheet. */
function touchBlock(css: string): string {
  const at = css.indexOf('@media (hover: none)');
  if (at < 0) {
    throw new Error('No @media (hover: none) block');
  }
  const open = css.indexOf('{', at);
  let depth = 1;
  let index = open + 1;
  while (depth > 0 && index < css.length) {
    if (css[index] === '{') depth += 1;
    if (css[index] === '}') depth -= 1;
    index += 1;
  }
  return css.slice(open + 1, index - 1);
}

describe('revision list', () => {
  it('gives the rows one shrinkable track, so a long name cannot widen them all', () => {
    // An implicit `auto` track sized itself to the longest nowrap reason and
    // carried every row's date and Restore/Branch out of the drawer.
    expect(rule(sheet('revisions.css'), '\n.revision-list')).toMatch(
      /grid-template-columns:\s*minmax\(0, 1fr\)/
    );
  });

  it('shows Restore and Branch on touch screens, where nothing hovers', () => {
    expect(touchBlock(sheet('revisions.css'))).toMatch(
      /\.revision-actions\s*\{\s*opacity:\s*1;/
    );
  });
});

describe('body rows on touch screens', () => {
  it('shows the visibility toggle over the later single-class rule that hides it', () => {
    // viewport-overlays.css loads after sidebar.css and sets
    // `.row-visibility { opacity: 0 }`; a one-class override here loses.
    expect(touchBlock(sheet('sidebar.css'))).toMatch(
      /\.body-row \.row-visibility\s*\{\s*opacity:\s*1;/
    );
  });
});

describe('model panels', () => {
  const stage = sheet('quiet-stage.css');

  it('runs the docks the full height, the corners at their inner edges', () => {
    // The layer is the whole viewer area (a window goes anywhere on it);
    // its padding is the docks' band, down to the window's foot.
    const layer = rule(stage, '\n.panel-dock-layer');
    expect(layer).toMatch(/inset:\s*0/);
    expect(layer).toMatch(/padding-top:\s*var\(--stage-top\)/);
    expect(layer).toMatch(/padding-bottom:\s*var\(--island-gap\)/);
    // So nothing in the bottom corners is ever under a docked panel: the
    // cube (with the ruler on it) stands inside the instrument rail at the
    // right dock's edge, and the readout at the left dock's.
    expect(
      rule(
        stage,
        '\n.workspace.column-layout .viewer-rail-stack,\n.workspace.column-layout .viewer-area.has-inspector .viewer-rail-stack'
      )
    ).toMatch(
      /right:\s*calc\(var\(--lane-end\) - var\(--right-peek-w, 0px\)\)/
    );
    expect(rule(stage, '\n.viewport-readout')).toMatch(
      /left:\s*calc\(var\(--island-gap\) \+ var\(--left-dock-w, 0px\)\)/
    );
    // The unpinned slot still stops above the corner, as the right lane does.
    expect(rule(stage, '\n.panel-unpinned')).toMatch(
      /bottom:\s*calc\(var\(--stage-corner-h\) \+ var\(--island-gap\)\)/
    );
  });

  it('scrolls a column that cannot give every panel its minimum', () => {
    expect(rule(stage, '\n.panel-column.is-scrolling')).toMatch(
      /overflow-y:\s*auto/
    );
    // Not scrolling, the column clips; the panels themselves scroll inside.
    expect(rule(stage, '\n.panel-column')).toMatch(/overflow:\s*hidden/);
    expect(rule(stage, '\n.model-panel-body')).toMatch(/overflow-y:\s*auto/);
  });

  it('keeps touch scrolling off the gaps and headers', () => {
    expect(rule(stage, '\n.panel-gap')).toMatch(/touch-action:\s*none/);
    expect(rule(stage, '\n.panel-gap')).toMatch(/cursor:\s*row-resize/);
    expect(rule(stage, '\n.model-panel-header')).toMatch(
      /touch-action:\s*none/
    );
  });

  it('fits the taller rail in one column down to 541px by compacting it', () => {
    // Revisions and Diagnostics made one column 522px tall. Side by side
    // from 600px instead, the islands squeezed a 320 × 568 phone's sketch
    // flyouts to 68px; the buttons give up 4px each there instead.
    const block = stage.slice(
      stage.indexOf('@media (min-height: 541px) and (max-height: 600px)')
    );
    expect(
      rule(block, '.workspace.column-layout .instrument-rail .rail-button')
    ).toMatch(/height:\s*26px/);
    expect(stage).toContain(
      '@media (max-height: 540px) {\n  .workspace.column-layout .instrument-rail {'
    );
  });

  it('moves the rail to the dock’s inner edge and the lanes past both', () => {
    expect(rule(stage, '\n.instrument-rail')).toMatch(
      /right:\s*calc\(var\(--island-gap\) \+ var\(--right-dock-w, 0px\)\)/
    );
    // Every definition of the lane's end counts the dock and the unpinned
    // panel, so the inspector and the overlays that keep clear of the lane
    // never sit under a panel.
    const ends = [...stage.matchAll(/--lane-end:\s*calc\(([^;]*)\);/g)];
    expect(ends.length).toBeGreaterThan(2);
    for (const [, value] of ends) {
      expect(value).toContain('var(--right-panels-w)');
    }
    expect(rule(stage, '\n.panel-unpinned')).toMatch(
      /right:\s*calc\(var\(--lane-end\) - var\(--right-peek-w, 0px\)\)/
    );
  });

  it('stands the verb rail on the left dock’s inner edge and starts the bottom lanes past it', () => {
    expect(rule(stage, '\n.workspace-column-float')).toMatch(
      /left:\s*calc\(var\(--island-gap\) \+ var\(--left-dock-w, 0px\)\)/
    );
    expect(stage).toMatch(
      /--lane-inset:\s*calc\(var\(--lane-start\) \+ var\(--left-dock-w, 0px\)\);/
    );
    // Only the lane-start is redefined elsewhere, so no rule drops the dock.
    expect([...stage.matchAll(/--lane-inset:/g)]).toHaveLength(1);
    expect(rule(stage, '.workspace.column-layout .sidebar-resizer')).toContain(
      'var(--left-dock-w, 0px)'
    );
  });

  // The rail arrives in a lazy chunk, and a :has() asked of the workspace
  // about it was missed on insertion: the rail stood in a 232px island
  // until a reload. The class AppShell sets is what sizes the column.
  it('sizes the column as a rail from the class AppShell sets, not a :has() on the workspace', () => {
    expect(rule(stage, '\n.workspace.column-layout.has-column')).toMatch(
      /--column-w:\s*var\(--rail-w\);/
    );
    expect(
      rule(
        stage,
        '\n.workspace.has-column .viewer-area .workspace-column-float'
      )
    ).toMatch(/top:\s*var\(--stage-middle\);/);
    expect(stage).not.toMatch(
      /:has\(\s*\.workspace-column-float :is\(\.command-rail/
    );
  });
});
