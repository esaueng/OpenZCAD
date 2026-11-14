/**
 * Contacts and verified pins (ADR-024 Phase 5, slice 5-1; roadmap L11).
 *
 * - `GET /api/e2ee/contacts`: the caller's identity-signed contacts list
 *   for their current identity generation, and the people they may look up.
 * - `POST /api/e2ee/contacts`: appends one sealed record (ADR-024 amendment
 *   2026-11-14). The Worker cannot open it; it checks what it can without
 *   the account key (`verifySealedContactsChain`): the record is
 *   identity-signed, extends the stored head by sequence and record hash,
 *   and is sealed under the account's current account key. It stores it in
 *   the same statement that checks the head, the generation and the device
 *   list, so two tabs cannot fork it and a rotation cannot slip past it. A
 *   plaintext entry is refused: the server no longer accepts the list in a
 *   form it can read.
 * - `PUT /api/e2ee/contacts`: replaces a plaintext list from before sealing
 *   with the same entries sealed, deleting the plaintext rows in the same
 *   transaction (and any a replaced identity left).
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
  decodeDeviceListEntry,
  fromBase64Url,
  isSealedContactsRecord,
  readSealedContactsHeader,
  toBase64Url,
  toHex,
  verifySealedContactsChain,
  type SignedContactsEntry,
  type VerifiedSealedContactsChain
} from '@openzcad/crypto';
import type {
  E2eeContactDeviceListResponse,
  E2eeContactPerson,
  E2eeContactsEntryRecord,
  E2eeContactsResponse
} from '@openzcad/shared';
import {
  isE2eeContactStorageReady,
  isE2eeInvitationStorageReady,
  isE2eeProjectGroupStorageReady
} from '@openzcad/cloudflare-adapters';
import { deviceListMoved, deviceListUnchanged } from './e2eeProjects';
import type { E2eeWriteAuthorization } from './e2eeWriteAuthorization';

export const CONTACTS_ROUTE = '/api/e2ee/contacts';
const DEVICE_LIST_ROUTE = /^\/api\/e2ee\/users\/([^/]+)\/device-list$/;
/** People one contacts response lists at most. */
export const MAX_CONTACT_PEOPLE = 500;
const SIGNATURE_BYTES = 65;
/**
 * The base64url text every stored row starts with: exactly the 3-byte magic
 * of a plaintext entry ("OZK") or a sealed record ("OZC"), so SQL can tell
 * them apart without decoding.
 */
const PLAINTEXT_PREFIX = toBase64Url(Uint8Array.of(0x4f, 0x5a, 0x4b));
const SEALED_PREFIX = toBase64Url(Uint8Array.of(0x4f, 0x5a, 0x43));

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

interface ContactRow extends EntryRow {
  entry_hash: string;
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
): Promise<ContactRow[]> {
  const { results } = await db
    .prepare(
      `SELECT sequence, entry, signature, entry_hash FROM e2ee_contact_entries
       WHERE user_id = ? AND generation = ? ORDER BY sequence`
    )
    .bind(userId, generation)
    .all<ContactRow>();
  return results ?? [];
}

const isSealedRow = (row: EntryRow) => row.entry.startsWith(SEALED_PREFIX);

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
  // Encrypted invitations (migration 0038), when the table exists. An
  // accepted invitation relates its sides only until the Add completes it
  // or it expires; from then on membership decides, so a removed member's
  // relation (and email) goes with the membership.
  const encryptedInvitations = await isE2eeInvitationStorageReady(db);
  const { results } = await db
    .prepare(
      // D1 limits each compound SELECT to five terms. Keep membership and
      // invitation relations separate, then deduplicate and cap the combined
      // result in the same snapshot with the same email-visibility rule.
      `WITH membership_related(user_id, email_known) AS (
         SELECT m.user_id, 1 FROM project_members m
           JOIN projects p ON p.id = m.project_id WHERE p.user_id = ?1
         UNION ALL
         SELECT p.user_id, 1 FROM project_members m
           JOIN projects p ON p.id = m.project_id WHERE m.user_id = ?1
         UNION ALL
         SELECT b.user_id, 0 FROM project_members a
           JOIN project_members b ON b.project_id = a.project_id
           WHERE a.user_id = ?1
       ), invitation_related(user_id, email_known) AS (
         SELECT u.id, 1 FROM project_invitations i
           JOIN users u ON u.email = i.email
           WHERE i.invited_by_user_id = ?1 AND i.revoked_at IS NULL
             AND i.accepted_at IS NULL AND i.expires_at >= ?2
         UNION ALL
         SELECT i.invited_by_user_id, 1 FROM project_invitations i
           WHERE i.revoked_at IS NULL AND i.accepted_at IS NULL
             AND i.expires_at >= ?2
             AND i.email = (SELECT email FROM users WHERE id = ?1)${
               encryptedInvitations
                 ? `
         UNION ALL
         SELECT e.accepted_by_user_id, 1 FROM e2ee_invitations e
           WHERE e.invited_by_user_id = ?1 AND e.accepted_by_user_id IS NOT NULL
             AND e.revoked_at IS NULL AND e.completed_at IS NULL
             AND e.expires_at >= ?4
         UNION ALL
         SELECT e.invited_by_user_id, 1 FROM e2ee_invitations e
           WHERE e.accepted_by_user_id = ?1 AND e.revoked_at IS NULL
             AND e.completed_at IS NULL AND e.expires_at >= ?4`
                 : ''
             }
       ), related(user_id, email_known) AS (
         SELECT user_id, email_known FROM membership_related
         UNION ALL
         SELECT user_id, email_known FROM invitation_related
       )
       SELECT r.user_id AS user_id,
              CASE WHEN MAX(r.email_known) = 1 THEN u.email END AS email
       FROM related r JOIN users u ON u.id = r.user_id
       WHERE r.user_id <> ?1
       GROUP BY r.user_id ORDER BY r.user_id LIMIT ?3`
    )
    // ?4 (milliseconds, as encrypted invitations store expiry) only when used.
    .bind(
      ...[userId, now, MAX_CONTACT_PEOPLE],
      ...(encryptedInvitations ? [Date.now()] : [])
    )
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
  // An accepted encrypted invitation relates its two sides (migration
  // 0038) while it is open: the invitee checks the owner's statement
  // signature, the owner the invitee's KeyPackage leaves. Before acceptance
  // the server knows only the email's hash, so it relates nobody; once the
  // Add completes it, or it expires, membership decides.
  const encrypted = (await isE2eeInvitationStorageReady(db))
    ? `
         OR EXISTS (SELECT 1 FROM e2ee_invitations e
           WHERE e.revoked_at IS NULL AND e.completed_at IS NULL
             AND e.expires_at >= ?4 AND (
             (e.invited_by_user_id = ?1 AND e.accepted_by_user_id = ?2)
             OR (e.invited_by_user_id = ?2 AND e.accepted_by_user_id = ?1)))`
    : '';
  // Someone who held a leaf in a project the caller can still open: their
  // signatures on its history must keep verifying after they leave or are
  // removed, while they themselves lose this relation with the membership.
  const authors = (await isE2eeProjectGroupStorageReady(db))
    ? `
         OR EXISTS (SELECT 1 FROM e2ee_project_leaves l
           JOIN projects p ON p.id = l.project_id
           WHERE l.user_id = ?2 AND (p.user_id = ?1 OR EXISTS (
             SELECT 1 FROM project_members m
             WHERE m.project_id = l.project_id AND m.user_id = ?1)))`
    : '';
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
           WHERE i.revoked_at IS NULL AND i.accepted_at IS NULL
             AND i.expires_at >= ?3 AND (
             (i.invited_by_user_id = ?1
               AND i.email = (SELECT email FROM users WHERE id = ?2))
             OR (i.invited_by_user_id = ?2
               AND i.email = (SELECT email FROM users WHERE id = ?1))))${encrypted}${authors}
         AS related`
    )
    .bind(userId, targetId, now, ...(encrypted ? [Date.now()] : []))
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

/**
 * The caller's device-list head and the `accountKeySequence` of the account
 * key it commits to: the sequence of the entry that first committed to it.
 * Entries were verified when they were appended.
 */
async function currentAccountKey(
  db: D1Database,
  userId: string,
  generation: number
): Promise<{ generation: number; headSequence: number; keySequence: number }> {
  const { results } = await db
    .prepare(
      `SELECT entry FROM e2ee_device_list_entries
       WHERE user_id = ? AND generation = ? ORDER BY sequence`
    )
    .bind(userId, generation)
    .all<{ entry: string }>();
  const commitments: { sequence: number; commitment: string }[] = [];
  try {
    for (const row of results ?? []) {
      const entry = decodeDeviceListEntry(fromBase64Url(row.entry));
      commitments.push({
        sequence: entry.sequence,
        commitment: toHex(entry.accountKeyCommitment)
      });
    }
  } catch {
    refuse(409, 'E2EE_NOT_SET_UP', 'Encryption keys are not set up yet.');
  }
  const head = commitments.at(-1);
  if (!head) {
    refuse(409, 'E2EE_NOT_SET_UP', 'Encryption keys are not set up yet.');
  }
  let first = commitments.length - 1;
  while (first > 0 && commitments[first - 1]!.commitment === head.commitment) {
    first -= 1;
  }
  return {
    generation,
    headSequence: head.sequence,
    keySequence: commitments[first]!.sequence
  };
}

function refuseStaleKey(): never {
  refuse(
    409,
    'E2EE_DEVICE_LIST_CHANGED',
    'Your account key changed meanwhile. Reload and try again.'
  );
}

function conflict(): never {
  refuse(
    409,
    'E2EE_CONTACTS_CONFLICT',
    'Your contacts list changed meanwhile. Reload and try again.'
  );
}

/** A signed record from the request: sealed, or refused before any work. */
function signedRecord(value: unknown, signatureValue: unknown) {
  const entry = bytesField(value, 'entry', MAX_CONTACTS_ENTRY_BYTES);
  const signature = bytesField(signatureValue, 'signature', SIGNATURE_BYTES);
  if (signature.byteLength !== SIGNATURE_BYTES) {
    invalid(`signature must be ${SIGNATURE_BYTES} bytes`);
  }
  if (!isSealedContactsRecord(entry)) {
    let plaintext = false;
    try {
      decodeContactsEntry(entry);
      plaintext = true;
    } catch {
      // Not a plaintext entry either.
    }
    if (plaintext) {
      refuse(
        400,
        'E2EE_CONTACTS_SEALED_REQUIRED',
        'Contacts lists are stored sealed now. Reload OpenZCAD and try again.'
      );
    }
    refuse(400, 'E2EE_CONTACTS_INVALID', 'Not a sealed contacts record.');
  }
  return { entry, signature };
}

async function requireGeneration(
  db: D1Database,
  userId: string,
  generation: unknown
): Promise<{ generation: number; identity_key: string }> {
  if (!Number.isSafeInteger(generation)) {
    invalid('generation must be an integer');
  }
  const current = await currentGeneration(db, userId);
  if (!current) {
    refuse(409, 'E2EE_NOT_SET_UP', 'Encryption keys are not set up yet.');
  }
  if (generation !== current.generation) {
    refuse(
      409,
      'E2EE_GENERATION_CONFLICT',
      'The encryption identity changed meanwhile. Reload and try again.'
    );
  }
  return current;
}

function sealedHeader(entry: Uint8Array) {
  try {
    return readSealedContactsHeader(entry);
  } catch (error) {
    if (error instanceof E2eeError) {
      refuse(
        400,
        'E2EE_CONTACTS_INVALID',
        `Not a sealed contacts record: ${error.message}`
      );
    }
    throw error;
  }
}

async function checkSealedChain(
  identityKey: string,
  chain: SignedContactsEntry[],
  signaturesFrom: number
): Promise<VerifiedSealedContactsChain> {
  try {
    return await verifySealedContactsChain(fromBase64Url(identityKey), chain, {
      signaturesFrom
    });
  } catch (error) {
    if (error instanceof E2eeError) {
      refuse(
        400,
        'E2EE_CONTACTS_INVALID',
        `The contacts record did not verify: ${error.message}`
      );
    }
    throw error;
  }
}

/**
 * Plaintext rows a replaced identity left: no browser reads a replaced
 * identity's list again, and it cannot be resealed under a key no device
 * holds, so the first sealed write of the account deletes them.
 */
function replacedPlaintextCleanup(
  db: D1Database,
  userId: string,
  generation: number
): D1PreparedStatement {
  return db
    .prepare(
      `DELETE FROM e2ee_contact_entries
       WHERE user_id = ? AND generation < ? AND substr(entry, 1, 4) = ?`
    )
    .bind(userId, generation, PLAINTEXT_PREFIX);
}

function isConstraintError(error: unknown): boolean {
  return /UNIQUE|PRIMARY KEY|constraint/i.test(String(error));
}

async function handleAppend(
  db: D1Database,
  userId: string,
  authorization: E2eeWriteAuthorization,
  body: Record<string, unknown>
): Promise<E2eeContactsResponse> {
  const { entry, signature } = signedRecord(body.entry, body.signature);
  const current = await requireGeneration(db, userId, body.generation);
  const rows = await contactRows(db, userId, current.generation);
  if (rows.length >= MAX_CONTACTS_ENTRIES) {
    refuse(
      409,
      'E2EE_CONTACTS_FULL',
      'Your contacts list is full. Replace the recovery key to start a new one.'
    );
  }
  if (!rows.every(isSealedRow)) {
    refuse(
      409,
      'E2EE_CONTACTS_RESEAL_REQUIRED',
      'Your contacts list must be sealed before it can change. Reload and try again.'
    );
  }
  const chain: SignedContactsEntry[] = [
    ...rows.map((row) => ({
      entry: fromBase64Url(row.entry),
      signature: fromBase64Url(row.signature)
    })),
    { entry, signature }
  ];
  // The sequence first: a stale record is a conflict, not an invalid one.
  if (sealedHeader(entry).sequence !== rows.length) conflict();
  const checked = await checkSealedChain(
    current.identity_key,
    chain,
    rows.length
  );
  const key = await currentAccountKey(db, userId, current.generation);
  if (checked.head.accountKeySequence !== key.keySequence) refuseStaleKey();
  const unchanged = deviceListUnchanged(userId, key);
  let result: { meta?: { changes?: number } } | undefined;
  try {
    [result] = await db.batch([
      db
        .prepare(
          `INSERT INTO e2ee_contact_entries
             (user_id, generation, sequence, entry, signature, entry_hash, created_at)
           SELECT ?, ?, ?, ?, ?, ?, ?
           WHERE ${authorization.sql}
             AND (SELECT COUNT(*) FROM e2ee_contact_entries
                  WHERE user_id = ? AND generation = ?) = ?
             AND NOT EXISTS (SELECT 1 FROM e2ee_contact_entries
                  WHERE user_id = ? AND generation = ? AND substr(entry, 1, 4) <> ?)
             AND ${unchanged.sql}`
        )
        .bind(
          userId,
          current.generation,
          rows.length,
          body.entry,
          body.signature,
          toHex(checked.head.recordHash),
          new Date().toISOString(),
          ...authorization.binds,
          userId,
          current.generation,
          rows.length,
          userId,
          current.generation,
          SEALED_PREFIX,
          ...unchanged.binds
        ),
      replacedPlaintextCleanup(db, userId, current.generation)
    ]);
  } catch (error) {
    // A concurrent append took this sequence first.
    if (isConstraintError(error)) conflict();
    throw error;
  }
  if ((result?.meta?.changes ?? 0) !== 1) {
    if (await deviceListMoved(db, userId, key)) refuseStaleKey();
    conflict();
  }
  return contactsResponse(db, userId);
}
/**
 * Replaces the caller's plaintext list with the same entries sealed. The
 * Worker cannot see that the entries match (the browser that resealed them
 * checked, and every device checks its own pin against them later); it
 * checks that the records are a whole sealed chain of the same length under
 * the current account key, and swaps the rows only while the stored list is
 * still the plaintext list whose head the browser named.
 */
async function handleReseal(
  db: D1Database,
  userId: string,
  authorization: E2eeWriteAuthorization,
  body: Record<string, unknown>
): Promise<E2eeContactsResponse> {
  if (
    !Array.isArray(body.entries) ||
    body.entries.length === 0 ||
    body.entries.length > MAX_CONTACTS_ENTRIES
  ) {
    invalid(`entries must list 1 to ${MAX_CONTACTS_ENTRIES} records`);
  }
  if (
    typeof body.replaces !== 'string' ||
    !/^[0-9a-f]{64}$/.test(body.replaces)
  ) {
    invalid('replaces must be a lowercase hex entry hash');
  }
  const records = (body.entries as unknown[]).map((item) => {
    if (item === null || typeof item !== 'object') invalid('Not a record');
    const record = item as Record<string, unknown>;
    return {
      ...signedRecord(record.entry, record.signature),
      text: {
        entry: record.entry as string,
        signature: record.signature as string
      }
    };
  });
  const current = await requireGeneration(db, userId, body.generation);
  const rows = await contactRows(db, userId, current.generation);
  if (
    rows.length !== records.length ||
    rows.some(isSealedRow) ||
    rows.at(-1)?.entry_hash !== body.replaces
  ) {
    conflict();
  }
  const checked = await checkSealedChain(
    current.identity_key,
    records.map(({ entry, signature }) => ({ entry, signature })),
    0
  );
  const key = await currentAccountKey(db, userId, current.generation);
  if (
    checked.records.some(
      (record) => record.header.accountKeySequence !== key.keySequence
    )
  ) {
    refuseStaleKey();
  }
  const unchanged = deviceListUnchanged(userId, key);
  const createdAt = new Date().toISOString();
  const count = `(SELECT COUNT(*) FROM e2ee_contact_entries
                  WHERE user_id = ? AND generation = ?)`;
  let removed: { meta?: { changes?: number } } | undefined;
  try {
    [removed] = await db.batch([
      db
        .prepare(
          `DELETE FROM e2ee_contact_entries
           WHERE user_id = ? AND generation = ?
             AND ${authorization.sql}
             AND ${count} = ?
             AND NOT EXISTS (SELECT 1 FROM e2ee_contact_entries
                  WHERE user_id = ? AND generation = ? AND substr(entry, 1, 4) <> ?)
             AND (SELECT entry_hash FROM e2ee_contact_entries
                  WHERE user_id = ? AND generation = ? AND sequence = ?) = ?
             AND ${unchanged.sql}`
        )
        .bind(
          userId,
          current.generation,
          ...authorization.binds,
          userId,
          current.generation,
          rows.length,
          userId,
          current.generation,
          PLAINTEXT_PREFIX,
          userId,
          current.generation,
          rows.length - 1,
          body.replaces,
          ...unchanged.binds
        ),
      // Each insert writes its record only once the delete above ran (the
      // count is then its sequence); otherwise the record is NULL, the NOT
      // NULL constraint fails and the whole batch rolls back, so the list is
      // never left half replaced.
      ...records.map(({ text }, index) =>
        db
          .prepare(
            `INSERT INTO e2ee_contact_entries
               (user_id, generation, sequence, entry, signature, entry_hash, created_at)
             SELECT ?, ?, ?, CASE WHEN ${count} = ? THEN ? END, ?, ?, ?`
          )
          .bind(
            userId,
            current.generation,
            index,
            userId,
            current.generation,
            index,
            text.entry,
            text.signature,
            toHex(checked.records[index]!.hash),
            createdAt
          )
      ),
      replacedPlaintextCleanup(db, userId, current.generation)
    ]);
  } catch (error) {
    if (isConstraintError(error)) {
      if (await deviceListMoved(db, userId, key)) refuseStaleKey();
      conflict();
    }
    throw error;
  }
  if ((removed?.meta?.changes ?? 0) !== rows.length) conflict();
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
    if (method !== 'GET' && method !== 'POST' && method !== 'PUT') {
      refuse(405, 'METHOD_NOT_ALLOWED', 'Use GET, POST or PUT.');
    }
    if (!(await isE2eeContactStorageReady(db))) {
      refuse(
        503,
        'E2EE_UNAVAILABLE',
        'Contacts are unavailable until the database is updated.'
      );
    }
    if (method === 'GET') return respond(await contactsResponse(db, userId));
    if (method === 'PUT') {
      return respond(
        await handleReseal(db, userId, authorization, await readBody())
      );
    }
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
