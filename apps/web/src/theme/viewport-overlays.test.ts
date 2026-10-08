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
  'view-mode.css',
  'viewer.css',
  'viewport-overlays.css',
  'sketch-mode.css',
  'direct-manipulation.css'
];

/**
 * Literal dark stages an overlay paints for itself, independent of theme: any
 * rgb()/rgba() whose red channel is under 40, or a hex under #300000. An
 * enumerated list of channel values here missed the Move instruction's
 * rgba(24, …) stage, which then read --color-text in the light theme.
 */
const DARK_STAGE =
  /background:\s*(rgba?\(\s*(?:[0-9]|[1-3][0-9])\s*,[^)]*\)|#[0-2][0-9a-f]{5})/;

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

  it('paints the right-lane command cards as chrome, never a dark stage', () => {
    // The Move panel and the closed-profile action ride the lane with the
    // other command cards and hold themed headers, fields and buttons; on a
    // fixed dark stage those went dark-on-dark in the light theme.
    const css = readFileSync(
      resolve(__dirname, '../styles/components/sketch-mode.css'),
      'utf8'
    );
    for (const selector of ['.extrude-controller', '.profile-quick-action']) {
      const block = ruleBlocks(css.replace(/\/\*[\s\S]*?\*\//g, '')).find(
        (rule) => rule.selector === selector
      );
      expect(block, selector).toBeDefined();
      expect(block!.body, selector).toMatch(
        /background:\s*var\(--color-surface/
      );
    }
  });

  it('paints the viewport HUD in viewport hues, never re-themed chrome ones', () => {
    // These paint on the always-dark stage, but the light theme darkens the
    // accents, the success green and the amber, and turns the surfaces and
    // text light: the Total/Offset tag went light grey beside its dark value
    // chip, and the snap glyph and the "catching up" dot fell under 3:1. The
    // viewport set (--color-select, --color-preselect, --color-preview,
    // --color-viewport-*) holds the dark values and never re-themes. Scoped
    // to the HUD whose rules live in direct-manipulation.css.
    const offenders: string[] = [];
    for (const sheet of OVERLAY_SHEETS) {
      const css = readFileSync(
        resolve(__dirname, '../styles/components', sheet),
        'utf8'
      ).replace(/\/\*[\s\S]*?\*\//g, '');
      for (const { selector, body } of ruleBlocks(css)) {
        if (!subjects(selector).some((subject) => HUD_SUBJECT.test(subject))) {
          continue;
        }
        if (CHROME_HUE.test(body)) {
          offenders.push(`${sheet}: ${selector}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});

/** HUD elements drawn on the viewport's dark stage. */
const HUD_SUBJECT =
  /\.(handle-value-chip|handle-label-chip|handle-dimension-prefix|sketch-snap-marker|sketch-center-(target|axis)|sketch-dim-label|sketch-grab-handle|sketch-rotate-ring|sketch-grid-indicator|snap-glyph|selection-band|selection-callout-verb|topology-pick-list[\w-]*)\b/;

/** Chrome tokens the light theme repaints. */
const CHROME_HUE =
  /var\(--(color-(accent|success|warning|error|surface|text|border)[\w-]*|border-(thin|strong))\)/;

/**
 * The element each selector in a list styles: its last compound selector.
 * `.viewer-shell:has(.handle-value-chip) .selection-callout` styles a callout,
 * not the chip it mentions.
 */
function subjects(selectorList: string): string[] {
  const selectors: string[] = [];
  let depth = 0;
  let current = '';
  for (const char of selectorList) {
    depth += char === '(' ? 1 : char === ')' ? -1 : 0;
    if (char === ',' && depth === 0) {
      selectors.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  selectors.push(current);
  return selectors.map((selector) => {
    let last = '';
    let level = 0;
    for (const char of selector.trim()) {
      level += char === '(' ? 1 : char === ')' ? -1 : 0;
      last = level === 0 && /[\s>+~]/.test(char) ? '' : last + char;
    }
    return last;
  });
}
