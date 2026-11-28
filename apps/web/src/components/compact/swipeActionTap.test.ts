import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  SWIPE_ACTION_CLICK_REACH_PX,
  SWIPE_ACTION_CLICK_WINDOW_MS,
  SWIPE_ACTION_TAP_SLOP_PX,
  SwipeActionTaps
} from './swipeActionTap';

const finger = {
  pointerId: 3,
  pointerType: 'touch',
  isPrimary: true,
  button: 0,
  buttons: 1,
  clientX: 100,
  clientY: 40
};

/** A click at a point, as a tap's or a script's. */
function clickAt(clientX: number, clientY: number) {
  document.body.dispatchEvent(
    new MouseEvent('click', {
      bubbles: true,
      cancelable: true,
      clientX,
      clientY
    })
  );
}

/** A lift at the finger's point, now or `ago` ms back. */
function lift(ago = 0) {
  return {
    clientX: finger.clientX,
    clientY: finger.clientY,
    timeStamp: new Event('lift').timeStamp - ago
  };
}

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

  it('holds only one finger or a pen’s tip, not a second finger, an eraser or a barrel button', () => {
    const pen = { ...finger, pointerType: 'pen' };
    for (const press of [
      { ...finger, isPrimary: false },
      { ...pen, button: 5, buttons: 32 },
      { ...pen, button: 2, buttons: 2 },
      { ...pen, buttons: 3 }
    ]) {
      taps.press();
      expect(taps.pressAction(press, 'delete')).toBe(false);
      expect(taps.release(press)).toBeNull();
    }
    taps.press();
    expect(taps.pressAction(pen, 'delete')).toBe(true);
    expect(taps.release(pen)).toBe('delete');
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

  it('swallows the one click the run’s tap makes, until a press or a key ends it', () => {
    const clicked = vi.fn();
    window.addEventListener('click', clicked);
    const { clientX: x, clientY: y } = finger;
    try {
      // The tap's click lands at the lift, or near it, wherever that is in
      // the page: swallowed once.
      taps.ran(lift());
      clickAt(x + SWIPE_ACTION_CLICK_REACH_PX, y - SWIPE_ACTION_CLICK_REACH_PX);
      clickAt(x, y);
      expect(clicked).toHaveBeenCalledTimes(1);
      taps.ran(lift());
      window.dispatchEvent(new Event('pointerdown'));
      clickAt(x, y);
      expect(clicked).toHaveBeenCalledTimes(2);
      taps.ran(lift());
      window.dispatchEvent(new Event('keydown'));
      clickAt(x, y);
      expect(clicked).toHaveBeenCalledTimes(3);
      taps.ran(lift());
      taps.dispose();
      clickAt(x, y);
      expect(clicked).toHaveBeenCalledTimes(4);
    } finally {
      window.removeEventListener('click', clicked);
    }
  });

  it('lets through a click that is not the run’s tap: away from the lift, or past the window', () => {
    const clicked = vi.fn();
    window.addEventListener('click', clicked);
    try {
      // No click followed the tap (it stopped a fling): a script's click
      // elsewhere, as on the notice's Undo, reaches it (review case: it
      // was swallowed).
      taps.ran(lift());
      document.body.click();
      clickAt(finger.clientX + SWIPE_ACTION_CLICK_REACH_PX + 1, finger.clientY);
      expect(clicked).toHaveBeenCalledTimes(2);
      // A click at the lift, but long after it, is a new click, and ends
      // the swallow.
      taps.ran(lift(SWIPE_ACTION_CLICK_WINDOW_MS + 1));
      clickAt(finger.clientX, finger.clientY);
      expect(clicked).toHaveBeenCalledTimes(3);
    } finally {
      window.removeEventListener('click', clicked);
    }
  });
});
