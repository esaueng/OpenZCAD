import type { ProjectDocument, UserId } from './index';
import { drawingSetError } from './drawings';
import { objectFolderSetError } from './object-folders';

export const MAX_UNDO_STEPS = 100;
export const MAX_UNDO_BYTES = 8_000_000;
export const MAX_HISTORY_COMMAND_KINDS = 100;
export const HISTORY_FIELDS = [
  'rootNodeId',
  'rootAssemblyId',
  'activePartId',
  'name',
  'units',
  'nodes',
  'featureOrder',
  'bodyOrder',
  'sketchOrder',
  'parameterOrder',
  'commandLog',
  'assets',
  'shaprImports',
  'shaprImportOrder',
  'drawings',
  'objectFolders'
] as const;
export type HistoryField = (typeof HISTORY_FIELDS)[number];

/** Exact document values, never executable commands or kernel handles. */
export type DocumentChange =
  | {
      kind: 'value';
      field: HistoryField;
      key?: string;
      before?: unknown;
      after?: unknown;
    }
  | {
      kind: 'splice';
      field: HistoryField;
      index: number;
      before: unknown[];
      after: unknown[];
    };

export interface DocumentHistoryEntry {
  id: string;
  label: string;
  changes: DocumentChange[];
  /**
   * Distinct command kinds the entry applied (e.g. `parameter.set`), in the
   * order first applied. Lets Tweak mode allow undo when the entry touched
   * parameters only. Absent on histories recorded before it existed, and on an
   * entry whose kinds {@link isHistoryCommandKinds} would refuse — treated as
   * unknown, not as parameter-only.
   */
  commandKinds?: string[];
}

export interface DocumentHistory {
  schemaVersion: 1;
  projectId: string;
  actorUserId: UserId;
  entries: DocumentHistoryEntry[];
  cursor: number;
  trimmed: number;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The one rule for an entry's `commandKinds`, shared by the validator and the
 * writer: a writer that stores a list this refuses makes the whole project
 * unopenable and every account save a 400.
 */
export function isHistoryCommandKinds(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length <= MAX_HISTORY_COMMAND_KINDS &&
    value.every((kind) => typeof kind === 'string' && kind.length <= 64)
  );
}

/** Validate before traversing data received from disk, a backup, or a peer. */
export function isDocumentHistory(
  value: unknown,
  projectId: string
): value is DocumentHistory {
  if (
    !record(value) ||
    value.schemaVersion !== 1 ||
    value.projectId !== projectId ||
    typeof value.actorUserId !== 'string' ||
    !value.actorUserId ||
    !Array.isArray(value.entries) ||
    value.entries.length > MAX_UNDO_STEPS ||
    !Number.isSafeInteger(value.cursor) ||
    Number(value.cursor) < 0 ||
    Number(value.cursor) > value.entries.length ||
    !Number.isSafeInteger(value.trimmed) ||
    Number(value.trimmed) < 0
  )
    return false;
  const ids = new Set<string>();
  for (const entry of value.entries) {
    if (
      !record(entry) ||
      typeof entry.id !== 'string' ||
      !entry.id ||
      ids.has(entry.id) ||
      typeof entry.label !== 'string' ||
      entry.label.length > 256 ||
      !Array.isArray(entry.changes) ||
      entry.changes.length > 100_000 ||
      (entry.commandKinds !== undefined &&
        !isHistoryCommandKinds(entry.commandKinds))
    )
      return false;
    ids.add(entry.id);
    for (const change of entry.changes) {
      if (
        !record(change) ||
        !HISTORY_FIELDS.includes(change.field as HistoryField)
      )
        return false;
      if (change.kind === 'splice') {
        if (
          ![
            'featureOrder',
            'bodyOrder',
            'sketchOrder',
            'parameterOrder',
            'commandLog',
            'shaprImportOrder'
          ].includes(String(change.field)) ||
          !Number.isSafeInteger(change.index) ||
          Number(change.index) < 0 ||
          !Array.isArray(change.before) ||
          !Array.isArray(change.after)
        )
          return false;
      } else if (change.kind === 'value') {
        if (
          change.key !== undefined &&
          (typeof change.key !== 'string' ||
            !['nodes', 'assets', 'shaprImports'].includes(String(change.field)))
        )
          return false;
        if (!Object.hasOwn(change, 'before') && !Object.hasOwn(change, 'after'))
          return false;
        // Undo and redo restore these snapshots verbatim, so a drawing
        // section in history must be as valid as a current one (D01).
        if (
          change.field === 'drawings' &&
          (change.key !== undefined ||
            [change.before, change.after].some(
              (side) => side !== undefined && drawingSetError(side) !== null
            ))
        )
          return false;
        // The same holds for the U06 folder section.
        if (
          change.field === 'objectFolders' &&
          (change.key !== undefined ||
            [change.before, change.after].some(
              (side) =>
                side !== undefined && objectFolderSetError(side) !== null
            ))
        )
          return false;
      } else return false;
    }
  }
  try {
    return (
      new TextEncoder().encode(JSON.stringify(value)).byteLength <=
      MAX_UNDO_BYTES
    );
  } catch {
    return false;
  }
}

export function assertDocumentHistory(document: ProjectDocument): void {
  if (
    document.editHistory !== undefined &&
    !isDocumentHistory(document.editHistory, document.projectId)
  ) {
    throw new Error('Invalid or unsupported project undo history.');
  }
}

/** Imports referenced only by undo or redo still own their source bytes. */
export function* documentNodesWithHistory(
  document: ProjectDocument
): Generator<ProjectDocument['nodes'][string]> {
  yield* Object.values(document.nodes);
  for (const entry of document.editHistory?.entries ?? []) {
    for (const change of entry.changes) {
      if (change.kind !== 'value' || change.field !== 'nodes') continue;
      for (const value of [change.before, change.after]) {
        if (!record(value)) continue;
        const nodes = change.key === undefined ? Object.values(value) : [value];
        for (const node of nodes) {
          if (record(node) && typeof node.kind === 'string')
            yield node as unknown as ProjectDocument['nodes'][string];
        }
      }
    }
  }
}

export function* documentAssetsWithHistory(
  document: ProjectDocument
): Generator<ProjectDocument['assets'][keyof ProjectDocument['assets']]> {
  yield* Object.values(document.assets);
  for (const entry of document.editHistory?.entries ?? []) {
    for (const change of entry.changes) {
      if (change.kind !== 'value' || change.field !== 'assets') continue;
      for (const value of [change.before, change.after]) {
        if (!record(value)) continue;
        const assets =
          change.key === undefined ? Object.values(value) : [value];
        for (const asset of assets) {
          if (record(asset))
            yield asset as unknown as ProjectDocument['assets'][keyof ProjectDocument['assets']];
        }
      }
    }
  }
}
