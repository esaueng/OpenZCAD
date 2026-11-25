import { cachedSchemaProbe } from '@openzcad/cloudflare-adapters';
import type { E2eeAccountResponse, E2eeDeviceLastUsed } from '@openzcad/shared';

/**
 * The day each certified device last read its encryption keys (ADR-024
 * amendment 2026-11-25, migration 0069). A browser names its own device id
 * when it reads the account (`GET /api/e2ee/account?device=`), the read
 * that hands it the account-key wrap it unlocks with. The Worker records
 * that UTC day, at most once per device per day, and only for a device
 * whose account-key wrap the current identity generation holds, so a
 * request cannot plant rows for ids the device list does not name. The
 * same write drops the rows of devices the list no longer wraps to.
 *
 * Nothing here is signed or trusted for keys: the browser only shows the
 * days and suggests removing devices that have not been used for a month,
 * which the user confirms like any other removal.
 */

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

/** A write fence: the session's write authorization, or erasure alone. */
export interface LastUsedFence {
  readonly sql: string;
  readonly binds: readonly unknown[];
}

const MAX_DEVICE_ID_CHARS = 255;

/** Today as a UTC date, `YYYY-MM-DD`. */
export function utcDay(at: number = Date.now()): string {
  return new Date(at).toISOString().slice(0, 10);
}

function isDeviceId(value: string | null): value is string {
  return (
    value !== null &&
    value.length > 0 &&
    value.length <= MAX_DEVICE_ID_CHARS &&
    /^[\x21-\x7e]+$/.test(value)
  );
}

const CURRENT_ACCOUNT_KEY_WRAPS = `SELECT target_id FROM e2ee_key_wraps
  WHERE user_id = ? AND purpose = 'account-key'
    AND generation = (SELECT MAX(generation) FROM e2ee_identities
                      WHERE user_id = ?)`;

/**
 * Reads the account's last-used days and, when `deviceId` names one of its
 * certified devices whose day is not today yet, records today first. Never
 * throws: a missing table, a refused fence or a failed write leaves the
 * account read as it was. Answers null before migration 0069.
 */
export async function deviceLastUsed(
  db: D1Database,
  userId: string,
  account: E2eeAccountResponse,
  options: {
    deviceId: string | null;
    /** Called only when a write is due; null skips recording. */
    fence: () => Promise<LastUsedFence | null>;
    today?: string;
  }
): Promise<E2eeDeviceLastUsed | null> {
  try {
    if (!(await isDeviceLastUsedStorageReady(db))) return null;
    const today = options.today ?? utcDay();
    const read = async () =>
      (
        await db
          .prepare(
            `SELECT device_id, first_day, last_day FROM e2ee_device_last_used
             WHERE user_id = ? ORDER BY device_id`
          )
          .bind(userId)
          .all<{ device_id: string; first_day: string; last_day: string }>()
      ).results ?? [];
    let rows = await read();
    const deviceId = options.deviceId;
    const wrapped =
      isDeviceId(deviceId) &&
      (account.current?.wraps ?? []).some(
        (wrap) => wrap.purpose === 'account-key' && wrap.targetId === deviceId
      );
    const known = rows.find((row) => row.device_id === deviceId);
    if (wrapped && known?.last_day !== today) {
      const fence = await options.fence();
      if (fence) {
        try {
          await db.batch([
            db
              .prepare(
                `INSERT INTO e2ee_device_last_used
                   (user_id, device_id, first_day, last_day)
                 SELECT ?, ?, ?, ?
                 WHERE EXISTS (${CURRENT_ACCOUNT_KEY_WRAPS} AND target_id = ?)
                   AND ${fence.sql}
                 ON CONFLICT (user_id, device_id) DO UPDATE
                   SET last_day = excluded.last_day
                   WHERE excluded.last_day > e2ee_device_last_used.last_day`
              )
              .bind(
                userId,
                deviceId,
                today,
                today,
                userId,
                userId,
                deviceId,
                ...fence.binds
              ),
            // Removed devices, and every device of a replaced identity,
            // keep no day.
            db
              .prepare(
                `DELETE FROM e2ee_device_last_used
                 WHERE user_id = ? AND device_id NOT IN (${CURRENT_ACCOUNT_KEY_WRAPS})`
              )
              .bind(userId, userId, userId)
          ]);
          rows = await read();
        } catch {
          // Recording is best effort (an erasure in progress refuses it).
        }
      }
    }
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
