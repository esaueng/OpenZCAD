import type { ProjectDocument, UserId } from './index';

export const MAX_UNDO_STEPS = 100;
export const MAX_UNDO_BYTES = 8_000_000;
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
  'shaprImportOrder'
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
      entry.changes.length > 100_000
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
