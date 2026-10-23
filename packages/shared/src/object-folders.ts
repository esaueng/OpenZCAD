import type { BodyId } from './index';

/**
 * U06 Objects folders (schema v34): named, nestable folders that organize
 * bodies in the Objects browser. Membership is organization only — it is
 * independent of geometry, so no rebuild reads it — and every change is one
 * undoable `objectFolder.*` command. Nested `parentId`s leave room for the
 * I02 STEP assembly hierarchy, which lands as nested folders.
 *
 * A body's folder is its explicit placement when it has one; otherwise the
 * folder of the body it was made from (a fillet's or a boolean's base
 * body), so a body keeps its place as features reshape it under new ids.
 */
export interface ObjectFolder {
  id: string;
  name: string;
  /** The enclosing folder; null at the top level. */
  parentId: string | null;
}

export interface ObjectFolderSet {
  /** Every folder, in display order among its siblings. */
  folders: ObjectFolder[];
  /**
   * Explicit placements: a body's folder, or null for one moved out to the
   * top level. A body absent here follows the body it was made from.
   */
  placements: Partial<Record<BodyId, string | null>>;
}

export const MAX_OBJECT_FOLDERS = 500;
export const MAX_OBJECT_FOLDER_DEPTH = 32;
export const MAX_OBJECT_FOLDER_NAME_LENGTH = 120;
const MAX_OBJECT_FOLDER_ID_LENGTH = 64;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_OBJECT_FOLDER_ID_LENGTH
  );
}

/** Why a value is not a valid folder section, or null when it is one. */
export function objectFolderSetError(value: unknown): string | null {
  if (
    !isRecord(value) ||
    !Array.isArray(value.folders) ||
    !isRecord(value.placements)
  )
    return 'The Objects folder section is not a folder list.';
  if (value.folders.length > MAX_OBJECT_FOLDERS)
    return `A project holds at most ${MAX_OBJECT_FOLDERS} Objects folders.`;
  const parents = new Map<string, string | null>();
  for (const folder of value.folders) {
    if (!isRecord(folder) || !isId(folder.id))
      return 'An Objects folder has no id.';
    if (parents.has(folder.id))
      return `Objects folder ${folder.id} is listed twice.`;
    if (
      typeof folder.name !== 'string' ||
      folder.name.trim() === '' ||
      folder.name !== folder.name.trim() ||
      folder.name.length > MAX_OBJECT_FOLDER_NAME_LENGTH
    )
      return `Objects folder ${folder.id} has no usable name.`;
    if (folder.parentId !== null && !isId(folder.parentId))
      return `Objects folder ${folder.id} has a malformed parent.`;
    parents.set(folder.id, folder.parentId);
  }
  for (const [id, parentId] of parents) {
    if (parentId !== null && !parents.has(parentId))
      return `Objects folder ${id} is inside a folder that does not exist.`;
    let depth = 0;
    for (let at = parentId; at !== null; at = parents.get(at) ?? null) {
      if (at === id || ++depth > MAX_OBJECT_FOLDER_DEPTH)
        return `Objects folder ${id} is inside itself.`;
    }
  }
  for (const [bodyId, folderId] of Object.entries(value.placements)) {
    if (!isId(bodyId)) return 'An Objects folder placement has no body.';
    if (folderId !== null && !(isId(folderId) && parents.has(folderId)))
      return `Body ${bodyId} is placed in a folder that does not exist.`;
  }
  return null;
}

/** Fails closed on a malformed folder section; absent is valid. */
export function assertObjectFolderSet(value: unknown): void {
  if (value === undefined) return;
  const error = objectFolderSetError(value);
  if (error) throw new Error(error);
}
