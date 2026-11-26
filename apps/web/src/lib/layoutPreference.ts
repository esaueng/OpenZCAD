/**
 * Which workspace frame this device draws (U12 slice 2; plan in
 * `docs/plans/compact-mobile-workspace-plan-2026-11-26.md`).
 *
 * The regular workspace is the one every desktop and tablet has today. The
 * compact workspace is built for a phone: one stage, one bottom sheet and a
 * row of mode tabs. Which one shows is a per-device choice, kept in this
 * browser's storage only: a phone and a desktop signed in to the same
 * account want different frames, so it is not an app setting and never
 * reaches the account.
 */

export type LayoutPreference = 'automatic' | 'compact' | 'full';

export type WorkspaceShell = 'regular' | 'compact';

export const LAYOUT_PREFERENCE_STORAGE_KEY = 'openzcad.layout:v1';

export const LAYOUT_PREFERENCES: readonly LayoutPreference[] = [
  'automatic',
  'compact',
  'full'
];

/**
 * The compact size class: a window at most 600 CSS px wide, or at most
 * 500 px tall held sideways. A size class rather than device detection, so a
 * narrow desktop window and an iPad Split View pane qualify as a phone does.
 */
export const COMPACT_SIZE_CLASS_QUERY =
  '(max-width: 600px), (max-height: 500px) and (orientation: landscape)';

/**
 * Whether Automatic picks the compact workspace for the compact size class.
 * Off until the compact workspace reaches every action (plan slice 12): until
 * then Automatic means the regular workspace everywhere, and the compact one
 * is a preview a person turns on in Settings › Appearance › Layout.
 */
export const AUTOMATIC_RESOLVES_TO_COMPACT = false;

export function isLayoutPreference(value: unknown): value is LayoutPreference {
  return (
    typeof value === 'string' &&
    (LAYOUT_PREFERENCES as readonly string[]).includes(value)
  );
}

/**
 * The frame a preference stands for at the current window size. Compact and
 * Full are forced; Automatic follows the size class once
 * `automaticIsCompact` is on.
 */
export function resolveWorkspaceShell(
  preference: LayoutPreference,
  compactClass: boolean,
  automaticIsCompact: boolean = AUTOMATIC_RESOLVES_TO_COMPACT
): WorkspaceShell {
  if (preference === 'compact') return 'compact';
  if (preference === 'full') return 'regular';
  return automaticIsCompact && compactClass ? 'compact' : 'regular';
}

type PreferenceStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

/**
 * The browser's storage, or null where reading it throws (a sandboxed
 * frame, storage blocked by the user) or it does not exist.
 */
function defaultStorage(): PreferenceStorage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

/** The stored preference; Automatic when none is stored or storage fails. */
export function readLayoutPreference(
  storage: PreferenceStorage | null = defaultStorage()
): LayoutPreference {
  try {
    const stored = storage?.getItem(LAYOUT_PREFERENCE_STORAGE_KEY);
    return isLayoutPreference(stored) ? stored : 'automatic';
  } catch {
    return 'automatic';
  }
}

const listeners = new Set<() => void>();
/**
 * The preference this page last set. Storage can refuse the write (full,
 * blocked, private mode), and the choice still holds for this visit.
 */
let sessionPreference: LayoutPreference | null = null;

/** The preference in force on this page. */
export function currentLayoutPreference(
  storage: PreferenceStorage | null = defaultStorage()
): LayoutPreference {
  return sessionPreference ?? readLayoutPreference(storage);
}

/**
 * Stores the preference and tells every subscriber. Automatic removes the
 * key, so a device that never chose keeps following the default. Returns
 * whether storage took it; the page follows the choice either way.
 */
export function writeLayoutPreference(
  preference: LayoutPreference,
  storage: PreferenceStorage | null = defaultStorage()
): boolean {
  sessionPreference = preference;
  let stored = false;
  try {
    if (storage) {
      if (preference === 'automatic') {
        storage.removeItem(LAYOUT_PREFERENCE_STORAGE_KEY);
      } else {
        storage.setItem(LAYOUT_PREFERENCE_STORAGE_KEY, preference);
      }
      stored = true;
    }
  } catch {
    stored = false;
  }
  for (const listener of [...listeners]) listener();
  return stored;
}

/**
 * Calls `listener` when the preference changes on this page or in another
 * tab (the `storage` event). Returns the unsubscribe.
 */
export function subscribeLayoutPreference(listener: () => void): () => void {
  listeners.add(listener);
  const onStorage = (event: StorageEvent) => {
    if (event.key !== LAYOUT_PREFERENCE_STORAGE_KEY && event.key !== null) {
      return;
    }
    // Another tab chose: its stored value wins over this page's last one.
    sessionPreference = null;
    listener();
  };
  if (typeof window !== 'undefined') {
    window.addEventListener('storage', onStorage);
  }
  return () => {
    listeners.delete(listener);
    if (typeof window !== 'undefined') {
      window.removeEventListener('storage', onStorage);
    }
  };
}

/** Forgets this page's choice; for tests. */
export function resetLayoutPreferenceForTests(): void {
  sessionPreference = null;
  listeners.clear();
}
