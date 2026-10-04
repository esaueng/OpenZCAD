/**
 * The status texts that only name the library's mode once startup settles.
 * The workspace's status bar still shows them; the start screen does not,
 * because its cloud card already says whether the parts are on this device or
 * in the account, and a second line saying "Local workspace" restated it.
 */
export const LIBRARY_MODE_STATUS = {
  checking: 'Checking beta API...',
  offlineMode: 'Offline mode',
  offline: 'Offline workspace',
  local: 'Local workspace',
  cloudReady: 'Cloud profile ready'
} as const;

const MODE_TEXTS: ReadonlySet<string> = new Set(
  Object.values(LIBRARY_MODE_STATUS)
);

/** True for a status the start screen's cloud card already conveys. */
export function isLibraryModeStatus(text: string): boolean {
  return MODE_TEXTS.has(text);
}
