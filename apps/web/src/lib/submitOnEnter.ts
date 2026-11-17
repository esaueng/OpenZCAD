import type { KeyboardEvent } from 'react';

/** Input types whose Enter belongs to the control itself, not the form. */
const OWN_ENTER = new Set(['button', 'submit', 'reset', 'image', 'file']);

/**
 * Makes Enter in a dialog form's fields submit it, whatever the field.
 *
 * Browsers submit implicitly from a text field but not reliably from a radio
 * or checkbox: in the Units dialog, Enter on the focused "Millimeters" radio
 * did nothing. Handling the key here, rather than leaning on implicit
 * submission, gives every field the same answer, and `requestSubmit` runs
 * the form's own submit handler, which keeps each dialog's guard (a blocked
 * export stays blocked). Buttons, selects and text areas keep their own
 * Enter, and so does a key that is composing text.
 */
export function submitOnEnter(event: KeyboardEvent<HTMLFormElement>): void {
  if (
    event.key !== 'Enter' ||
    event.defaultPrevented ||
    event.nativeEvent.isComposing ||
    event.altKey ||
    event.ctrlKey ||
    event.metaKey ||
    event.shiftKey
  ) {
    return;
  }
  const target = event.target;
  if (
    !(target instanceof HTMLInputElement) ||
    OWN_ENTER.has(target.type) ||
    target.form !== event.currentTarget
  ) {
    return;
  }
  event.preventDefault();
  event.currentTarget.requestSubmit();
}
