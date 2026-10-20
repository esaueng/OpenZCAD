import { formatNumber } from './model';
import {
  selectionCalloutObstacleShift,
  type ScreenRect
} from './selectionCalloutView';

/** Which number the offset chip shows: the drag delta, or the whole span. */
export type OffsetChipMode = 'offset' | 'total';

/** What a freshly armed offset-arrow rig's chip starts from. */
export interface OffsetChipState {
  mode: OffsetChipMode;
  /** How far the body reaches behind the armed face, for "Total". */
  extent: number | null;
}

/**
 * A face offset: resizing a primitive reads its own dimension (the total) by
 * default, since that is the number the gesture sets; moving any other face
 * reads the change, with the body's reach behind it one click away.
 */
export function faceOffsetChipState(
  totalBaseline: number | undefined,
  extentBehind: number | null
): OffsetChipState {
  return {
    mode: totalBaseline === undefined ? 'offset' : 'total',
    extent: extentBehind
  };
}

/**
 * A sketch-region extrude shares the face offset's arrow rig, but nothing
 * stands behind a region and it has no dimension of its own: it always reads
 * the signed distance. Arming it must reset the chip, or it inherits the last
 * face's Total mode and span (a −5 drag read "Total 5").
 */
export function regionChipState(): OffsetChipState {
  return { mode: 'offset', extent: null };
}

/** The offset chip's value text, before any warning marker. */
export function offsetChipText(input: {
  rawValue: number;
  mode: OffsetChipMode;
  /** The span "Total" adds the offset to, when one is known. */
  span: number | null;
  /** +1 when the offset grows the span, −1 when it shrinks it. */
  sense: number;
  units: string;
}): string {
  const { rawValue, mode, span, sense, units } = input;
  // Both readings round to hundredths, so flipping the tag changes the number
  // it shows, never how precisely it shows it.
  if (mode === 'total' && span !== null) {
    return `${formatNumber(Math.round((span + sense * rawValue) * 100) / 100)} ${units}`;
  }
  const value = Math.round(rawValue * 100) / 100;
  return `${value >= 0 ? '+' : ''}${value} ${units}`;
}

/** The gap kept between an edge chip and the right lane or the stage edge. */
const EDGE_CHIP_MARGIN_PX = 8;

/**
 * Where an edge rig's value chip centres horizontally: clear of the right
 * lane when the space left of it can hold the chip. At a phone width the lane
 * spans the stage from its left inset, and dodging it would put the chip,
 * and with it exact entry, off-screen; it stays on its anchor instead.
 */
export function edgeChipCenterX(
  anchorX: number,
  laneLeft: number | null,
  chipWidth: number
): number {
  if (laneLeft === null) return anchorX;
  const dodged = laneLeft - EDGE_CHIP_MARGIN_PX - chipWidth / 2;
  return dodged - chipWidth / 2 >= EDGE_CHIP_MARGIN_PX
    ? Math.min(anchorX, dodged)
    : anchorX;
}

/**
 * How far a handle's chip — its value pill and any tag beside it, as one
 * box, in the same coordinates as `stage` — moves to come out from under a
 * model panel the right lane's rule does not cover: a floating window or
 * the left dock. The right lane keeps its own rule (`edgeChipCenterX`, the
 * pin's swap to its other side), so while the stage has room left of the
 * lane no move here takes the chip into it. A chip nothing covers, or one
 * no move inside the stage clears, stays where it is.
 */
export function chipPanelDodge(
  chip: ScreenRect,
  panels: readonly ScreenRect[],
  stage: ScreenRect,
  laneLeft: number | null
): { dx: number; dy: number } {
  if (panels.length === 0) return { dx: 0, dy: 0 };
  const width = chip.right - chip.left;
  const laneEdge =
    laneLeft !== null &&
    laneLeft - EDGE_CHIP_MARGIN_PX - width >= stage.left + EDGE_CHIP_MARGIN_PX
      ? Math.min(stage.right, laneLeft - EDGE_CHIP_MARGIN_PX)
      : stage.right;
  return selectionCalloutObstacleShift(
    chip,
    panels,
    // A chip the lane rule left over the lane (a phone's) may stay there.
    { ...stage, right: Math.max(laneEdge, chip.right) },
    EDGE_CHIP_MARGIN_PX
  );
}
