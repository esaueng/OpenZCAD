import { cachedSchemaProbe } from '@openzcad/cloudflare-adapters';

/**
 * The owner's names for the share links of end-to-end encrypted projects
 * (migration 0067, ADR-024 amendment 2026-11-22): one record per account,
 * sealed under the account key in the browser
 * (`src/lib/e2ee/sealedShareLinkNames.ts`). The Worker never reads a name.
 * It checks only what the sealed record's plaintext header says: the layout
 * version and the sequence, which must rise with every write, so no device
 * (or a replayed request) can store an older record over a newer one. The
 * browser owns the merge: a write states the revision it last read, and a
 * second device writing at once is told the current copy, merges it and
 * writes again.
 */
export const SHARE_LINK_NAMES_ROUTE = '/api/share-link-names';
/** Matches the migration's CHECK; leaves room for the 90 KiB plaintext cap. */
export const MAX_SHARE_LINK_NAMES_RECORD_CHARS = 128 * 1024;

/** The sealed account record's header (`sealed-records.ts`). */
const SEALED_RECORD_VERSION_1 = 1;
const COMMITMENT_BYTES = 32;
const HEADER_BYTES = 1 + COMMITMENT_BYTES + 4;
const IV_BYTES = 12;
const TAG_BYTES = 16;

export interface ShareLinkNamesSnapshot {
  /** 0 while the account has never stored names. */
  revision: number;
  /** The stored record's sealed sequence; 0 with none. */
  sequence: number;
  record: string | null;
  updatedAt: string | null;
}

export interface SaveShareLinkNamesInput {
  expectedRevision: number;
  record: string;
  /** Read from the record's header, never taken from the request. */
  sequence: number;
}

export class ShareLinkNamesRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string
  ) {
    super(message);
    this.name = 'ShareLinkNamesRequestError';
  }
}

export class ShareLinkNamesConflictError extends Error {
  constructor(readonly current: ShareLinkNamesSnapshot) {
    super(
      `Share link names are at revision ${current.revision}, sequence ${current.sequence}.`
    );
    this.name = 'ShareLinkNamesConflictError';
  }
}

/** Whether migration 0067 installed the table and its erasure fence. */
export const isShareLinkNameStorageReady = cachedSchemaProbe(
  `SELECT
     (SELECT COUNT(*) FROM pragma_table_info('e2ee_share_link_names')
      WHERE name IN ('user_id', 'revision', 'sequence', 'record', 'updated_at'))
       AS columns,
     (SELECT COUNT(*) FROM sqlite_schema
      WHERE type = 'trigger' AND name IN (
        'block_erasing_share_link_names_insert',
        'block_erasing_share_link_names_update'
      )) AS triggers`,
  (row) => row?.columns === 5 && row.triggers === 2
);

function invalid(message: string): ShareLinkNamesRequestError {
  return new ShareLinkNamesRequestError(
    400,
    'SHARE_LINK_NAMES_INVALID',
    message
  );
}

const BASE64URL = /^[A-Za-z0-9_-]+$/;

function base64UrlBytes(value: string): Uint8Array | null {
  if (!BASE64URL.test(value) || value.length % 4 === 1) return null;
  const padded =
    value.replace(/-/g, '+').replace(/_/g, '/') +
    '='.repeat((4 - (value.length % 4)) % 4);
  try {
    return Uint8Array.from(atob(padded), (char) => char.charCodeAt(0));
  } catch {
    return null;
  }
}

/**
 * Shape checks only: a base64url sealed record of the known layout whose
 * header carries a sequence from 1. The browser authenticates the content
 * when it reads it back.
 */
export function parseSaveShareLinkNamesRequest(
  body: unknown
): SaveShareLinkNamesInput {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw invalid('Request body must be a JSON object.');
  }
  const { expectedRevision, record } = body as Record<string, unknown>;
  if (
    typeof expectedRevision !== 'number' ||
    !Number.isSafeInteger(expectedRevision) ||
    expectedRevision < 0
  ) {
    throw invalid('"expectedRevision" must be a non-negative integer.');
  }
  if (typeof record !== 'string' || record.length === 0) {
    throw invalid('"record" must be a non-empty string.');
  }
  if (record.length > MAX_SHARE_LINK_NAMES_RECORD_CHARS) {
    throw new ShareLinkNamesRequestError(
      413,
      'SHARE_LINK_NAMES_TOO_LARGE',
      `Share link names exceed the ${MAX_SHARE_LINK_NAMES_RECORD_CHARS}-character cloud limit.`
    );
  }
  const bytes = base64UrlBytes(record);
  if (!bytes) throw invalid('"record" must be base64url.');
  if (bytes.byteLength < HEADER_BYTES + IV_BYTES + TAG_BYTES) {
    throw invalid('"record" is not a sealed record.');
  }
  if (bytes[0] !== SEALED_RECORD_VERSION_1) {
    throw invalid(`Sealed record version ${bytes[0]} is not supported.`);
  }
  const sequence = new DataView(
    bytes.buffer,
    bytes.byteOffset + 1 + COMMITMENT_BYTES,
    4
  ).getUint32(0);
  if (sequence < 1) throw invalid('A sealed record has sequence 0.');
  return { expectedRevision, record, sequence };
}

interface ShareLinkNamesRow {
  revision: number;
  sequence: number;
  record: string;
  updated_at: string;
}

export async function loadShareLinkNames(
  db: D1Database,
  userId: string
): Promise<ShareLinkNamesSnapshot> {
  const row = await db
    .prepare(
      `SELECT revision, sequence, record, updated_at
       FROM e2ee_share_link_names WHERE user_id = ?`
    )
    .bind(userId)
    .first<ShareLinkNamesRow>();
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
 * Stores the record when the account copy is still at `expectedRevision`
 * (0: none stored yet) and the record's sequence is above the stored one.
 * Otherwise answers the current copy so the browser can merge it and seal
 * again past its sequence.
 */
export async function saveShareLinkNames(
  db: D1Database,
  userId: string,
  input: SaveShareLinkNamesInput,
  now = new Date().toISOString()
): Promise<ShareLinkNamesSnapshot> {
  const revision = input.expectedRevision + 1;
  const result =
    input.expectedRevision === 0
      ? await db
          .prepare(
            `INSERT INTO e2ee_share_link_names
               (user_id, revision, sequence, record, updated_at)
             VALUES (?, 1, ?, ?, ?)
             ON CONFLICT(user_id) DO NOTHING`
          )
          .bind(userId, input.sequence, input.record, now)
          .run()
      : await db
          .prepare(
            `UPDATE e2ee_share_link_names
             SET revision = ?, sequence = ?, record = ?, updated_at = ?
             WHERE user_id = ? AND revision = ? AND sequence < ?`
          )
          .bind(
            revision,
            input.sequence,
            input.record,
            now,
            userId,
            input.expectedRevision,
            input.sequence
          )
          .run();
  if (result.meta?.changes !== 1) {
    throw new ShareLinkNamesConflictError(
      await loadShareLinkNames(db, userId)
    );
  }
  return {
    revision,
    sequence: input.sequence,
    record: input.record,
    updatedAt: now
  };
}

/** Profile erasure removes the names with the rest of the profile. */
export async function shareLinkNameErasureStatements(
  db: D1Database,
  userId: string
): Promise<D1PreparedStatement[]> {
  if (!(await isShareLinkNameStorageReady(db))) return [];
  return [
    db
      .prepare('DELETE FROM e2ee_share_link_names WHERE user_id = ?')
      .bind(userId)
  ];
}
