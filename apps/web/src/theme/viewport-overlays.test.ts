import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The light theme repaints the chrome and leaves the viewport dark, so any
 * overlay that paints its own dark stage and then reads `--color-text` goes
 * dark-on-dark the moment the theme flips: the rotate-view icons, the scale
 * bar and the topology pick list all vanished that way. Those overlays read
 * the viewport text tokens instead, and those tokens never re-theme.
 */
const tokens = readFileSync(resolve(__dirname, './tokens.css'), 'utf8');

const OVERLAY_SHEETS = [
  'viewer.css',
  'viewport-overlays.css',
  'sketch-mode.css',
  'direct-manipulation.css'
];

/** Literal dark stages an overlay paints for itself, independent of theme. */
const DARK_STAGE =
  /background:\s*(rgba?\(\s*(?:7|8|11|12|14|17)\s*,[^)]*\)|#0[0-9a-f]{5})/;

function ruleBlocks(css: string): { selector: string; body: string }[] {
  const blocks: { selector: string; body: string }[] = [];
  const pattern = /([^{}]+)\{([^{}]*)\}/g;
  for (const match of css.matchAll(pattern)) {
    blocks.push({ selector: match[1]!.trim(), body: match[2]! });
  }
  return blocks;
}

function tokenBlock(selector: string): string {
  const start = tokens.indexOf(selector);
  const open = tokens.indexOf('{', start);
  return tokens.slice(open + 1, tokens.indexOf('}', open));
}

describe('viewport overlay text tokens', () => {
  it('defines the viewport text tokens once, outside the light theme', () => {
    const root = tokenBlock(':root {');
    const light = tokenBlock(":root[data-theme='light'] {");
    expect(root).toMatch(/--color-viewport-text:\s*#/);
    expect(root).toMatch(/--color-viewport-text-muted:\s*#/);
    expect(light).not.toMatch(/--color-viewport-text/);
  });

  it('never reads themed text tokens on a hard-coded dark stage', () => {
    const offenders: string[] = [];
    for (const sheet of OVERLAY_SHEETS) {
      const css = readFileSync(
        resolve(__dirname, '../styles/components', sheet),
        'utf8'
      );
      for (const { selector, body } of ruleBlocks(css)) {
        if (!DARK_STAGE.test(body)) continue;
        if (/(^|[^-])color:\s*var\(--color-text/m.test(body)) {
          offenders.push(`${sheet}: ${selector}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('never draws a themed border on a hard-coded dark stage', () => {
    // --color-border is a light grey in the light theme; on a dark overlay it
    // read as a pale ring. Overlays take their border from the viewport set.
    const offenders: string[] = [];
    for (const sheet of OVERLAY_SHEETS) {
      const css = readFileSync(
        resolve(__dirname, '../styles/components', sheet),
        'utf8'
      );
      for (const { selector, body } of ruleBlocks(css)) {
        if (!DARK_STAGE.test(body)) continue;
        if (
          /border(-color)?:\s*(var\(--border-(thin|strong)\)|1px solid var\(--color-border)/m.test(
            body
          )
        ) {
          offenders.push(`${sheet}: ${selector}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
