/**
 * The step a fillet or chamfer drag snaps to, in shown units.
 *
 * Steps are round numbers as the value is read (whole millimetres at an
 * ordinary zoom or further out, tenths once the part is close), chosen as the finest that
 * still moves the arrow at least {@link MIN_BLEND_STEP_PX} on screen, so the
 * value steps in numbers worth typing rather than flickering through tenths
 * a pixel apart. A held free-value modifier skips the snap.
 */
export const BLEND_DRAG_STEPS = [0.01, 0.05, 0.1, 0.5] as const;

/**
 * Taken when no finer step spans enough of the screen. Never coarser: with
 * the part far away a small blend still steps from 1 mm rather than
 * rounding to none.
 */
export const COARSEST_BLEND_STEP = 1;

/** Screen pixels one step must span. */
export const MIN_BLEND_STEP_PX = 3;

/**
 * `pixelsPerUnit` is screen pixels per document unit along the drag, and
 * `shownScale` converts document units to shown units.
 */
export function blendDragStep(
  pixelsPerUnit: number,
  shownScale: number
): number {
  const perShown =
    Number.isFinite(pixelsPerUnit) && pixelsPerUnit > 0 && shownScale > 0
      ? pixelsPerUnit / shownScale
      : 0;
  for (const step of BLEND_DRAG_STEPS) {
    if (step * perShown >= MIN_BLEND_STEP_PX) return step;
  }
  return COARSEST_BLEND_STEP;
}

/** Snaps a document-unit value to `step` shown units. */
export function snapBlendValue(
  value: number,
  step: number,
  shownScale: number
): number {
  const shown = Math.round((value * shownScale) / step) * step;
  // Round off binary noise, so 0.1-unit steps read 0.3 rather than 0.30000004.
  return Number((shown / shownScale).toPrecision(12));
}
