import type { NdcFrame } from '../render/scene';

/** A screen rectangle in CSS pixels; a `DOMRect` satisfies it. */
export interface StageRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** Pixels kept clear between a framed model and the panel beside it. */
export const STAGE_FRAME_GAP_PX = 12;

/**
 * The narrowest clear band, as a fraction of the canvas width, worth
 * framing into; narrower and the whole canvas is the better answer. A
 * 1024px window with the column and the drawer both open leaves about 38%.
 */
export const STAGE_FRAME_MIN_CLEAR_FRACTION = 0.25;

/**
 * The part of the canvas Fit should frame into: what the floating side
 * panels leave clear. The panels float over the canvas rather than
 * shrinking it, so a fit to the whole canvas puts part of the model under
 * an open drawer.
 *
 * Each panel that overlaps the canvas and is narrower than half of it
 * pushes in the side its centre is on, plus `gap`; a panel spanning more
 * than half the canvas is a sheet, not a side panel, and is ignored. Returns
 * undefined (frame the whole canvas) when nothing covers a side, or when
 * what is left is narrower than `minClearFraction` of the canvas.
 */
export function clearStageFrame(
  canvas: StageRect,
  panels: readonly StageRect[],
  gap = STAGE_FRAME_GAP_PX,
  minClearFraction = STAGE_FRAME_MIN_CLEAR_FRACTION
): NdcFrame | undefined {
  const width = canvas.right - canvas.left;
  const height = canvas.bottom - canvas.top;
  if (!(width > 0) || !(height > 0)) {
    return undefined;
  }
  const middle = canvas.left + width / 2;
  let left = canvas.left;
  let right = canvas.right;
  for (const panel of panels) {
    const panelLeft = Math.max(panel.left, canvas.left);
    const panelRight = Math.min(panel.right, canvas.right);
    const panelTop = Math.max(panel.top, canvas.top);
    const panelBottom = Math.min(panel.bottom, canvas.bottom);
    if (!(panelRight > panelLeft) || !(panelBottom > panelTop)) {
      continue;
    }
    if (panelRight - panelLeft > width / 2) {
      continue;
    }
    if ((panelLeft + panelRight) / 2 < middle) {
      left = Math.max(left, panelRight + gap);
    } else {
      right = Math.min(right, panelLeft - gap);
    }
  }
  if (left === canvas.left && right === canvas.right) {
    return undefined;
  }
  if (right - left < width * minClearFraction) {
    return undefined;
  }
  return {
    minX: ((left - canvas.left) / width) * 2 - 1,
    maxX: ((right - canvas.left) / width) * 2 - 1,
    minY: -1,
    maxY: 1
  };
}
