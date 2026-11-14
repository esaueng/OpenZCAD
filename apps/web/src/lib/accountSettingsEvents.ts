import type { AppSettings } from '@openzcad/shared';

/**
 * Settings the account saved that differ from what this page sent: a save
 * that merged this device's edits onto a sealed record it could not open
 * when it last read (ADR-024 amendment 2026-11-14). The settings hook adopts
 * them, so the page shows what the account now holds and its next save does
 * not undo the merge.
 */
type Listener = (userId: string, settings: AppSettings) => void;

const listeners = new Set<Listener>();

export function accountSettingsMerged(
  userId: string,
  settings: AppSettings
): void {
  for (const listener of listeners) listener(userId, settings);
}

export function subscribeAccountSettingsMerged(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
