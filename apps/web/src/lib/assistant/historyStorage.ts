/** Account-session cleanup stays lightweight even while the assistant is lazy. */
export const ASSISTANT_HISTORY_STORAGE_KEY = 'openzcad-assistant-history:v1';

export const ASSISTANT_HISTORY_CLEARED_EVENT =
  'openzcad-assistant-history-cleared';
export function clearAssistantHistory(): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.removeItem(ASSISTANT_HISTORY_STORAGE_KEY);
  } catch {
    // Storage restrictions must not interrupt sign-out or in-memory cleanup.
  } finally {
    window.dispatchEvent(new Event(ASSISTANT_HISTORY_CLEARED_EVENT));
  }
}
