/**
 * The staging lease of a plaintext project moving to encrypted storage
 * (ADR-024 Phase 7, slice 7-1; roadmap L11). While a project is staged,
 * the encrypted-project routes take its ciphertext from one browser only:
 * the owner's device that holds the live lease, named on every request in
 * the `x-e2ee-migration-lease` header. This module reads that header and
 * the lease row (migration 0042); `e2eeProjects.ts` turns a held lease into
 * staging access and a fence every staged write carries in its own SQL,
 * and `e2eeProjectMigrations.ts` serves the migration routes themselves.
 *
 * It imports nothing from the route modules, so they can all use it.
 */
import {
  E2EE_MIGRATION_LEASE_HEADER,
  type E2eeMigrationDirection
} from '@openzcad/shared';
import { isE2eeProjectMigrationStorageReady } from '@openzcad/cloudflare-adapters';

/** A lease token: 32 random bytes, unpadded base64url. */
export const MIGRATION_LEASE_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/** The staging lease a request runs under, as its fences bind it. */
export interface StagingLease {
  readonly leaseId: string;
  /** The time the lease was checked at, in milliseconds. */
  readonly now: number;
}

/**
 * The lease a request names, or null. Only while E2EE_MIGRATION_ENABLED is
 * open to the account (`enabled`): with the flag off no request stages
 * anything, whatever it sends.
 */
export function migrationLeaseOf(
  request: Request,
  enabled: boolean
): string | null {
  if (!enabled) return null;
  const value = request.headers.get(E2EE_MIGRATION_LEASE_HEADER);
  return value !== null && MIGRATION_LEASE_PATTERN.test(value) ? value : null;
}

/**
 * `held`: the caller owns the project, it is a live plaintext project
 * staged for encryption, and `leaseId` is its live lease. `lost`: it is
 * staged, but under another or a lapsed lease. Null: not staged at all
 * (or migration 0042 is missing).
 */
export type StagingCheck =
  | { readonly kind: 'held'; readonly lease: StagingLease }
  | { readonly kind: 'lost' }
  | null;

export async function checkStagingLease(
  db: D1Database,
  projectId: string,
  userId: string,
  leaseId: string,
  now = Date.now(),
  /**
   * Slice 7-3: `decrypt` checks the lease of an encrypted project (format
   * 2) its owner is turning back into plaintext instead.
   */
  direction: E2eeMigrationDirection = 'encrypt'
): Promise<StagingCheck> {
  if (!(await isE2eeProjectMigrationStorageReady(db))) return null;
  const row = await db
    .prepare(
      `SELECT m.lease_id, m.lease_expires_at
       FROM e2ee_project_migrations m
       JOIN projects p ON p.id = m.project_id
       WHERE m.project_id = ? AND m.owner_user_id = ? AND p.user_id = ?
         AND m.direction = ? AND m.state = 'staging'
         AND p.storage_format = ? AND p.status <> 'deleted'`
    )
    .bind(
      projectId,
      userId,
      userId,
      direction,
      direction === 'encrypt' ? 1 : 2
    )
    .first<{ lease_id: string | null; lease_expires_at: number | null }>();
  if (!row) return null;
  if (row.lease_id === leaseId && (row.lease_expires_at ?? 0) > now) {
    return { kind: 'held', lease: { leaseId, now } };
  }
  return { kind: 'lost' };
}

/**
 * Whether a project is staged for encryption, so its plaintext writes,
 * named saves and room refuse with 409 PROJECT_MIGRATING. Only while
 * E2EE_MIGRATION_ENABLED is on (`enabled`) and migration 0042 is
 * installed: otherwise no statement names the table and nothing changes.
 */
export async function isProjectMigrating(
  db: D1Database | undefined,
  projectId: string,
  enabled: boolean
): Promise<boolean> {
  if (!enabled || !db || !(await isE2eeProjectMigrationStorageReady(db))) {
    return false;
  }
  const row = await db
    .prepare(
      `SELECT 1 AS migrating FROM e2ee_project_migrations
       WHERE project_id = ? AND state = 'staging'`
    )
    .bind(projectId)
    .first<{ migrating: number }>();
  return row?.migrating === 1;
}

/** The staged head the migration row records (0 and null before any). */
export async function stagedHead(
  db: D1Database,
  projectId: string
): Promise<{ stagedVersion: number; stagedHash: string | null } | null> {
  const row = await db
    .prepare(
      `SELECT staged_version, staged_hash FROM e2ee_project_migrations
       WHERE project_id = ? AND state = 'staging'`
    )
    .bind(projectId)
    .first<{ staged_version: number; staged_hash: string | null }>();
  return row
    ? { stagedVersion: row.staged_version, stagedHash: row.staged_hash }
    : null;
}

/**
 * Slice 7-3: the fence a plaintext staging write for an encrypted project
 * being turned back into plaintext carries in its own SQL: the owner's live
 * format-2 project, staged for decryption under the request's lease, which
 * is still live at the time it was checked.
 */
export function decryptStagingFence(
  projectId: string,
  userId: string,
  lease: StagingLease
): { sql: string; binds: unknown[] } {
  return {
    sql: `EXISTS (SELECT 1 FROM e2ee_project_migrations dm
      JOIN projects dp ON dp.id = dm.project_id
      WHERE dm.project_id = ? AND dm.owner_user_id = ? AND dp.user_id = ?
        AND dm.direction = 'decrypt' AND dm.state = 'staging'
        AND dm.lease_id = ? AND dm.lease_expires_at > ?
        AND dp.storage_format = 2 AND dp.status <> 'deleted')`,
    binds: [projectId, userId, userId, lease.leaseId, lease.now]
  };
}

/**
 * Slice 7-3: whether an encrypted project is being turned back into
 * plaintext, so its encrypted writes refuse with 409 PROJECT_MIGRATING.
 * Only while the reverse path is open (`enabled`) and migration 0042 is
 * installed; otherwise no statement names the table.
 */
export async function isProjectDecryptStaging(
  db: D1Database | undefined,
  projectId: string,
  enabled: boolean
): Promise<boolean> {
  if (!enabled || !db || !(await isE2eeProjectMigrationStorageReady(db))) {
    return false;
  }
  const row = await db
    .prepare(
      `SELECT 1 AS staged FROM e2ee_project_migrations
       WHERE project_id = ? AND direction = 'decrypt' AND state = 'staging'`
    )
    .bind(projectId)
    .first<{ staged: number }>();
  return row?.staged === 1;
}
