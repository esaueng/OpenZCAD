import { useState, useSyncExternalStore } from 'react';
import type { PreviewVerdict } from '../lib/keypad';

/** Verdicts arrive at pointer frequency; only the open keypad displays them. */
export function createPreviewVerdictStore() {
  let current: PreviewVerdict | null = null;
  const listeners = new Set<() => void>();
  return {
    getSnapshot: () => current,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    set(verdict: PreviewVerdict | null) {
      if (
        current === verdict ||
        (current?.value === verdict?.value &&
          current?.status === verdict?.status)
      )
        return;
      current = verdict;
      for (const listener of listeners) listener();
    }
  };
}

const noSubscription = () => () => {};
const noVerdict = () => null;

export function usePreviewVerdict(observed: boolean) {
  const [store] = useState(createPreviewVerdictStore);
  const verdict = useSyncExternalStore(
    observed ? store.subscribe : noSubscription,
    observed ? store.getSnapshot : noVerdict,
    noVerdict
  );
  return [verdict, store.set] as const;
}
