import { isOperationState, type InteractionState } from './interaction/machine';

export function isTypingTarget(target: HTMLElement | null): boolean {
  if (!target) return false;
  if (['INPUT', 'SELECT', 'TEXTAREA'].includes(target.tagName)) return true;
  const editable = target.closest?.('[contenteditable]');
  return (
    editable != null && editable.getAttribute('contenteditable') !== 'false'
  );
}

/**
 * Marks a control whose Enter is its own wherever focus reached it from:
 * the workspace's key handler leaves Enter on it to the control rather than
 * finishing a running command (Done on a Box), a Move or an Extrude, or
 * opening a pick's value entry. The top bar's "Edit not applied" and
 * History's reopen buttons carry it, so Enter there asks for the refused
 * edit, and that request is refused over work in progress rather than the
 * key creating it.
 */
export const OWN_ENTER_ATTRIBUTE = 'data-own-enter';

/** Whether Enter on `target` belongs to a control marked as owning it. */
export function controlOwnsEnter(target: EventTarget | null): boolean {
  return (
    typeof Element !== 'undefined' &&
    target instanceof Element &&
    target.closest(`[${OWN_ENTER_ATTRIBUTE}]`) !== null
  );
}

/**
 * Whether Enter on `target` is left to it rather than opening the pick's
 * value entry: a control marked as owning Enter, or a row of an open menu.
 * Select other's list is such a menu: Enter on a focused row confirms that
 * row, and opening exact entry instead acted on the pick it would replace
 * (and its preventDefault cancelled the row's own activation).
 */
export function enterSkipsExactEntry(target: EventTarget | null): boolean {
  return (
    controlOwnsEnter(target) ||
    (typeof Element !== 'undefined' &&
      target instanceof Element &&
      target.closest('[role="menu"]') !== null)
  );
}

export function exactEntryShortcut(
  interaction: InteractionState,
  event: Pick<
    KeyboardEvent,
    | 'key'
    | 'ctrlKey'
    | 'metaKey'
    | 'altKey'
    | 'isComposing'
    | 'defaultPrevented'
    | 'repeat'
  >,
  typing: boolean,
  keypadOpen: boolean,
  modelingLocked = false
): { initial?: string } | null {
  if (
    modelingLocked ||
    typing ||
    keypadOpen ||
    event.ctrlKey ||
    event.metaKey ||
    event.altKey ||
    event.isComposing ||
    event.defaultPrevented ||
    !isOperationState(interaction) ||
    (interaction.mode === 'face' && interaction.op === 'remove-face-feature') ||
    (interaction.phase !== 'armed' && interaction.phase !== 'failed')
  )
    return null;
  // Only a fresh press of Enter opens the value entry. A held Enter's
  // auto-repeat belongs to whatever its first keydown did (confirming a
  // Select other row, Done, Apply), not to the focus that press left behind.
  if (event.key === 'Enter') return event.repeat ? null : {};
  return /^[0-9.-]$/.test(event.key) ? { initial: event.key } : null;
}

/**
 * The character a keydown types into a running in-place command's first
 * value (a box's Width): a digit, a minus or a point, pressed outside any
 * field and without a modifier. Null for every other key, which stays a
 * shortcut. Without this the digits reached the view shortcuts, and
 * "100 Tab 60 Tab 6 Enter" turned the camera and then canceled the box.
 */
export function inPlaceTypedEntryKey(
  event: Pick<
    KeyboardEvent,
    | 'key'
    | 'ctrlKey'
    | 'metaKey'
    | 'altKey'
    | 'isComposing'
    | 'defaultPrevented'
  >,
  typing: boolean
): string | null {
  if (
    typing ||
    event.ctrlKey ||
    event.metaKey ||
    event.altKey ||
    event.isComposing ||
    event.defaultPrevented
  )
    return null;
  return /^[0-9.-]$/.test(event.key) ? event.key : null;
}
