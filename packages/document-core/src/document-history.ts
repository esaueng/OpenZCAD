import {
  documentNodesWithHistory,
  HISTORY_FIELDS,
  importedSourceReferenceOf,
  isImportedSourceReference,
  isHistoryCommandKinds,
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

function utf8Bytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

/**
 * Serializes each entry once and keeps a running total as entries drop.
 * Re-serializing the whole history per dropped entry cost seconds on the main
 * thread for one mid-size mesh import. The total is exact: the history's JSON
 * is its envelope (the counters, re-measured as they change) plus the entries
 * joined by commas inside the envelope's `[]`.
 */
function bounded(history: DocumentHistory): DocumentHistory {
  const result = { ...history, entries: [...history.entries] };
  const sizes = result.entries.map(utf8Bytes);
  let entryBytes = sizes.reduce((total, size) => total + size, 0);
  while (
    result.entries.length > MAX_UNDO_STEPS ||
    utf8Bytes({ ...result, entries: [] }) +
      entryBytes +
      Math.max(sizes.length - 1, 0) >
      MAX_UNDO_BYTES
  ) {
    if (!result.entries.length) break;
    // Drop the oldest undo first; a redo-only timeline drops its farthest future.
    if (result.cursor > 0) {
      result.entries.shift();
      entryBytes -= sizes.shift()!;
      result.cursor--;
    } else {
      result.entries.pop();
      entryBytes -= sizes.pop()!;
    }
    result.trimmed++;
  }
  return result;
}

export function recordDocumentEdit(
  before: ProjectDocument,
  after: ProjectDocument,
  label: string,
  actorUserId: UserId,
  commandKinds?: readonly string[]
): ProjectDocument {
  const previous =
    before.editHistory?.actorUserId === actorUserId
      ? before.editHistory
      : undefined;
  const entries = previous?.entries.slice(0, previous.cursor) ?? [];
  // Distinct kinds answer every question asked of them. A list the validator
  // would still refuse is left out — unknown, which Tweak treats as modeling —
  // because storing it would make the project unopenable: a "Roll back after"
  // over 100 features or a 101-solid STEP import used to.
  const kinds = commandKinds && [...new Set(commandKinds)];
  entries.push({
    id: crypto.randomUUID(),
    label: label.slice(0, 256),
    changes: documentChanges(before, after),
    ...(isHistoryCommandKinds(kinds) ? { commandKinds: kinds } : {})
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

export interface ImportedSourceArchiveIdentity {
  kind: 'step-source' | 'mesh-payload';
  checksumSha256: string;
  logicalBytes: number;
}

/** Uploading source bytes is durable metadata, so undo must not resurrect a device-only artifact id. */
export function archiveHistorySources(
  document: ProjectDocument,
  replacement?: {
    featureId: string;
    artifactId: string;
    source?: ImportedSourceArchiveIdentity;
  }
): ProjectDocument {
  const identity = (
    value: unknown
  ): ImportedSourceArchiveIdentity | undefined => {
    if (!value || typeof value !== 'object') return;
    const data = value as Record<string, unknown>;
    const kind =
      data.featureKind === 'imported-step'
        ? 'step-source'
        : data.featureKind === 'imported-mesh' ||
            data.meshPayloadRef !== undefined
          ? 'mesh-payload'
          : 'step-source';
    const ref =
      kind === 'mesh-payload' ? data.meshPayloadRef : data.stepSourceRef;
    if (isImportedSourceReference(ref))
      return {
        kind,
        checksumSha256: ref.checksumSha256,
        logicalBytes: ref.logicalBytes
      };
  };
  const key = (source: ImportedSourceArchiveIdentity) =>
    `${source.kind}:${source.checksumSha256}:${source.logicalBytes}`;
  const archived = new Map<string, string>();
  const local = new Map<string, Set<string>>();
  const retained = new Map<string, ImportedSourceArchiveIdentity>();
  let current: ImportedSourceArchiveIdentity | undefined;
  for (const node of documentNodesWithHistory(document)) {
    if (node.kind !== 'feature' || !importedSourceReferenceOf(node.data))
      continue;
    const source = identity(node.data);
    if (!source) continue;
    const sourceKey = key(source);
    if (replacement && node.featureId === replacement.featureId) {
      retained.set(sourceKey, source);
      if (document.nodes[node.id] === node) current = source;
    }
    const { artifactId } = node.data as { artifactId: string };
    if (artifactId.startsWith('artifact_local_')) {
      const sources = local.get(artifactId) ?? new Set<string>();
      sources.add(sourceKey);
      local.set(artifactId, sources);
    } else archived.set(sourceKey, artifactId);
  }
  if (replacement) {
    // Legacy calls infer the current source, or the sole retained source when
    // undone. A delayed upload passes its captured identity explicitly.
    const source =
      replacement.source ??
      current ??
      (retained.size === 1 ? retained.values().next().value : undefined);
    if (source) archived.set(key(source), replacement.artifactId);
  }
  if (
    ![...local.values()].some((sources) =>
      [...sources].some((source) => archived.has(source))
    )
  )
    return document;
  const { derived, ...content } = document;
  const rewritten = structuredClone(content);
  const pending: unknown[] = [rewritten];
  const targets: Record<string, unknown>[] = [];
  while (pending.length) {
    const value = pending.pop();
    if (!value || typeof value !== 'object') continue;
    const object = value as Record<string, unknown>;
    const id = object.artifactId;
    if (typeof id === 'string' && id.startsWith('artifact_local_')) {
      targets.push(object);
      const source = identity(object);
      if (source) {
        const sources = local.get(id) ?? new Set<string>();
        sources.add(key(source));
        local.set(id, sources);
      }
    }
    for (const child of Object.values(object))
      if (child && typeof child === 'object') pending.push(child);
  }
  for (const object of targets) {
    const source = identity(object);
    const id = object.artifactId as string;
    const sources = local.get(id);
    // Bare command metadata can inherit an id only when its content is
    // unambiguous. Embedded legacy geometry keeps its original-file id.
    const sourceKey = source
      ? key(source)
      : object.vertices === undefined &&
          object.stepText === undefined &&
          sources?.size === 1
        ? sources.values().next().value
        : undefined;
    const artifactId = sourceKey ? archived.get(sourceKey) : undefined;
    if (artifactId) object.artifactId = artifactId;
  }
  return {
    ...rewritten,
    derived,
    ...(rewritten.editHistory
      ? { editHistory: bounded(rewritten.editHistory) }
      : {})
  };
}
