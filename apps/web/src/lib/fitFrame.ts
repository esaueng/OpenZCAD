import {
  clearStageFrame,
  STAGE_FRAME_GAP_PX,
  type NdcFrame,
  type StageRect
} from '@openzcad/viewport';
import { SELECTION_CALLOUT_OBSTACLES } from './selectionCalloutView';

/**
 * The part of the viewport canvas that Fit frames into: the canvas less the
 * floating panels over it — the right lane (command card, inspector), the
 * model panels, the instrument rail, the left column and the tool palette. These
 * are the same panels a selection chip keeps out from under. Undefined means
 * the whole canvas.
 */
export function measureFitFrame(canvas: HTMLElement): NdcFrame | undefined {
  return clearStageFrame(
    canvas.getBoundingClientRect(),
    panelsOver(canvas, SELECTION_CALLOUT_OBSTACLES)
  );
}

/**
 * The clear stage a picked target is kept in: what Fit frames into, less the
 * tool palette's open fold too, which hangs outside the column's box. Any
 * band counts — a profile and its arrow fit in far less than a model needs.
 */
export function measurePickFrame(canvas: HTMLElement): NdcFrame | undefined {
  return clearStageFrame(
    canvas.getBoundingClientRect(),
    panelsOver(canvas, `${SELECTION_CALLOUT_OBSTACLES}, .command-flyout`),
    STAGE_FRAME_GAP_PX,
    0
  );
}

function panelsOver(canvas: HTMLElement, selector: string): DOMRect[] {
  return [
    ...(canvas
      .closest('.viewer-area')
      ?.querySelectorAll<HTMLElement>(selector) ?? [])
  ].map((panel) => panel.getBoundingClientRect());
}

/**
 * The sideways move, in CSS pixels, that brings `target` (a screen
 * rectangle) into the clear band of `frame` on `canvas`: the smallest one
 * that fits it. A target wider than the band keeps only its `core` (what
 * must be reachable in it) clear, by the smallest move again, and a core
 * wider still is centred. Zero when nothing needs to move, or when nothing
 * covers the canvas.
 */
export function shiftIntoFrame(
  target: StageRect,
  canvas: StageRect,
  frame: NdcFrame | undefined,
  core: StageRect = target
): number {
  if (!frame) {
    return 0;
  }
  const width = canvas.right - canvas.left;
  const left = canvas.left + ((frame.minX + 1) / 2) * width;
  const right = canvas.left + ((frame.maxX + 1) / 2) * width;
  const kept = target.right - target.left <= right - left ? target : core;
  if (kept.right - kept.left > right - left) {
    return (left + right) / 2 - (kept.left + kept.right) / 2;
  }
  if (kept.left < left) {
    return left - kept.left;
  }
  if (kept.right > right) {
    return right - kept.right;
  }
  return 0;
}
