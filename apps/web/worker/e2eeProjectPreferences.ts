/**
 * The account's "Encrypt new projects" opt-in (ADR-024 Phase 4, decision
 * D2). The browser writes a canonical record MAC'd under its account key;
 * the Worker cannot verify the MAC and does not try. It checks what it can —
 * the record is canonical, names this account, and moves the sequence
 * forward — and reads `encrypt_new_projects` for one purpose: refusing new
 * plaintext projects once an account has opted in.
 *
 * Served under `/api/e2ee/project-preferences` by `handleE2eeRequest`, which
 * applies the rollout flag (E2EE_PROJECTS_ENABLED) and the session/erasure
 * write authorization before calling in here. Refused with 503 until
 * migration 0031 is in D1.
 */
import {
  ACCOUNT_RECORD_MAC_BYTES,
  MAX_PROJECT_PREFERENCES_BYTES,
  decodeProjectPreferences,
  fromBase64Url
} from '@openzcad/crypto';
import type {
  E2eeProjectPreferenceRecord,
  E2eeProjectPreferenceResponse
} from '@openzcad/shared';
import { cachedSchemaProbe } from '@openzcad/cloudflare-adapters';

export const PROJECT_PREFERENCES_ROUTE = '/api/e2ee/project-preferences';

interface PreferenceRow {
  encrypt_new_projects: number;
  record: string;
  record_mac: string;
  sequence: number;
  updated_at: string;
}

/**
 * Whether migration 0031 is installed: the preference table and the
 * projects' storage-format column. Anything else — including a failed probe
 * — reads as not ready, which keeps the opt-in closed and the preference
 * routes at 503. Probed once per isolate (see `cachedSchemaProbe`).
 */
export const isE2eeProjectPreferenceStorageReady = cachedSchemaProbe(
  `SELECT
     (SELECT COUNT(*) FROM pragma_table_info('e2ee_project_preferences')
      WHERE name IN ('user_id', 'encrypt_new_projects', 'record',
                     'record_mac', 'sequence', 'updated_at')) AS columns,
     (SELECT COUNT(*) FROM pragma_table_info('projects')
      WHERE name = 'storage_format') AS format_column`,
  (row) => row?.columns === 6 && row.format_column === 1
);

/**
 * Decision D2: true when this account opted in to encrypting new projects.
 * Callers apply the rollout flag first; a database without migration 0031
 * holds no opt-in.
 */
export async function accountRequiresEncryptedProjects(
  db: D1Database | undefined,
  userId: string
): Promise<boolean> {
  if (!db || !(await isE2eeProjectPreferenceStorageReady(db))) return false;
  const row = await db
    .prepare(
      'SELECT encrypt_new_projects FROM e2ee_project_preferences WHERE user_id = ?'
    )
    .bind(userId)
    .first<{ encrypt_new_projects: number }>();
  return row?.encrypt_new_projects === 1;
}

/** Profile erasure removes the opt-in with the key tables. */
export function projectPreferenceErasureStatement(
  db: D1Database,
  userId: string
): D1PreparedStatement {
  return db
    .prepare('DELETE FROM e2ee_project_preferences WHERE user_id = ?')
    .bind(userId);
}

function respond(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }
  });
}

function refusal(status: number, code: string, message: string): Response {
  return respond({ error: message, code }, status);
}

function recordOf(row: PreferenceRow): E2eeProjectPreferenceRecord {
  return {
    record: row.record,
    recordMac: row.record_mac,
    encryptNewProjects: row.encrypt_new_projects === 1,
    sequence: row.sequence,
    updatedAt: row.updated_at
  };
}

async function storedRow(
  db: D1Database,
  userId: string
): Promise<PreferenceRow | null> {
  return db
    .prepare(
      `SELECT encrypt_new_projects, record, record_mac, sequence, updated_at
       FROM e2ee_project_preferences WHERE user_id = ?`
    )
    .bind(userId)
    .first<PreferenceRow>();
}

function base64UrlBytes(value: unknown, maxBytes: number): Uint8Array | null {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > Math.ceil((maxBytes * 4) / 3)
  ) {
    return null;
  }
  try {
    return fromBase64Url(value);
  } catch {
    return null;
  }
}

/**
 * GET answers the stored record (or null); PUT stores a newer one. The
 * caller has already checked the flag, readiness and, for PUT, the write
 * authorization whose SQL predicate binds the write to a live session and
 * the erasure fence.
 */
export async function handleProjectPreferenceRequest(
  request: Request,
  db: D1Database,
  userId: string,
  authorization: { sql: string; binds: readonly unknown[] },
  body: () => Promise<Record<string, unknown>>
): Promise<Response> {
  if (request.method === 'GET') {
    const row = await storedRow(db, userId);
    return respond({
      preference: row ? recordOf(row) : null
    } satisfies E2eeProjectPreferenceResponse);
  }
  if (request.method !== 'PUT') {
    return refusal(404, 'NOT_FOUND', 'Not found.');
  }
  const input = await body();
  const recordBytes = base64UrlBytes(
    input.record,
    MAX_PROJECT_PREFERENCES_BYTES
  );
  const mac = base64UrlBytes(input.recordMac, ACCOUNT_RECORD_MAC_BYTES);
  if (!recordBytes || !mac || mac.byteLength !== ACCOUNT_RECORD_MAC_BYTES) {
    return refusal(
      400,
      'E2EE_REQUEST_INVALID',
      'record and recordMac must be base64url; the MAC is 32 bytes.'
    );
  }
  let decoded: ReturnType<typeof decodeProjectPreferences>;
  try {
    decoded = decodeProjectPreferences(recordBytes);
  } catch {
    return refusal(
      400,
      'E2EE_REQUEST_INVALID',
      'The preference record is not a canonical project preference record.'
    );
  }
  if (decoded.userId !== userId) {
    return refusal(
      400,
      'E2EE_REQUEST_INVALID',
      'The preference record names another account.'
    );
  }
  const now = new Date().toISOString();
  // One statement: the session/erasure predicate admits the write and the
  // upsert's own WHERE refuses a sequence that does not move forward.
  const written = await db
    .prepare(
      `INSERT INTO e2ee_project_preferences
         (user_id, encrypt_new_projects, record, record_mac, sequence, updated_at)
       SELECT ?, ?, ?, ?, ?, ? WHERE ${authorization.sql}
       ON CONFLICT(user_id) DO UPDATE SET
         encrypt_new_projects = excluded.encrypt_new_projects,
         record = excluded.record,
         record_mac = excluded.record_mac,
         sequence = excluded.sequence,
         updated_at = excluded.updated_at
       WHERE excluded.sequence > e2ee_project_preferences.sequence`
    )
    .bind(
      userId,
      decoded.encryptNewProjects ? 1 : 0,
      input.record,
      input.recordMac,
      decoded.sequence,
      now,
      ...authorization.binds
    )
    .run();
  const row = await storedRow(db, userId);
  if ((written.meta?.changes ?? 0) !== 1) {
    if (row && row.sequence >= decoded.sequence) {
      return respond(
        {
          error:
            'A newer encryption preference is already stored. Reload and try again.',
          code: 'E2EE_PREFERENCE_STALE',
          preference: recordOf(row)
        },
        409
      );
    }
    return refusal(
      401,
      'E2EE_SESSION_REQUIRED',
      'Sign in again before changing encryption settings.'
    );
  }
  return respond({
    preference: row ? recordOf(row) : null
  } satisfies E2eeProjectPreferenceResponse);
}
