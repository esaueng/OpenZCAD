import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { toUserId, type E2eeAccountResponse } from '@openzcad/shared';
import {
  deviceLastUsed,
  deviceLastUsedErasureStatements,
  isDeviceLastUsedStorageReady,
  utcDay
} from '../apps/web/worker/e2eeDeviceLastUsed';
import { exportAccountData } from '../apps/web/worker/accountExport';
import { d1Database, migratedDatabase } from './d1-sqlite';

/**
 * Devices' last-used days (migration 0069, ADR-024 amendment 2026-11-25):
 * one UTC day per certified device, written at most once a day, only for a
 * device the current generation wraps the account key to.
 */

let db: DatabaseSync | undefined;
afterEach(() => {
  db?.close();
  db = undefined;
});

function withAccount(userId: string, devices: string[]) {
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
  for (const device of devices) wrap(userId, device);
  return d1Database(db);
}

function wrap(userId: string, device: string) {
  db!
    .prepare(
      `INSERT INTO e2ee_key_wraps (user_id, generation, purpose, target_id,
         key_sequence, wrapped, updated_at)
       VALUES (?, 1, 'account-key', ?, 0, 'w', '2026-11-01T00:00:00.000Z')`
    )
    .run(userId, device);
}

/** The account read as `loadAccount` answers it, only the wraps matter. */
function account(devices: string[]): E2eeAccountResponse {
  return {
    current: {
      generation: 1,
      identityKey: 'k',
      createdAt: '2026-11-01T00:00:00.000Z',
      entries: [],
      transition: null,
      wraps: devices.map((targetId) => ({
        purpose: 'account-key',
        targetId,
        keySequence: 0,
        wrapped: 'w'
      }))
    },
    previous: []
  } as unknown as E2eeAccountResponse;
}

const open = async () => ({ sql: '1', binds: [] });

describe('device last-used storage (migration 0069)', () => {
  it('is ready on the migrated schema and not before it', async () => {
    expect(await isDeviceLastUsedStorageReady(withAccount('owner', []))).toBe(
      true
    );
    const bare = new DatabaseSync(':memory:');
    expect(await isDeviceLastUsedStorageReady(d1Database(bare))).toBe(false);
    bare.close();
  });

  it('writes a day once, moves it forward, and keeps when it started', async () => {
    const d1 = withAccount('owner', ['dev_a', 'dev_b']);
    let fences = 0;
    const fence = async () => {
      fences++;
      return open();
    };
    const read = (deviceId: string | null, today: string) =>
      deviceLastUsed(d1, 'owner', account(['dev_a', 'dev_b']), {
        deviceId,
        fence,
        today
      });
    expect(await read('dev_a', '2026-11-20')).toEqual({
      since: '2026-11-20',
      devices: [{ deviceId: 'dev_a', day: '2026-11-20' }]
    });
    // The same day asks for no write at all.
    await read('dev_a', '2026-11-20');
    expect(fences).toBe(1);
    expect(await read('dev_b', '2026-11-22')).toEqual({
      since: '2026-11-20',
      devices: [
        { deviceId: 'dev_a', day: '2026-11-20' },
        { deviceId: 'dev_b', day: '2026-11-22' }
      ]
    });
    expect((await read('dev_a', '2026-11-25'))?.devices[0]).toEqual({
      deviceId: 'dev_a',
      day: '2026-11-25'
    });
    // A read naming no device, or one with an older day, writes nothing.
    await read(null, '2026-11-26');
    await read('dev_a', '2026-11-24');
    expect(fences).toBe(4);
    expect(
      db!
        .prepare(
          "SELECT first_day, last_day FROM e2ee_device_last_used WHERE device_id = 'dev_a'"
        )
        .get()
    ).toEqual({ first_day: '2026-11-20', last_day: '2026-11-25' });
  });

  it('plants nothing for an unwrapped device and drops removed ones', async () => {
    const d1 = withAccount('owner', ['dev_a', 'dev_b']);
    await deviceLastUsed(d1, 'owner', account(['dev_a', 'dev_b']), {
      deviceId: 'dev_b',
      fence: open,
      today: '2026-11-20'
    });
    // The response's wraps are not trusted: the table's own wraps decide.
    expect(
      await deviceLastUsed(d1, 'owner', account(['dev_x']), {
        deviceId: 'dev_x',
        fence: open,
        today: '2026-11-21'
      })
    ).toEqual({
      since: '2026-11-20',
      devices: [{ deviceId: 'dev_b', day: '2026-11-20' }]
    });
    db!.prepare("DELETE FROM e2ee_key_wraps WHERE target_id = 'dev_b'").run();
    expect(
      await deviceLastUsed(d1, 'owner', account(['dev_a']), {
        deviceId: 'dev_a',
        fence: open,
        today: '2026-11-21'
      })
    ).toEqual({
      since: '2026-11-21',
      devices: [{ deviceId: 'dev_a', day: '2026-11-21' }]
    });
  });

  it('records nothing without a fence, or while the account is erased, and erases with it', async () => {
    const d1 = withAccount('owner', ['dev_a']);
    const days = () =>
      db!.prepare('SELECT COUNT(*) AS n FROM e2ee_device_last_used').get();
    await deviceLastUsed(d1, 'owner', account(['dev_a']), {
      deviceId: 'dev_a',
      fence: async () => null,
      today: '2026-11-20'
    });
    expect(days()).toEqual({ n: 0 });
    await deviceLastUsed(d1, 'owner', account(['dev_a']), {
      deviceId: 'dev_a',
      fence: open,
      today: '2026-11-20'
    });
    db!
      .prepare(
        "INSERT INTO account_erasure_requests (user_id, scope, started_at, updated_at) VALUES (?, 'profile', 1, 1)"
      )
      .run('owner');
    // The trigger refuses the write; the read still answers.
    expect(
      await deviceLastUsed(d1, 'owner', account(['dev_a']), {
        deviceId: 'dev_a',
        fence: open,
        today: '2026-11-21'
      })
    ).toEqual({
      since: '2026-11-20',
      devices: [{ deviceId: 'dev_a', day: '2026-11-20' }]
    });
    await d1.batch(await deviceLastUsedErasureStatements(d1, 'owner'));
    expect(days()).toEqual({ n: 0 });
  });

  it('goes with the user row and is in its owner’s export', async () => {
    const d1 = withAccount('owner', ['dev_a']);
    await deviceLastUsed(d1, 'owner', account(['dev_a']), {
      deviceId: 'dev_a',
      fence: open,
      today: '2026-11-20'
    });
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
    expect(
      db!.prepare('SELECT COUNT(*) AS n FROM e2ee_device_last_used').get()
    ).toEqual({ n: 0 });
  });

  it('names days in UTC', () => {
    expect(utcDay(Date.parse('2026-11-25T23:59:59-05:00'))).toBe('2026-11-26');
  });
});
