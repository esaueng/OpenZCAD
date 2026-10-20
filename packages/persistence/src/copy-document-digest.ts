import {
  normalizeDocument,
  withoutDerivedProjection
} from '@openzcad/document-core';
import type { ProjectDocument } from '@openzcad/shared';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Exact canonical identity of a project copy; presentation caches never count
 * as owner edits. The browser that builds a copy sends this digest with it
 * (ADR-024 Phase 1), so copy rollback and finalize compare a value the server
 * did not compute from the copy itself.
 */
export async function projectCopyDocumentDigest(
  document: ProjectDocument
): Promise<string> {
  const { derived: _derived, ...canonical } = withoutDerivedProjection(
    normalizeDocument(document)
  );
  const json = JSON.stringify(canonical, (_key, value: unknown) =>
    isRecord(value)
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((key) => [key, value[key]])
        )
      : value
  );
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(json)
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, '0')
  ).join('');
}

/** The shape of {@link projectCopyDocumentDigest}'s output. */
export function isProjectCopyDocumentDigest(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
}
