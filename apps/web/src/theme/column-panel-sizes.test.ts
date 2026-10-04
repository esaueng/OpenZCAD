import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Sizes and bounds in the right lane and the panels beside it that a 4 Oct
 * 2026 pass measured as wrong on screen, none of which a component test can
 * see: a 20×8 history thumb read as a stray dash, 8–9px rail subscripts, a
 * column of four 16px measurement icons, a Hole card that ran through the
 * orientation cube, and an activity log that covered the rail button that
 * opened it.
 */
function sheet(name: string): string {
  return readFileSync(
    resolve(__dirname, '../styles/components', name),
    'utf8'
  ).replace(/\/\*[\s\S]*?\*\//g, '');
}

/** The declarations of the first top-level rule with exactly this selector. */
function rule(css: string, selector: string): Record<string, string> {
  for (const match of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (match[1]!.trim() !== selector) continue;
    return Object.fromEntries(
      match[2]!
        .split(';')
        .map((declaration) => declaration.trim())
        .filter(Boolean)
        .map((declaration) => {
          const colon = declaration.indexOf(':');
          return [
            declaration.slice(0, colon).trim(),
            declaration
              .slice(colon + 1)
              .replace(/\s+/g, ' ')
              .trim()
          ];
        })
    );
  }
  throw new Error(`no rule for ${selector}`);
}

const px = (value: string | undefined) => Number.parseFloat(value ?? '');

describe('column and panel sizes', () => {
  it('draws the end-of-history handle as a 20px knob, not a 20×8 bar', () => {
    const handle = rule(sheet('sidebar.css'), '.history-handle');
    expect(px(handle.width)).toBeGreaterThanOrEqual(20);
    expect(px(handle.height)).toBeGreaterThanOrEqual(20);
    // Centred on its boundary, so it still sits on the line.
    expect(px(handle['margin-top'])).toBe(-px(handle.height) / 2);
  });

  it('sets the rail subscripts at the mini size', () => {
    const css = sheet('quiet-stage.css');
    expect(rule(css, '.rail-count')['font-size']).toBe('var(--fs-mini)');
    expect(rule(css, '.tweak-rail-badge')['font-size']).toBe('var(--fs-mini)');
  });

  it('lays the measurement row actions out as a row of 24px buttons', () => {
    const css = sheet('view-mode.css');
    const actions = rule(css, '.measurement-row-actions');
    expect(actions['flex-direction'] ?? 'row').toBe('row');
    const button = rule(css, '.measurement-row-actions button');
    expect(px(button.width)).toBeGreaterThanOrEqual(24);
    expect(px(button.height)).toBeGreaterThanOrEqual(24);
  });

  it('stops the right lane above the bottom-right corner', () => {
    const css = sheet('quiet-stage.css');
    expect(rule(css, '.stage-right').bottom).toContain('var(--stage-corner-h)');
    expect(px(rule(css, '.workspace.column-layout')['--stage-corner-h'])).toBe(
      96
    );
  });

  it('keeps the activity log clear of the instrument rail', () => {
    const panel = rule(sheet('status-bar.css'), '.status-log-panel');
    expect(panel.right).toBe('var(--status-log-rail-clear)');
    expect(panel['--status-log-rail-clear']).toContain('var(--rail-w)');
  });
});
