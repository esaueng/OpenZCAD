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
const tokens = readFileSync(resolve(__dirname, './tokens.css'), 'utf8');

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
  it('keeps numeric-entry and viewport labels legible on their actual surfaces', () => {
    expect(
      contrastRatio(
        palette['--color-text-muted']!,
        palette['--color-surface-2']!
      )
    ).toBeGreaterThanOrEqual(4.5);
    expect(
      contrastRatio(palette['--color-text-muted']!, palette['--color-surface']!)
    ).toBeGreaterThanOrEqual(4.5);
    expect(
      contrastRatio(palette['--color-text']!, palette['--color-surface-2']!)
    ).toBeGreaterThanOrEqual(4.5);
    expect(
      contrastRatio(palette['--color-on-accent']!, palette['--color-accent']!)
    ).toBeGreaterThanOrEqual(4.5);
  });
});

describe.each([
  ['dark', ':root {'],
  ['light', ":root[data-theme='light'] {"]
])('%s stage', (_name, selector) => {
  // The stage re-themes with the chrome (lib/stagePalette.ts paints the
  // WebGL backdrop from these), and whatever is drawn straight on it — the
  // scale bar, the snap refusal — reads the stage ink, which must clear the
  // whole backdrop gradient.
  const palette = { ...tokenBlock(':root {'), ...tokenBlock(selector) };

  it('keeps the stage ink legible across the backdrop gradient', () => {
    for (const ground of [
      '--color-stage-top',
      '--color-viewport-bg',
      '--color-stage-bottom'
    ]) {
      expect(palette[ground], ground).toMatch(/^#[0-9a-f]{6}$/);
      expect(
        contrastRatio(palette['--color-stage-ink']!, palette[ground]!),
        ground
      ).toBeGreaterThanOrEqual(7);
      expect(
        contrastRatio(palette['--color-stage-ink-muted']!, palette[ground]!),
        ground
      ).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('draws grid lines that separate from the stage', () => {
    for (const line of [
      '--color-stage-grid-minor',
      '--color-stage-grid-major'
    ]) {
      expect(
        contrastRatio(palette[line]!, palette['--color-viewport-bg']!),
        line
      ).toBeGreaterThanOrEqual(1.4);
    }
  });
});

describe.each([
  ['dark', ':root {'],
  ['light', ":root[data-theme='light'] {"]
])('%s selected fill', (_name, selector) => {
  // The selected fill is translucent, so the label is measured against the
  // fill laid over each surface a rail, the mode switch or a panel puts it
  // on.
  const block = tokens.slice(tokens.indexOf(selector));
  const palette = tokenBlock(selector);
  const fill =
    /--color-selected-fill:\s*rgba\((\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\)/.exec(
      block
    );

  it('labels the selection at WCAG AA on every surface', () => {
    expect(fill).not.toBeNull();
    const [r, g, b, alpha] = fill!.slice(1).map(Number) as [
      number,
      number,
      number,
      number
    ];
    for (const surface of SURFACES) {
      const ground = palette[surface]!;
      const over = [r, g, b]
        .map((channel, index) => {
          const base = Number.parseInt(
            ground.slice(1 + index * 2, 3 + index * 2),
            16
          );
          return Math.round(channel * alpha + base * (1 - alpha))
            .toString(16)
            .padStart(2, '0');
        })
        .join('');
      expect(
        contrastRatio(palette['--color-selected-text']!, `#${over}`),
        surface
      ).toBeGreaterThanOrEqual(4.5);
    }
  });
});

describe('destructive confirm', () => {
  it('labels the danger fill at WCAG AA in both themes', () => {
    // Defined once on :root and not re-themed. White on the error red was
    // 3.8:1 on the delete-feature and cloud-deletion confirm buttons.
    const palette = tokenBlock(':root {');
    expect(palette['--color-on-danger']).toBeDefined();
    expect(
      contrastRatio(
        palette['--color-on-danger']!,
        palette['--color-danger-fill']!
      )
    ).toBeGreaterThanOrEqual(4.5);
    expect(tokenBlock(":root[data-theme='light'] {")).not.toHaveProperty(
      '--color-danger-fill'
    );
  });
});
