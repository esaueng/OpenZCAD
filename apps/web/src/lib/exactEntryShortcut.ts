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
