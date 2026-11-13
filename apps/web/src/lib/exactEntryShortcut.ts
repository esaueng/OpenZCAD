import { isOperationState, type InteractionState } from './interaction/machine';

export function isTypingTarget(target: HTMLElement | null): boolean {
  if (!target) return false;
  if (['INPUT', 'SELECT', 'TEXTAREA'].includes(target.tagName)) return true;
  const editable = target.closest?.('[contenteditable]');
  return (
    editable != null && editable.getAttribute('contenteditable') !== 'false'
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
