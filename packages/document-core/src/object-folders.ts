import { assertObjectFolderSchema } from './document-content-schema';
import {
  assertObjectFolderSet,
  deepClone,
  type BodyId,
  type BodyNode,
  type FeatureNode,
  type ObjectFolder,
  type ObjectFolderSet,
  type ProjectDocument
} from '@openzcad/shared';

/**
 * U06 Objects folder commands (schema v34). Each carries explicit ids and
 * names, so undo, redo and replay reproduce the same folders, and none of
 * them changes geometry: a rebuild never reads `objectFolders`.
 */

export interface ObjectFolderCreateInput {
  folderId: string;
  name: string;
  parentId: string | null;
  /** Bodies moved into the new folder in the same step. */
  bodyIds?: BodyId[];
}

export interface ObjectFolderRenameInput {
  folderId: string;
  name: string;
}

export interface ObjectFolderDeleteInput {
  folderId: string;
}

export interface ObjectFolderMoveInput {
  /** Where everything goes; null is the top level. */
  parentId: string | null;
  bodyIds?: BodyId[];
  folderIds?: string[];
}

const EMPTY: ObjectFolderSet = { folders: [], placements: {} };

function withFolders(
  document: ProjectDocument,
  edit: (set: ObjectFolderSet) => ObjectFolderSet
): ProjectDocument {
  assertObjectFolderSchema(document.schemaVersion);
  const before = document.objectFolders ?? EMPTY;
  const after = edit(deepClone(before));
  // A move that changes nothing returns the same document, which the command
  // manager records as no edit at all.
  if (JSON.stringify(after) === JSON.stringify(before)) return document;
  const empty =
    after.folders.length === 0 && Object.keys(after.placements).length === 0;
  const objectFolders = empty ? undefined : after;
  assertObjectFolderSet(objectFolders);
  const { objectFolders: _previous, ...rest } = document;
  return {
    ...rest,
    // Fresh arrays: the command manager appends this command to the log of
    // the document returned here, and a shared array would write it into
    // the previous document too.
    commandLog: [...document.commandLog],
    revisions: [...document.revisions],
    checkpoints: [...document.checkpoints],
    ...(objectFolders ? { objectFolders } : {}),
    version: document.version + 1
  };
}

function folderName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) throw new Error('A folder needs a name.');
  return trimmed;
}

function assertFolder(set: ObjectFolderSet, folderId: string | null): void {
  if (folderId !== null && !set.folders.some((f) => f.id === folderId))
    throw new Error(`Objects folder ${folderId} not found.`);
}

function assertBodiesExist(document: ProjectDocument, bodyIds: BodyId[]): void {
  const known = new Set(document.bodyOrder);
  const missing = bodyIds.find((id) => !known.has(id));
  if (missing) throw new Error(`Body ${missing} is not in this project.`);
}

function isInside(
  set: ObjectFolderSet,
  folderId: string | null,
  ancestorId: string
): boolean {
  const parents = new Map(set.folders.map((f) => [f.id, f.parentId]));
  for (let at = folderId; at !== null; at = parents.get(at) ?? null) {
    if (at === ancestorId) return true;
  }
  return false;
}

/**
 * Explicit placements, so a body keeps the folder it is put in even when the
 * body it was made from moves elsewhere. Placing a body where its lineage
 * would put it anyway still records it: the user's choice is the fact.
 */
function place(
  document: ProjectDocument,
  set: ObjectFolderSet,
  bodyIds: BodyId[],
  folderId: string | null
): void {
  for (const bodyId of bodyIds) {
    // A body placed at the top level that would land there anyway needs no
    // entry; keep the section small and an empty folder set absent.
    if (
      folderId === null &&
      objectFolderOfBody(
        { ...document, objectFolders: withoutPlacement(set, bodyId) },
        bodyId
      ) === null
    ) {
      delete set.placements[bodyId];
    } else {
      set.placements[bodyId] = folderId;
    }
  }
}

function withoutPlacement(
  set: ObjectFolderSet,
  bodyId: BodyId
): ObjectFolderSet {
  const placements = { ...set.placements };
  delete placements[bodyId];
  return { folders: set.folders, placements };
}

export function createObjectFolder(
  document: ProjectDocument,
  input: ObjectFolderCreateInput
): ProjectDocument {
  const name = folderName(input.name);
  const bodyIds = input.bodyIds ?? [];
  assertBodiesExist(document, bodyIds);
  return withFolders(document, (set) => {
    if (set.folders.some((folder) => folder.id === input.folderId))
      throw new Error(`Objects folder ${input.folderId} already exists.`);
    assertFolder(set, input.parentId);
    set.folders.push({ id: input.folderId, name, parentId: input.parentId });
    place(document, set, bodyIds, input.folderId);
    return set;
  });
}

export function renameObjectFolder(
  document: ProjectDocument,
  input: ObjectFolderRenameInput
): ProjectDocument {
  const name = folderName(input.name);
  return withFolders(document, (set) => {
    const folder = set.folders.find((f) => f.id === input.folderId);
    if (!folder) throw new Error(`Objects folder ${input.folderId} not found.`);
    folder.name = name;
    return set;
  });
}

/**
 * Deletes the folder only: its bodies and folders move up to its parent, so
 * nothing in the model is lost and the step undoes as one.
 */
export function deleteObjectFolder(
  document: ProjectDocument,
  input: ObjectFolderDeleteInput
): ProjectDocument {
  return withFolders(document, (set) => {
    const folder = set.folders.find((f) => f.id === input.folderId);
    if (!folder) throw new Error(`Objects folder ${input.folderId} not found.`);
    // Bodies that only followed their source into this folder now follow it
    // to the parent, which an explicit placement records.
    const placements = objectFolderPlacements(document);
    const members = document.bodyOrder.filter(
      (bodyId) => placements.get(bodyId) === folder.id
    );
    for (const child of set.folders) {
      if (child.parentId === folder.id) child.parentId = folder.parentId;
    }
    set.folders = set.folders.filter((f) => f.id !== folder.id);
    for (const [bodyId, folderId] of Object.entries(set.placements)) {
      if (folderId === folder.id) delete set.placements[bodyId as BodyId];
    }
    place(document, set, members, folder.parentId);
    return set;
  });
}

/** Moves bodies and folders into a folder, or out to the top level. */
export function moveToObjectFolder(
  document: ProjectDocument,
  input: ObjectFolderMoveInput
): ProjectDocument {
  const bodyIds = input.bodyIds ?? [];
  const folderIds = input.folderIds ?? [];
  assertBodiesExist(document, bodyIds);
  return withFolders(document, (set) => {
    assertFolder(set, input.parentId);
    for (const folderId of folderIds) {
      const folder = set.folders.find((f) => f.id === folderId);
      if (!folder) throw new Error(`Objects folder ${folderId} not found.`);
      if (isInside(set, input.parentId, folderId))
        throw new Error(`${folder.name} cannot go inside itself.`);
      if (folder.parentId !== input.parentId) {
        // Last among its new siblings, where a drop lands.
        set.folders = [
          ...set.folders.filter((f) => f.id !== folderId),
          { ...folder, parentId: input.parentId }
        ];
      }
    }
    place(document, set, bodyIds, input.parentId);
    return set;
  });
}

function bodyNodes(document: ProjectDocument): Map<BodyId, BodyNode> {
  const nodes = new Map<BodyId, BodyNode>();
  for (const node of Object.values(document.nodes)) {
    if (node.kind === 'body') nodes.set(node.bodyId, node);
  }
  return nodes;
}

function featureNodes(document: ProjectDocument): Map<string, FeatureNode> {
  const nodes = new Map<string, FeatureNode>();
  for (const node of Object.values(document.nodes)) {
    if (node.kind === 'feature') nodes.set(node.featureId, node);
  }
  return nodes;
}

/**
 * The body a body was made from: its feature's target (a fillet's, a hole's,
 * a pattern's or a copy's source) or a boolean's first operand. Null for a
 * body that starts from nothing — a primitive, an extrude, an import.
 */
function sourceBodyOf(
  body: BodyNode,
  features: Map<string, FeatureNode>
): BodyId | null {
  const data = features.get(body.featureId)?.data as
    { targetBodyId?: unknown; targetBodyIds?: unknown } | undefined;
  const source =
    typeof data?.targetBodyId === 'string'
      ? data.targetBodyId
      : Array.isArray(data?.targetBodyIds) &&
          typeof data.targetBodyIds[0] === 'string'
        ? data.targetBodyIds[0]
        : null;
  return source && source !== body.bodyId ? (source as BodyId) : null;
}

/**
 * Every body's folder (null: the top level), resolved once for a document:
 * an explicit placement, else the folder of the body it was made from.
 * Placements that name a missing folder read as the top level.
 */
export function objectFolderPlacements(
  document: ProjectDocument
): Map<BodyId, string | null> {
  const set = document.objectFolders;
  const resolved = new Map<BodyId, string | null>();
  if (!set) return resolved;
  const known = new Set(set.folders.map((folder) => folder.id));
  const bodies = bodyNodes(document);
  const features = featureNodes(document);
  const resolve = (bodyId: BodyId, seen: Set<BodyId>): string | null => {
    const cached = resolved.get(bodyId);
    if (cached !== undefined) return cached;
    let folderId: string | null = null;
    if (Object.hasOwn(set.placements, bodyId)) {
      const placed = set.placements[bodyId] ?? null;
      folderId = placed !== null && known.has(placed) ? placed : null;
    } else {
      const body = bodies.get(bodyId);
      const source = body ? sourceBodyOf(body, features) : null;
      if (source && !seen.has(source)) {
        seen.add(source);
        folderId = resolve(source, seen);
      }
    }
    resolved.set(bodyId, folderId);
    return folderId;
  };
  for (const bodyId of bodies.keys()) resolve(bodyId, new Set([bodyId]));
  return resolved;
}

export function objectFolderOfBody(
  document: ProjectDocument,
  bodyId: BodyId
): string | null {
  return objectFolderPlacements(document).get(bodyId) ?? null;
}

export function listObjectFolders(document: ProjectDocument): ObjectFolder[] {
  return document.objectFolders?.folders ?? [];
}

/**
 * The next free "Folder N" name among a parent's folders, so two new
 * folders never read the same.
 */
export function nextObjectFolderName(
  document: ProjectDocument,
  parentId: string | null = null
): string {
  const names = new Set(
    listObjectFolders(document)
      .filter((folder) => folder.parentId === parentId)
      .map((folder) => folder.name)
  );
  for (let n = 1; ; n++) {
    const name = `Folder ${n}`;
    if (!names.has(name)) return name;
  }
}
