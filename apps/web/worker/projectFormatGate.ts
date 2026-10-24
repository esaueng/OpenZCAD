/**
 * The project storage-format gate (ADR-024 Phase 4, roadmap L11). An
 * end-to-end encrypted project (storage format 2) cannot be served by any
 * route that reads or writes a document, a revision, measurements, view
 * state or the room until the encrypted paths exist, so every
 * `/api/projects/:id/*` route passes through here before its handler —
 * including routes added later, which are refused unless listed below as
 * metadata-only. The persistence layer applies the same guard
 * (`assertPlaintextProject`) inside each document method as well.
 *
 * Plaintext projects cost one primary-key read; the caller's access is
 * resolved only for a project that is not plaintext, so an outsider still
 * gets the handler's opaque 404 rather than learning the format.
 */
import {
  assertPlaintextProject,
  assertShareableProject,
  isPlaintextStorageFormat,
  ProjectNotFoundError,
  type ProjectAccess
} from '@openzcad/persistence';
import type { UserId } from '@openzcad/shared';
import { isProjectStorageFormatReady } from '@openzcad/cloudflare-adapters';

/**
 * - `metadata`: never touches document content (shelf state, deletion, and
 *   revoking or listing access) and works on any format.
 * - `share`: creates new access; refused on an encrypted project as sharing.
 * - `room`: the collaboration room; members refused as sharing, the owner
 *   as unreadable.
 * - `document`: everything else, refused as unreadable.
 */
export type ProjectRouteFormatRule = 'metadata' | 'share' | 'room' | 'document';

const PROJECT_SCOPED = /^\/api\/projects\/([^/]+)(\/.*)?$/;
/** Collection routes that share the prefix but name no project. */
const COLLECTION_SEGMENTS = new Set(['reorder', 'purge']);

const METADATA_ROUTES: ReadonlyArray<{ method: string; rest: RegExp }> = [
  // Shelf organization (archive, trash, pin) and permanent deletion.
  { method: 'PATCH', rest: /^$/ },
  { method: 'DELETE', rest: /^$/ },
  // Reading and revoking existing access stays possible on any project.
  { method: 'GET', rest: /^\/sharing$/ },
  { method: 'GET', rest: /^\/share-links$/ },
  { method: 'DELETE', rest: /^\/share-links\/[^/]+$/ },
  { method: 'DELETE', rest: /^\/invitations\/[^/]+$/ },
  { method: 'DELETE', rest: /^\/members\/[^/]+$/ }
];

const SHARE_ROUTES: ReadonlyArray<{ method: string; rest: RegExp }> = [
  { method: 'POST', rest: /^\/invitations$/ },
  { method: 'POST', rest: /^\/share-links$/ },
  // A role change can grant stronger access, so it is sharing too.
  { method: 'PATCH', rest: /^\/members\/[^/]+$/ }
];

const ROOM_ROUTE = /^\/collaboration(?:\/ticket)?$/;

/** The rule for one request, or null when it names no single project. */
export function projectRouteFormatRule(
  method: string,
  pathname: string
): { projectId: string; rule: ProjectRouteFormatRule } | null {
  const match = PROJECT_SCOPED.exec(pathname);
  if (!match) return null;
  const projectId = match[1]!;
  const rest = match[2] ?? '';
  if (!rest && COLLECTION_SEGMENTS.has(projectId)) return null;
  const listed = (routes: typeof METADATA_ROUTES) =>
    routes.some((route) => route.method === method && route.rest.test(rest));
  const rule: ProjectRouteFormatRule = listed(METADATA_ROUTES)
    ? 'metadata'
    : listed(SHARE_ROUTES)
      ? 'share'
      : ROOM_ROUTE.test(rest)
        ? 'room'
        : 'document';
  return { projectId, rule };
}

/** Room access on a project that is not plaintext. */
export function assertPlaintextRoomAccess(
  access: Pick<ProjectAccess, 'projectId' | 'role' | 'storageFormat'>
): void {
  if (access.role !== 'owner') assertShareableProject(access);
  assertPlaintextProject(access);
}

/**
 * Refuses a request to an encrypted project the caller can read with 409
 * PROJECT_FORMAT_UNSUPPORTED (or ENCRYPTED_PROJECT_SHARING_UNAVAILABLE).
 * Everything else — plaintext, unknown or inaccessible projects, and
 * metadata routes — passes to the handler unchanged.
 */
export async function assertProjectRouteFormat(
  db: D1Database | undefined,
  persistence: {
    requireProjectRead(
      userId: UserId,
      projectId: string
    ): Promise<ProjectAccess>;
  },
  userId: UserId,
  method: string,
  pathname: string
): Promise<void> {
  const route = projectRouteFormatRule(method, pathname);
  if (!db || !route || route.rule === 'metadata') return;
  // Before migration 0031 every project is plaintext, and no statement may
  // name the column.
  if (!(await isProjectStorageFormatReady(db))) return;
  const row = await db
    .prepare('SELECT storage_format FROM projects WHERE id = ?')
    .bind(route.projectId)
    .first<{ storage_format?: number | null }>();
  if (!row || isPlaintextStorageFormat(row.storage_format)) return;
  let access: ProjectAccess;
  try {
    access = await persistence.requireProjectRead(userId, route.projectId);
  } catch (error) {
    // No access: the handler answers with its usual 404.
    if (error instanceof ProjectNotFoundError) return;
    throw error;
  }
  if (route.rule === 'share') assertShareableProject(access);
  else if (route.rule === 'room') assertPlaintextRoomAccess(access);
  else assertPlaintextProject(access);
}
