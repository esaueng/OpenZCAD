import { afterEach, describe, expect, it, vi } from 'vitest';
import { SWIPE_ACTION_TAP_SLOP_PX, SwipeActionTaps } from './swipeActionTap';

const finger = {
  pointerId: 3,
  pointerType: 'touch',
  clientX: 100,
  clientY: 40
};

describe('the taps on a swiped row’s revealed actions', () => {
  let taps = new SwipeActionTaps<string>();
  afterEach(() => {
    taps.dispose();
    taps = new SwipeActionTaps<string>();
  });

  it('runs a finger’s or a pen’s press on its lift within the slop, once', () => {
    taps.press();
    expect(taps.pressAction(finger, 'delete')).toBe(true);
    expect(taps.release({ ...finger, pointerId: 4 })).toBeNull();
    expect(
      taps.release({
        ...finger,
        clientX: finger.clientX + SWIPE_ACTION_TAP_SLOP_PX - 1
      })
    ).toBe('delete');
    expect(taps.release(finger)).toBeNull();

    taps.press();
    taps.pressAction({ ...finger, pointerType: 'pen' }, 'suppress');
    expect(
      taps.release({
        ...finger,
        clientY: finger.clientY + SWIPE_ACTION_TAP_SLOP_PX
      })
    ).toBeNull();
  });

  it('leaves a mouse to its click, and a cancelled pointer to nothing', () => {
    taps.press();
    expect(
      taps.pressAction({ ...finger, pointerType: 'mouse' }, 'delete')
    ).toBe(false);
    expect(taps.release(finger)).toBeNull();
    taps.pressAction(finger, 'delete');
    taps.cancel(finger);
    expect(taps.release(finger)).toBeNull();
  });

  it('swallows a swipe’s click on the row but not on the actions, and each press starts clear', () => {
    taps.swallowRowClick();
    expect(taps.takeClick(false)).toBe(true);
    expect(taps.takeClick(false)).toBe(false);
    taps.swallowRowClick();
    expect(taps.takeClick(true)).toBe(false);
    expect(taps.takeClick(false)).toBe(false);
    taps.swallowRowClick();
    taps.press();
    expect(taps.takeClick(false)).toBe(false);
  });

  it('swallows the one click after a run anywhere, until a press or a key ends it', () => {
    const clicked = vi.fn();
    window.addEventListener('click', clicked);
    try {
      taps.ran();
      document.body.click();
      document.body.click();
      expect(clicked).toHaveBeenCalledTimes(1);
      taps.ran();
      window.dispatchEvent(new Event('pointerdown'));
      document.body.click();
      expect(clicked).toHaveBeenCalledTimes(2);
      taps.ran();
      window.dispatchEvent(new Event('keydown'));
      document.body.click();
      expect(clicked).toHaveBeenCalledTimes(3);
      taps.ran();
      taps.dispose();
      document.body.click();
      expect(clicked).toHaveBeenCalledTimes(4);
    } finally {
      window.removeEventListener('click', clicked);
    }
  });
});
