import {
  documentNodesWithHistory,
  HISTORY_FIELDS,
  MAX_UNDO_BYTES,
  MAX_UNDO_STEPS,
  type DocumentChange,
  type DocumentHistory,
  type DocumentHistoryEntry,
  type ProjectDocument,
  type UserId
} from '@openzcad/shared';

function equal(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b))
    return (
      a.length === b.length && a.every((value, index) => equal(value, b[index]))
    );
  if (
    !a ||
    !b ||
    typeof a !== 'object' ||
    typeof b !== 'object' ||
    Array.isArray(a) ||
    Array.isArray(b)
  )
    return false;
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const keys = Object.keys(left).filter((key) => left[key] !== undefined);
  return (
    keys.length ===
      Object.keys(right).filter((key) => right[key] !== undefined).length &&
    keys.every(
      (key) => Object.hasOwn(right, key) && equal(left[key], right[key])
    )
  );
}

/** Collection entries are the snapshot boundary; array splices avoid copying the growing command log. */
export function documentChanges(
  before: ProjectDocument,
  after: ProjectDocument
): DocumentChange[] {
  const changes: DocumentChange[] = [];
  for (const field of HISTORY_FIELDS) {
    const left = before[field];
    const right = after[field];
    if (left === right) continue;
    if (field === 'nodes' || field === 'assets' || field === 'shaprImports') {
      const a = before[field] as Record<string, unknown>;
      const b = after[field] as Record<string, unknown>;
      for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
        if (!equal(a[key], b[key]))
          changes.push({
            kind: 'value',
            field,
            key,
            before: a[key],
            after: b[key]
          });
      }
    } else if (Array.isArray(left) && Array.isArray(right)) {
      let start = 0;
      while (
        start < left.length &&
        start < right.length &&
        equal(left[start], right[start])
      )
        start++;
      let end = 0;
      while (
        end < left.length - start &&
        end < right.length - start &&
        equal(left[left.length - 1 - end], right[right.length - 1 - end])
      )
        end++;
      if (start !== left.length || start !== right.length)
        changes.push({
          kind: 'splice',
          field,
          index: start,
          before: left.slice(start, left.length - end),
          after: right.slice(start, right.length - end)
        });
    } else if (!equal(left, right))
      changes.push({ kind: 'value', field, before: left, after: right });
  }
  // Snapshots must not retain aliases to mutable callers or undefined object fields.
  return JSON.parse(JSON.stringify(changes)) as DocumentChange[];
}

export function applyDocumentChanges(
  document: ProjectDocument,
  changes: DocumentChange[],
  direction: 'undo' | 'redo'
): ProjectDocument {
  const result = { ...document };
  for (const change of changes) {
    const value = direction === 'undo' ? change.before : change.after;
    if (change.kind === 'splice') {
      const current = result[change.field];
      const removed = direction === 'undo' ? change.after : change.before;
      if (
        !Array.isArray(current) ||
        change.index + removed.length > current.length ||
        !equal(
          current.slice(change.index, change.index + removed.length),
          removed
        )
      ) {
        throw new Error('Undo history does not match this document.');
      }
      const next = [
        ...current.slice(0, change.index),
        ...structuredClone(value as unknown[]),
        ...current.slice(change.index + removed.length)
      ];
      Object.defineProperty(result, change.field, {
        value: next,
        enumerable: true,
        writable: true,
        configurable: true
      });
    } else if (change.key !== undefined) {
      const expected = direction === 'undo' ? change.after : change.before;
      if (
        !equal(
          (result[change.field] as Record<string, unknown>)[change.key],
          expected
        )
      )
        throw new Error('Undo history does not match this document.');
      const next = { ...(result[change.field] as Record<string, unknown>) };
      if (value === undefined) delete next[change.key];
      else
        Object.defineProperty(next, change.key, {
          value: structuredClone(value),
          enumerable: true,
          writable: true,
          configurable: true
        });
      Object.defineProperty(result, change.field, {
        value: next,
        enumerable: true,
        writable: true,
        configurable: true
      });
    } else {
      const expected = direction === 'undo' ? change.after : change.before;
      if (!equal(result[change.field], expected))
        throw new Error('Undo history does not match this document.');
      Object.defineProperty(result, change.field, {
        value: structuredClone(value),
        enumerable: true,
        writable: true,
        configurable: true
      });
    }
  }
  return result;
}

function bounded(history: DocumentHistory): DocumentHistory {
  const result = { ...history, entries: [...history.entries] };
  while (
    result.entries.length > MAX_UNDO_STEPS ||
    new TextEncoder().encode(JSON.stringify(result)).byteLength > MAX_UNDO_BYTES
  ) {
    if (!result.entries.length) break;
    // Drop the oldest undo first; a redo-only timeline drops its farthest future.
    if (result.cursor > 0) {
      result.entries.shift();
      result.cursor--;
    } else result.entries.pop();
    result.trimmed++;
  }
  return result;
}

export function recordDocumentEdit(
  before: ProjectDocument,
  after: ProjectDocument,
  label: string,
  actorUserId: UserId
): ProjectDocument {
  const previous =
    before.editHistory?.actorUserId === actorUserId
      ? before.editHistory
      : undefined;
  const entries = previous?.entries.slice(0, previous.cursor) ?? [];
  entries.push({
    id: crypto.randomUUID(),
    label: label.slice(0, 256),
    changes: documentChanges(before, after)
  });
  return archiveHistorySources({
    ...after,
    editHistory: bounded({
      schemaVersion: 1,
      projectId: after.projectId,
      actorUserId,
      entries,
      cursor: entries.length,
      trimmed: previous?.trimmed ?? 0
    })
  });
}

/** A repair changes the adjacent snapshot endpoints, without adding a user action. */
export function normalizeDocumentHistory(
  before: ProjectDocument,
  after: ProjectDocument
): ProjectDocument {
  const history = before.editHistory;
  if (!history) return after;
  const entries: DocumentHistoryEntry[] = [...history.entries];
  const undo = entries[history.cursor - 1];
  const redo = entries[history.cursor];
  if (undo)
    entries[history.cursor - 1] = {
      ...undo,
      changes: documentChanges(
        applyDocumentChanges(before, undo.changes, 'undo'),
        after
      )
    };
  if (redo)
    entries[history.cursor] = {
      ...redo,
      changes: documentChanges(
        after,
        applyDocumentChanges(before, redo.changes, 'redo')
      )
    };
  return { ...after, editHistory: bounded({ ...history, entries }) };
}

/** Uploading source bytes is durable metadata, so undo must not resurrect a device-only artifact id. */
export function archiveHistorySources(
  document: ProjectDocument,
  replacement?: { featureId: string; artifactId: string }
): ProjectDocument {
  const byChecksum = new Map<string, string>();
  const local = new Map<string, string>();
  for (const node of documentNodesWithHistory(document)) {
    if (
      node.kind !== 'feature' ||
      node.data.featureKind !== 'imported-step' ||
      !node.data.stepSourceRef
    )
      continue;
    const { artifactId, stepSourceRef } = node.data;
    if (replacement && node.featureId === replacement.featureId)
      byChecksum.set(stepSourceRef.checksumSha256, replacement.artifactId);
    if (artifactId.startsWith('artifact_local_'))
      local.set(artifactId, stepSourceRef.checksumSha256);
    else byChecksum.set(stepSourceRef.checksumSha256, artifactId);
  }
  const ids = new Map(
    [...local].flatMap(([id, checksum]) => {
      const archived = byChecksum.get(checksum);
      return archived ? [[id, archived] as const] : [];
    })
  );
  if (!ids.size) return document;
  const { derived, ...content } = document;
  const rewritten = JSON.parse(
    JSON.stringify(content, (key, value: unknown) =>
      key === 'artifactId' && typeof value === 'string'
        ? (ids.get(value) ?? value)
        : value
    )
  ) as Omit<ProjectDocument, 'derived'>;
  return {
    ...rewritten,
    derived,
    ...(rewritten.editHistory
      ? { editHistory: bounded(rewritten.editHistory) }
      : {})
  };
}
