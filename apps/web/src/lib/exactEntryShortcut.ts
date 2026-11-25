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
  if (event.key === 'Enter') return {};
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
