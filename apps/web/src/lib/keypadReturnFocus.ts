/**
 * Focus handback for controls that open the numeric keypad from the
 * keyboard (a viewport value chip). The keypad takes focus into its field;
 * when it closes, focus fell to <body> and a keyboard user lost their place.
 *
 * Only a keyboard opening is marked. After a pointer opening, focus is left
 * where it falls, so a click, a typed value and Enter, then Enter again
 * still finishes the command rather than reopening the chip's keypad.
 */
const ATTRIBUTE = 'data-keypad-return-focus';

/** Marks `control` as opened from the keyboard, or clears the mark. */
export function markKeypadOpener(
  control: HTMLElement,
  keyboard: boolean
): void {
  if (keyboard) control.setAttribute(ATTRIBUTE, '');
  else control.removeAttribute(ATTRIBUTE);
}

/** The focused control the keypad should hand focus back to, if any. */
export function keypadReturnTarget(): HTMLElement | null {
  const active = document.activeElement;
  return active instanceof HTMLElement && active.hasAttribute(ATTRIBUTE)
    ? active
    : null;
}

/**
 * Hands focus back to `target` once the keypad has gone, unless it has left
 * the page, is hidden, or focus has already moved somewhere on purpose.
 */
export function returnKeypadFocus(target: HTMLElement | null): void {
  if (!target) return;
  target.removeAttribute(ATTRIBUTE);
  // After the keypad's own nodes are removed, so the check below sees where
  // focus actually landed.
  queueMicrotask(() => {
    if (!target.isConnected || target.hidden) return;
    const active = document.activeElement;
    if (active && active !== document.body) return;
    target.focus({ preventScroll: true });
  });
}
