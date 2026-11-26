import { useCallback, useSyncExternalStore } from 'react';
import {
  COMPACT_SIZE_CLASS_QUERY,
  currentLayoutPreference,
  resolveWorkspaceShell,
  subscribeLayoutPreference,
  writeLayoutPreference,
  type LayoutPreference,
  type WorkspaceShell
} from '../lib/layoutPreference';
import { useMediaQuery } from './useMediaQuery';

/** This device's layout preference, kept current across tabs. */
export function useLayoutPreference(): [
  LayoutPreference,
  (preference: LayoutPreference) => void
] {
  const preference = useSyncExternalStore(
    subscribeLayoutPreference,
    () => currentLayoutPreference(),
    () => 'automatic' as const
  );
  const set = useCallback((next: LayoutPreference) => {
    writeLayoutPreference(next);
  }, []);
  return [preference, set];
}

/**
 * The workspace frame in force: re-rendered when the preference or the
 * window's size class changes.
 */
export function useWorkspaceShell(): {
  preference: LayoutPreference;
  compactClass: boolean;
  shell: WorkspaceShell;
} {
  const [preference] = useLayoutPreference();
  const compactClass = useMediaQuery(COMPACT_SIZE_CLASS_QUERY);
  return {
    preference,
    compactClass,
    shell: resolveWorkspaceShell(preference, compactClass)
  };
}
