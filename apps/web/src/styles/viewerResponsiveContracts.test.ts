import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The right edge of the stage in short windows: the instrument rail, the
 * orientation cube under it and the status row beside the cube. happy-dom
 * computes no layout, so these read the declarations that keep each one
 * clickable (viewer chrome review, 8 Oct 2026). The live layouts are covered
 * by the e2e reach specs; this pins the rules they depend on.
 */
const components = resolve(__dirname, 'components');

function sheet(name: string): string {
  return readFileSync(join(components, name), 'utf8').replace(
    /\/\*[\s\S]*?\*\//g,
    ''
  );
}

/** The body of the block that opens right after `at`, braces balanced. */
function blockAfter(css: string, at: number): string {
  const open = css.indexOf('{', at);
  let depth = 0;
  for (let index = open; index < css.length; index += 1) {
    if (css[index] === '{') depth += 1;
    if (css[index] === '}') {
      depth -= 1;
      if (depth === 0) return css.slice(open + 1, index);
    }
  }
  throw new Error('Unbalanced block');
}

/** Every top-level (or in-block) rule whose selector list is exactly this. */
function rules(css: string, selector: string): string[] {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(
    `(?:^|[}\\n])\\s*${escaped}\\s*\\{([^}]*)\\}`,
    'g'
  );
  return Array.from(css.matchAll(pattern), (match) => match[1]!);
}

function media(css: string, query: string): string {
  const at = css.indexOf(`@media ${query}`);
  if (at < 0) {
    throw new Error(`No @media ${query}`);
  }
  return blockAfter(css, at);
}

const CUBE =
  '.workspace.column-layout .viewer-rail-stack,\n  .workspace.column-layout .viewer-area.has-inspector .viewer-rail-stack';

describe('the instrument rail over the cube', () => {
  const css = sheet('quiet-stage.css');

  it('lets only its islands take the pointer, never the box around them', () => {
    // Side by side at 540px and shorter, the box's empty corner under the
    // Model panels island sat on the cube and swallowed every facet's click.
    expect(rules(css, '.instrument-rail').join('\n')).toMatch(
      /pointer-events:\s*none/
    );
    expect(rules(css, '.instrument-rail > *').join('\n')).toMatch(
      /pointer-events:\s*auto/
    );
  });

  it('lifts off the bottom-right corner instead of staying centred on it', () => {
    const rail = rules(css, '.workspace.column-layout .instrument-rail')[0]!;
    expect(rail).toMatch(/--rail-band-room:[^;]*var\(--stage-corner-h\)/);
    // Centred while it fits (-50%), lifted past that, never above the top
    // islands (the max() clamp on the stage's top).
    expect(rail).toMatch(
      /transform:\s*translateY\(\s*max\(\s*calc\(\(var\(--stage-top\)[\s\S]*min\(-50%,\s*calc\(var\(--rail-band-room\) - 100%\)\)/
    );
  });

  it('steps the cube left past the rail where even the lifted rail reaches it', () => {
    const block = media(
      css,
      '(max-width: 960px) and (max-height: 657px),\n  (max-width: 520px) and (max-height: 703px)'
    );
    expect(block).toContain(CUBE);
    expect(block).toMatch(/right:\s*var\(--lane-end\)/);
  });

  it('stands the cube above the status row wherever the row runs under it', () => {
    // On a phone the row spans the width; the toast took the bottom facet.
    const phone = media(css, '(max-width: 520px)');
    expect(phone).toMatch(/--stage-corner-h:[^;]*var\(--status-row-h\)/);
    const phoneCube = phone.slice(phone.indexOf(CUBE));
    expect(phoneCube).toMatch(/bottom:[^;]*var\(--status-row-h\)/);
    // Off the corner, narrow and short, the cube is nearer the row's centre.
    const narrow = media(
      css,
      '(min-width: 521px) and (max-width: 960px) and (max-height: 657px)'
    );
    expect(narrow).toMatch(/--stage-corner-h:[^;]*var\(--status-row-h\)/);
    expect(narrow.slice(narrow.indexOf(CUBE))).toMatch(
      /bottom:[^;]*var\(--status-row-h\)/
    );
  });
});

describe('the first-run tour', () => {
  it('outlines its target inside the edge, where no overflow clips it', () => {
    // The tool rail is exactly as large as its scrollers; an outline drawn
    // outside it was clipped away.
    expect(rules(sheet('tour.css'), '.tour-target').join('\n')).toMatch(
      /outline-offset:\s*-\d/
    );
  });
});
