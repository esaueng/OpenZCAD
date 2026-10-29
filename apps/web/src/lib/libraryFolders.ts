import { useCallback, useSyncExternalStore } from 'react';

/**
 * Folders on the parts library: a way to group parts on this device's shelf.
 *
 * A folder is shelf furniture, like a pin, but unlike a pin it is not part of
 * a project's organization record: it lives in this browser's storage, under
 * the signed-in account, and never reaches the account or another device.
 * The account mirror would need a folder table and, for encrypted accounts,
 * encrypted folder names (ADR-024); until then folders are per device.
 *
 * Membership is by project id. A part belongs to at most one folder; an id
 * the library no longer lists is kept (the part may be in the trash, or the
 * listing still loading) and simply not shown.
 */
export interface LibraryFolder {
  id: string;
  name: string;
  /** Members, front to back. */
  projectIds: string[];
  /** The part whose preview stands for the folder; the first member if unset. */
  coverProjectId?: string;
  pinned: boolean;
  createdAt: string;
}

export interface LibraryFolders {
  /** Front to back. */
  folders: LibraryFolder[];
}

export const MAX_FOLDER_NAME_LENGTH = 80;
const STORAGE_PREFIX = 'openzcad.library.folders.v1';
const EMPTY: LibraryFolders = { folders: [] };

export function folderStorageKey(accountId: string | null | undefined) {
  return `${STORAGE_PREFIX}:${accountId ?? 'device'}`;
}

/** Anything malformed is dropped rather than trusted. */
export function parseLibraryFolders(raw: string | null): LibraryFolders {
  if (!raw) return EMPTY;
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== 'object') return EMPTY;
    const list = (value as { folders?: unknown }).folders;
    if (!Array.isArray(list)) return EMPTY;
    const seen = new Set<string>();
    const claimed = new Set<string>();
    const folders: LibraryFolder[] = [];
    for (const entry of list) {
      if (!entry || typeof entry !== 'object') continue;
      const { id, name, projectIds, coverProjectId, pinned, createdAt } =
        entry as Record<string, unknown>;
      if (typeof id !== 'string' || !id || seen.has(id)) continue;
      if (typeof name !== 'string') continue;
      seen.add(id);
      // A part sits in one folder: a second claim on it is dropped.
      const members: string[] = [];
      for (const projectId of Array.isArray(projectIds) ? projectIds : []) {
        if (typeof projectId === 'string' && !claimed.has(projectId)) {
          claimed.add(projectId);
          members.push(projectId);
        }
      }
      folders.push({
        id,
        name: cleanFolderName(name) || 'Folder',
        projectIds: members,
        ...(typeof coverProjectId === 'string' &&
        members.includes(coverProjectId)
          ? { coverProjectId }
          : {}),
        pinned: pinned === true,
        createdAt:
          typeof createdAt === 'string' ? createdAt : new Date(0).toISOString()
      });
    }
    return { folders };
  } catch {
    return EMPTY;
  }
}

export function cleanFolderName(name: string): string {
  return name.replace(/\s+/g, ' ').trim().slice(0, MAX_FOLDER_NAME_LENGTH);
}

/** "New folder", then "New folder 2", and so on: never a duplicate. */
export function nextFolderName(
  state: LibraryFolders,
  base = 'New folder'
): string {
  const taken = new Set(state.folders.map((folder) => folder.name));
  if (!taken.has(base)) return base;
  let index = 2;
  while (taken.has(`${base} ${index}`)) index += 1;
  return `${base} ${index}`;
}

export function folderOf(
  state: LibraryFolders,
  projectId: string
): LibraryFolder | undefined {
  return state.folders.find((folder) => folder.projectIds.includes(projectId));
}

/** The member whose preview the folder shows, among the ones listed. */
export function folderCover(
  folder: LibraryFolder,
  listed: ReadonlySet<string>
): string | undefined {
  if (folder.coverProjectId && listed.has(folder.coverProjectId)) {
    return folder.coverProjectId;
  }
  return folder.projectIds.find((projectId) => listed.has(projectId));
}

function withoutProjects(
  folders: LibraryFolder[],
  projectIds: ReadonlySet<string>
): LibraryFolder[] {
  return folders.map((folder) => {
    if (!folder.projectIds.some((projectId) => projectIds.has(projectId))) {
      return folder;
    }
    const remaining = folder.projectIds.filter(
      (projectId) => !projectIds.has(projectId)
    );
    const { coverProjectId, ...rest } = folder;
    return coverProjectId && remaining.includes(coverProjectId)
      ? { ...rest, coverProjectId, projectIds: remaining }
      : { ...rest, projectIds: remaining };
  });
}

export function createFolder(
  state: LibraryFolders,
  options: {
    id: string;
    name?: string;
    projectIds?: string[];
    pinned?: boolean;
    now?: string;
  }
): LibraryFolders {
  const members = [...new Set(options.projectIds ?? [])];
  const folder: LibraryFolder = {
    id: options.id,
    name: cleanFolderName(options.name ?? '') || nextFolderName(state),
    projectIds: members,
    pinned: options.pinned ?? false,
    createdAt: options.now ?? new Date().toISOString()
  };
  return {
    folders: [...withoutProjects(state.folders, new Set(members)), folder]
  };
}

/**
 * Files the parts in a folder, out of whichever one held them, appended in
 * the order given. A null folder takes them out of every folder.
 */
export function moveProjectsToFolder(
  state: LibraryFolders,
  projectIds: readonly string[],
  folderId: string | null
): LibraryFolders {
  const moving = new Set(projectIds);
  const folders = withoutProjects(state.folders, moving);
  if (folderId === null) return { folders };
  // A part moved within its own folder (a reorder) never left it, so the
  // folder keeps the cover it had.
  const cover = state.folders.find(
    (folder) => folder.id === folderId
  )?.coverProjectId;
  return {
    folders: folders.map((folder) =>
      folder.id === folderId
        ? {
            ...folder,
            projectIds: [
              ...folder.projectIds,
              ...projectIds.filter(
                (id, index, all) => all.indexOf(id) === index
              )
            ],
            ...(cover ? { coverProjectId: cover } : {})
          }
        : folder
    )
  };
}

/**
 * A new order for the folder's parts that are on screen. Members the shelf
 * is not showing (archived, trashed, not yet listed) keep their slots; the
 * shown ones fill the remaining slots in the order given.
 */
export function reorderFolderMembers(
  state: LibraryFolders,
  folderId: string,
  shownIds: readonly string[]
): LibraryFolders {
  return updateFolder(state, folderId, (folder) => {
    const shown = new Set(shownIds);
    const queue = shownIds.filter((id) => folder.projectIds.includes(id));
    if (queue.length !== shown.size) return folder;
    const projectIds = folder.projectIds.map((id) =>
      shown.has(id) ? queue.shift()! : id
    );
    return { ...folder, projectIds };
  });
}

/** Forgets parts that no longer exist anywhere (deleted forever). */
export function forgetProjects(
  state: LibraryFolders,
  projectIds: readonly string[]
): LibraryFolders {
  return { folders: withoutProjects(state.folders, new Set(projectIds)) };
}

function updateFolder(
  state: LibraryFolders,
  folderId: string,
  update: (folder: LibraryFolder) => LibraryFolder
): LibraryFolders {
  return {
    folders: state.folders.map((folder) =>
      folder.id === folderId ? update(folder) : folder
    )
  };
}

export function renameFolder(
  state: LibraryFolders,
  folderId: string,
  name: string
): LibraryFolders {
  const clean = cleanFolderName(name);
  return clean
    ? updateFolder(state, folderId, (folder) => ({ ...folder, name: clean }))
    : state;
}

export function setFolderCover(
  state: LibraryFolders,
  folderId: string,
  projectId: string
): LibraryFolders {
  return updateFolder(state, folderId, (folder) =>
    folder.projectIds.includes(projectId)
      ? { ...folder, coverProjectId: projectId }
      : folder
  );
}

export function setFolderPinned(
  state: LibraryFolders,
  folderId: string,
  pinned: boolean
): LibraryFolders {
  return updateFolder(state, folderId, (folder) => ({ ...folder, pinned }));
}

/** Removes the folder; its parts go back onto the shelf. */
export function deleteFolder(
  state: LibraryFolders,
  folderId: string
): LibraryFolders {
  return { folders: state.folders.filter((folder) => folder.id !== folderId) };
}

/** Folders in a new order; any not named keep their place at the end. */
export function reorderFolders(
  state: LibraryFolders,
  folderIds: readonly string[]
): LibraryFolders {
  const byId = new Map(state.folders.map((folder) => [folder.id, folder]));
  const ordered = folderIds.flatMap((id) => {
    const folder = byId.get(id);
    byId.delete(id);
    return folder ? [folder] : [];
  });
  return { folders: [...ordered, ...byId.values()] };
}

export function newFolderId(): string {
  return `folder-${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`}`;
}

// ── Storage ────────────────────────────────────────────────────────────────

const listeners = new Set<() => void>();
const snapshots = new Map<
  string,
  { raw: string | null; value: LibraryFolders }
>();

// Folders written while storage refused them (blocked, full or absent): kept
// for this visit, and read in place of storage until a write succeeds.
const unsaved = new Map<string, string>();

function readRaw(key: string): string | null {
  const pending = unsaved.get(key);
  if (pending !== undefined) return pending;
  try {
    return globalThis.localStorage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

/** One parsed value per stored string, so React sees a stable snapshot. */
export function readLibraryFolders(key: string): LibraryFolders {
  const raw = readRaw(key);
  const cached = snapshots.get(key);
  if (cached && cached.raw === raw) return cached.value;
  const value = parseLibraryFolders(raw);
  snapshots.set(key, { raw, value });
  return value;
}

export function writeLibraryFolders(key: string, state: LibraryFolders) {
  const raw = JSON.stringify(state);
  try {
    if (!globalThis.localStorage) throw new Error('No local storage');
    globalThis.localStorage.setItem(key, raw);
    unsaved.delete(key);
  } catch {
    // Blocked or full storage keeps the folders for this visit only.
    unsaved.set(key, raw);
  }
  snapshots.set(key, { raw, value: state });
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  // Another tab's change arrives as a storage event.
  const onStorage = (event: StorageEvent) => {
    if (event.key?.startsWith(STORAGE_PREFIX)) listener();
  };
  globalThis.addEventListener?.('storage', onStorage);
  return () => {
    listeners.delete(listener);
    globalThis.removeEventListener?.('storage', onStorage);
  };
}

/** The account's folders on this device, and a way to change them. */
export function useLibraryFolders(accountId: string | null | undefined) {
  const key = folderStorageKey(accountId);
  const state = useSyncExternalStore(
    subscribe,
    () => readLibraryFolders(key),
    () => EMPTY
  );
  const update = useCallback(
    (change: (current: LibraryFolders) => LibraryFolders) => {
      const next = change(readLibraryFolders(key));
      writeLibraryFolders(key, next);
    },
    [key]
  );
  return [state, update] as const;
}
