import { DARK_STAGE_PALETTE, type StagePalette } from '@openzcad/viewport';

/**
 * The 3D stage's colours come from tokens.css, like the rest of the theme.
 *
 * The stylesheet resolves the Appearance setting — including 'system', which
 * it follows through a media query — so the viewer reads the resolved tokens
 * rather than deciding the theme itself. A missing or unreadable token falls
 * back to the graphite stage.
 */
const STAGE_TOKENS: Record<
  Exclude<keyof StagePalette, 'shadowOpacity'>,
  string
> = {
  backdropTop: '--color-stage-top',
  backdropMiddle: '--color-viewport-bg',
  backdropBottom: '--color-stage-bottom',
  gridMinor: '--color-stage-grid-minor',
  gridMajor: '--color-stage-grid-major'
};

/**
 * The production CSS minifier shortens `#eeeeee` to `#eee`, so the short form
 * is what the light stage actually ships. Rejecting it dropped the backdrop's
 * middle stop to the graphite fallback: a black band across the light stage.
 */
const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

function expandHex(value: string): string {
  return value.length === 4
    ? `#${[...value.slice(1)].map((digit) => digit + digit).join('')}`
    : value;
}

export function readStagePalette(element: Element): StagePalette {
  const styles = window.getComputedStyle(element);
  const palette: StagePalette = { ...DARK_STAGE_PALETTE };
  for (const [key, token] of Object.entries(STAGE_TOKENS) as [
    keyof typeof STAGE_TOKENS,
    string
  ][]) {
    const value = styles.getPropertyValue(token).trim();
    if (HEX.test(value)) palette[key] = expandHex(value);
  }
  const shadow = Number.parseFloat(
    styles.getPropertyValue('--stage-shadow-opacity')
  );
  if (Number.isFinite(shadow)) palette.shadowOpacity = shadow;
  return palette;
}

/** `--color-datum` in the dark theme, and the fallback when it is unreadable. */
const DARK_DATUM_COLOR = '#b3bed0';

/**
 * The colour committed datum planes and axes are drawn in. A steel that
 * reads on the graphite stage is too faint on the pale one, so each theme
 * sets its own `--color-datum`.
 */
export function readDatumColor(element: Element): string {
  const value = window
    .getComputedStyle(element)
    .getPropertyValue('--color-datum')
    .trim();
  return HEX.test(value) ? expandHex(value) : DARK_DATUM_COLOR;
}

/**
 * Calls `onChange` whenever the resolved theme may have changed: the
 * Appearance setting rewrites `data-theme` on the root, and under 'system'
 * the OS appearance flips the media query. Returns the unsubscribe.
 */
export function watchStageTheme(onChange: () => void): () => void {
  const root = document.documentElement;
  const observer = new MutationObserver(onChange);
  observer.observe(root, { attributes: true, attributeFilter: ['data-theme'] });
  const scheme = window.matchMedia?.('(prefers-color-scheme: light)');
  scheme?.addEventListener('change', onChange);
  return () => {
    observer.disconnect();
    scheme?.removeEventListener('change', onChange);
  };
}
