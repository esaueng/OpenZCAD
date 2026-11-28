/** The Delivery Service stores each account's authenticated MLS anchors. */
import {
  MAX_MLS_AUTHORITY_BYTES,
  verifyMlsAuthorityTrustSigner
} from '@openzcad/crypto';
import { isE2eeProjectAuthorityStorageReady } from '@openzcad/cloudflare-adapters';
import type {
  E2eeProjectAuthorityRecord,
  E2eeProjectAuthorityResponse
} from '@openzcad/shared';
import {
  bytesField,
  deviceListUnchanged,
  idField,
  json,
  projectFence,
  refuse,
  requireCertifiedDevice,
  runBatch,
  uintField,
  type Authorization,
  type EncryptedProjectAccess
} from './e2eeProjects';

const columns = `sequence, account_key_generation AS accountKeyGeneration,
  account_key_sequence AS accountKeySequence, signer_device_id AS signerDeviceId,
  record, record_mac AS recordMac, signature`;
async function stored(db: D1Database, userId: string, projectId: string) {
  return db
    .prepare(
      `SELECT ${columns} FROM e2ee_project_authority
    WHERE user_id = ? AND project_id = ?`
    )
    .bind(userId, projectId)
    .first<E2eeProjectAuthorityRecord>();
}

export async function projectAuthority(
  db: D1Database,
  userId: string,
  projectId: string,
  authorization: Authorization,
  access: EncryptedProjectAccess,
  body?: Record<string, unknown>
): Promise<Response> {
  if (!(await isE2eeProjectAuthorityStorageReady(db)))
    refuse(
      503,
      'E2EE_UNAVAILABLE',
      'MLS authority storage needs database migration 0044.'
    );
  if (!body)
    return json({
      authority: await stored(db, userId, projectId)
    } satisfies E2eeProjectAuthorityResponse);
  if (
    !(await db
      .prepare('SELECT 1 AS ok FROM e2ee_project_groups WHERE project_id = ?')
      .bind(projectId)
      .first())
  )
    refuse(
      409,
      'E2EE_GROUP_NOT_FOUND',
      'The project needs an MLS group before storing its authority.'
    );
  const deviceId = idField(body.signerDeviceId, 'signerDeviceId');
  const expected = uintField(
    body.expectedSequence,
    'expectedSequence',
    0xffffffff
  );
  const sequence = uintField(body.sequence, 'sequence', 0xffffffff);
  if (sequence !== expected + 1)
    refuse(
      400,
      'E2EE_AUTHORITY_INVALID',
      'Authority sequence must advance by one.'
    );
  // Issue #1704: the owner's confirmed restoration of a record this account
  // no longer stores. The device continues the sequence it pinned, so the
  // compare-and-swap below cannot apply; instead the row must be absent.
  // The Worker cannot tell a restoration from any other signed record, and
  // need not: devices check every record against their own pins.
  if (body.restoreMissing !== undefined && body.restoreMissing !== true)
    refuse(400, 'E2EE_AUTHORITY_INVALID', 'restoreMissing must be true.');
  const restore = body.restoreMissing === true;
  if (restore && (access.staging || access.ownerUserId !== userId))
    refuse(
      403,
      'E2EE_AUTHORITY_RESTORE_REFUSED',
      'Only the owner of an encrypted project can restore its authority record.'
    );
  const record = bytesField(body.record, 'record', {
    max: MAX_MLS_AUTHORITY_BYTES
  });
  const recordMac = bytesField(body.recordMac, 'recordMac', { exact: 32 });
  const signature = bytesField(body.signature, 'signature', { exact: 65 });
  const account = await requireCertifiedDevice(db, userId, deviceId);
  let decoded;
  try {
    decoded = await verifyMlsAuthorityTrustSigner(account.signingKey, {
      record: record.bytes,
      recordMac: recordMac.bytes,
      signature: signature.bytes
    });
  } catch {
    refuse(
      400,
      'E2EE_AUTHORITY_INVALID',
      'The authority device signature or record did not verify.'
    );
  }
  if (
    decoded.userId !== userId ||
    decoded.projectId !== projectId ||
    decoded.sequence !== sequence ||
    decoded.signerDeviceId !== deviceId ||
    decoded.accountKeyGeneration !== account.generation ||
    decoded.accountKeyGeneration !== body.accountKeyGeneration ||
    decoded.accountKeySequence !== body.accountKeySequence ||
    decoded.accountKeySequence > account.headSequence
  )
    refuse(
      400,
      'E2EE_AUTHORITY_INVALID',
      'Authority metadata names another account, key or project.'
    );
  const fence = projectFence(
    access,
    projectId,
    userId,
    restore ? 'owner' : 'member'
  );
  const device = deviceListUnchanged(userId, account);
  const predicate = `${authorization.sql} AND ${fence.sql} AND ${device.sql}`;
  const binds = [...authorization.binds, ...fence.binds, ...device.binds];
  const values = [
    userId,
    projectId,
    sequence,
    decoded.accountKeyGeneration,
    decoded.accountKeySequence,
    deviceId,
    record.text,
    recordMac.text,
    signature.text,
    new Date().toISOString(),
    ...binds
  ];
  const insert = `INSERT INTO e2ee_project_authority
    (user_id, project_id, sequence, account_key_generation, account_key_sequence,
     signer_device_id, record, record_mac, signature, updated_at)
    SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE ${predicate}`;
  await runBatch(db, [
    restore
      ? // Never replaces a row: a record the account still stores is advanced
        // only by the compare-and-swap, whatever this request claims.
        db
          .prepare(
            `${insert}
      AND NOT EXISTS (SELECT 1 FROM e2ee_project_authority
        WHERE user_id = ? AND project_id = ?)
    ON CONFLICT (user_id, project_id) DO NOTHING`
          )
          .bind(...values, userId, projectId)
      : db
          .prepare(
            `${insert}
      AND (? = 0 OR EXISTS (SELECT 1 FROM e2ee_project_authority
        WHERE user_id = ? AND project_id = ? AND sequence = ?))
    ON CONFLICT (user_id, project_id) DO UPDATE SET sequence = excluded.sequence,
      account_key_generation = excluded.account_key_generation,
      account_key_sequence = excluded.account_key_sequence, signer_device_id = excluded.signer_device_id,
      record = excluded.record, record_mac = excluded.record_mac, signature = excluded.signature,
      updated_at = excluded.updated_at
    WHERE e2ee_project_authority.sequence = ?`
          )
          .bind(...values, expected, userId, projectId, expected, expected)
  ]);
  if (
    !(await db
      .prepare(`SELECT 1 AS ok WHERE ${predicate}`)
      .bind(...binds)
      .first<{ ok: number }>())
  )
    refuse(
      409,
      'E2EE_DEVICE_LIST_CHANGED',
      'The session, membership or devices changed while authority was saving.'
    );
  const saved = await stored(db, userId, projectId);
  if (
    !saved ||
    saved.sequence !== sequence ||
    saved.record !== record.text ||
    saved.recordMac !== recordMac.text ||
    saved.signature !== signature.text
  )
    refuse(
      409,
      'E2EE_AUTHORITY_CONFLICT',
      'Another device advanced the project authority record. Read it before saving again.'
    );
  return json({ authority: saved } satisfies E2eeProjectAuthorityResponse);
}
