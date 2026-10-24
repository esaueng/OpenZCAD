import { normalizeDocument } from '@openzcad/document-core';
import type { ProjectDocument } from '@openzcad/shared';
import { ProjectObjectStorageError } from './project-storage-snapshot';

/** Stored documents this build could not normalize, served as stored. */
const unreadable = new WeakSet<object>();

/**
 * A stored document as loads return it: normalized when this build can, and
 * otherwise exactly as stored (ADR-024 Phase 1). The browser checks every
 * document it loads and refuses one it cannot open, keeping its own copy,
 * so one bad version must not fail the whole request with a server error.
 * A document served as stored is marked, and load steps that read contents
 * (source aliases, storage hydration) pass it through untouched.
 */
export function normalizedForLoad(document: ProjectDocument): ProjectDocument {
  // A stored value that is not even an object cannot be served as an opaque
  // document (a null would read as "not found"), so it is reported as an
  // unreadable account copy, which the browser handles the same way.
  if (typeof document !== 'object' || document === null)
    throw new ProjectObjectStorageError(
      'The stored project document is unreadable.'
    );
  try {
    return normalizeDocument(document);
  } catch {
    return markUnreadableStoredDocument(document);
  }
}

/** Marks a stored document a load must serve as stored, unread. */
export function markUnreadableStoredDocument<T extends object>(document: T): T {
  unreadable.add(document);
  return document;
}

/** True for a document a load serves as stored because it could not be read. */
export function isUnreadableStoredDocument(document: unknown): boolean {
  return (
    typeof document === 'object' &&
    document !== null &&
    unreadable.has(document)
  );
}
