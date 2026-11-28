import { useCallback, useRef, useState } from 'react';

/** Words written into the command bar's field, with an id per write. */
export interface PromptDraft {
  id: number;
  text: string;
}

/**
 * The command bar's draft: words the assistant puts into the prompt line (a
 * suggestion picked to edit before sending, or a question it could not take
 * yet), and the search button's empty draft that opens the bar.
 *
 * A draft is settled when the bar closes. It used to outlive the bar: the
 * workspace remounted for the next project opened or imported, and its new
 * bar took the search button's old draft for a fresh one and opened its
 * full-screen list over the model (the phone review). A draft written while
 * the bar is still loading stays until the bar mounts and takes it.
 *
 * Ids only grow, so a write after a settle is new to a bar that took the one
 * before it, even with the same words.
 */
export function usePromptDraft() {
  const lastId = useRef(0);
  const [draft, setDraft] = useState<PromptDraft | null>(null);
  const write = useCallback((text: string) => {
    lastId.current += 1;
    setDraft({ id: lastId.current, text });
  }, []);
  const settle = useCallback(() => setDraft(null), []);
  return { draft, write, settle };
}
