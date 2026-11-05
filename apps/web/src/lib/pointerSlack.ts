/**
 * How much farther a pointer may land from what it means to hit (L02 slice
 * 5, docs/plans/ipad-touch-plan-2026-11-05.md).
 *
 * A fingertip covers several millimetres and hides the point under it, so a
 * finger gets twice each screen-space tolerance: snaps, grab handles and
 * curve picks. Pen and mouse keep the tolerances as tuned; a Pencil tip is
 * as precise as a cursor. Edge picking scales its own band
 * (`edgePickPaddingPx` in @openzcad/viewport).
 */
export const TOUCH_TOLERANCE_SCALE = 2;

/** The multiplier for a pointer type ('' or absent reads as a mouse). */
export function pointerSlack(event: { pointerType?: string } | null): number {
  return event?.pointerType === 'touch' ? TOUCH_TOLERANCE_SCALE : 1;
}
