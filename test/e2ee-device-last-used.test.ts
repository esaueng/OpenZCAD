import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { toUserId } from '@openzcad/shared';
import {
  DEVICE_LAST_USED_EXPORT_SQL,
  deviceLastUsedErasureStatements,
  deviceLastUsedReplacementStatements,
  deviceLastUsedRevocationStatements,
  isDeviceLastUsedStorageReady,
  readDeviceLastUsed,
  recordDeviceLastUsed,
  utcDay
} from '../apps/web/worker/e2eeDeviceLastUsed';
import { exportAccountData } from '../apps/web/worker/accountExport';
import { d1Database, migratedDatabase } from './d1-sqlite';

/**
 * Devices' last-used days (migration 0069, ADR-024 amendment 2026-11-25):
 * one UTC day per certified device, written at most once a day under the
 * session's write fence, only for a device (never an unlock target) the
 * current generation certifies.
 */

let db: DatabaseSync | undefined;
afterEach(() => {
  db?.close();
  db = undefined;
});

const OPEN = { sql: '1', binds: [] };
/** A session that was revoked: its fence holds nothing. */
const REVOKED = { sql: '0', binds: [] };

function withAccount(
  userId: string,
  devices: string[],
  targets: string[] = []
) {
  db = migratedDatabase();
  db.prepare('INSERT INTO users (id, email, created_at) VALUES (?, ?, ?)').run(
    userId,
    `${userId}@example.com`,
    '2026-11-01T00:00:00.000Z'
  );
  db.prepare(
    `INSERT INTO e2ee_identities (user_id, generation, identity_key, created_at)
     VALUES (?, 1, ?, '2026-11-01T00:00:00.000Z')`
  ).run(userId, 'k'.repeat(87));
  for (const device of devices) wrap(userId, device, 'account-key');
  // A passkey or recovery-key target: an account-key wrap of its own, and
  // the unlock-target-key wrap only targets carry.
  for (const target of targets) {
    wrap(userId, target, 'account-key');
    wrap(userId, target, 'unlock-target-key');
  }
  return d1Database(db);
}

function wrap(userId: string, target: string, purpose: string) {
  db!
    .prepare(
      `INSERT INTO e2ee_key_wraps (user_id, generation, purpose, target_id,
         key_sequence, wrapped, updated_at)
       VALUES (?, 1, ?, ?, 0, 'w', '2026-11-01T00:00:00.000Z')`
    )
    .run(userId, purpose, target);
}

const rows = () =>
  db!
    .prepare(
      'SELECT device_id, first_day, last_day FROM e2ee_device_last_used ORDER BY device_id'
    )
    .all();

describe('device last-used storage (migration 0069)', () => {
  it('is ready on the migrated schema and not before it', async () => {
    expect(await isDeviceLastUsedStorageReady(withAccount('owner', []))).toBe(
      true
    );
    const bare = new DatabaseSync(':memory:');
    expect(await isDeviceLastUsedStorageReady(d1Database(bare))).toBe(false);
    expect(
      await readDeviceLastUsed(d1Database(bare), 'owner', new Set())
    ).toBeNull();
    bare.close();
  });

  it('writes a day once, moves it forward, and keeps when it started', async () => {
    const d1 = withAccount('owner', ['dev_a', 'dev_b']);
    const record = (deviceId: string, today: string) =>
      recordDeviceLastUsed(d1, 'owner', deviceId, OPEN, today);
    expect(await record('dev_a', '2026-11-20')).toBe(true);
    // The same day, or an older one, writes nothing.
    expect(await record('dev_a', '2026-11-20')).toBe(false);
    expect(await record('dev_a', '2026-11-19')).toBe(false);
    expect(await record('dev_b', '2026-11-22')).toBe(true);
    expect(await record('dev_a', '2026-11-25')).toBe(true);
    expect(rows()).toEqual([
      { device_id: 'dev_a', first_day: '2026-11-20', last_day: '2026-11-25' },
      { device_id: 'dev_b', first_day: '2026-11-22', last_day: '2026-11-22' }
    ]);
    expect(
      await readDeviceLastUsed(d1, 'owner', new Set(['dev_a', 'dev_b']))
    ).toEqual({
      since: '2026-11-20',
      devices: [
        { deviceId: 'dev_a', day: '2026-11-25' },
        { deviceId: 'dev_b', day: '2026-11-22' }
      ]
    });
  });

  it('records only certified devices, never an unlock target or an unknown id', async () => {
    const d1 = withAccount('owner', ['dev_a'], ['pk_passkey', 'rk_recovery']);
    for (const id of ['pk_passkey', 'rk_recovery', 'dev_planted'])
      await recordDeviceLastUsed(d1, 'owner', id, OPEN, '2026-11-20');
    expect(rows()).toEqual([]);
    await recordDeviceLastUsed(d1, 'owner', 'dev_a', OPEN, '2026-11-20');
    expect(rows()).toEqual([
      { device_id: 'dev_a', first_day: '2026-11-20', last_day: '2026-11-20' }
    ]);
  });

  it('shows only the listed devices, and drops removed ones with the next write', async () => {
    const d1 = withAccount('owner', ['dev_a', 'dev_b']);
    await recordDeviceLastUsed(d1, 'owner', 'dev_b', OPEN, '2026-11-20');
    // The list no longer names dev_b: hidden at once.
    expect(
      (await readDeviceLastUsed(d1, 'owner', new Set(['dev_a'])))?.devices
    ).toEqual([]);
    db!.prepare("DELETE FROM e2ee_key_wraps WHERE target_id = 'dev_b'").run();
    await recordDeviceLastUsed(d1, 'owner', 'dev_a', OPEN, '2026-11-21');
    expect(rows()).toEqual([
      { device_id: 'dev_a', first_day: '2026-11-21', last_day: '2026-11-21' }
    ]);
  });

  it('writes and deletes nothing under a revoked session', async () => {
    const d1 = withAccount('owner', ['dev_a', 'dev_b']);
    await recordDeviceLastUsed(d1, 'owner', 'dev_b', OPEN, '2026-11-20');
    db!.prepare("DELETE FROM e2ee_key_wraps WHERE target_id = 'dev_b'").run();
    // The upsert and the clean-up beside it both hold to the fence.
    expect(
      await recordDeviceLastUsed(d1, 'owner', 'dev_a', REVOKED, '2026-11-21')
    ).toBe(false);
    expect(rows()).toEqual([
      { device_id: 'dev_b', first_day: '2026-11-20', last_day: '2026-11-20' }
    ]);
  });

  it('drops the days of revoked devices, and of everything a replacement leaves out', async () => {
    const d1 = withAccount('owner', ['dev_a', 'dev_b', 'dev_c']);
    for (const id of ['dev_a', 'dev_b', 'dev_c'])
      await recordDeviceLastUsed(d1, 'owner', id, OPEN, '2026-11-20');
    await d1.batch(
      await deviceLastUsedRevocationStatements(d1, 'owner', ['dev_b'], OPEN)
    );
    expect(rows()).toHaveLength(2);
    // Fenced like the append: a guard that fails deletes nothing.
    await d1.batch(
      await deviceLastUsedRevocationStatements(d1, 'owner', ['dev_a'], REVOKED)
    );
    expect(rows()).toHaveLength(2);
    await d1.batch(
      await deviceLastUsedReplacementStatements(d1, 'owner', ['dev_c'], OPEN)
    );
    expect(rows()).toEqual([
      { device_id: 'dev_c', first_day: '2026-11-20', last_day: '2026-11-20' }
    ]);
  });

  it('records nothing while the account is erased, and erases with it', async () => {
    const d1 = withAccount('owner', ['dev_a']);
    await recordDeviceLastUsed(d1, 'owner', 'dev_a', OPEN, '2026-11-20');
    db!
      .prepare(
        "INSERT INTO account_erasure_requests (user_id, scope, started_at, updated_at) VALUES (?, 'profile', 1, 1)"
      )
      .run('owner');
    await expect(
      recordDeviceLastUsed(d1, 'owner', 'dev_a', OPEN, '2026-11-21')
    ).rejects.toThrow(/ACCOUNT_ERASURE_IN_PROGRESS/);
    await d1.batch(await deviceLastUsedErasureStatements(d1, 'owner'));
    expect(rows()).toEqual([]);
  });

  it('exports only current devices, and goes with the user row', async () => {
    const d1 = withAccount('owner', ['dev_a', 'dev_b']);
    await recordDeviceLastUsed(d1, 'owner', 'dev_a', OPEN, '2026-11-20');
    await recordDeviceLastUsed(d1, 'owner', 'dev_b', OPEN, '2026-11-20');
    db!.prepare("DELETE FROM e2ee_key_wraps WHERE target_id = 'dev_b'").run();
    expect(
      db!
        .prepare(DEVICE_LAST_USED_EXPORT_SQL)
        .all('owner', 'owner', 'owner', 'owner')
    ).toEqual([
      { device_id: 'dev_a', first_day: '2026-11-20', last_day: '2026-11-20' }
    ]);
    const exported = await exportAccountData(
      { userId: toUserId('owner'), displayName: 'Owner', mode: 'development' },
      { DB: d1 }
    );
    expect(
      (exported.records as Record<string, unknown[]>).e2ee_device_last_used
    ).toEqual([
      { device_id: 'dev_a', first_day: '2026-11-20', last_day: '2026-11-20' }
    ]);
    db!.prepare('DELETE FROM users WHERE id = ?').run('owner');
    expect(rows()).toEqual([]);
  });

  it('names days in UTC', () => {
    expect(utcDay(Date.parse('2026-11-25T23:59:59-05:00'))).toBe('2026-11-26');
  });
});
