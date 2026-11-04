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
  const bounds = canvas.getBoundingClientRect();
  const panels = panelsOver(
    canvas,
    `${SELECTION_CALLOUT_OBSTACLES}, .tweak-flyouts, .view-flyouts`
  );
  const width = bounds.width;
  const height = bounds.height;
  if (!(width > 0) || !(height > 0)) return undefined;
  let top = bounds.top;
  let bottom = bounds.bottom;
  const topbar = canvas.closest('.app-shell')?.querySelector('.topbar');
  if (topbar)
    top = Math.max(
      top,
      topbar.getBoundingClientRect().bottom + STAGE_FRAME_GAP_PX
    );
  // Wide lower sheets reserve height, while narrow rails reserve width.
  // Keep this UI projection local: the viewport package's side-band API
  // remains available unchanged to other consumers.
  for (const panel of panels) {
    if (
      panel.width <= width / 2 ||
      panel.height >= height / 2 ||
      panel.height <= 0
    )
      continue;
    if ((panel.top + panel.bottom) / 2 >= bounds.top + height / 2)
      bottom = Math.min(bottom, panel.top - STAGE_FRAME_GAP_PX);
    else top = Math.max(top, panel.bottom + STAGE_FRAME_GAP_PX);
  }
  if (bottom <= top) return undefined;
  const verticalBounds = {
    left: bounds.left,
    right: bounds.right,
    top,
    bottom
  };
  const sides = clearStageFrame(verticalBounds, panels);
  if (!sides && top === bounds.top && bottom === bounds.bottom)
    return undefined;
  return {
    minX: sides?.minX ?? -1,
    maxX: sides?.maxX ?? 1,
    minY: 1 - ((bottom - bounds.top) / height) * 2,
    maxY: 1 - ((top - bounds.top) / height) * 2
  };
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
  ]
    .filter((panel) => {
      const style = getComputedStyle(panel);
      return (
        style.display !== 'none' &&
        style.visibility !== 'hidden' &&
        !panel.closest('[inert]')
      );
    })
    .map((panel) => panel.getBoundingClientRect());
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
