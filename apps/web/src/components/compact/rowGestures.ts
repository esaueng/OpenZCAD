/**
 * The compact panel rows' gestures (U12 slice 5), as pure decisions: a
 * horizontal swipe that uncovers a row's actions, and a drag on the grip
 * that moves the row. The components feed pointer positions in and draw
 * what comes out, so the thresholds are testable without a DOM.
 */

/** Which side's actions a swipe has uncovered. */
export type SwipeSide = 'start' | 'end';

/** Travel before a press reads as a swipe rather than a tap. */
export const SWIPE_SLOP_PX = 10;
/** Travel past which a released swipe stays open. */
export const SWIPE_OPEN_PX = 48;
/** The width of one uncovered action button. */
export const SWIPE_ACTION_PX = 76;

/**
 * Whether a press that has travelled (dx, dy) is a row swipe: far enough,
 * and more across than down, so a vertical scroll of the list stays one.
 */
export function isSwipe(dx: number, dy: number): boolean {
  return Math.abs(dx) >= SWIPE_SLOP_PX && Math.abs(dx) > Math.abs(dy) * 1.2;
}

/**
 * Where the row's face is drawn for a swipe that has travelled `dx` from
 * where it started (`base`, the offset of a row already open). It stops at
 * the width of the actions on each side, and does not move toward a side
 * that has none.
 */
export function swipeOffset(
  base: number,
  dx: number,
  actions: { start: number; end: number }
): number {
  const max = actions.start * SWIPE_ACTION_PX;
  const min = -actions.end * SWIPE_ACTION_PX;
  return Math.max(min, Math.min(max, base + dx));
}

/** The side a swipe released at `offset` leaves open, or null to close. */
export function swipeRest(offset: number): SwipeSide | null {
  if (offset >= SWIPE_OPEN_PX) return 'start';
  if (offset <= -SWIPE_OPEN_PX) return 'end';
  return null;
}

/** The face's offset for a row left open on `side`. */
export function restOffset(
  side: SwipeSide | null,
  actions: { start: number; end: number }
): number {
  if (side === 'start') return actions.start * SWIPE_ACTION_PX;
  if (side === 'end') return -actions.end * SWIPE_ACTION_PX;
  return 0;
}

/**
 * The index a row dragged by its grip lands on: the row whose middle the
 * dragged row's middle has passed, from the rows' midpoints as laid out
 * when the drag began.
 */
export function reorderTarget(
  midpoints: readonly number[],
  from: number,
  dy: number
): number {
  const middle = (midpoints[from] ?? 0) + dy;
  let target = from;
  if (dy > 0) {
    for (let index = from + 1; index < midpoints.length; index += 1) {
      if (middle > midpoints[index]!) target = index;
    }
  } else if (dy < 0) {
    for (let index = from - 1; index >= 0; index -= 1) {
      if (middle < midpoints[index]!) target = index;
    }
  }
  return target;
}
