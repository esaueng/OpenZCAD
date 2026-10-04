/**
 * Glyph measurements the text e2e specs compare the live app against.
 *
 * Playwright's loader cannot import the font pipeline (opentype.js is CommonJS
 * and the loader expects ESM named exports), so the numbers are recorded here
 * and `test/text-e2e-glyphs.test.ts` recomputes them from the same pipeline
 * on every root run: a font or layout change that moves them fails there,
 * not as a mysterious e2e miss.
 */

/** Open Sans regular, em size 10: the regions' exact area, holes subtracted. */
export const OPEN_SANS_AREA_AT_10: Readonly<Record<'Boa' | 'Boat', number>> = {
  Boa: 39.397251605987535,
  Boat: 46.8535671631495
};

/**
 * The midpoint of the left stem of an Open Sans `B` at em size 10, in the
 * text's own frame (baseline origin, unrotated): a point on the drawn
 * outline, so a click there picks the text object.
 */
export const OPEN_SANS_B_STEM_AT_10 = { x: 0.9765625, y: 3.5693359375 };

/** `local` in the frame of a text object at (`x`, `y`) turned `rotation`°. */
export function textFramePoint(
  object: { x: unknown; y: unknown; rotation?: unknown },
  local: { x: number; y: number }
): { x: number; y: number } {
  const turn = (Number(object.rotation ?? 0) * Math.PI) / 180;
  return {
    x: Number(object.x) + local.x * Math.cos(turn) - local.y * Math.sin(turn),
    y: Number(object.y) + local.x * Math.sin(turn) + local.y * Math.cos(turn)
  };
}
