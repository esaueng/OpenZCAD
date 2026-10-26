/**
 * Wire types of moving an existing plaintext project to encrypted storage
 * (ADR-024 Phase 7, slice 7-1; roadmap L11), served under
 * `/api/e2ee/projects/:id/migration…` behind E2EE_MIGRATION_ENABLED. The
 * owner's browser encrypts everything; the Worker keeps the migration's
 * state, takes the staged ciphertext beside the plaintext from the lease
 * holder, flips the storage format in one batch and then purges the
 * plaintext a bounded step at a time. It never transforms content.
 */

/**
 * The request header that carries the migration lease. While a plaintext
 * project is being staged, the encrypted-project routes (MLS group, key
 * store, versions, revisions, project info, content blobs, measurements and
 * view state) accept its ciphertext only with this header naming the live
 * lease.
 */
export const E2EE_MIGRATION_LEASE_HEADER = 'x-e2ee-migration-lease';

/** The plaintext routes' refusal while a project is staged. */
export const PROJECT_MIGRATING_CODE = 'PROJECT_MIGRATING';

/** How long a lease lasts without renewal (judgment: five minutes). */
export const E2EE_MIGRATION_LEASE_TTL_MS = 5 * 60 * 1000;

export type E2eeMigrationDirection = 'encrypt' | 'decrypt';

/**
 * `staging`: ciphertext lands beside the plaintext; plaintext writes,
 * named saves and the room refuse with 409 PROJECT_MIGRATING, reads keep
 * working. `cutover`: the storage format flipped in one batch; nothing is
 * purged yet. `purging`: the plaintext is being deleted. `done`: nothing
 * plaintext remains. `abandoned`: the staged ciphertext is dropped (or
 * still being dropped while `cleanupPending`) and the plaintext unlocked.
 */
export type E2eeMigrationState =
  'staging' | 'cutover' | 'purging' | 'done' | 'abandoned';

export interface E2eeProjectMigrationRecord {
  projectId: string;
  direction: E2eeMigrationDirection;
  state: E2eeMigrationState;
  /** The device that holds (or last held) the lease. */
  deviceId: string | null;
  /** Milliseconds since the epoch; null once no lease is held. */
  leaseExpiresAt: number | null;
  /** True when the request named the live lease. */
  leaseHeld: boolean;
  /** The plaintext head when staging began. */
  sourceVersion: number;
  /** The staged head: its document version (0 before any) and hash. */
  stagedVersion: number;
  stagedHash: string | null;
  /**
   * While staging, what has been staged so far; from the cutover on, what
   * the cutover found.
   */
  revisionCount: number;
  blobCount: number;
  blobBytes: number;
  /** The next purge step, `cleanup` while an abandon is unfinished. */
  purgeCursor: string | null;
  purgedRows: number;
  purgedObjects: number;
  startedAt: string;
  updatedAt: string;
  cutoverAt: string | null;
  finishedAt: string | null;
}

/** `GET /api/e2ee/projects/:id/migration`. */
export interface E2eeProjectMigrationResponse {
  migration: E2eeProjectMigrationRecord | null;
}

/** `POST /api/e2ee/projects/:id/migration`: start, or resume a lapsed lease. */
export interface E2eeMigrationStartRequest {
  direction: E2eeMigrationDirection;
  /** A device the owner's newest device list certifies. */
  deviceId: string;
}

/**
 * The start and lease-renewal answer. `leaseId` goes in
 * {@link E2EE_MIGRATION_LEASE_HEADER} on every staging write.
 */
export interface E2eeMigrationLeaseResponse {
  migration: E2eeProjectMigrationRecord;
  leaseId: string;
}

/**
 * `POST …/migration/abandon` and `POST …/migration/purge`: one bounded
 * step. `complete` is false while more remains; call again.
 */
export interface E2eeMigrationStepResponse {
  migration: E2eeProjectMigrationRecord;
  complete: boolean;
}

/** `POST …/migration/cutover`. */
export interface E2eeMigrationCutoverResponse {
  migration: E2eeProjectMigrationRecord;
  /** Plaintext share links the cutover revoked (decision M8). */
  revokedShareLinks: number;
  /** Unaccepted invitations the cutover revoked. */
  revokedInvitations: number;
}

/** Refusal codes of the migration routes, besides the common ones. */
export const E2EE_MIGRATION_CODES = Object.freeze({
  /** Another device holds a live lease. */
  leased: 'E2EE_MIGRATION_LEASED',
  /** The request's lease lapsed or was taken over; start again to resume. */
  leaseLost: 'E2EE_MIGRATION_LEASE_LOST',
  /** The project has members or pending invitations (decision M7). */
  shared: 'E2EE_MIGRATION_SHARED',
  /** The plaintext changed after staging began. */
  stale: 'E2EE_MIGRATION_STALE',
  /** Retained plaintext revisions have no staged named save (decision M9). */
  revisionsIncomplete: 'E2EE_MIGRATION_REVISIONS_INCOMPLETE',
  /** No staged head, group or project info yet. */
  notStaged: 'E2EE_MIGRATION_NOT_STAGED',
  /**
   * The staged head's document version is not above the plaintext head's:
   * a project's version only moves forward, so stage from
   * `sourceVersion + 1` on.
   */
  headBehind: 'E2EE_MIGRATION_HEAD_BEHIND',
  /**
   * The project's room holds edits the account never saved (slice 7-2):
   * nothing is staged and the plaintext stays unlocked; open the project
   * and save it, then start again.
   */
  roomAhead: 'E2EE_MIGRATION_ROOM_AHEAD',
  /** Staged rows of an earlier attempt remain; finish the abandon first. */
  cleanupPending: 'E2EE_MIGRATION_CLEANUP_PENDING',
  /** The request does not fit the migration's state. */
  state: 'E2EE_MIGRATION_STATE',
  /**
   * Slice 7-3: the account's "Encrypt new projects" opt-in is on, so it
   * cannot hold a new plaintext project (decision D2); turn it off first.
   */
  optedIn: 'E2EE_MIGRATION_OPTED_IN'
} as const);

// --- Slice 7-3: the beta-only reverse path ------------------------------------

/**
 * One plaintext save state staged for a project being turned back into
 * plaintext (direction `decrypt`), as `GET …/migration/plaintext` lists it.
 */
export interface E2eeDecryptStagedRevision {
  revisionId: string;
  reason: string;
  createdAt: string;
}

/** One plaintext file staged for a decrypting project. */
export interface E2eeDecryptStagedArtifact {
  artifactId: string;
  kind: string;
  name: string;
  bytes: number;
  /**
   * The encrypted blob it was decrypted from, as the staging browser named
   * it in the artifact's metadata (`e2eeBlobId`), so a resumed run finds it.
   */
  blobId: string | null;
}

/**
 * `GET /api/e2ee/projects/:id/migration/plaintext`: what the lease holder
 * staged so far beside the encrypted project, its journal on a resume.
 */
export interface E2eeDecryptStagingResponse {
  revisions: E2eeDecryptStagedRevision[];
  artifacts: E2eeDecryptStagedArtifact[];
  /** The staged plaintext head (document version), or null before it. */
  head: { version: number; checksumSha256: string } | null;
  /** 0 until measurements are staged, then their revision. */
  measurementsRevision: number;
  workspaceSessions: number;
}

/**
 * `PUT /api/e2ee/projects/:id/migration/plaintext/details`: the decrypted
 * measurements and view state, staged in one call. Each workspace session
 * is the plaintext route's shape without `updatedAt`.
 */
export interface E2eeDecryptDetailsRequest {
  measurements: unknown;
  workspaceSessions: unknown[];
}

/** Workspace sessions one details call stages at most (the route keeps 20). */
export const MAX_DECRYPT_STAGED_SESSIONS = 20;

/** The artifact metadata key that names the blob a staged file came from. */
export const DECRYPT_STAGED_BLOB_METADATA_KEY = 'e2eeBlobId';
