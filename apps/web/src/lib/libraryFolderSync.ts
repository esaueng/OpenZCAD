import {
  cleanFolderName,
  type LibraryFolder,
  type LibraryFolders
} from './libraryFolders';

/**
 * The account copy of the library's folders, and how two devices' copies
 * combine. Nothing reads or writes the account yet; this is the model the
 * sync layer will exchange.
 *
 * Folders stay edited through the device shape (`LibraryFolders`): a change
 * is turned into this record by `recordFolderChanges`, which stamps only the
 * fields it touched. `mergeFolderSets` keeps, per folder field and per
 * project, whichever side stamped it last. A rename on one device and a pin
 * on another therefore both survive, and every device reaches the same
 * result whichever copy it merges first.
 *
 * Membership is recorded per project, not per folder, so a merge can never
 * leave one part in two folders.
 */
export const FOLDER_SET_VERSION = 2;
/** Deleted folders and cleared memberships are remembered this long. */
export const FOLDER_TOMBSTONE_MS = 30 * 24 * 60 * 60 * 1000;

/** When each field last changed, in milliseconds. */
export interface FolderFieldStamps {
  name: number;
  pinned: number;
  cover: number;
  order: number;
}

export interface SyncedFolder {
  name: string;
  pinned: boolean;
  coverProjectId?: string;
  /** Position among folders; ties fall back to the folder id. */
  order: number;
  createdAt: string;
  stamps: FolderFieldStamps;
  /**
   * Milliseconds; when the folder was last deleted. It stays deleted unless
   * a field was changed after that.
   */
  deletedAt?: number;
}

export interface SyncedMember {
  /** Null once the part was taken out of every folder. */
  folderId: string | null;
  /** Position inside the folder; ties fall back to the project id. */
  order: number;
  stamp: number;
}

export interface FolderSet {
  version: typeof FOLDER_SET_VERSION;
  folders: Record<string, SyncedFolder>;
  members: Record<string, SyncedMember>;
}

export const EMPTY_FOLDER_SET: FolderSet = {
  version: FOLDER_SET_VERSION,
  folders: {},
  members: {}
};

const FIELDS = ['name', 'pinned', 'cover', 'order'] as const;

function lastEdited(folder: SyncedFolder): number {
  return Math.max(...FIELDS.map((field) => folder.stamps[field]));
}

/** Whether the folder is on the shelf: never deleted, or edited since. */
export function folderIsLive(folder: SyncedFolder): boolean {
  return (
    folder.deletedAt === undefined || lastEdited(folder) > folder.deletedAt
  );
}

function allStamps(stamp: number): FolderFieldStamps {
  return { name: stamp, pinned: stamp, cover: stamp, order: stamp };
}

function createdStamp(folder: LibraryFolder): number {
  const time = Date.parse(folder.createdAt);
  return Number.isFinite(time) ? time : 0;
}

function syncedFolder(
  folder: LibraryFolder,
  order: number,
  stamps: FolderFieldStamps
): SyncedFolder {
  return {
    name: folder.name,
    pinned: folder.pinned,
    ...(folder.coverProjectId ? { coverProjectId: folder.coverProjectId } : {}),
    order,
    createdAt: folder.createdAt,
    stamps
  };
}

/**
 * A device's folders as they stood before sync existed. Each entry is stamped
 * with its folder's creation time rather than now, so anything another device
 * has since changed on the account wins over this device's untimed state.
 */
export function folderSetFromDevice(state: LibraryFolders): FolderSet {
  const folders: Record<string, SyncedFolder> = {};
  const members: Record<string, SyncedMember> = {};
  state.folders.forEach((folder, index) => {
    const stamp = createdStamp(folder);
    folders[folder.id] = syncedFolder(folder, index, allStamps(stamp));
    folder.projectIds.forEach((projectId, position) => {
      members[projectId] = { folderId: folder.id, order: position, stamp };
    });
  });
  return { version: FOLDER_SET_VERSION, folders, members };
}

function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** The device shape the shelf renders: live folders, in order, with members. */
export function deviceFoldersFromSet(set: FolderSet): LibraryFolders {
  const live = Object.entries(set.folders)
    .filter(([, folder]) => folderIsLive(folder))
    .sort(([aId, a], [bId, b]) => a.order - b.order || compareIds(aId, bId));
  const membersByFolder = new Map<string, [string, SyncedMember][]>();
  for (const entry of Object.entries(set.members)) {
    const folderId = entry[1].folderId;
    if (folderId === null) continue;
    const list = membersByFolder.get(folderId) ?? [];
    list.push(entry);
    membersByFolder.set(folderId, list);
  }
  return {
    folders: live.map(([id, folder]) => {
      const projectIds = (membersByFolder.get(id) ?? [])
        .sort(([aId, a], [bId, b]) => a.order - b.order || compareIds(aId, bId))
        .map(([projectId]) => projectId);
      return {
        id,
        name: folder.name,
        projectIds,
        ...(folder.coverProjectId && projectIds.includes(folder.coverProjectId)
          ? { coverProjectId: folder.coverProjectId }
          : {}),
        pinned: folder.pinned,
        createdAt: folder.createdAt
      };
    })
  };
}

function highestStamp(set: FolderSet): number {
  let highest = 0;
  for (const folder of Object.values(set.folders)) {
    highest = Math.max(highest, lastEdited(folder), folder.deletedAt ?? 0);
  }
  for (const member of Object.values(set.members)) {
    highest = Math.max(highest, member.stamp);
  }
  return highest;
}

/**
 * The stamp for a change made now. Device clocks disagree, so a change is
 * always stamped after everything this device has already seen: an edit made
 * on top of another device's work supersedes it even when this clock is slow.
 */
export function nextFolderStamp(set: FolderSet, now: number): number {
  return Math.max(now, highestStamp(set) + 1);
}

/**
 * Records a device edit (`before` → `after`) into the synced set, stamping
 * only the folder fields and memberships the edit changed.
 */
export function recordFolderChanges(
  set: FolderSet,
  before: LibraryFolders,
  after: LibraryFolders,
  now: number
): FolderSet {
  const stamp = nextFolderStamp(set, now);
  const folders = { ...set.folders };
  const members = { ...set.members };
  const beforeById = new Map(
    before.folders.map((folder, order) => [folder.id, { folder, order }])
  );
  const afterIds = new Set(after.folders.map((folder) => folder.id));

  after.folders.forEach((folder, order) => {
    const previous = beforeById.get(folder.id);
    const synced = folders[folder.id];
    if (!previous || !synced) {
      folders[folder.id] = syncedFolder(folder, order, allStamps(stamp));
      return;
    }
    const changed: Record<(typeof FIELDS)[number], boolean> = {
      name: previous.folder.name !== folder.name,
      pinned: previous.folder.pinned !== folder.pinned,
      cover: previous.folder.coverProjectId !== folder.coverProjectId,
      order: previous.order !== order
    };
    if (!FIELDS.some((field) => changed[field])) return;
    const stamps = { ...synced.stamps };
    for (const field of FIELDS) if (changed[field]) stamps[field] = stamp;
    folders[folder.id] = {
      ...syncedFolder(folder, order, stamps),
      createdAt: synced.createdAt,
      ...(synced.deletedAt !== undefined ? { deletedAt: synced.deletedAt } : {})
    };
  });
  for (const [id, { folder, order }] of beforeById) {
    if (afterIds.has(id)) continue;
    folders[id] = {
      ...(folders[id] ?? syncedFolder(folder, order, allStamps(stamp))),
      deletedAt: stamp
    };
  }

  const placement = (state: LibraryFolders) => {
    const map = new Map<string, { folderId: string; order: number }>();
    for (const folder of state.folders) {
      folder.projectIds.forEach((projectId, order) =>
        map.set(projectId, { folderId: folder.id, order })
      );
    }
    return map;
  };
  const placedBefore = placement(before);
  const placedAfter = placement(after);
  for (const [projectId, place] of placedAfter) {
    const previous = placedBefore.get(projectId);
    if (
      previous?.folderId === place.folderId &&
      previous.order === place.order
    ) {
      continue;
    }
    members[projectId] = { ...place, stamp };
  }
  for (const projectId of placedBefore.keys()) {
    if (placedAfter.has(projectId)) continue;
    members[projectId] = { folderId: null, order: 0, stamp };
  }
  return { version: FOLDER_SET_VERSION, folders, members };
}

/** The later of two stamped values; equal stamps resolve the same way everywhere. */
function later<T>(
  a: { value: T; stamp: number },
  b: { value: T; stamp: number }
): { value: T; stamp: number } {
  if (a.stamp !== b.stamp) return a.stamp > b.stamp ? a : b;
  return JSON.stringify(a.value ?? null) >= JSON.stringify(b.value ?? null)
    ? a
    : b;
}

function mergeFolder(a: SyncedFolder, b: SyncedFolder): SyncedFolder {
  const name = later(
    { value: a.name, stamp: a.stamps.name },
    { value: b.name, stamp: b.stamps.name }
  );
  const pinned = later(
    { value: a.pinned, stamp: a.stamps.pinned },
    { value: b.pinned, stamp: b.stamps.pinned }
  );
  const cover = later(
    { value: a.coverProjectId, stamp: a.stamps.cover },
    { value: b.coverProjectId, stamp: b.stamps.cover }
  );
  const order = later(
    { value: a.order, stamp: a.stamps.order },
    { value: b.order, stamp: b.stamps.order }
  );
  const deletedAt =
    a.deletedAt === undefined
      ? b.deletedAt
      : b.deletedAt === undefined
        ? a.deletedAt
        : Math.max(a.deletedAt, b.deletedAt);
  return {
    name: name.value,
    pinned: pinned.value,
    ...(cover.value ? { coverProjectId: cover.value } : {}),
    order: order.value,
    createdAt: a.createdAt <= b.createdAt ? a.createdAt : b.createdAt,
    stamps: {
      name: name.stamp,
      pinned: pinned.stamp,
      cover: cover.stamp,
      order: order.stamp
    },
    ...(deletedAt !== undefined ? { deletedAt } : {})
  };
}

function mergeMember(a: SyncedMember, b: SyncedMember): SyncedMember {
  if (a.stamp !== b.stamp) return a.stamp > b.stamp ? a : b;
  return JSON.stringify([a.folderId, a.order]) >=
    JSON.stringify([b.folderId, b.order])
    ? a
    : b;
}

/**
 * Combines two copies of the set. Per folder field and per project the later
 * stamp wins; a folder deletion beats every edit stamped before it and loses
 * to any made after. Commutative, associative and idempotent.
 */
export function mergeFolderSets(a: FolderSet, b: FolderSet): FolderSet {
  const folders: Record<string, SyncedFolder> = {};
  for (const id of new Set([
    ...Object.keys(a.folders),
    ...Object.keys(b.folders)
  ])) {
    const left = a.folders[id];
    const right = b.folders[id];
    folders[id] = left && right ? mergeFolder(left, right) : (left ?? right)!;
  }
  const members: Record<string, SyncedMember> = {};
  for (const id of new Set([
    ...Object.keys(a.members),
    ...Object.keys(b.members)
  ])) {
    const left = a.members[id];
    const right = b.members[id];
    members[id] = left && right ? mergeMember(left, right) : (left ?? right)!;
  }
  return { version: FOLDER_SET_VERSION, folders, members };
}

/**
 * Forgets deletions older than the tombstone window. A copy that has been
 * offline for longer than that can bring a deleted folder back; that is the
 * accepted cost of not keeping deletions forever.
 */
export function pruneFolderSet(
  set: FolderSet,
  now: number,
  window = FOLDER_TOMBSTONE_MS
): FolderSet {
  const cutoff = now - window;
  const folders = Object.fromEntries(
    Object.entries(set.folders).filter(
      ([, folder]) => folderIsLive(folder) || (folder.deletedAt ?? 0) >= cutoff
    )
  );
  // A membership in a folder that is gone counts as cleared.
  const members = Object.fromEntries(
    Object.entries(set.members).filter(([, member]) => {
      if (member.stamp >= cutoff) return true;
      const folder =
        member.folderId === null ? undefined : folders[member.folderId];
      return folder !== undefined && folderIsLive(folder);
    })
  );
  return { version: FOLDER_SET_VERSION, folders, members };
}

const MAX_ID_LENGTH = 128;

function validId(id: unknown): id is string {
  return typeof id === 'string' && id.length > 0 && id.length <= MAX_ID_LENGTH;
}

function finiteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function parseStamps(value: unknown): FolderFieldStamps | null {
  if (!value || typeof value !== 'object') return null;
  const stamps = value as Record<string, unknown>;
  const { name, pinned, cover, order } = stamps;
  return finiteNumber(name) &&
    finiteNumber(pinned) &&
    finiteNumber(cover) &&
    finiteNumber(order)
    ? { name, pinned, cover, order }
    : null;
}

/** Reads a set from the account or storage; malformed entries are dropped. */
export function parseFolderSet(value: unknown): FolderSet | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  if (record.version !== FOLDER_SET_VERSION) return null;
  const folders: Record<string, SyncedFolder> = {};
  const members: Record<string, SyncedMember> = {};
  if (record.folders && typeof record.folders === 'object') {
    for (const [id, raw] of Object.entries(record.folders)) {
      if (!validId(id) || !raw || typeof raw !== 'object') continue;
      const entry = raw as Record<string, unknown>;
      const stamps = parseStamps(entry.stamps);
      if (
        !stamps ||
        typeof entry.name !== 'string' ||
        !finiteNumber(entry.order) ||
        typeof entry.createdAt !== 'string' ||
        (entry.deletedAt !== undefined && !finiteNumber(entry.deletedAt)) ||
        (entry.coverProjectId !== undefined && !validId(entry.coverProjectId))
      ) {
        continue;
      }
      folders[id] = {
        name: cleanFolderName(entry.name) || 'Folder',
        pinned: entry.pinned === true,
        ...(entry.coverProjectId !== undefined
          ? { coverProjectId: entry.coverProjectId }
          : {}),
        order: entry.order,
        createdAt: entry.createdAt,
        stamps,
        ...(entry.deletedAt !== undefined ? { deletedAt: entry.deletedAt } : {})
      };
    }
  }
  if (record.members && typeof record.members === 'object') {
    for (const [id, raw] of Object.entries(record.members)) {
      if (!validId(id) || !raw || typeof raw !== 'object') continue;
      const entry = raw as Record<string, unknown>;
      if (
        !(entry.folderId === null || validId(entry.folderId)) ||
        !finiteNumber(entry.order) ||
        !finiteNumber(entry.stamp)
      ) {
        continue;
      }
      members[id] = {
        folderId: entry.folderId,
        order: entry.order,
        stamp: entry.stamp
      };
    }
  }
  return { version: FOLDER_SET_VERSION, folders, members };
}
