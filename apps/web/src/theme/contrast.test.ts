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

/** `color-mix(in srgb, a weight, b)`: a straight blend of the encoded channels. */
function mix(a: string, b: string, weight: number): string {
  return `#${[1, 3, 5]
    .map((i) => {
      const value =
        Number.parseInt(a.slice(i, i + 2), 16) * weight +
        Number.parseInt(b.slice(i, i + 2), 16) * (1 - weight);
      return Math.round(value).toString(16).padStart(2, '0');
    })
    .join('')}`;
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
  it('keeps the History repair chip and the first-failure row legible on their warning tints', () => {
    // sidebar.css: the chip is --color-warning on a 13% warning mix of the
    // surface (its hover adds an edge, not a deeper tint, which the light
    // theme's warning would not clear); the first failure's row is a 9% mix
    // under its name and value.
    for (const [fg, weight] of [
      ['--color-warning', 0.13],
      ['--color-text', 0.09],
      ['--color-text-muted', 0.09]
    ] as const) {
      const tint = mix(
        palette['--color-warning']!,
        palette['--color-surface']!,
        weight
      );
      expect(
        contrastRatio(palette[fg]!, tint),
        `${fg} on ${weight * 100}% warning`
      ).toBeGreaterThanOrEqual(4.5);
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

/**
 * The compact workspace (U12) repaints the shell under
 * `[data-shell='compact']`. Its tokens are declared on the shell element and
 * cascade over the theme's own, so each palette is the theme's :root tokens
 * with the compact blocks laid over them in the order the cascade applies
 * them: anything compact leaves alone (the error text, say) keeps its theme
 * value and is measured against the compact surfaces too.
 */
const COMPACT = "[data-shell='compact'] {";
const COMPACT_LIGHT = ":root[data-theme='light'] [data-shell='compact'] {";

function rgbaTokens(selector: string): Record<string, number[]> {
  const start = tokens.indexOf(selector);
  const open = tokens.indexOf('{', start);
  const block = tokens.slice(open + 1, tokens.indexOf('}', open));
  return Object.fromEntries(
    [
      ...block.matchAll(
        /(--[\w-]+):\s*rgba\((\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\)/g
      )
    ].map((m) => [m[1]!, m.slice(2, 6).map(Number)])
  );
}

/** An `rgba()` fill laid over an opaque ground. */
function over(fill: number[], ground: string): string {
  const [r, g, b, alpha] = fill as [number, number, number, number];
  return `#${[r, g, b]
    .map((value, index) => {
      const base = Number.parseInt(
        ground.slice(1 + index * 2, 3 + index * 2),
        16
      );
      return Math.round(value * alpha + base * (1 - alpha))
        .toString(16)
        .padStart(2, '0');
    })
    .join('')}`;
}

describe.each([
  ['dark', [':root {', COMPACT]],
  ['light', [':root {', ":root[data-theme='light'] {", COMPACT, COMPACT_LIGHT]]
])('compact %s contrast', (_name, selectors) => {
  // Later blocks win, as they do in the cascade.
  const palette = Object.fromEntries(
    selectors.flatMap((selector) => Object.entries(tokenBlock(selector)))
  );
  const fills = Object.fromEntries(
    selectors.flatMap((selector) => Object.entries(rgbaTokens(selector)))
  );
  const compact = {
    ...tokenBlock(COMPACT),
    ...(selectors.includes(COMPACT_LIGHT) ? tokenBlock(COMPACT_LIGHT) : {})
  };

  it('repaints every surface and text token it is measured on', () => {
    // Otherwise the compact checks would quietly measure the regular theme.
    for (const name of [
      ...SURFACES,
      ...FOREGROUNDS.filter((token) => token !== '--color-error-text'),
      '--color-text-dim',
      '--color-on-accent',
      '--color-selected-text',
      '--color-cut'
    ]) {
      expect(compact[name], `${name} not re-declared`).toMatch(
        /^#[0-9a-f]{6}$/
      );
    }
  });

  it('clears WCAG AA for text on every surface', () => {
    const failures: string[] = [];
    for (const fg of FOREGROUNDS) {
      for (const bg of SURFACES) {
        const ratio = contrastRatio(palette[fg]!, palette[bg]!);
        if (ratio < 4.5) failures.push(`${fg} on ${bg}: ${ratio.toFixed(2)}`);
      }
    }
    expect(failures).toEqual([]);
  });

  it('clears 3:1 for the focus ring, dim marks and the cut hue on every surface', () => {
    const failures: string[] = [];
    for (const fg of ['--color-accent', '--color-text-dim', '--color-cut']) {
      for (const bg of SURFACES) {
        const ratio = contrastRatio(palette[fg]!, palette[bg]!);
        if (ratio < 3) failures.push(`${fg} on ${bg}: ${ratio.toFixed(2)}`);
      }
    }
    expect(failures).toEqual([]);
  });

  it('labels the primary action and the tinted selection at WCAG AA', () => {
    expect(
      contrastRatio(palette['--color-on-accent']!, palette['--color-accent']!)
    ).toBeGreaterThanOrEqual(4.5);
    const fill = fills['--color-selected-fill'];
    expect(fill).toBeDefined();
    for (const surface of SURFACES) {
      expect(
        contrastRatio(
          palette['--color-selected-text']!,
          over(fill!, palette[surface]!)
        ),
        surface
      ).toBeGreaterThanOrEqual(4.5);
      // Primary text stays readable on a selected row too.
      expect(
        contrastRatio(palette['--color-text']!, over(fill!, palette[surface]!)),
        surface
      ).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('keeps the History repair chip and the first-failure row legible on their warning tints', () => {
    for (const [fg, weight] of [
      ['--color-warning', 0.13],
      ['--color-text', 0.09],
      ['--color-text-muted', 0.09]
    ] as const) {
      const tint = mix(
        palette['--color-warning']!,
        palette['--color-surface']!,
        weight
      );
      expect(
        contrastRatio(palette[fg]!, tint),
        `${fg} on ${weight * 100}% warning`
      ).toBeGreaterThanOrEqual(4.5);
    }
  });
});
