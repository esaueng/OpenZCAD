/**
 * The taps on a swiped row's revealed actions (U12), shared by the compact
 * library's rows and the compact History rows.
 *
 * A revealed action runs when the finger or pen that pressed it lifts
 * within the slop, from pointer events, not on the click the browser may
 * make of the tap. The swipe that revealed it ends with horizontal
 * velocity, so Chromium's gesture layer starts a fling even where the row
 * has nothing to scroll; the next touch stops that fling, and on Aura
 * (Linux, ChromeOS) the tap that stops a fling is suppressed: no mousedown,
 * mouseup or click is made. Pointer events still arrive.
 *
 * Only the press of one finger or a pen's tip is held for its lift: not a
 * second finger, nor a pen's eraser or barrel button.
 *
 * The click that may follow a run on release is swallowed wherever it
 * lands, in the page and not only in the list: the row has slid back under
 * the finger by then, or the action has opened a prompt there, so nothing
 * runs twice, nothing opens and no prompt is answered by the same tap. It
 * is told by where and when it comes: at the lift, within the time a
 * browser may hold a tap's click. Any other click (a script's, a screen
 * reader's) reaches its button, and the next press or key ends the
 * swallow, whether the click came or not.
 *
 * A swipe, a hold or a press that closed a row swallows only its row's
 * click: a click on the revealed actions still reaches them. Each press
 * starts clear, so a click the browser never sent cannot eat the next tap,
 * and a click with no press before it (a mouse is pressed too; a keyboard
 * or a screen reader is not) reaches its button.
 */

/** Travel within which a lift is still a tap on the action it pressed. */
export const SWIPE_ACTION_TAP_SLOP_PX = 10;

/**
 * How far from the lift the click a tap makes may land: the browser may
 * move it toward the nearest button under the finger's contact.
 */
export const SWIPE_ACTION_CLICK_REACH_PX = 32;

/**
 * How long after the lift the click a tap makes may come: past the 300 ms
 * a browser may hold it to rule out a double tap.
 */
export const SWIPE_ACTION_CLICK_WINDOW_MS = 600;

/** The parts of a pointer event the taps read. */
export interface TapPointer {
  pointerId: number;
  pointerType: string;
  clientX: number;
  clientY: number;
}

/** The parts of a press the taps read. */
export interface TapPress extends TapPointer {
  isPrimary: boolean;
  button: number;
  buttons: number;
}

/** The parts of the lift an action ran on that the taps read. */
export interface TapLift {
  clientX: number;
  clientY: number;
  timeStamp: number;
}

/**
 * One finger, or a pen's tip alone: not a second finger, a pen's eraser
 * (button 5) or its barrel button (2), held or pressed.
 */
function isTapPress(event: TapPress): boolean {
  if (!event.isPrimary || event.button !== 0) return false;
  if (event.pointerType === 'touch') return true;
  return event.pointerType === 'pen' && (event.buttons & ~1) === 0;
}

interface ActionPress<T> {
  pointerId: number;
  target: T;
  startX: number;
  startY: number;
}

export class SwipeActionTaps<T> {
  private pressed: ActionPress<T> | null = null;
  private swallowRow = false;
  private disarm: (() => void) | null = null;

  /** Every press on the surface: it starts clear. */
  press(): void {
    this.swallowRow = false;
    this.pressed = null;
  }

  /**
   * A press on a revealed action, after `press()`. One finger or a pen's
   * tip is held for its lift; a mouse is left to the button's click, and a
   * second finger, an eraser or a barrel button to nothing. Returns
   * whether the press was taken.
   */
  pressAction(event: TapPress, target: T): boolean {
    if (!isTapPress(event)) return false;
    this.pressed = {
      pointerId: event.pointerId,
      target,
      startX: event.clientX,
      startY: event.clientY
    };
    return true;
  }

  /**
   * A lift. Returns the pressed action when this lift is a tap on it (the
   * same pointer, still within the slop), or null. A caller that runs it
   * calls `ran()` first.
   */
  release(event: TapPointer): T | null {
    const pressed = this.pressed;
    if (!pressed || pressed.pointerId !== event.pointerId) return null;
    this.pressed = null;
    const still =
      Math.abs(event.clientX - pressed.startX) < SWIPE_ACTION_TAP_SLOP_PX &&
      Math.abs(event.clientY - pressed.startY) < SWIPE_ACTION_TAP_SLOP_PX;
    return still ? pressed.target : null;
  }

  /** The browser took the pointer back: nothing runs on it. */
  cancel(event: Pick<TapPointer, 'pointerId'>): void {
    if (this.pressed?.pointerId === event.pointerId) this.pressed = null;
  }

  /**
   * An action runs on `lift`: the click that tap may make, anywhere in the
   * page, is not a tap. That is a click at the lift, within the window;
   * others pass. Armed until that click, one past the window, the next
   * press or a key.
   */
  ran(lift: TapLift): void {
    this.swallowRow = false;
    this.disarm?.();
    if (typeof window === 'undefined') return;
    const onClick = (event: MouseEvent) => {
      if (event.timeStamp - lift.timeStamp > SWIPE_ACTION_CLICK_WINDOW_MS) {
        disarm();
        return;
      }
      if (
        Math.abs(event.clientX - lift.clientX) > SWIPE_ACTION_CLICK_REACH_PX ||
        Math.abs(event.clientY - lift.clientY) > SWIPE_ACTION_CLICK_REACH_PX
      ) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      disarm();
    };
    const disarm = () => {
      window.removeEventListener('click', onClick, true);
      window.removeEventListener('pointerdown', disarm, true);
      window.removeEventListener('keydown', disarm, true);
      if (this.disarm === disarm) this.disarm = null;
    };
    window.addEventListener('click', onClick, true);
    window.addEventListener('pointerdown', disarm, true);
    window.addEventListener('keydown', disarm, true);
    this.disarm = disarm;
  }

  /** A press that swiped, held or closed a row: its click is not a tap. */
  swallowRowClick(): void {
    this.swallowRow = true;
  }

  /**
   * A click on the surface: whether to swallow it as the end of a swipe,
   * a hold or a close. `onActions` says it landed on the revealed actions,
   * which keep their clicks.
   */
  takeClick(onActions: boolean): boolean {
    if (!this.swallowRow) return false;
    this.swallowRow = false;
    return !onActions;
  }

  /** The surface is gone: nothing stays armed. */
  dispose(): void {
    this.pressed = null;
    this.swallowRow = false;
    this.disarm?.();
  }
}
