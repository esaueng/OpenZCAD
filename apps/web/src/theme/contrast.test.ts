import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * The palette is measured, not eyeballed.
 *
 * The dark theme was already sound; the light one cleared only its lightest
 * surface, so a label's readability depended on which surface it happened to
 * land on. These check every text token against every surface it can sit on,
 * in both themes, so a future colour edit cannot quietly reintroduce that.
 */
const tokens = readFileSync(
  resolve(__dirname, './tokens.css'),
  'utf8'
);

function tokenBlock(selector: string): Record<string, string> {
  const start = tokens.indexOf(selector);
  const open = tokens.indexOf('{', start);
  const close = tokens.indexOf('}', open);
  const block = tokens.slice(open + 1, close);
  return Object.fromEntries(
    [...block.matchAll(/(--[\w-]+):\s*(#[0-9a-fA-F]{6})/g)].map((m) => [
      m[1]!,
      m[2]!.toLowerCase()
    ])
  );
}

function channel(value: number): number {
  const c = value / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) =>
    channel(Number.parseInt(hex.slice(i, i + 2), 16))
  ) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [
    number,
    number
  ];
  return (hi + 0.05) / (lo + 0.05);
}

const SURFACES = [
  '--color-bg',
  '--color-surface',
  '--color-surface-2',
  '--color-surface-hover'
];
const FOREGROUNDS = [
  '--color-text',
  '--color-text-muted',
  '--color-text-subtle',
  '--color-accent',
  '--color-error-text',
  '--color-warning',
  '--color-success'
];

describe.each([
  ['dark', ':root {'],
  ['light', ":root[data-theme='light'] {"]
])('%s theme contrast', (_name, selector) => {
  const palette = tokenBlock(selector);

  it('reads every token from the stylesheet', () => {
    for (const name of [...SURFACES, ...FOREGROUNDS]) {
      expect(palette[name], `${name} missing`).toMatch(/^#[0-9a-f]{6}$/);
    }
  });

  it('clears WCAG AA on every surface a label can land on', () => {
    const failures: string[] = [];
    for (const fg of FOREGROUNDS) {
      for (const bg of SURFACES) {
        const ratio = contrastRatio(palette[fg]!, palette[bg]!);
        if (ratio < 4.5) {
          failures.push(`${fg} on ${bg}: ${ratio.toFixed(2)}`);
        }
      }
    }
    expect(failures).toEqual([]);
  });

  it('keeps the focus ring visible against the surfaces it is drawn on', () => {
    // 2.4.11 wants the indicator to clear 3:1 against what it sits against.
    for (const bg of SURFACES) {
      expect(
        contrastRatio(palette['--color-accent']!, palette[bg]!)
      ).toBeGreaterThanOrEqual(3);
    }
  });
});
