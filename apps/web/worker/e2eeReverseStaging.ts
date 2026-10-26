/**
 * The plaintext staging writes of the beta-only reverse path (ADR-024
 * Phase 7, slice 7-3; roadmap L11). While its owner turns an encrypted
 * project back into plaintext, the browser that holds the decrypt lease
 * writes the decrypted plaintext under the same project id through the
 * ordinary plaintext routes, each request naming the lease
 * (`x-e2ee-migration-lease`):
 *
 * - `POST /api/projects/:id/revisions`: a save state, under its own id;
 * - `PUT /api/projects/:id/document`: the head, at a version above the
 *   encrypted head's;
 * - `POST /api/uploads` (then the upload and finalize routes): a file.
 *
 * Each lands beside the ciphertext and never touches the project row, which
 * the cutover (`e2eeProjectMigrations.ts`) points at the staged head. Every
 * statement carries the lease in its own SQL, and the lease holder's
 * device-list fence (its device still certified, `decryptLeaseDeviceFence`). Without the reverse path open
 * (E2EE_REVERSE_ENABLED with migration, and migration 0043), or without a
 * held lease, nothing here applies and the routes answer as before (an
 * encrypted project's plaintext routes refuse with 409).
 */
import type {
  ClientProjectStorage,
  PersistenceService
} from '@openzcad/persistence';
import {
  E2EE_MIGRATION_CODES,
  type ProjectDocument,
  type SaveProjectDocumentRequest,
  type SaveProjectDocumentResponse,
  type SaveRevisionRequest,
  type UserId
} from '@openzcad/shared';
import {
  D1R2PersistenceService,
  DecryptStagingLeaseError,
  isE2eeReverseStorageReady
} from '@openzcad/cloudflare-adapters';
import {
  checkStagingLease,
  decryptStagingFence,
  migrationLeaseOf,
  type StagingLease
} from './e2eeMigrationLease';
import {
  decryptLeaseDeviceFence,
  recordDecryptStagedHead,
  type DecryptLeaseDevice
} from './e2eeProjectMigrations';
import { RouteError } from './e2eeProjects';
import { SharingRequestError } from './sharing';

/** A plaintext write running under a held decrypt lease. */
export interface DecryptStaging {
  readonly projectId: string;
  readonly lease: StagingLease;
  /** The lease holder's device, still certified when the lease was checked. */
  readonly device: DecryptLeaseDevice;
  readonly fence: { sql: string; binds: unknown[] };
}

const LEASE_LOST_MESSAGE =
  'This project’s migration lease lapsed or moved to another device. Start the migration again to resume.';

/** The project routes a decrypt staging writes through. */
const STAGING_ROUTES: ReadonlyArray<{ method: string; path: RegExp }> = [
  { method: 'POST', path: /^\/api\/projects\/([^/]+)\/revisions$/ },
  { method: 'PUT', path: /^\/api\/projects\/([^/]+)\/document$/ }
];

/** The project a staging write names on a project route, or null. */
export function decryptStagingRouteProject(
  method: string,
  pathname: string
): string | null {
  for (const route of STAGING_ROUTES) {
    if (route.method !== method) continue;
    const match = route.path.exec(pathname);
    if (!match) continue;
    try {
      return decodeURIComponent(match[1]!);
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * The decrypt staging a request runs under: the reverse path is open to
 * the account, the request names a lease, and it is the live lease of the
 * caller's encrypted project being turned back into plaintext. Null when
 * any of that is missing, so the route answers as it always did; 409
 * E2EE_MIGRATION_LEASE_LOST when the project is staged under another or a
 * lapsed lease.
 */
export async function decryptStagingFor(
  db: D1Database | undefined,
  request: Request,
  userId: string,
  projectId: string,
  reverseEnabled: boolean
): Promise<DecryptStaging | null> {
  if (!reverseEnabled || !db) return null;
  const leaseId = migrationLeaseOf(request, true);
  if (!leaseId) return null;
  if (!(await isE2eeReverseStorageReady(db))) return null;
  const check = await checkStagingLease(
    db,
    projectId,
    userId,
    leaseId,
    Date.now(),
    'decrypt'
  );
  if (!check) return null;
  if (check.kind === 'lost') {
    throw new SharingRequestError(
      409,
      E2EE_MIGRATION_CODES.leaseLost,
      LEASE_LOST_MESSAGE
    );
  }
  const device = await translated(() =>
    decryptLeaseDeviceFence(db, userId, check.deviceId)
  );
  return {
    projectId,
    lease: check.lease,
    device,
    fence: decryptStagingFence(projectId, userId, check.lease, device)
  };
}

function stagingService(
  persistence: PersistenceService
): D1R2PersistenceService {
  if (!(persistence instanceof D1R2PersistenceService)) {
    throw new SharingRequestError(
      503,
      'E2EE_UNAVAILABLE',
      'Turning encryption off needs the account’s project storage.'
    );
  }
  return persistence;
}

/** The persistence layer's and the migration module's refusals, as JSON. */
async function translated<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof DecryptStagingLeaseError) {
      throw new SharingRequestError(
        409,
        E2EE_MIGRATION_CODES.leaseLost,
        LEASE_LOST_MESSAGE
      );
    }
    if (error instanceof RouteError) {
      throw new SharingRequestError(error.status, error.code, error.message);
    }
    throw error;
  }
}

/** The longest user id a staged save state's author may name. */
const MAX_AUTHOR_ID_LENGTH = 256;

/**
 * The author a staged save state's request names (`authorUserId`), who
 * saved the encrypted save state it decrypts; undefined when absent.
 */
export function stagedRevisionAuthor(body: unknown): string | undefined {
  const value =
    body && typeof body === 'object'
      ? (body as Record<string, unknown>).authorUserId
      : undefined;
  if (value === undefined || value === null) return undefined;
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > MAX_AUTHOR_ID_LENGTH
  ) {
    throw new SharingRequestError(
      400,
      'SAVE_POINT_INVALID',
      'A staged save state names its author by user id.'
    );
  }
  return value;
}

/**
 * `POST /api/projects/:id/revisions` under a decrypt lease. The save state
 * keeps who saved it (`authorUserId`, a former collaborator's say) only
 * when the encrypted save state under the same id records that author and
 * the account still exists; otherwise the owner staging it is its author,
 * as for any save state whose author is unknown.
 */
export async function stageDecryptedRevision(
  persistence: PersistenceService,
  userId: UserId,
  payload: SaveRevisionRequest,
  storage: ClientProjectStorage | undefined,
  staging: DecryptStaging,
  authorUserId?: string
): Promise<ProjectDocument> {
  if (payload.savedRevisionId === undefined) {
    throw new SharingRequestError(
      400,
      'SAVE_POINT_INVALID',
      'A staged save state names its own revision id.'
    );
  }
  const revisionId = payload.savedRevisionId;
  await translated(() =>
    stagingService(persistence).stageDecryptedDocument(userId, {
      projectId: staging.projectId,
      document: payload.document,
      ...(storage ? { storage } : {}),
      revision: {
        revisionId,
        reason: payload.reason.trim(),
        ...(authorUserId ? { authorUserId } : {})
      },
      fence: staging.fence
    })
  );
  return payload.document;
}

/**
 * `PUT /api/projects/:id/document` under a decrypt lease: the head. A
 * resumed run that stages the head it already staged (the same version
 * and object checksum the migration row journals) reuses that object, so
 * no unreferenced copy is left beside it.
 */
export async function stageDecryptedHead(
  persistence: PersistenceService,
  db: D1Database,
  userId: UserId,
  payload: SaveProjectDocumentRequest,
  storage: ClientProjectStorage | undefined,
  staging: DecryptStaging
): Promise<SaveProjectDocumentResponse> {
  const journal = await db
    .prepare(
      `SELECT staged_version, staged_hash FROM e2ee_project_migrations
       WHERE project_id = ? AND direction = 'decrypt' AND state = 'staging'`
    )
    .bind(staging.projectId)
    .first<{ staged_version: number; staged_hash: string | null }>();
  const journaledHead =
    journal?.staged_hash && journal.staged_version > 0
      ? {
          version: journal.staged_version,
          checksumSha256: journal.staged_hash
        }
      : undefined;
  const stored = await translated(() =>
    stagingService(persistence).stageDecryptedDocument(userId, {
      projectId: staging.projectId,
      document: payload.document,
      ...(storage ? { storage } : {}),
      ...(journaledHead ? { journaledHead } : {}),
      fence: staging.fence
    })
  );
  await translated(() =>
    recordDecryptStagedHead(
      db,
      staging.projectId,
      userId,
      staging.lease,
      staging.device,
      stored.version,
      stored.checksumSha256
    )
  );
  return {
    projectId: payload.projectId,
    version: stored.version,
    updatedAt: new Date().toISOString()
  };
}
