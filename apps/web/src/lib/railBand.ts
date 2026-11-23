/**
 * The right rail band, measured: from the right dock's inner edge to the
 * left edge of the chrome standing there, and a gap past it. The chrome is
 * the instrument rail's islands — the viewer bar, the model panels' buttons
 * (side by side where a short window folds them), the relations while
 * sketching and the snap and grid readout wherever it hangs. Media queries
 * fold, widen and move every one of them (pointer size, window height,
 * width), and constants per breakpoint missed several layouts, so the
 * unpinned panel, Pop out and the right lane read this one number instead.
 *
 * The flyouts the rail opens (views, section, a toolbox) are inside the
 * islands, not beside them, so an open popover never moves a panel.
 */

/** The instrument rail's islands, its direct children. */
const RAIL_BAND_PARTS = '.viewer-rail, .sketch-relations, .viewport-readout';

/** The rail's islands the band reads, shown or not. */
export function railBandParts(rail: Element): Element[] {
  return Array.from(rail.children).filter((child) =>
    child.matches(RAIL_BAND_PARTS)
  );
}

/**
 * The band in CSS pixels: the rail's right edge (an island gap from the
 * dock, or the screen) less the leftmost shown island, with a gap either
 * side. `null` when nothing is laid out (no rail, or no layout at all, as
 * in tests), so callers keep their gap-rail-gap default.
 */
export function measureRailBand(
  rail: Element | null,
  gap: number
): number | null {
  if (!rail) return null;
  const edge = rail.getBoundingClientRect().right;
  let left = Number.POSITIVE_INFINITY;
  for (const part of railBandParts(rail)) {
    const box = part.getBoundingClientRect();
    // `display: none` (the readout outside a sketch) has no box.
    if (box.width <= 0 || box.height <= 0) continue;
    left = Math.min(left, box.left);
  }
  if (!Number.isFinite(left) || edge - left <= 0) return null;
  return Math.ceil(edge - left + gap * 2);
}
