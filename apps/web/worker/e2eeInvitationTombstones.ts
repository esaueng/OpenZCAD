/**
 * The invitations an account cancelled (migration 0068, ADR-024 amendment
 * 2026-11-25): one record per account, sealed under the account key in the
 * browser (`INVITATION_TOMBSTONES_RECORD`, `src/lib/e2ee/invitationTombstones.ts`).
 * The account's own devices renew, and add an acceptance of, no invitation
 * it names, whatever the server lists. The Worker never reads an entry: as
 * for the share link names (migration 0067) it checks only the sealed
 * record's plaintext header, the layout version and a sequence that must
 * rise with every write, and the browser merges a concurrent write (it
 * states the revision it read; a conflict answers the current copy).
 *
 * `GET` / `PUT /api/e2ee/invitations/tombstones`, served with the other
 * invitation routes (`handleE2eeInvitationRequest`) behind the same gates.
 */
import { cachedSchemaProbe } from '@openzcad/cloudflare-adapters';
import { refuse, type Authorization } from './e2eeProjects';

export const E2EE_INVITATION_TOMBSTONES_ROUTE =
  '/api/e2ee/invitations/tombstones';
/** Matches the migration's CHECK; leaves room for the 60 KiB plaintext. */
export const MAX_INVITATION_TOMBSTONES_RECORD_CHARS = 96 * 1024;

const SEALED_RECORD_VERSION_1 = 1;
const COMMITMENT_BYTES = 32;
const HEADER_BYTES = 1 + COMMITMENT_BYTES + 4;
const IV_BYTES = 12;
const TAG_BYTES = 16;

export interface InvitationTombstonesSnapshot {
  /** 0 while the account never stored one. */
  revision: number;
  /** The stored record's sealed sequence; 0 with none. */
  sequence: number;
  record: string | null;
  updatedAt: string | null;
}

/** Whether migration 0068 installed the table and its erasure fence. */
export const isInvitationTombstoneStorageReady = cachedSchemaProbe(
  `SELECT
     (SELECT COUNT(*) FROM pragma_table_info('e2ee_invitation_tombstones')
      WHERE name IN ('user_id', 'revision', 'sequence', 'record', 'updated_at'))
       AS columns,
     (SELECT COUNT(*) FROM sqlite_schema
      WHERE type = 'trigger' AND name IN (
        'block_erasing_invitation_tombstones_insert',
        'block_erasing_invitation_tombstones_update'
      )) AS triggers`,
  (row) => row?.columns === 5 && row.triggers === 2
);

const invalid = (message: string): never =>
  refuse(400, 'E2EE_INVITATION_TOMBSTONES_INVALID', message);

function base64UrlBytes(value: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]+$/.test(value) || value.length % 4 === 1) return null;
  const padded =
    value.replace(/-/g, '+').replace(/_/g, '/') +
    '='.repeat((4 - (value.length % 4)) % 4);
  try {
    return Uint8Array.from(atob(padded), (char) => char.charCodeAt(0));
  } catch {
    return null;
  }
}

/** Shape checks only; the browser authenticates the record it reads. */
function parseSave(body: Record<string, unknown>): {
  expectedRevision: number;
  record: string;
  sequence: number;
} {
  const { expectedRevision, record } = body;
  if (
    typeof expectedRevision !== 'number' ||
    !Number.isSafeInteger(expectedRevision) ||
    expectedRevision < 0
  ) {
    invalid('"expectedRevision" must be a non-negative integer.');
  }
  if (typeof record !== 'string' || record.length === 0) {
    invalid('"record" must be a non-empty string.');
  }
  const text = record as string;
  if (text.length > MAX_INVITATION_TOMBSTONES_RECORD_CHARS) {
    refuse(
      413,
      'E2EE_INVITATION_TOMBSTONES_TOO_LARGE',
      'The cancelled invitations record is too large.'
    );
  }
  const bytes = base64UrlBytes(text);
  if (!bytes) return invalid('"record" must be base64url.');
  if (bytes.byteLength < HEADER_BYTES + IV_BYTES + TAG_BYTES) {
    invalid('"record" is not a sealed record.');
  }
  if (bytes[0] !== SEALED_RECORD_VERSION_1) {
    invalid(`Sealed record version ${bytes[0]} is not supported.`);
  }
  const sequence = new DataView(
    bytes.buffer,
    bytes.byteOffset + 1 + COMMITMENT_BYTES,
    4
  ).getUint32(0);
  if (sequence < 1) invalid('A sealed record has sequence 0.');
  return { expectedRevision: expectedRevision as number, record: text, sequence };
}

export async function loadInvitationTombstones(
  db: D1Database,
  userId: string
): Promise<InvitationTombstonesSnapshot> {
  const row = await db
    .prepare(
      `SELECT revision, sequence, record, updated_at
       FROM e2ee_invitation_tombstones WHERE user_id = ?`
    )
    .bind(userId)
    .first<{
      revision: number;
      sequence: number;
      record: string;
      updated_at: string;
    }>();
  return row
    ? {
        revision: row.revision,
        sequence: row.sequence,
        record: row.record,
        updatedAt: row.updated_at
      }
    : { revision: 0, sequence: 0, record: null, updatedAt: null };
}

/**
 * Stores the record while the account copy is still at `expectedRevision`
 * (0: none yet) and the record's sequence is above the stored one; else
 * 409 with the current copy, which the browser merges and seals past.
 */
async function saveInvitationTombstones(
  db: D1Database,
  userId: string,
  authorization: Authorization,
  body: Record<string, unknown>
): Promise<InvitationTombstonesSnapshot> {
  const input = parseSave(body);
  const now = new Date().toISOString();
  const revision = input.expectedRevision + 1;
  const result =
    input.expectedRevision === 0
      ? await db
          .prepare(
            `INSERT INTO e2ee_invitation_tombstones
               (user_id, revision, sequence, record, updated_at)
             SELECT ?, 1, ?, ?, ? WHERE ${authorization.sql}
             ON CONFLICT(user_id) DO NOTHING`
          )
          .bind(
            userId,
            input.sequence,
            input.record,
            now,
            ...authorization.binds
          )
          .run()
      : await db
          .prepare(
            `UPDATE e2ee_invitation_tombstones
             SET revision = ?, sequence = ?, record = ?, updated_at = ?
             WHERE user_id = ? AND revision = ? AND sequence < ?
               AND ${authorization.sql}`
          )
          .bind(
            revision,
            input.sequence,
            input.record,
            now,
            userId,
            input.expectedRevision,
            input.sequence,
            ...authorization.binds
          )
          .run();
  if (result.meta?.changes !== 1) {
    const current = await loadInvitationTombstones(db, userId);
    if (
      current.revision === input.expectedRevision &&
      current.sequence < input.sequence
    ) {
      // Nothing moved: the write authorization refused it.
      refuse(
        401,
        'E2EE_SESSION_REQUIRED',
        'Sign in again before changing encryption keys.'
      );
    }
    refuse(
      409,
      'E2EE_INVITATION_TOMBSTONES_CONFLICT',
      `Cancelled invitations are at revision ${current.revision}, sequence ${current.sequence}.`,
      { current }
    );
  }
  return {
    revision,
    sequence: input.sequence,
    record: input.record,
    updatedAt: now
  };
}

/** The `GET` and `PUT` of the route, once its table exists (else 503). */
export async function handleInvitationTombstones(
  db: D1Database,
  userId: string,
  method: string,
  authorization: Authorization,
  readBody: () => Promise<Record<string, unknown>>
): Promise<InvitationTombstonesSnapshot | null> {
  if (method !== 'GET' && method !== 'PUT') return null;
  if (!(await isInvitationTombstoneStorageReady(db))) {
    refuse(
      503,
      'E2EE_UNAVAILABLE',
      'Cancelled invitations cannot be recorded until the database is updated.'
    );
  }
  return method === 'GET'
    ? loadInvitationTombstones(db, userId)
    : saveInvitationTombstones(db, userId, authorization, await readBody());
}

/** Profile erasure removes the record with the rest of the profile. */
export async function invitationTombstoneErasureStatements(
  db: D1Database,
  userId: string
): Promise<D1PreparedStatement[]> {
  if (!(await isInvitationTombstoneStorageReady(db))) return [];
  return [
    db
      .prepare('DELETE FROM e2ee_invitation_tombstones WHERE user_id = ?')
      .bind(userId)
  ];
}
