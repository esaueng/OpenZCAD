import { describe, expect, it } from 'vitest';
import { togglePanelSheet } from './panelSheet';
import {
  SWIPE_ACTION_PX,
  isSwipe,
  reorderTarget,
  restOffset,
  swipeOffset,
  swipeRest
} from './rowGestures';

describe('compact row gestures', () => {
  it('tells a swipe from a tap and from a vertical scroll', () => {
    expect(isSwipe(4, 0)).toBe(false);
    expect(isSwipe(-12, 2)).toBe(true);
    expect(isSwipe(12, 12)).toBe(false);
    expect(isSwipe(30, 20)).toBe(true);
  });

  it('stops the face at the width of the actions on each side', () => {
    const both = { start: 1, end: 2 };
    expect(swipeOffset(0, -400, both)).toBe(-2 * SWIPE_ACTION_PX);
    expect(swipeOffset(0, 400, both)).toBe(SWIPE_ACTION_PX);
    // The last step has nothing to roll back after: it does not move right.
    expect(swipeOffset(0, 60, { start: 0, end: 2 })).toBe(0);
    // An open row swiped back starts from where it rests.
    expect(swipeOffset(restOffset('end', both), 40, both)).toBe(
      -2 * SWIPE_ACTION_PX + 40
    );
  });

  it('keeps a row open past the threshold and closes it short of it', () => {
    expect(swipeRest(-60)).toBe('end');
    expect(swipeRest(60)).toBe('start');
    expect(swipeRest(-20)).toBeNull();
    expect(restOffset(null, { start: 1, end: 2 })).toBe(0);
  });

  it('lands a dragged row on the row whose middle it passed', () => {
    const middles = [20, 70, 120, 170];
    expect(reorderTarget(middles, 1, 0)).toBe(1);
    expect(reorderTarget(middles, 1, 30)).toBe(1);
    expect(reorderTarget(middles, 1, 60)).toBe(2);
    expect(reorderTarget(middles, 1, 200)).toBe(3);
    expect(reorderTarget(middles, 2, -60)).toBe(1);
    expect(reorderTarget(middles, 2, -200)).toBe(0);
  });
});

describe('the panel sheet toggle', () => {
  it('shuts an open sheet and reopens the panel shown last', () => {
    expect(togglePanelSheet('bodies', 'bodies')).toBeNull();
    expect(togglePanelSheet(null, 'revisions')).toBe('revisions');
    expect(togglePanelSheet(null, null)).toBe('history');
  });
});
