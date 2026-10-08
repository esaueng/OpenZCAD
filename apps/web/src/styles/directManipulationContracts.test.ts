import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Stacking and focus rules for the viewport's direct-manipulation overlays.
 * happy-dom computes no stacking or layout, so these read the declarations
 * that fixed each defect.
 */
const components = resolve(__dirname, 'components');

function sheet(name: string): string {
  return readFileSync(join(components, name), 'utf8').replace(
    /\/\*[\s\S]*?\*\//g,
    ''
  );
}

/**
 * The declarations of the first rule whose whole selector is `selector`, not
 * one that only lists it among others.
 */
function rule(css: string, selector: string): string {
  for (const match of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (match[1]!.trim() === selector) {
      return match[2]!;
    }
  }
  throw new Error(`No rule for ${selector}`);
}

function zIndexOffset(body: string): number {
  const value = body.match(/z-index:\s*([^;]+);/)?.[1] ?? '';
  const offset = value.match(/var\(--z-viewer-overlay\)\s*\+\s*(\d+)/)?.[1];
  if (offset === undefined) {
    throw new Error(`Unexpected z-index ${value}`);
  }
  return Number(offset);
}

describe('CSS2D label layer', () => {
  it('holds every label but the selection chip under the overlay cards', () => {
    // CSS2DRenderer writes each label an inline z-index of 1..N by depth, so
    // with three labels on screen a measurement pill painted over the Measure
    // dock (z 2), and with six over the pick list and the keypad.
    const viewer = readFileSync(
      resolve(__dirname, '../components/ModelViewer.tsx'),
      'utf8'
    );
    expect(viewer).toMatch(
      /labelRenderer\.domElement\.classList\.add\('viewer-label-layer'\)/
    );
    const body = rule(
      sheet('viewport-overlays.css'),
      '.viewer-label-layer > :not(.selection-callout-chip)'
    );
    // Important: the renderer rewrites the inline value every frame. One is
    // below --z-viewer-overlay (2), the lowest overlay card.
    expect(body).toMatch(/z-index:\s*1\s*!important;/);
    const tokens = readFileSync(
      resolve(__dirname, '../theme/tokens.css'),
      'utf8'
    );
    expect(
      Number(tokens.match(/--z-viewer-overlay:\s*(\d+);/)?.[1])
    ).toBeGreaterThan(1);
  });
});

describe('sketch snap marker', () => {
  it('stands above the centre target, so its label is not struck through', () => {
    const css = sheet('direct-manipulation.css');
    expect(zIndexOffset(rule(css, '.sketch-snap-marker'))).toBeGreaterThan(
      zIndexOffset(rule(css, '.sketch-center-target'))
    );
  });
});

describe('handle chip focus', () => {
  it('rings the Ø/R prefix rather than only recolouring it', () => {
    const body = rule(
      sheet('direct-manipulation.css'),
      '.handle-dimension-prefix:focus-visible'
    );
    expect(body).toMatch(/outline:\s*2px solid/);
    expect(body).not.toMatch(/outline:\s*none/);
  });
});
