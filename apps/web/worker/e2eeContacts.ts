/**
 * Contacts and verified pins (ADR-024 Phase 5, slice 5-1; roadmap L11).
 *
 * - `GET /api/e2ee/contacts`: the caller's identity-signed contacts list
 *   for their current identity generation, and the people they may look up.
 * - `POST /api/e2ee/contacts`: appends one entry. The Worker checks it under
 *   the caller's identity key and the list's rules (`verifyContactsList`),
 *   that it extends the stored head, and stores it in the same statement
 *   that checks the head and the generation, so two tabs cannot fork it.
 * - `GET /api/e2ee/users/:id/device-list`: another user's identity key and
 *   device list, served only when the two share a project (owner and
 *   member, or two members) or an invitation (decision M2). Anyone else,
 *   and an id that does not exist, gets the same 404, so the route cannot
 *   be used to enumerate accounts or their keys.
 *
 * The Worker is a store: browsers verify every list against their own pins
 * and never trust these checks. The contacts table is migration 0037; until
 * it is applied the contacts routes answer 503 and nothing else names it.
 * The device-list route needs only migration 0029.
 */
import {
  E2eeError,
  MAX_CONTACTS_ENTRIES,
  MAX_CONTACTS_ENTRY_BYTES,
  decodeContactsEntry,
  fromBase64Url,
  toHex,
  verifyContactsList,
  type SignedContactsEntry
} from '@openzcad/crypto';
import type {
  E2eeContactDeviceListResponse,
  E2eeContactPerson,
  E2eeContactsEntryRecord,
  E2eeContactsResponse
} from '@openzcad/shared';
import { isE2eeContactStorageReady } from '@openzcad/cloudflare-adapters';
import type { E2eeWriteAuthorization } from './e2eeWriteAuthorization';

export const CONTACTS_ROUTE = '/api/e2ee/contacts';
const DEVICE_LIST_ROUTE = /^\/api\/e2ee\/users\/([^/]+)\/device-list$/;
/** People one contacts response lists at most. */
export const MAX_CONTACT_PEOPLE = 500;
const SIGNATURE_BYTES = 65;

export function isE2eeContactsPath(pathname: string): boolean {
  return pathname === CONTACTS_ROUTE || DEVICE_LIST_ROUTE.test(pathname);
}

class ContactsRouteError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string
  ) {
    super(message);
    this.name = 'ContactsRouteError';
  }
}

function refuse(status: number, code: string, message: string): never {
  throw new ContactsRouteError(status, code, message);
}

function invalid(message: string): never {
  refuse(400, 'E2EE_REQUEST_INVALID', message);
}

function notFound(): never {
  refuse(
    404,
    'E2EE_CONTACT_NOT_FOUND',
    'No one you share a project or an invitation with has this id.'
  );
}

function respond(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }
  });
}

function isId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 128 &&
    /^[\x21-\x7e]+$/.test(value)
  );
}

/** Bytes from an unpadded base64url field of at most `max` bytes. */
function bytesField(value: unknown, what: string, max: number): Uint8Array {
  if (typeof value !== 'string' || value.length === 0) {
    invalid(`${what} must be base64url text`);
  }
  if (value.length > Math.ceil((max * 4) / 3)) invalid(`${what} is too long`);
  try {
    return fromBase64Url(value);
  } catch {
    invalid(`${what} is not base64url`);
  }
}

interface EntryRow {
  sequence: number;
  entry: string;
  signature: string;
}

async function currentGeneration(
  db: D1Database,
  userId: string
): Promise<{ generation: number; identity_key: string } | null> {
  return db
    .prepare(
      `SELECT generation, identity_key FROM e2ee_identities
       WHERE user_id = ? ORDER BY generation DESC LIMIT 1`
    )
    .bind(userId)
    .first<{ generation: number; identity_key: string }>();
}

async function contactRows(
  db: D1Database,
  userId: string,
  generation: number
): Promise<EntryRow[]> {
  const { results } = await db
    .prepare(
      `SELECT sequence, entry, signature FROM e2ee_contact_entries
       WHERE user_id = ? AND generation = ? ORDER BY sequence`
    )
    .bind(userId, generation)
    .all<EntryRow>();
  return results ?? [];
}

const toRecord = (row: EntryRow): E2eeContactsEntryRecord => ({
  sequence: row.sequence,
  entry: row.entry,
  signature: row.signature
});

/**
 * Everyone `userId` shares a project or a live invitation with (M2). An
 * email is returned only where the plaintext sharing flow already shows it
 * to this caller: an owner sees their members and invitees, a member and an
 * invitee see the owner and inviter. A co-member alone stays an id.
 */
async function relatedPeople(
  db: D1Database,
  userId: string
): Promise<E2eeContactPerson[]> {
  const now = Math.floor(Date.now() / 1000);
  const { results } = await db
    .prepare(
      `WITH related(user_id, email_known) AS (
         SELECT m.user_id, 1 FROM project_members m
           JOIN projects p ON p.id = m.project_id WHERE p.user_id = ?1
         UNION ALL
         SELECT p.user_id, 1 FROM project_members m
           JOIN projects p ON p.id = m.project_id WHERE m.user_id = ?1
         UNION ALL
         SELECT b.user_id, 0 FROM project_members a
           JOIN project_members b ON b.project_id = a.project_id
           WHERE a.user_id = ?1
         UNION ALL
         SELECT COALESCE(i.accepted_by_user_id, u.id), 1
           FROM project_invitations i
           LEFT JOIN users u ON i.accepted_by_user_id IS NULL AND u.email = i.email
           WHERE i.invited_by_user_id = ?1 AND i.revoked_at IS NULL
             AND (i.accepted_by_user_id IS NOT NULL OR i.expires_at >= ?2)
         UNION ALL
         SELECT i.invited_by_user_id, 1 FROM project_invitations i
           WHERE i.revoked_at IS NULL AND (i.accepted_by_user_id = ?1 OR (
             i.accepted_at IS NULL AND i.expires_at >= ?2
             AND i.email = (SELECT email FROM users WHERE id = ?1)))
       )
       SELECT r.user_id AS user_id,
              CASE WHEN MAX(r.email_known) = 1 THEN u.email END AS email
       FROM related r JOIN users u ON u.id = r.user_id
       WHERE r.user_id <> ?1
       GROUP BY r.user_id ORDER BY r.user_id LIMIT ?3`
    )
    .bind(userId, now, MAX_CONTACT_PEOPLE)
    .all<{ user_id: string; email: string | null }>();
  return (results ?? []).map((row) => ({
    userId: row.user_id,
    email: row.email ?? null
  }));
}

/** Whether `userId` may read `targetId`'s device list (M2). */
async function mayLookUp(
  db: D1Database,
  userId: string,
  targetId: string
): Promise<boolean> {
  if (userId === targetId) return true;
  const now = Math.floor(Date.now() / 1000);
  const row = await db
    .prepare(
      `SELECT
         EXISTS (SELECT 1 FROM project_members m
           JOIN projects p ON p.id = m.project_id
           WHERE (p.user_id = ?1 AND m.user_id = ?2)
              OR (p.user_id = ?2 AND m.user_id = ?1))
         OR EXISTS (SELECT 1 FROM project_members a
           JOIN project_members b ON b.project_id = a.project_id
           WHERE a.user_id = ?1 AND b.user_id = ?2)
         OR EXISTS (SELECT 1 FROM project_invitations i
           WHERE i.revoked_at IS NULL AND (
             (i.invited_by_user_id = ?1 AND (i.accepted_by_user_id = ?2 OR (
               i.accepted_at IS NULL AND i.expires_at >= ?3
               AND i.email = (SELECT email FROM users WHERE id = ?2))))
             OR (i.invited_by_user_id = ?2 AND (i.accepted_by_user_id = ?1 OR (
               i.accepted_at IS NULL AND i.expires_at >= ?3
               AND i.email = (SELECT email FROM users WHERE id = ?1))))))
         AS related`
    )
    .bind(userId, targetId, now)
    .first<{ related: number }>();
  return row?.related === 1;
}

async function contactsResponse(
  db: D1Database,
  userId: string
): Promise<E2eeContactsResponse> {
  const current = await currentGeneration(db, userId);
  return {
    generation: current?.generation ?? null,
    entries: current
      ? (await contactRows(db, userId, current.generation)).map(toRecord)
      : [],
    people: await relatedPeople(db, userId)
  };
}

async function handleAppend(
  db: D1Database,
  userId: string,
  authorization: E2eeWriteAuthorization,
  body: Record<string, unknown>
): Promise<E2eeContactsResponse> {
  const entry = bytesField(body.entry, 'entry', MAX_CONTACTS_ENTRY_BYTES);
  const signature = bytesField(body.signature, 'signature', SIGNATURE_BYTES);
  if (signature.byteLength !== SIGNATURE_BYTES) {
    invalid(`signature must be ${SIGNATURE_BYTES} bytes`);
  }
  if (!Number.isSafeInteger(body.generation)) {
    invalid('generation must be an integer');
  }
  const current = await currentGeneration(db, userId);
  if (!current) {
    refuse(409, 'E2EE_NOT_SET_UP', 'Encryption keys are not set up yet.');
  }
  if (body.generation !== current.generation) {
    refuse(
      409,
      'E2EE_GENERATION_CONFLICT',
      'The encryption identity changed meanwhile. Reload and try again.'
    );
  }
  const rows = await contactRows(db, userId, current.generation);
  if (rows.length >= MAX_CONTACTS_ENTRIES) {
    refuse(
      409,
      'E2EE_CONTACTS_FULL',
      'Your contacts list is full. Replace the recovery key to start a new one.'
    );
  }
  let sequence: number;
  try {
    sequence = decodeContactsEntry(entry).sequence;
  } catch (error) {
    if (error instanceof E2eeError) {
      refuse(
        400,
        'E2EE_CONTACTS_INVALID',
        `Not a contacts entry: ${error.message}`
      );
    }
    throw error;
  }
  if (sequence !== rows.length) {
    refuse(
      409,
      'E2EE_CONTACTS_CONFLICT',
      'Your contacts list changed meanwhile. Reload and try again.'
    );
  }
  const chain: SignedContactsEntry[] = [
    ...rows.map((row) => ({
      entry: fromBase64Url(row.entry),
      signature: fromBase64Url(row.signature)
    })),
    { entry, signature }
  ];
  let list;
  try {
    // Stored entries were checked when they were appended; re-check only
    // the new signature, but every rule over the whole chain.
    list = await verifyContactsList(
      fromBase64Url(current.identity_key),
      chain,
      { signaturesFrom: rows.length }
    );
  } catch (error) {
    if (error instanceof E2eeError) {
      refuse(
        400,
        'E2EE_CONTACTS_INVALID',
        `The contacts entry did not verify: ${error.message}`
      );
    }
    throw error;
  }
  if (list.userId !== userId) {
    refuse(
      400,
      'E2EE_CONTACTS_INVALID',
      'The contacts list names another user.'
    );
  }
  const result = await db
    .prepare(
      `INSERT INTO e2ee_contact_entries
         (user_id, generation, sequence, entry, signature, entry_hash, created_at)
       SELECT ?, ?, ?, ?, ?, ?, ?
       WHERE ${authorization.sql}
         AND (SELECT COUNT(*) FROM e2ee_contact_entries
              WHERE user_id = ? AND generation = ?) = ?
         AND (SELECT MAX(generation) FROM e2ee_identities WHERE user_id = ?) = ?`
    )
    .bind(
      userId,
      current.generation,
      sequence,
      body.entry,
      body.signature,
      toHex(list.headHash),
      new Date().toISOString(),
      ...authorization.binds,
      userId,
      current.generation,
      rows.length,
      userId,
      current.generation
    )
    .run()
    .catch((error: unknown) => {
      // A concurrent append took this sequence first.
      if (/UNIQUE|PRIMARY KEY|constraint/i.test(String(error))) return null;
      throw error;
    });
  if ((result?.meta?.changes ?? 0) !== 1) {
    refuse(
      409,
      'E2EE_CONTACTS_CONFLICT',
      'Your contacts list changed meanwhile. Reload and try again.'
    );
  }
  return contactsResponse(db, userId);
}

async function handleDeviceList(
  db: D1Database,
  userId: string,
  segment: string
): Promise<E2eeContactDeviceListResponse> {
  let targetId: string;
  try {
    targetId = decodeURIComponent(segment);
  } catch {
    notFound();
  }
  if (!isId(targetId) || !(await mayLookUp(db, userId, targetId))) notFound();
  const current = await currentGeneration(db, targetId);
  if (!current) return { userId: targetId, identity: null };
  const { results } = await db
    .prepare(
      `SELECT sequence, entry, signature FROM e2ee_device_list_entries
       WHERE user_id = ? AND generation = ? ORDER BY sequence`
    )
    .bind(targetId, current.generation)
    .all<EntryRow>();
  return {
    userId: targetId,
    identity: {
      generation: current.generation,
      identityKey: current.identity_key,
      entries: (results ?? []).map(toRecord)
    }
  };
}

/**
 * Handles the contacts routes for an authenticated session whose key routes
 * are enabled and whose key tables (migrations 0029 and 0030) exist; the
 * caller has checked both. Writes carry `authorization`'s predicate.
 */
export async function handleE2eeContactsRequest(
  request: Request,
  db: D1Database,
  userId: string,
  authorization: E2eeWriteAuthorization,
  readBody: () => Promise<Record<string, unknown>>
): Promise<Response> {
  const { pathname } = new URL(request.url);
  const method = request.method;
  try {
    const lookup = DEVICE_LIST_ROUTE.exec(pathname);
    if (lookup) {
      if (method !== 'GET') refuse(405, 'METHOD_NOT_ALLOWED', 'Use GET.');
      return respond(await handleDeviceList(db, userId, lookup[1]!));
    }
    if (method !== 'GET' && method !== 'POST') {
      refuse(405, 'METHOD_NOT_ALLOWED', 'Use GET or POST.');
    }
    if (!(await isE2eeContactStorageReady(db))) {
      refuse(
        503,
        'E2EE_UNAVAILABLE',
        'Contacts are unavailable until the database is updated.'
      );
    }
    if (method === 'GET') return respond(await contactsResponse(db, userId));
    return respond(
      await handleAppend(db, userId, authorization, await readBody()),
      201
    );
  } catch (error) {
    if (error instanceof ContactsRouteError) {
      return respond({ error: error.message, code: error.code }, error.status);
    }
    throw error;
  }
}

/**
 * Account erasure: the caller's contacts lists, before the identities they
 * hang from. Empty before migration 0037.
 */
export async function contactErasureStatements(
  db: D1Database,
  userId: string
): Promise<D1PreparedStatement[]> {
  if (!(await isE2eeContactStorageReady(db))) return [];
  return [
    db
      .prepare('DELETE FROM e2ee_contact_entries WHERE user_id = ?')
      .bind(userId)
  ];
}
