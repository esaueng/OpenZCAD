import type { AppSettings } from '@openzcad/shared';

/**
 * Settings the account saved that differ from what this page sent: a save
 * that merged this device's edits onto a sealed record it could not open
 * when it last read (ADR-024 amendment 2026-11-14). The settings hook merges
 * them into what the page shows now, keeping any edit made since it sent.
 */
type Listener = (userId: string, sent: AppSettings, saved: AppSettings) => void;

const listeners = new Set<Listener>();

/** `sent` is what the page sent; `saved` what the account now holds. */
export function accountSettingsMerged(
  userId: string,
  sent: AppSettings,
  saved: AppSettings
): void {
  for (const listener of listeners) listener(userId, sent, saved);
}

export function subscribeAccountSettingsMerged(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
