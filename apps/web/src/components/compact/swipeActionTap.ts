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
 * The click that may follow a run on release is swallowed wherever it
 * lands, in the page and not only in the list: the row has slid back under
 * the finger by then, or the action has opened a prompt there, so nothing
 * runs twice, nothing opens and no prompt is answered by the same tap. The
 * next press or key ends that swallow, whether the click came or not.
 *
 * A swipe, a hold or a press that closed a row swallows only its row's
 * click: a click on the revealed actions still reaches them. Each press
 * starts clear, so a click the browser never sent cannot eat the next tap,
 * and a click with no press before it (a mouse is pressed too; a keyboard
 * or a screen reader is not) reaches its button.
 */

/** Travel within which a lift is still a tap on the action it pressed. */
export const SWIPE_ACTION_TAP_SLOP_PX = 10;

/** The parts of a pointer event the taps read. */
export interface TapPointer {
  pointerId: number;
  pointerType: string;
  clientX: number;
  clientY: number;
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
   * A press on a revealed action, after `press()`. A finger or pen is
   * held for its lift; a mouse is left to the button's click. Returns
   * whether the press was taken.
   */
  pressAction(event: TapPointer, target: T): boolean {
    if (event.pointerType === 'mouse') return false;
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
   * An action runs on its lift: the click that may follow, anywhere in the
   * page, is not a tap. Armed until that click, the next press or a key.
   */
  ran(): void {
    this.swallowRow = false;
    this.disarm?.();
    if (typeof window === 'undefined') return;
    const onClick = (event: MouseEvent) => {
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
