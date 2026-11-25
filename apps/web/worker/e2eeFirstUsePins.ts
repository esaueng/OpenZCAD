import { cachedSchemaProbe } from '@openzcad/cloudflare-adapters';
import type { E2eeWriteAuthorization } from './e2eeWriteAuthorization';

/**
 * The identities an account's devices pinned for other people on first use
 * (migration 0070, ADR-024 amendment 2026-11-25): one record per account,
 * sealed under the account key in the browser
 * (`src/lib/e2ee/firstUsePins.ts`), so every owner device compares an
 * invitee against what any of them added. The Worker never reads a pin. It
 * checks only the sealed record's plaintext header (the layout version and
 * the sequence, which must rise with every write, so no device or replayed
 * request stores an older record over a newer one) and, as every e2ee write
 * does, that the session is still admitted. The browser owns the merge: a
 * write names the revision it last read, and a device writing at the same
 * time is answered with the current copy, merges it and writes again.
 */
export const FIRST_USE_PINS_ROUTE = '/api/e2ee/first-use-pins';
/** Matches the migration's CHECK; leaves room for the 90 KiB plaintext cap. */
export const MAX_FIRST_USE_PINS_RECORD_CHARS = 128 * 1024;
/** The JSON body of a write: the record plus a little framing. */
export const MAX_FIRST_USE_PINS_BODY_BYTES =
  MAX_FIRST_USE_PINS_RECORD_CHARS + 1024;

const SEALED_RECORD_VERSION_1 = 1;
const COMMITMENT_BYTES = 32;
const HEADER_BYTES = 1 + COMMITMENT_BYTES + 4;
const IV_BYTES = 12;
const TAG_BYTES = 16;

export interface FirstUsePinsSnapshot {
  /** 0 while the account never stored pins. */
  revision: number;
  /** The stored record's sealed sequence; 0 with none. */
  sequence: number;
  record: string | null;
  updatedAt: string | null;
}

/** Whether migration 0070 installed the table and its erasure fence. */
export const isFirstUsePinStorageReady = cachedSchemaProbe(
  `SELECT
     (SELECT COUNT(*) FROM pragma_table_info('e2ee_first_use_pins')
      WHERE name IN ('user_id', 'revision', 'sequence', 'record', 'updated_at'))
       AS columns,
     (SELECT COUNT(*) FROM sqlite_schema
      WHERE type = 'trigger' AND name IN (
        'block_erasing_first_use_pins_insert',
        'block_erasing_first_use_pins_update'
      )) AS triggers`,
  (row) => row?.columns === 5 && row.triggers === 2
);

class FirstUsePinsRouteError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>
  ) {
    super(message);
    this.name = 'FirstUsePinsRouteError';
  }
}

const invalid = (message: string) =>
  new FirstUsePinsRouteError(400, 'E2EE_FIRST_USE_PINS_INVALID', message);

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
export function parseSaveFirstUsePins(body: unknown): {
  expectedRevision: number;
  record: string;
  sequence: number;
} {
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
  if (record.length > MAX_FIRST_USE_PINS_RECORD_CHARS) {
    throw new FirstUsePinsRouteError(
      413,
      'E2EE_FIRST_USE_PINS_TOO_LARGE',
      `First-use pins exceed the ${MAX_FIRST_USE_PINS_RECORD_CHARS}-character cloud limit.`
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

export async function loadFirstUsePins(
  db: D1Database,
  userId: string
): Promise<FirstUsePinsSnapshot> {
  const row = await db
    .prepare(
      `SELECT revision, sequence, record, updated_at
       FROM e2ee_first_use_pins WHERE user_id = ?`
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
 * Stores the record when the account copy is still at `expectedRevision`
 * (0: none stored yet), the record's sequence is above the stored one and
 * the session is still admitted. Otherwise answers the current copy, so the
 * browser can merge it and seal again past its sequence.
 */
export async function saveFirstUsePins(
  db: D1Database,
  userId: string,
  authorization: E2eeWriteAuthorization,
  input: { expectedRevision: number; record: string; sequence: number },
  now = new Date().toISOString()
): Promise<FirstUsePinsSnapshot> {
  const revision = input.expectedRevision + 1;
  const result =
    input.expectedRevision === 0
      ? await db
          .prepare(
            `INSERT INTO e2ee_first_use_pins
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
            `UPDATE e2ee_first_use_pins
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
    throw new FirstUsePinsRouteError(
      409,
      'E2EE_FIRST_USE_PINS_CONFLICT',
      'The first-use pins changed on another device.',
      { current: await loadFirstUsePins(db, userId) }
    );
  }
  return {
    revision,
    sequence: input.sequence,
    record: input.record,
    updatedAt: now
  };
}

const respond = (body: unknown, status = 200) =>
  Response.json(body, {
    status,
    headers: { 'Cache-Control': 'no-store' }
  });

/** GET the account's record, PUT a new one (`expectedRevision`, `record`). */
export async function handleFirstUsePinsRequest(
  request: Request,
  db: D1Database,
  userId: string,
  authorization: E2eeWriteAuthorization,
  readBody: () => Promise<Record<string, unknown>>
): Promise<Response> {
  try {
    if (!(await isFirstUsePinStorageReady(db))) {
      throw new FirstUsePinsRouteError(
        503,
        'E2EE_UNAVAILABLE',
        'First-use pins are unavailable until the database is updated.'
      );
    }
    if (request.method === 'GET') {
      return respond(await loadFirstUsePins(db, userId));
    }
    if (request.method !== 'PUT') {
      throw new FirstUsePinsRouteError(
        405,
        'METHOD_NOT_ALLOWED',
        'Use GET or PUT.'
      );
    }
    const input = parseSaveFirstUsePins(await readBody());
    return respond(await saveFirstUsePins(db, userId, authorization, input));
  } catch (error) {
    if (error instanceof FirstUsePinsRouteError) {
      return respond(
        {
          error: error.message,
          code: error.code,
          ...(error.details ? { details: error.details } : {})
        },
        error.status
      );
    }
    throw error;
  }
}

/** Profile erasure removes the pins with the rest of the profile. */
export async function firstUsePinErasureStatements(
  db: D1Database,
  userId: string
): Promise<D1PreparedStatement[]> {
  if (!(await isFirstUsePinStorageReady(db))) return [];
  return [
    db.prepare('DELETE FROM e2ee_first_use_pins WHERE user_id = ?').bind(userId)
  ];
}
