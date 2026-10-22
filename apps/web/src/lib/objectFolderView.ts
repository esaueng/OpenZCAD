import { useCallback, useState } from 'react';

/**
 * Which Objects folders are collapsed, per project, on this device. Folding
 * a folder is a way of looking at the model, not a change to it: kept in the
 * document it would mark the project changed whenever someone tidied the
 * browser.
 */
export const COLLAPSED_FOLDERS_STORAGE_KEY = 'openzcad-objects-collapsed:v1';
/** Projects remembered at once; the oldest entries go first. */
const MAX_PROJECTS = 50;

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;

function defaultStorage(): StorageLike | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

function readAll(storage: StorageLike | null): Record<string, string[]> {
  try {
    const raw = storage?.getItem(COLLAPSED_FOLDERS_STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {};
    }
    const entries = Object.entries(parsed as Record<string, unknown>).filter(
      (entry): entry is [string, string[]] =>
        Array.isArray(entry[1]) &&
        entry[1].every((id) => typeof id === 'string')
    );
    return Object.fromEntries(entries);
  } catch {
    return {};
  }
}

export function loadCollapsedFolders(
  projectId: string,
  storage: StorageLike | null = defaultStorage()
): Set<string> {
  return new Set(readAll(storage)[projectId] ?? []);
}

export function saveCollapsedFolders(
  projectId: string,
  collapsed: ReadonlySet<string>,
  storage: StorageLike | null = defaultStorage()
): void {
  const all = readAll(storage);
  delete all[projectId];
  if (collapsed.size > 0) all[projectId] = [...collapsed];
  const kept = Object.entries(all).slice(-MAX_PROJECTS);
  try {
    storage?.setItem(
      COLLAPSED_FOLDERS_STORAGE_KEY,
      JSON.stringify(Object.fromEntries(kept))
    );
  } catch {
    // A full or blocked storage only forgets which folders were folded.
  }
}

/** The collapsed folders of one project, remembered on this device. */
export function useCollapsedFolders(projectId: string | null): {
  collapsed: ReadonlySet<string>;
  toggle(folderId: string): void;
  expand(folderId: string): void;
} {
  const [state, setState] = useState(() => ({
    projectId,
    collapsed: projectId ? loadCollapsedFolders(projectId) : new Set<string>()
  }));
  // Another project opened in the same panel: read its own folds.
  let current = state;
  if (state.projectId !== projectId) {
    current = {
      projectId,
      collapsed: projectId ? loadCollapsedFolders(projectId) : new Set()
    };
    setState(current);
  }
  const update = useCallback(
    (edit: (next: Set<string>) => void) =>
      setState((previous) => {
        const next = new Set(previous.collapsed);
        edit(next);
        if (previous.projectId) saveCollapsedFolders(previous.projectId, next);
        return { ...previous, collapsed: next };
      }),
    []
  );
  const toggle = useCallback(
    (folderId: string) =>
      update((next) => {
        if (!next.delete(folderId)) next.add(folderId);
      }),
    [update]
  );
  const expand = useCallback(
    (folderId: string) => update((next) => void next.delete(folderId)),
    [update]
  );
  return { collapsed: current.collapsed, toggle, expand };
}
