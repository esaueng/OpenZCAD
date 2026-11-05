/**
 * A finger's press-and-hold as a context menu, everywhere in the chrome
 * (L02 slice 4, docs/plans/ipad-touch-plan-2026-11-05.md).
 *
 * iPadOS Safari fires no `contextmenu` for a long press, so every right-click
 * menu (History rows, Assemble's parts and joints) was out of reach of a
 * finger. Holding still for `TOUCH_LONG_PRESS_MS` dispatches a real
 * `contextmenu` at the pressed element, so the existing `onContextMenu`
 * handlers run unchanged, and the click the lift would make is swallowed: a
 * hold is never also a press. A `Tooltip` trigger with no menu of its own
 * shows its help instead (see `isTouchLongPress`).
 *
 * Left alone: mouse and pen, which have their own buttons; text fields,
 * whose own long press places the caret and offers paste; the 3D viewport,
 * whose touch layer times its own long press; and a press where the browser
 * already fired a native `contextmenu` (Android does).
 */

/** Just past Android's native long press, so a native menu cancels this one. */
export const TOUCH_LONG_PRESS_MS = 550;
/** Travel that makes a press a scroll or drag rather than a hold. */
const TOUCH_LONG_PRESS_SLOP_PX = 10;
/** How long after the finger lifts its delayed click is still swallowed. */
const SWALLOW_CLICK_MS = 1000;

const IGNORED =
  'input, textarea, select, [contenteditable]:not([contenteditable="false"]), .viewer-host canvas, [data-touch-long-press-ignore]';

const longPressMenus = new WeakSet<Event>();

/** Whether a `contextmenu` event is a finger's hold rather than a button. */
export function isTouchLongPress(event: Event): boolean {
  return longPressMenus.has(event);
}

export function installTouchLongPress(
  doc: Document = document,
  clock: {
    now(): number;
    setTimeout(callback: () => void, ms: number): number;
    clearTimeout(handle: number): void;
  } = {
    now: () => performance.now(),
    setTimeout: (callback, ms) => window.setTimeout(callback, ms),
    clearTimeout: (handle) => window.clearTimeout(handle)
  }
): () => void {
  let pending: {
    pointerId: number;
    x: number;
    y: number;
    target: Element;
    timer: number;
  } | null = null;
  let swallowClickUntil = Number.NEGATIVE_INFINITY;
  let heldPointerId: number | null = null;

  const cancel = () => {
    if (!pending) return;
    clock.clearTimeout(pending.timer);
    pending = null;
  };

  const onPointerDown = (event: PointerEvent) => {
    cancel();
    // A new deliberate press must not lose its click to a previous hold
    // that was cancelled or whose browser never emitted a click.
    if (heldPointerId === null) {
      swallowClickUntil = Number.NEGATIVE_INFINITY;
    }
    if (event.pointerType !== 'touch' || !event.isPrimary) return;
    const target = event.target;
    if (!(target instanceof Element) || target.closest(IGNORED)) return;
    const press = {
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      target,
      timer: 0
    };
    press.timer = clock.setTimeout(() => {
      pending = null;
      if (!press.target.isConnected) return;
      const menu = new MouseEvent('contextmenu', {
        bubbles: true,
        cancelable: true,
        clientX: press.x,
        clientY: press.y,
        view: doc.defaultView
      });
      longPressMenus.add(menu);
      heldPointerId = press.pointerId;
      // The hold can last arbitrarily long after its menu has opened. Start
      // the browser's delayed-click grace period only when this finger lifts.
      swallowClickUntil = Number.POSITIVE_INFINITY;
      press.target.dispatchEvent(menu);
    }, TOUCH_LONG_PRESS_MS);
    pending = press;
  };

  const onPointerMove = (event: PointerEvent) => {
    if (
      pending?.pointerId === event.pointerId &&
      Math.hypot(event.clientX - pending.x, event.clientY - pending.y) >
        TOUCH_LONG_PRESS_SLOP_PX
    ) {
      cancel();
    }
  };

  const onPointerEnd = (event: PointerEvent) => {
    if (pending?.pointerId === event.pointerId) cancel();
    if (heldPointerId === event.pointerId) {
      heldPointerId = null;
      swallowClickUntil = clock.now() + SWALLOW_CLICK_MS;
    }
  };

  const onContextMenu = (event: MouseEvent) => {
    // The browser opened its own: this hold is already a menu.
    if (!isTouchLongPress(event)) cancel();
  };

  const onClick = (event: MouseEvent) => {
    if (clock.now() > swallowClickUntil) return;
    swallowClickUntil = Number.NEGATIVE_INFINITY;
    event.preventDefault();
    event.stopPropagation();
  };

  doc.addEventListener('pointerdown', onPointerDown, true);
  doc.addEventListener('pointermove', onPointerMove, true);
  doc.addEventListener('pointerup', onPointerEnd, true);
  doc.addEventListener('pointercancel', onPointerEnd, true);
  doc.addEventListener('contextmenu', onContextMenu, true);
  doc.addEventListener('click', onClick, true);
  return () => {
    cancel();
    doc.removeEventListener('pointerdown', onPointerDown, true);
    doc.removeEventListener('pointermove', onPointerMove, true);
    doc.removeEventListener('pointerup', onPointerEnd, true);
    doc.removeEventListener('pointercancel', onPointerEnd, true);
    doc.removeEventListener('contextmenu', onContextMenu, true);
    doc.removeEventListener('click', onClick, true);
  };
}
