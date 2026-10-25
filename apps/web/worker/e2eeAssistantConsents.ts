/**
 * Per-project assistant consent on end-to-end encrypted projects (ADR-024
 * Phase 6, slice 6-1; plan default M6: per user, per project). The browser
 * writes a canonical record MAC'd under its account key; the Worker cannot
 * verify the MAC and does not try. It checks what it can — the record is
 * canonical, names this account and this project, the project is an
 * encrypted one the caller owns or is a member of, and the sequence moves
 * forward — and keeps the record's reading in columns for two purposes:
 * its own gate on `/api/assistant/proposals` (defence in depth and an audit
 * trail; browsers never rely on it) and showing co-members who allowed it.
 *
 * Routes, served by `handleE2eeRequest` after the rollout flags
 * (E2EE_KEYS_ENABLED and E2EE_PROJECTS_ENABLED) and, for PUT, the
 * session/erasure write authorization:
 *   GET  /api/e2ee/assistant-consents                     the caller's records
 *   GET  /api/e2ee/assistant-consents/:projectId          one of them, or null
 *   PUT  /api/e2ee/assistant-consents/:projectId          store a newer record
 *   GET  /api/e2ee/assistant-consents/:projectId/members  who allowed it (M6)
 * Refused with 503 until migration 0041 is in D1.
 */
import {
  ASSISTANT_CONSENT_MAC_BYTES,
  MAX_ASSISTANT_CONSENT_BYTES,
  decodeAssistantConsent,
  fromBase64Url
} from '@openzcad/crypto';
import {
  ASSISTANT_CONSENT_COPY_VERSION,
  type E2eeAssistantConsentListResponse,
  type E2eeAssistantConsentRecord,
  type E2eeAssistantConsentResponse,
  type E2eeProjectAssistantConsentsResponse
} from '@openzcad/shared';
import { isE2eeAssistantConsentStorageReady } from '@openzcad/cloudflare-adapters';

export { isE2eeAssistantConsentStorageReady };

export const ASSISTANT_CONSENTS_ROUTE = '/api/e2ee/assistant-consents';
const SINGLE_ROUTE = /^\/api\/e2ee\/assistant-consents\/([^/]+)$/;
const MEMBERS_ROUTE = /^\/api\/e2ee\/assistant-consents\/([^/]+)\/members$/;

export function isAssistantConsentPath(pathname: string): boolean {
  return (
    pathname === ASSISTANT_CONSENTS_ROUTE ||
    pathname.startsWith(`${ASSISTANT_CONSENTS_ROUTE}/`)
  );
}

interface ConsentRow {
  project_id: string;
  allowed: number;
  copy_version: number;
  route: string;
  record: string;
  record_mac: string;
  sequence: number;
  updated_at: string;
  revoked_at: string | null;
}

const COLUMNS = `project_id, allowed, copy_version, route, record, record_mac,
  sequence, updated_at, revoked_at`;

function respond(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }
  });
}

function refusal(status: number, code: string, message: string): Response {
  return respond({ error: message, code }, status);
}

function recordOf(row: ConsentRow): E2eeAssistantConsentRecord {
  return {
    projectId: row.project_id,
    record: row.record,
    recordMac: row.record_mac,
    allowed: row.allowed === 1,
    copyVersion: row.copy_version,
    route: row.route,
    sequence: row.sequence,
    updatedAt: row.updated_at,
    revokedAt: row.revoked_at
  };
}

async function storedRow(
  db: D1Database,
  userId: string,
  projectId: string
): Promise<ConsentRow | null> {
  return db
    .prepare(
      `SELECT ${COLUMNS} FROM e2ee_assistant_consents
       WHERE user_id = ? AND project_id = ?`
    )
    .bind(userId, projectId)
    .first<ConsentRow>();
}

/**
 * An encrypted (format 2), not deleted project the caller owns or is a
 * member of. The same answer for one that does not exist, so the route
 * reveals nothing about other accounts' projects.
 */
async function accessibleEncryptedProject(
  db: D1Database,
  userId: string,
  projectId: string
): Promise<boolean> {
  const row = await db
    .prepare(
      `SELECT 1 AS ok FROM projects p
       WHERE p.id = ? AND p.storage_format = 2 AND p.status != 'deleted' AND (
         p.user_id = ? OR EXISTS (
           SELECT 1 FROM project_members pm
           WHERE pm.project_id = p.id AND pm.user_id = ?
         )
       )`
    )
    .bind(projectId, userId, userId)
    .first<{ ok: number }>();
  return row?.ok === 1;
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

function projectIdOf(raw: string): string | null {
  let projectId: string;
  try {
    projectId = decodeURIComponent(raw);
  } catch {
    return null;
  }
  return /^[\x21-\x7e]{1,128}$/.test(projectId) ? projectId : null;
}

/**
 * The assistant gate (decision D7, lifted per project by Phase 6): the
 * route this account consented to for the project, when a live consent for
 * the current copy exists, else null. Callers check the flag and storage
 * readiness first; plaintext projects never reach this.
 */
export async function liveAssistantConsentRoute(
  db: D1Database,
  userId: string,
  projectId: string
): Promise<string | null> {
  const row = await db
    .prepare(
      `SELECT route FROM e2ee_assistant_consents
       WHERE user_id = ? AND project_id = ? AND allowed = 1
         AND revoked_at IS NULL AND copy_version >= ?`
    )
    .bind(userId, projectId, ASSISTANT_CONSENT_COPY_VERSION)
    .first<{ route: string }>();
  return row ? row.route : null;
}

/** Profile erasure removes the account's consents with the key tables. */
export async function assistantConsentErasureStatements(
  db: D1Database,
  userId: string
): Promise<D1PreparedStatement[]> {
  if (!(await isE2eeAssistantConsentStorageReady(db))) return [];
  return [
    db
      .prepare('DELETE FROM e2ee_assistant_consents WHERE user_id = ?')
      .bind(userId)
  ];
}

/**
 * Serves the consent routes. The caller has already checked the flags and
 * readiness and, for PUT, the write authorization whose SQL predicate binds
 * the write to a live session and the erasure fence.
 */
export async function handleAssistantConsentRequest(
  request: Request,
  db: D1Database,
  userId: string,
  authorization: { sql: string; binds: readonly unknown[] },
  body: () => Promise<Record<string, unknown>>
): Promise<Response> {
  const { pathname } = new URL(request.url);
  const method = request.method;
  if (pathname === ASSISTANT_CONSENTS_ROUTE) {
    if (method !== 'GET') return refusal(404, 'NOT_FOUND', 'Not found.');
    const { results } = await db
      .prepare(
        `SELECT ${COLUMNS} FROM e2ee_assistant_consents
         WHERE user_id = ? ORDER BY updated_at DESC`
      )
      .bind(userId)
      .all<ConsentRow>();
    return respond({
      consents: (results ?? []).map(recordOf)
    } satisfies E2eeAssistantConsentListResponse);
  }
  const members = MEMBERS_ROUTE.exec(pathname);
  if (members) {
    const projectId = projectIdOf(members[1]!);
    if (method !== 'GET' || !projectId) {
      return refusal(404, 'NOT_FOUND', 'Not found.');
    }
    if (!(await accessibleEncryptedProject(db, userId, projectId))) {
      return refusal(404, 'PROJECT_NOT_FOUND', 'Project not found.');
    }
    // Only users who still own or belong to the project are listed.
    const { results } = await db
      .prepare(
        `SELECT c.user_id, c.allowed, c.revoked_at, c.updated_at
         FROM e2ee_assistant_consents c JOIN projects p ON p.id = c.project_id
         WHERE c.project_id = ? AND (
           c.user_id = p.user_id OR EXISTS (
             SELECT 1 FROM project_members pm
             WHERE pm.project_id = c.project_id AND pm.user_id = c.user_id
           )
         )
         ORDER BY c.updated_at DESC`
      )
      .bind(projectId)
      .all<{
        user_id: string;
        allowed: number;
        revoked_at: string | null;
        updated_at: string;
      }>();
    return respond({
      consents: (results ?? []).map((row) => ({
        userId: row.user_id,
        allowed: row.allowed === 1 && row.revoked_at === null,
        updatedAt: row.updated_at
      }))
    } satisfies E2eeProjectAssistantConsentsResponse);
  }
  const single = SINGLE_ROUTE.exec(pathname);
  const projectId = single ? projectIdOf(single[1]!) : null;
  if (!projectId) return refusal(404, 'NOT_FOUND', 'Not found.');
  if (method === 'GET') {
    const row = await storedRow(db, userId, projectId);
    return respond({
      consent: row ? recordOf(row) : null
    } satisfies E2eeAssistantConsentResponse);
  }
  if (method !== 'PUT') return refusal(404, 'NOT_FOUND', 'Not found.');

  const input = await body();
  const recordBytes = base64UrlBytes(input.record, MAX_ASSISTANT_CONSENT_BYTES);
  const mac = base64UrlBytes(input.recordMac, ASSISTANT_CONSENT_MAC_BYTES);
  if (!recordBytes || !mac || mac.byteLength !== ASSISTANT_CONSENT_MAC_BYTES) {
    return refusal(
      400,
      'E2EE_REQUEST_INVALID',
      'record and recordMac must be base64url; the MAC is 32 bytes.'
    );
  }
  let decoded: ReturnType<typeof decodeAssistantConsent>;
  try {
    decoded = decodeAssistantConsent(recordBytes);
  } catch {
    return refusal(
      400,
      'E2EE_REQUEST_INVALID',
      'The consent record is not a canonical assistant consent record.'
    );
  }
  if (decoded.userId !== userId || decoded.projectId !== projectId) {
    return refusal(
      400,
      'E2EE_REQUEST_INVALID',
      'The consent record names another account or project.'
    );
  }
  if (!(await accessibleEncryptedProject(db, userId, projectId))) {
    return refusal(404, 'PROJECT_NOT_FOUND', 'Project not found.');
  }
  const now = new Date().toISOString();
  // One statement: the session/erasure predicate admits the write and the
  // upsert's own WHERE refuses a sequence that does not move forward. A
  // revocation stamps revoked_at, which the assistant gate reads.
  const written = await db
    .prepare(
      `INSERT INTO e2ee_assistant_consents
         (user_id, project_id, allowed, copy_version, route, record,
          record_mac, sequence, updated_at, revoked_at)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE ${authorization.sql}
       ON CONFLICT(user_id, project_id) DO UPDATE SET
         allowed = excluded.allowed,
         copy_version = excluded.copy_version,
         route = excluded.route,
         record = excluded.record,
         record_mac = excluded.record_mac,
         sequence = excluded.sequence,
         updated_at = excluded.updated_at,
         revoked_at = excluded.revoked_at
       WHERE excluded.sequence > e2ee_assistant_consents.sequence`
    )
    .bind(
      userId,
      projectId,
      decoded.allowed ? 1 : 0,
      decoded.copyVersion,
      decoded.route,
      input.record,
      input.recordMac,
      decoded.sequence,
      now,
      decoded.allowed ? null : now,
      ...authorization.binds
    )
    .run();
  const row = await storedRow(db, userId, projectId);
  if ((written.meta?.changes ?? 0) !== 1) {
    if (row && row.sequence >= decoded.sequence) {
      return respond(
        {
          error:
            'A newer assistant choice is already stored for this project. Reload and try again.',
          code: 'E2EE_ASSISTANT_CONSENT_STALE',
          consent: recordOf(row)
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
    consent: row ? recordOf(row) : null
  } satisfies E2eeAssistantConsentResponse);
}
