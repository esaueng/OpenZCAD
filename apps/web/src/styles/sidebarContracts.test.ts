import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Model-drawer layout rules the happy-dom suite cannot see by rendering: it
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

describe('collapsed History', () => {
  it('lets the collapsed rule shrink the section, with no later rule growing it back', () => {
    expect(
      rule(sheet('sidebar.css'), '\n.sidebar-section.collapsed.grow')
    ).toMatch(/flex:\s*0 0 auto/);
    // workspace-column.css loads later; an equally specific `flex: 1` there
    // kept a collapsed History filling the drawer above Revisions.
    expect(sheet('workspace-column.css')).not.toMatch(
      /\.sidebar-section\.grow\s*\{/
    );
  });
});
