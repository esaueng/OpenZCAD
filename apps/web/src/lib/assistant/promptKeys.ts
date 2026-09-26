/**
 * Keys the prompt line hands to the conversation standing on it.
 *
 * The command bar owns the one text field on the stage and the assistant
 * owns the proposal waiting at the foot of its stream. They are separate
 * components in separate trees, so a keystroke on the empty prompt reaches
 * the stream as a cancelable window event: the stream calls
 * `preventDefault()` when it has taken the key, and the bar then leaves its
 * own default (typing the letter, dropping focus) alone.
 */
export const ASSISTANT_PROMPT_KEY_EVENT = 'openzcad:assistant-prompt-key';

export type AssistantPromptKey =
  /** Enter on the empty prompt: apply the open proposal, or send pending drawings. */
  | 'apply'
  /** `p` on the empty prompt: toggle the open proposal's viewport preview. */
  | 'preview'
  /** Escape on the empty prompt: reject the open proposal. */
  | 'reject'
  /** ⌘↑ / Ctrl+↑: open or close scrollback. */
  | 'history';

export interface AssistantPromptKeyDetail {
  key: AssistantPromptKey;
}

/** Sends a prompt key to whoever is listening; true when something took it. */
export function sendAssistantPromptKey(key: AssistantPromptKey): boolean {
  const event = new CustomEvent<AssistantPromptKeyDetail>(
    ASSISTANT_PROMPT_KEY_EVENT,
    { detail: { key }, cancelable: true }
  );
  window.dispatchEvent(event);
  return event.defaultPrevented;
}
