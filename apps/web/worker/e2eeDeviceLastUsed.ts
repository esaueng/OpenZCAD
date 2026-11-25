import { cachedSchemaProbe } from '@openzcad/cloudflare-adapters';
import type { E2eeDeviceLastUsed } from '@openzcad/shared';

/**
 * The day each certified device last used its encryption keys (ADR-024
 * amendment 2026-11-25, migration 0069). An unlocked browser reports its
 * own device id at most once per UTC day, in the body of its own small
 * request (`POST /api/e2ee/devices/last-used`), never on the account read,
 * so request logs do not pair the stable id with every read's time. The
 * Worker records that UTC day, at most once per device per day, only for a
 * device the current identity generation certifies (an account-key wrap
 * that is not an unlock target's), so a request cannot plant rows for a
 * passkey, a recovery key or an id the device list does not name. Every
 * write is fenced on the session's write authorization, and the same write
 * drops the rows of devices the list no longer names; the device-list
 * append drops a removed device's row in its own batch.
 *
 * Nothing here is signed or trusted for keys: the browser only shows the
 * days and suggests removing devices that have not been used for a month,
 * which the user confirms like any other removal.
 */

export const DEVICE_LAST_USED_ROUTE = '/api/e2ee/devices/last-used';

/** Whether migration 0069 installed the table and its erasure fence. */
export const isDeviceLastUsedStorageReady = cachedSchemaProbe(
  `SELECT
     (SELECT COUNT(*) FROM pragma_table_info('e2ee_device_last_used')
      WHERE name IN ('user_id', 'device_id', 'first_day', 'last_day'))
       AS columns,
     (SELECT COUNT(*) FROM sqlite_schema
      WHERE type = 'trigger' AND name IN (
        'block_erasing_device_last_used_insert',
        'block_erasing_device_last_used_update'
      )) AS triggers`,
  (row) => row?.columns === 4 && row.triggers === 2
);

/** A write fence: the session's write authorization. */
export interface LastUsedFence {
  readonly sql: string;
  readonly binds: readonly unknown[];
}

const MAX_DEVICE_ID_CHARS = 128;

/** Today as a UTC date, `YYYY-MM-DD`. */
export function utcDay(at: number = Date.now()): string {
  return new Date(at).toISOString().slice(0, 10);
}

export function isDeviceId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_DEVICE_ID_CHARS &&
    /^[\x21-\x7e]+$/.test(value)
  );
}

/**
 * The current generation's certified devices: account-key wraps that are
 * not an unlock target's (every passkey and recovery-key target also has
 * an unlock-target-key wrap). Binds the user id three times.
 */
const CURRENT_DEVICES = `SELECT w.target_id FROM e2ee_key_wraps w
  WHERE w.user_id = ? AND w.purpose = 'account-key'
    AND w.generation = (SELECT MAX(generation) FROM e2ee_identities
                        WHERE user_id = ?)
    AND NOT EXISTS (SELECT 1 FROM e2ee_key_wraps t
                    WHERE t.user_id = ? AND t.generation = w.generation
                      AND t.purpose = 'unlock-target-key'
                      AND t.target_id = w.target_id)`;

/**
 * The account's days, for the devices `listed` names (the current device
 * list's head), so a removed device or an unlock target never shows even
 * before its row is dropped. Null before migration 0069 or on a failed read.
 */
export async function readDeviceLastUsed(
  db: D1Database,
  userId: string,
  listed: ReadonlySet<string>
): Promise<E2eeDeviceLastUsed | null> {
  try {
    if (!(await isDeviceLastUsedStorageReady(db))) return null;
    const rows = (
      (
        await db
          .prepare(
            `SELECT device_id, first_day, last_day FROM e2ee_device_last_used
             WHERE user_id = ? ORDER BY device_id`
          )
          .bind(userId)
          .all<{ device_id: string; first_day: string; last_day: string }>()
      ).results ?? []
    ).filter((row) => listed.has(row.device_id));
    return {
      since: rows.reduce<string | null>(
        (min, row) =>
          min === null || row.first_day < min ? row.first_day : min,
        null
      ),
      devices: rows.map((row) => ({
        deviceId: row.device_id,
        day: row.last_day
      }))
    };
  } catch {
    return null;
  }
}

/**
 * Records today for `deviceId` unless its row already says today, and
 * drops the rows of devices the list no longer names, both under `fence`.
 * Answers whether a write was made. Throws only what the database throws
 * (an erasure in progress refuses the write).
 */
export async function recordDeviceLastUsed(
  db: D1Database,
  userId: string,
  deviceId: string,
  fence: LastUsedFence,
  today: string = utcDay()
): Promise<boolean> {
  const known = await db
    .prepare(
      `SELECT last_day FROM e2ee_device_last_used
       WHERE user_id = ? AND device_id = ?`
    )
    .bind(userId, deviceId)
    .first<{ last_day: string }>();
  if (known && known.last_day >= today) return false;
  const [written] = await db.batch([
    db
      .prepare(
        `INSERT INTO e2ee_device_last_used
           (user_id, device_id, first_day, last_day)
         SELECT ?, ?, ?, ?
         WHERE ? IN (${CURRENT_DEVICES}) AND ${fence.sql}
         ON CONFLICT (user_id, device_id) DO UPDATE
           SET last_day = excluded.last_day
           WHERE excluded.last_day > e2ee_device_last_used.last_day`
      )
      .bind(
        userId,
        deviceId,
        today,
        today,
        deviceId,
        userId,
        userId,
        userId,
        ...fence.binds
      ),
    // Removed devices, and every device of a replaced identity, keep no
    // day. Fenced like the write: a revoked session deletes nothing.
    db
      .prepare(
        `DELETE FROM e2ee_device_last_used
         WHERE user_id = ? AND device_id NOT IN (${CURRENT_DEVICES})
           AND ${fence.sql}`
      )
      .bind(userId, userId, userId, userId, ...fence.binds)
  ]);
  return (written?.meta?.changes ?? 0) > 0;
}

/**
 * For a device-list append's batch: drops the rows of the devices the
 * entry revokes, under the append's own guard, so a removed device's day
 * goes with its removal. One JSON-array parameter for every id.
 */
export async function deviceLastUsedRevocationStatements(
  db: D1Database,
  userId: string,
  revokedDeviceIds: readonly string[],
  guard: LastUsedFence
): Promise<D1PreparedStatement[]> {
  if (
    revokedDeviceIds.length === 0 ||
    !(await isDeviceLastUsedStorageReady(db))
  )
    return [];
  return [
    db
      .prepare(
        `DELETE FROM e2ee_device_last_used
         WHERE user_id = ?
           AND device_id IN (SELECT value FROM json_each(?))
           AND ${guard.sql}`
      )
      .bind(userId, JSON.stringify(revokedDeviceIds), ...guard.binds)
  ];
}

/**
 * For an identity replacement's batch: keeps only the new list's devices.
 */
export async function deviceLastUsedReplacementStatements(
  db: D1Database,
  userId: string,
  keptDeviceIds: readonly string[],
  guard: LastUsedFence
): Promise<D1PreparedStatement[]> {
  if (!(await isDeviceLastUsedStorageReady(db))) return [];
  return [
    db
      .prepare(
        `DELETE FROM e2ee_device_last_used
         WHERE user_id = ?
           AND device_id NOT IN (SELECT value FROM json_each(?))
           AND ${guard.sql}`
      )
      .bind(userId, JSON.stringify(keptDeviceIds), ...guard.binds)
  ];
}

/** The account export: only the current generation's devices. */
export const DEVICE_LAST_USED_EXPORT_SQL = `SELECT device_id, first_day, last_day
  FROM e2ee_device_last_used
  WHERE user_id = ? AND device_id IN (${CURRENT_DEVICES})`;

/** Account erasure: the days go with the profile. */
export async function deviceLastUsedErasureStatements(
  db: D1Database,
  userId: string
): Promise<D1PreparedStatement[]> {
  if (!(await isDeviceLastUsedStorageReady(db))) return [];
  return [
    db
      .prepare('DELETE FROM e2ee_device_last_used WHERE user_id = ?')
      .bind(userId)
  ];
}
