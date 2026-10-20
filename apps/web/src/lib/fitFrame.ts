import { clearStageFrame, type NdcFrame } from '@openzcad/viewport';
import { SELECTION_CALLOUT_OBSTACLES } from './selectionCalloutView';

/**
 * The part of the viewport canvas that Fit frames into: the canvas less the
 * floating panels over it — the right lane (command card, inspector), the
 * model panels, the instrument rail, the left column and the tool palette. These
 * are the same panels a selection chip keeps out from under. Undefined means
 * the whole canvas.
 */
export function measureFitFrame(canvas: HTMLElement): NdcFrame | undefined {
  const panels = [
    ...(canvas
      .closest('.viewer-area')
      ?.querySelectorAll<HTMLElement>(SELECTION_CALLOUT_OBSTACLES) ?? [])
  ].map((panel) => panel.getBoundingClientRect());
  return clearStageFrame(canvas.getBoundingClientRect(), panels);
}
