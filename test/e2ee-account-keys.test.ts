import { admitDevelopmentE2eeWrite } from '../apps/web/worker/e2eeWriteAuthorization';
import { describe, expect, it } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import {
  accountKeyCommitment,
  decodeDeviceApprovalGrant,
  decodeDeviceListEntry,
  exportPublicKey,
  fromBase64Url,
  generateEncryptionKeyPair,
  generateRecoveryKey,
  generateSigningKeyPair,
  generateSymmetricKey,
  nextDeviceListEntry,
  sealKey,
  signDeviceListEntry,
  signDeviceApprovalGrant,
  toBase64Url,
  verifyDeviceList
} from '@openzcad/crypto';
import {
  APPROVAL_TTL_MS,
  MAX_APPROVALS_PER_HOUR,
  handleE2eeRequest
} from '../apps/web/worker/e2ee';
import {
  advanceApprovalAsNewDevice,
  approveDevice,
  confirmApprovalCode,
  approverComparisonCode,
  beginCompareApproval,
  deviceScanCode,
  enrollWithRecoveryKey,
  EncryptionFlowError,
  forgetThisDevice,
  loadEncryption,
  lockAccount,
  parseScanCode,
  removeDevice,
  revokeReadOnlyDevices,
  replaceRecoveryKey,
  requestApproval,
  setUpEncryption,
  unlockedEncryptionKey,
  type AccountView,
  type E2eeContext,
  type EncryptionState
} from '../apps/web/src/lib/e2ee/accountKeys';
import { createE2eeApi, E2eeApiError } from '../apps/web/src/lib/e2ee/e2eeApi';
import {
  memoryDeviceStore,
  type DeviceKeyStore
} from '../apps/web/src/lib/e2ee/deviceStore';
import type { E2eeSetupRequest } from '@openzcad/shared';
import { d1Database, migratedDatabase } from './d1-sqlite';

const USER = 'user_alice';

interface Server {
  db: DatabaseSync;
  enabled: boolean;
  /** Rewrites a response body before the browser sees it. */
  tamper?: (path: string, body: unknown) => unknown;
  beforeWrite?: (sql: string) => Promise<void>;
  /** A competing rotation at an account-read boundary. */
  beforeAccountSnapshot?: () => Promise<void>;
  credential?: { token: string; desktop: boolean };
}

function server(db = migratedDatabase()): Server {
  db.prepare(`INSERT INTO users (id, email, created_at) VALUES (?, ?, ?)`).run(
    USER,
    'alice@example.com',
    '2026-10-20T00:00:00.000Z'
  );
  return { db, enabled: true };
}

function fetcherFor(srv: Server, userId: string) {
  const base = d1Database(srv.db);
  const originals = new WeakMap<D1PreparedStatement, D1PreparedStatement>();
  const queries = new WeakMap<D1PreparedStatement, string>();
  const wrap = (
    sql: string,
    statement: D1PreparedStatement
  ): D1PreparedStatement => {
    const wrapped: D1PreparedStatement = {
      bind: (...values) => wrap(sql, statement.bind(...values)),
      first: () => statement.first(),
      all: async <T>() => {
        const result = await statement.all<T>();
        if (sql.includes('FROM e2ee_device_list_entries'))
          await srv.beforeAccountSnapshot?.();
        return result;
      },
      run: async () => {
        await srv.beforeWrite?.(sql);
        return statement.run();
      }
    };
    originals.set(wrapped, statement);
    queries.set(wrapped, sql);
    return wrapped;
  };
  const env = {
    DB: {
      prepare: (sql: string) => wrap(sql, base.prepare(sql)),
      batch: async (statements: D1PreparedStatement[]) => {
        const sql = statements.map((s) => queries.get(s)).join('\n');
        if (
          sql.includes('FROM e2ee_device_list_entries') &&
          sql.includes('SELECT purpose, target_id, key_sequence, wrapped')
        )
          await srv.beforeAccountSnapshot?.();
        await srv.beforeWrite?.(sql);
        return base.batch(statements.map((s) => originals.get(s)!));
      }
    },
    AUTH_MODE: srv.credential ? 'email-code' : 'development',
    ENVIRONMENT: 'development'
  };
  return async (path: string, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    if (srv.credential) {
      headers.set(
        srv.credential.desktop ? 'authorization' : 'cookie',
        srv.credential.desktop
          ? `Bearer ${srv.credential.token}`
          : `__Host-openzcad_session=${srv.credential.token}`
      );
    }
    const session = { userId };
    if (
      !srv.credential &&
      !['GET', 'HEAD', 'OPTIONS'].includes(init?.method ?? 'GET') &&
      srv.enabled
    )
      await admitDevelopmentE2eeWrite(env.DB, session);
    const response = await handleE2eeRequest(
      new Request(`https://zcad.test${path}`, { ...init, headers }),
      env,
      session,
      srv.enabled
    );
    if (!srv.tamper || !response.ok) return response;
    const body = srv.tamper(path, await response.json());
    return new Response(JSON.stringify(body), {
      status: response.status,
      headers: response.headers
    });
  };
}

function device(srv: Server, userId = USER): E2eeContext {
  return {
    userId,
    api: createE2eeApi(fetcherFor(srv, userId)),
    store: memoryDeviceStore(),
    now: () => 1_760_000_000_000
  };
}

function ready(state: EncryptionState): AccountView {
  if (state.kind !== 'ready') {
    throw new Error(`Expected a ready account, got ${state.kind}`);
  }
  return state.account;
}

async function refusal(promise: Promise<unknown>): Promise<E2eeApiError> {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught
  );
  expect(error).toBeInstanceOf(E2eeApiError);
  return error as E2eeApiError;
}

async function flowRefusal(
  promise: Promise<unknown>,
  code: EncryptionFlowError['code']
): Promise<void> {
  await expect(promise).rejects.toSatisfy(
    (error: unknown) =>
      error instanceof EncryptionFlowError && error.code === code
  );
}

async function setUp(srv: Server) {
  const recovery = await generateRecoveryKey();
  const laptop = device(srv);
  const account = ready(
    await setUpEncryption(laptop, {
      recoverySecret: recovery.secret,
      label: 'Laptop'
    })
  );
  return { recovery, laptop, account };
}

async function enrolled(
  srv: Server,
  recoverySecret: Uint8Array,
  label: string
): Promise<{ ctx: E2eeContext; account: AccountView }> {
  const ctx = device(srv);
  const fresh = await loadEncryption(ctx);
  const account = ready(
    await enrollWithRecoveryKey(ctx, ready(fresh), recoverySecret, label)
  );
  return { ctx, account };
}

const count = (db: DatabaseSync, sql: string, ...values: string[]) =>
  (db.prepare(sql).get(...values) as { n: number }).n;

describe('encryption key routes', () => {
  it.each(['rotation', 'replacement'] as const)(
    'returns a coherent chain and wraps when %s races an account read',
    async (change) => {
      const srv = server();
      const { laptop, recovery } = await setUp(srv);
      const phone = await enrolled(srv, recovery.secret, 'Phone');
      const before = ready(await loadEncryption(laptop));
      let moved = false;
      srv.beforeAccountSnapshot = async () => {
        srv.beforeAccountSnapshot = undefined;
        moved = true;
        if (change === 'rotation')
          await removeDevice(
            laptop,
            before,
            phone.account.device!.deviceId,
            recovery.secret
          );
        else
          await replaceRecoveryKey(
            laptop,
            before,
            (await generateRecoveryKey()).secret,
            null
          );
      };
      lockAccount(USER);
      const loaded = ready(await loadEncryption(laptop));
      expect(moved).toBe(true);
      expect(loaded.unlocked).toBe(true);
      const fresh = ready(await loadEncryption(laptop));
      expect(loaded.list.pin).toEqual(fresh.list.pin);
      expect(loaded.wraps).toEqual(fresh.wraps);
    }
  );
  it('stay closed unless enabled, and unavailable until migrated', async () => {
    const srv = server();
    srv.enabled = false;
    const api = createE2eeApi(fetcherFor(srv, USER));
    expect(await api.config()).toEqual({ enabled: false });
    const closed = await refusal(api.account());
    expect([closed.status, closed.code]).toEqual([501, 'FEATURE_DISABLED']);

    const bare = migratedDatabase();
    bare.exec(
      'DROP TABLE e2ee_device_approvals; DROP TABLE e2ee_key_wraps; DROP TABLE e2ee_device_list_entries; DROP TABLE e2ee_identities'
    );
    const unmigrated = { db: bare, enabled: true };
    const unmigratedApi = createE2eeApi(fetcherFor(unmigrated, USER));
    expect(await unmigratedApi.config()).toEqual({ enabled: false });
    const missing = await refusal(unmigratedApi.account());
    expect([missing.status, missing.code]).toEqual([503, 'E2EE_UNAVAILABLE']);
  });

  it('reports an account with no keys yet', async () => {
    const srv = server();
    expect(await loadEncryption(device(srv))).toEqual({
      kind: 'not-set-up',
      previous: []
    });
  });
});

describe('setup', () => {
  it('certifies this device, unlocks it and stores only public or wrapped keys', async () => {
    const srv = server();
    const { laptop, account } = await setUp(srv);
    expect(account.deviceStatus).toBe('certified');
    expect(account.unlocked).toBe(true);
    expect(unlockedEncryptionKey(USER)?.extractable).toBe(false);
    expect(account.list.devices.map((d) => d.label)).toEqual(['Laptop']);
    expect(account.fingerprint).toMatch(/^(\d{5} ){7}\d{5}$/);
    const stored = await laptop.store.loadDevice(USER);
    expect(stored?.signing.privateKey.extractable).toBe(false);
    expect(stored?.unlock.privateKey.extractable).toBe(false);
    // The account key never reaches the server unwrapped: the only place a
    // 32-byte value derived from it appears is the commitment.
    expect(
      account.wraps.map((w) => `${w.purpose}:${w.targetId}`).sort()
    ).toEqual(
      [
        `account-key:${account.list.devices[0]!.deviceId}`,
        `account-key:${account.list.unlockTargets[0]!.targetId}`,
        'encryption-key:current',
        `identity-key:${account.list.unlockTargets[0]!.targetId}`,
        `unlock-target-key:${account.list.unlockTargets[0]!.targetId}`
      ].sort()
    );
    expect(count(srv.db, 'SELECT COUNT(*) AS n FROM e2ee_identities')).toBe(1);
  });

  it('unlocks again after a reload from the device key alone', async () => {
    const srv = server();
    const { laptop } = await setUp(srv);
    lockAccount(USER);
    expect(unlockedEncryptionKey(USER)).toBeNull();
    const again = ready(await loadEncryption(laptop));
    expect(again.unlocked).toBe(true);
  });

  it('refuses a second setup and an incomplete one', async () => {
    const srv = server();
    const { recovery } = await setUp(srv);
    const second = await refusal(
      setUpEncryption(device(srv), {
        recoverySecret: recovery.secret,
        label: 'Phone'
      })
    );
    expect([second.status, second.code]).toEqual([409, 'E2EE_ALREADY_SET_UP']);

    const other = server(migratedDatabase());
    const ctx = device(other);
    const incomplete = createE2eeApi(async (path, init) => {
      if (path === '/api/e2ee/setup' && init?.body) {
        const body = JSON.parse(init.body as string) as E2eeSetupRequest;
        body.wraps = body.wraps.filter((w) => w.purpose !== 'identity-key');
        init = { ...init, body: JSON.stringify(body) };
      }
      return fetcherFor(other, USER)(path, init);
    });
    const refused = await refusal(
      setUpEncryption(
        { ...ctx, api: incomplete },
        { recoverySecret: generateSymmetricKey(), label: 'Laptop' }
      )
    );
    expect([refused.status, refused.code]).toEqual([
      400,
      'E2EE_REQUEST_INVALID'
    ]);
  });

  it('refuses a device list for another user', async () => {
    const srv = server();
    const mallory = device(srv, 'user_mallory');
    const refused = await refusal(
      setUpEncryption(
        {
          ...mallory,
          api: createE2eeApi(fetcherFor(srv, USER))
        },
        { recoverySecret: generateSymmetricKey(), label: 'Laptop' }
      )
    );
    expect(refused.status).toBe(400);
  });
});

describe('a new device with the recovery key', () => {
  it('certifies itself and unlocks', async () => {
    const srv = server();
    const { recovery } = await setUp(srv);
    const { account } = await enrolled(srv, recovery.secret, 'Phone');
    expect(account.deviceStatus).toBe('certified');
    expect(account.unlocked).toBe(true);
    expect(account.list.devices.map((d) => d.label).sort()).toEqual([
      'Laptop',
      'Phone'
    ]);
  });

  it('refuses a wrong recovery key without changing anything', async () => {
    const srv = server();
    await setUp(srv);
    const phone = device(srv);
    const account = ready(await loadEncryption(phone));
    expect(account.deviceStatus).toBe('none');
    await flowRefusal(
      enrollWithRecoveryKey(phone, account, generateSymmetricKey(), 'Phone'),
      'wrong-recovery-key'
    );
    expect(
      count(srv.db, 'SELECT COUNT(*) AS n FROM e2ee_device_list_entries')
    ).toBe(1);
  });
});

describe('removing a device', () => {
  it('revokes it and rotates the account and encryption keys for the survivors', async () => {
    const srv = server();
    const { recovery, laptop, account } = await setUp(srv);
    const phone = await enrolled(srv, recovery.secret, 'Phone');
    const tablet = await enrolled(srv, recovery.secret, 'Tablet');
    const before = ready(await loadEncryption(laptop));
    const after = ready(
      await removeDevice(
        laptop,
        before,
        phone.account.device!.deviceId,
        recovery.secret
      )
    );
    expect(after.list.devices.map((d) => d.label).sort()).toEqual([
      'Laptop',
      'Tablet'
    ]);
    expect(after.list.head.revoked).toEqual([
      { kind: 'device', id: phone.account.device!.deviceId }
    ]);
    expect(after.list.head.encryptionKey).not.toEqual(
      account.list.head.encryptionKey
    );
    expect(after.list.head.accountKeyCommitment).not.toEqual(
      account.list.head.accountKeyCommitment
    );
    expect(after.unlocked).toBe(true);
    // The removed device keeps no wrap and cannot unlock.
    expect(
      count(
        srv.db,
        'SELECT COUNT(*) AS n FROM e2ee_key_wraps WHERE target_id = ?',
        phone.account.device!.deviceId
      )
    ).toBe(0);
    lockAccount(USER);
    const removed = ready(await loadEncryption(phone.ctx));
    expect(removed.deviceStatus).toBe('removed');
    expect(removed.unlocked).toBe(false);
    // A surviving device that was offline opens the new account key itself.
    lockAccount(USER);
    expect(ready(await loadEncryption(tablet.ctx)).unlocked).toBe(true);
  });

  it('needs the recovery key and never removes this device', async () => {
    const srv = server();
    const { recovery, laptop } = await setUp(srv);
    await enrolled(srv, recovery.secret, 'Phone');
    const account = ready(await loadEncryption(laptop));
    const phoneId = account.list.devices.find(
      (d) => d.label === 'Phone'
    )!.deviceId;
    await flowRefusal(
      removeDevice(laptop, account, phoneId, generateSymmetricKey()),
      'wrong-recovery-key'
    );
    await flowRefusal(
      removeDevice(laptop, account, account.device!.deviceId, recovery.secret),
      'invalid-request'
    );
  });
});

describe('refusing what a server substitutes', () => {
  it('reports an account key the device list does not certify', async () => {
    const srv = server();
    const { laptop } = await setUp(srv);
    const stored = (await laptop.store.loadDevice(USER))!;
    const forged = await sealKey(
      stored.unlockPublicKey,
      generateSymmetricKey(),
      {
        purpose: 'account-key',
        userId: USER,
        method: 'device',
        unlockId: stored.deviceId
      }
    );
    srv.db
      .prepare(
        `UPDATE e2ee_key_wraps SET wrapped = ? WHERE purpose = 'account-key' AND target_id = ?`
      )
      .run(toBase64Url(forged), stored.deviceId);
    lockAccount(USER);
    const account = ready(await loadEncryption(laptop));
    expect(account.unlocked).toBe(false);
    expect(account.unlockError).toMatch(/does not match/);
  });

  it('detects a rolled-back or forked device list', async () => {
    const srv = server();
    const { recovery, laptop } = await setUp(srv);
    await enrolled(srv, recovery.secret, 'Phone');
    ready(await loadEncryption(laptop));
    srv.tamper = (path, body) => {
      if (path !== '/api/e2ee/account') return body;
      const account = body as { current: { entries: unknown[] } };
      account.current.entries = account.current.entries.slice(0, 1);
      return account;
    };
    const rolledBack = await loadEncryption(laptop);
    expect(rolledBack.kind).toBe('fork');
    expect(unlockedEncryptionKey(USER)).toBeNull();
  });

  it('refuses a write answered with an older prefix and keeps the pin', async () => {
    const srv = server();
    const { recovery, laptop } = await setUp(srv);
    await enrolled(srv, recovery.secret, 'Phone');
    const before = ready(await loadEncryption(laptop));
    const pinned = await laptop.store.loadPin(USER);
    expect(pinned?.sequence).toBe(1);
    srv.tamper = (path, body) => {
      if (path !== '/api/e2ee/device-list') return body;
      const account = body as { current: { entries: unknown[] } };
      account.current.entries = account.current.entries.slice(0, 1);
      return account;
    };
    const phoneId = before.list.devices.find(
      (d) => d.label === 'Phone'
    )!.deviceId;
    await expect(
      removeDevice(laptop, before, phoneId, recovery.secret)
    ).rejects.toThrow();
    expect(await laptop.store.loadPin(USER)).toEqual(pinned);
    // Answered with a list missing the entry just written, it refuses too.
    srv.tamper = undefined;
    const tablet = device(srv);
    const current = ready(await loadEncryption(tablet));
    srv.tamper = (path, body) => {
      if (path !== '/api/e2ee/device-list') return body;
      const account = body as { current: { entries: unknown[] } };
      account.current.entries = account.current.entries.slice(0, -1);
      return account;
    };
    await flowRefusal(
      enrollWithRecoveryKey(tablet, current, recovery.secret, 'Tablet'),
      'key-mismatch'
    );
  });

  it('lets a fresh browser trust the newest identity, which the old recovery key cannot open', async () => {
    const srv = server();
    const { recovery } = await setUp(srv);
    const phone = await enrolled(srv, recovery.secret, 'Phone');
    ready(
      await replaceRecoveryKey(
        phone.ctx,
        phone.account,
        (await generateRecoveryKey()).secret,
        null
      )
    );
    // No pin: first sight, with the fork-consistency limit the ADR states.
    const fresh = device(srv);
    const seen = ready(await loadEncryption(fresh));
    expect(seen.generation).toBe(2);
    await flowRefusal(
      enrollWithRecoveryKey(fresh, seen, recovery.secret, 'Tablet'),
      'wrong-recovery-key'
    );
  });
});

describe('replacing the recovery key', () => {
  it('starts a new identity with only this device and a fresh recovery key', async () => {
    const srv = server();
    const { recovery, laptop } = await setUp(srv);
    const phone = await enrolled(srv, recovery.secret, 'Phone');
    const before = ready(await loadEncryption(laptop));
    const next = await generateRecoveryKey();
    const after = ready(
      await replaceRecoveryKey(laptop, before, next.secret, recovery.secret)
    );
    expect(after.generation).toBe(2);
    expect(after.list.devices.map((d) => d.label)).toEqual(['Laptop']);
    expect(after.list.identityKey).not.toEqual(before.list.identityKey);
    expect(after.list.head.previousIdentityKeyHash).toEqual(
      before.list.identityKeyHash
    );
    expect(after.unlocked).toBe(true);
    expect(after.previous).toEqual([
      expect.objectContaining({
        generation: 1,
        devices: expect.arrayContaining([
          expect.objectContaining({ label: 'Phone' })
        ]) as unknown
      })
    ]);
    // Old wraps are gone; only the new generation's remain.
    expect(
      count(
        srv.db,
        'SELECT COUNT(*) AS n FROM e2ee_key_wraps WHERE generation = 1'
      )
    ).toBe(0);
    // The phone pinned the old identity and must be approved again.
    lockAccount(USER);
    const stale = await loadEncryption(phone.ctx);
    expect(stale.kind).toBe('identity-changed');
    expect(unlockedEncryptionKey(USER)).toBeNull();
    // The old recovery key opens nothing now; the new one enrols the phone.
    if (stale.kind !== 'identity-changed') throw new Error('unreachable');
    await flowRefusal(
      enrollWithRecoveryKey(phone.ctx, stale.account, recovery.secret, 'Phone'),
      'wrong-recovery-key'
    );
    const reenrolled = ready(
      await enrollWithRecoveryKey(
        phone.ctx,
        stale.account,
        next.secret,
        'Phone'
      )
    );
    expect(reenrolled.deviceStatus).toBe('certified');
    expect(reenrolled.unlocked).toBe(true);
  });

  it('signs the transition with this device when the old key is lost', async () => {
    const srv = server();
    const { laptop, account } = await setUp(srv);
    const after = ready(
      await replaceRecoveryKey(
        laptop,
        account,
        (await generateRecoveryKey()).secret,
        null
      )
    );
    expect(after.generation).toBe(2);
    const row = srv.db
      .prepare(
        'SELECT transition_statement FROM e2ee_identities WHERE generation = 2'
      )
      .get() as { transition_statement: string };
    expect(row.transition_statement).toBeTruthy();
  });

  it('refuses a replacement from a browser holding neither key', async () => {
    const srv = server();
    const { laptop, account } = await setUp(srv);
    const stranger = await generateSigningKeyPair(false);
    const strangerKey = await exportPublicKey(stranger.publicKey);
    const refused = await refusal(
      replaceRecoveryKey(
        laptop,
        {
          ...account,
          device: {
            ...account.device!,
            signing: stranger,
            signingPublicKey: strangerKey
          }
        },
        (await generateRecoveryKey()).secret,
        null
      )
    );
    expect([refused.status, refused.code]).toEqual([
      403,
      'E2EE_TRANSITION_UNAUTHORIZED'
    ]);
  });
});

describe('device approval', () => {
  it.each([
    'retained',
    'legacy pruned',
    'colliding ID',
    'duplicate receipts',
    'omitted wraps'
  ] as const)(
    'lists and revokes read-only devices with %s approval metadata',
    async (metadata) => {
      const srv = server();
      const { recovery, laptop } = await setUp(srv);
      const survivor = await enrolled(
        srv,
        recovery.secret,
        'Certified survivor'
      );
      const account = ready(await loadEncryption(laptop));
      const phones: E2eeContext[] = [];
      for (const label of ['Lost phone', 'Other reader']) {
        const phone = device(srv);
        if (metadata === 'colliding ID' && label === 'Lost phone') {
          await requestApproval(phone, null, label);
          const stored = (await phone.store.loadDevice(USER))!;
          await phone.store.saveDevice({
            ...stored,
            deviceId: account.device!.deviceId
          });
        }
        const request = await requestApproval(phone, null, label);
        if (request.step !== 'waiting') throw new Error('Expected request');
        await approveDevice(
          laptop,
          ready(await loadEncryption(laptop)),
          await laptop.api.getApproval(request.approval.id),
          { kind: 'scan', code: request.scanCode },
          null
        );
        expect((await advanceApprovalAsNewDevice(phone)).step).toBe('done');
        if (metadata === 'duplicate receipts' && label === 'Lost phone') {
          const again = await requestApproval(phone, null, label);
          if (again.step !== 'waiting') throw new Error('Expected request');
          await approveDevice(
            laptop,
            ready(await loadEncryption(laptop)),
            again.approval,
            { kind: 'scan', code: again.scanCode },
            null
          );
          expect((await advanceApprovalAsNewDevice(phone)).step).toBe('done');
        }
        phones.push(phone);
      }
      const ids = await Promise.all(
        phones.map(
          async (phone) => (await phone.store.loadDevice(USER))!.deviceId
        )
      );
      srv.db
        .prepare('UPDATE e2ee_device_approvals SET created_at = ?')
        .run(new Date(Date.now() - 60 * 60 * 1000 - 1).toISOString());
      if (metadata === 'legacy pruned')
        srv.db
          .prepare('DELETE FROM e2ee_device_approvals WHERE device_id = ?')
          .run(ids[0]!);
      // Pruning and the hourly cap must ignore old accounting receipts while
      // retaining display metadata for every live read-only wrap.
      for (let i = 0; i < MAX_APPROVALS_PER_HOUR; i += 1) {
        const request = await requestApproval(
          device(srv),
          null,
          `Attempt ${i}`
        );
        if (request.step !== 'waiting') throw new Error('Expected request');
        await laptop.api.cancelApproval(request.approval.id);
      }
      const listed = ready(await loadEncryption(laptop));
      expect(
        count(
          srv.db,
          "SELECT COUNT(*) AS n FROM e2ee_device_approvals WHERE state = 'completed'"
        )
      ).toBe(metadata === 'legacy pruned' ? 1 : 2);
      expect(listed.approvedDevices.map((d) => d.deviceId).sort()).toEqual(
        [...ids].sort()
      );
      expect(
        listed.approvedDevices.find((d) => d.deviceId === ids[0])?.label
      ).toBe(metadata === 'legacy pruned' ? 'Read-only device' : 'Lost phone');
      for (const [index, phone] of phones.entries()) {
        lockAccount(USER);
        expect(ready(await loadEncryption(phone)).unlocked).toBe(
          !(metadata === 'colliding ID' && index === 0)
        );
      }
      // Unsigned metadata cannot hide a live wrap or add a sealing target.
      srv.tamper = (path, body) => {
        if (path === '/api/e2ee/account') {
          const response = body as {
            current: {
              approvedDevices?: unknown[];
              wraps: { purpose: string }[];
            };
          };
          response.current.approvedDevices = [
            { deviceId: 'forged', label: 'Fake' }
          ];
          if (metadata === 'omitted wraps')
            response.current.wraps = response.current.wraps.filter(
              (wrap) => wrap.purpose !== 'account-key-approval'
            );
        }
        return body;
      };
      const untrusted = ready(await loadEncryption(laptop));
      expect(untrusted.approvedDevices.map((d) => d.deviceId).sort()).toEqual(
        metadata === 'omitted wraps' ? [] : [...ids].sort()
      );
      const removed = ready(
        await revokeReadOnlyDevices(laptop, untrusted, recovery.secret)
      );
      srv.tamper = undefined;
      expect(removed.approvedDevices).toEqual([]);
      expect(removed.list.head.accountKeyCommitment).not.toEqual(
        listed.list.head.accountKeyCommitment
      );
      expect(removed.list.head.encryptionKey).not.toEqual(
        listed.list.head.encryptionKey
      );
      expect(removed.list.devices).toEqual(listed.list.devices);
      expect(removed.list.head.revoked).toEqual([]);
      lockAccount(USER);
      expect(ready(await loadEncryption(survivor.ctx)).unlocked).toBe(true);
      for (const phone of phones) {
        lockAccount(USER);
        const state = ready(await loadEncryption(phone));
        expect(state.unlocked).toBe(false);
        expect(state.deviceStatus).not.toBe('approved');
      }
    }
  );

  it('removes read-only listings when the identity is replaced', async () => {
    const srv = server();
    const { laptop, account } = await setUp(srv);
    const request = await requestApproval(device(srv), null, 'Phone');
    if (request.step !== 'waiting') throw new Error('Expected request');
    await approveDevice(
      laptop,
      account,
      request.approval,
      { kind: 'scan', code: request.scanCode },
      null
    );
    const before = ready(await loadEncryption(laptop));
    expect(before.approvedDevices).toHaveLength(1);
    const replaced = ready(
      await replaceRecoveryKey(
        laptop,
        before,
        (await generateRecoveryKey()).secret,
        null
      )
    );
    expect(replaced.approvedDevices).toEqual([]);
  });

  it.each(['cancel', 'replace identity'] as const)(
    'retains hourly accounting when approvals %s',
    async (action) => {
      const srv = server();
      const { laptop, account } = await setUp(srv);
      let lastId = '';
      for (let i = 0; i < MAX_APPROVALS_PER_HOUR; i += 1) {
        const request = await requestApproval(device(srv), null, `Phone ${i}`);
        if (request.step !== 'waiting')
          throw new Error('Expected pending approval');
        lastId = request.approval.id;
        await laptop.api.cancelApproval(lastId);
        await laptop.api.cancelApproval(lastId);
      }
      if (action === 'replace identity') {
        await replaceRecoveryKey(
          laptop,
          account,
          (await generateRecoveryKey()).secret,
          null
        );
      }
      expect((await refusal(laptop.api.getApproval(lastId))).status).toBe(404);
      expect((await laptop.api.listApprovals()).approvals).toEqual([]);
      const capped = await refusal(
        requestApproval(device(srv), null, 'Too many')
      );
      expect([capped.status, capped.code]).toEqual([
        429,
        'E2EE_APPROVAL_RATE_LIMITED'
      ]);
      expect(
        count(srv.db, 'SELECT COUNT(*) AS n FROM e2ee_device_approvals')
      ).toBe(MAX_APPROVALS_PER_HOUR);
      srv.db
        .prepare('UPDATE e2ee_device_approvals SET created_at = ?')
        .run(new Date(Date.now() - 60 * 60 * 1000 - 1).toISOString());
      expect(
        (await requestApproval(device(srv), null, 'After retention')).step
      ).toBe('waiting');
      expect(
        count(srv.db, 'SELECT COUNT(*) AS n FROM e2ee_device_approvals')
      ).toBe(1);
    }
  );

  it('accepts an equivalent legacy responder key encoding and normalizes new responses', async () => {
    const srv = server();
    const { laptop, account } = await setUp(srv);
    const phone = device(srv);
    const request = await requestApproval(phone, null, 'Phone');
    if (request.step !== 'waiting')
      throw new Error('Expected pending approval');
    const [approval] = (await laptop.api.listApprovals()).approvals;
    const key = toBase64Url(account.device!.signingPublicKey);
    const alphabet =
      'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    const alias =
      key.slice(0, -1) + alphabet[alphabet.indexOf(key.at(-1)!) ^ 1];
    expect(fromBase64Url(alias)).toEqual(fromBase64Url(key));
    const originalRespond = laptop.api.respondApproval;
    const responded = await beginCompareApproval(
      {
        ...laptop,
        api: {
          ...laptop.api,
          respondApproval: (id, body) =>
            originalRespond(id, { ...body, approverKey: alias })
        }
      },
      account,
      approval!.id
    );
    expect(responded.approverKey).toBe(key);
    srv.db
      .prepare('UPDATE e2ee_device_approvals SET approver_key = ? WHERE id = ?')
      .run(alias, approval!.id);
    await advanceApprovalAsNewDevice(phone);
    await approveDevice(
      laptop,
      account,
      await laptop.api.getApproval(approval!.id),
      { kind: 'scan', code: request.scanCode },
      null
    );
    const done = await confirmApprovalCode(phone);
    if (done.step !== 'done') throw new Error('Expected completed comparison');
    expect(ready(done.state).unlocked).toBe(true);
  });

  it('refuses a correctly signed grant naming a different hash at the same height', async () => {
    const srv = server();
    const { laptop, account } = await setUp(srv);
    const phone = device(srv);
    const request = await requestApproval(phone, null, 'Phone');
    if (request.step !== 'waiting')
      throw new Error('Expected pending approval');
    const [approval] = (await laptop.api.listApprovals()).approvals;
    const original = laptop.api.completeApproval;
    const intercept = {
      ...laptop,
      api: {
        ...laptop.api,
        completeApproval: async (
          id: string,
          body: Parameters<typeof original>[1]
        ) => {
          const grant = await signDeviceApprovalGrant(
            account.device!.signing.privateKey,
            {
              ...decodeDeviceApprovalGrant(fromBase64Url(body.grant.statement)),
              headHash: generateSymmetricKey()
            }
          );
          return original(id, {
            ...body,
            grant: {
              statement: toBase64Url(grant.statement),
              signature: toBase64Url(grant.signature)
            }
          });
        }
      }
    };
    const refused = await refusal(
      approveDevice(
        intercept,
        account,
        approval!,
        { kind: 'scan', code: request.scanCode },
        null
      )
    );
    expect([refused.status, refused.code]).toEqual([
      409,
      'E2EE_DEVICE_LIST_CONFLICT'
    ]);
    expect((await laptop.api.getApproval(approval!.id)).state).toBe(
      'requested'
    );
    expect(
      count(
        srv.db,
        "SELECT COUNT(*) AS n FROM e2ee_key_wraps WHERE purpose = 'account-key-approval'"
      )
    ).toBe(0);
  });

  it('resumes a certified approval whose completion never reached the Worker', async () => {
    const srv = server();
    const { recovery, laptop, account } = await setUp(srv);
    const phone = device(srv);
    const request = await requestApproval(phone, null, 'Phone');
    if (request.step !== 'waiting')
      throw new Error('Expected pending approval');
    const lost = {
      ...laptop,
      api: {
        ...laptop.api,
        completeApproval: async () => {
          throw new Error('network lost');
        }
      }
    };
    await expect(
      approveDevice(
        lost,
        account,
        request.approval,
        { kind: 'scan', code: request.scanCode },
        recovery.secret
      )
    ).rejects.toThrow('network lost');
    // The append landed: the phone is certified but its approval is pending.
    expect((await laptop.api.getApproval(request.approval.id)).state).toBe(
      'requested'
    );
    const entries = ready(await loadEncryption(laptop)).list.entries.length;
    // Retry from the same, now stale, view without appending again.
    await approveDevice(
      laptop,
      account,
      request.approval,
      { kind: 'scan', code: request.scanCode },
      recovery.secret
    );
    expect(ready(await loadEncryption(laptop)).list.entries).toHaveLength(
      entries
    );
    const done = await advanceApprovalAsNewDevice(phone);
    if (done.step !== 'done') throw new Error('Expected completed approval');
    lockAccount(USER);
    const state = ready(await loadEncryption(phone));
    expect([state.deviceStatus, state.unlocked]).toEqual(['certified', true]);
  });

  it('refuses to certify from a view an account-key rotation made stale', async () => {
    const srv = server();
    const { recovery, laptop } = await setUp(srv);
    await enrolled(srv, recovery.secret, 'Tablet');
    const stale = ready(await loadEncryption(laptop));
    const phone = device(srv);
    const request = await requestApproval(phone, null, 'Phone');
    if (request.step !== 'waiting')
      throw new Error('Expected pending approval');
    const tabletId = stale.list.devices.find(
      (d) => d.label === 'Tablet'
    )!.deviceId;
    // The unlocked-key store is page memory: keep this page's old unlock
    // while the rotation runs, as a second browser would.
    const { rememberUnlockedAccount, unlockedAccount } =
      await import('../apps/web/src/lib/e2ee/unlockedKeys');
    const held = unlockedAccount(USER)!;
    const pageMemory = { ...held, accountKey: held.accountKey.slice() };
    const rotated = ready(
      await removeDevice(laptop, stale, tabletId, recovery.secret)
    );
    rememberUnlockedAccount(USER, pageMemory);
    expect(rotated.list.head.accountKeyCommitment).not.toEqual(
      stale.list.head.accountKeyCommitment
    );
    await flowRefusal(
      approveDevice(
        laptop,
        stale,
        request.approval,
        { kind: 'scan', code: request.scanCode },
        recovery.secret
      ),
      'key-mismatch'
    );
    expect(ready(await loadEncryption(laptop)).list.entries).toHaveLength(
      rotated.list.entries.length
    );
  });

  it.each(['before verification', 'before commit'] as const)(
    'binds a revealed comparison to its responding approver %s',
    async (timing) => {
      const srv = server();
      const { recovery, laptop } = await setUp(srv);
      const other = await enrolled(srv, recovery.secret, 'Other approver');
      const account = ready(await loadEncryption(laptop));
      const phone = device(srv);
      const request = await requestApproval(phone, null, 'Phone');
      if (request.step !== 'waiting')
        throw new Error('Expected pending approval');
      const [scanSnapshot] = (await laptop.api.listApprovals()).approvals;
      const reveal = async () => {
        await beginCompareApproval(laptop, account, scanSnapshot!.id);
        expect((await advanceApprovalAsNewDevice(phone)).step).toBe('compare');
      };
      if (timing === 'before verification') await reveal();
      else
        srv.beforeWrite = async (sql) => {
          if (!sql.includes("SET state = 'completed'")) return;
          srv.beforeWrite = undefined;
          await reveal();
        };
      const rejected = await refusal(
        approveDevice(
          other.ctx,
          other.account,
          scanSnapshot!,
          { kind: 'scan', code: request.scanCode },
          null
        )
      );
      expect([rejected.status, rejected.code]).toEqual([
        409,
        'E2EE_APPROVAL_STATE'
      ]);
      const pending = await laptop.api.getApproval(scanSnapshot!.id);
      expect(pending.state).toBe('revealed');
      expect(
        count(
          srv.db,
          "SELECT COUNT(*) AS n FROM e2ee_key_wraps WHERE purpose = 'account-key-approval'"
        )
      ).toBe(0);
      await approveDevice(laptop, account, pending, { kind: 'compare' }, null);
      const done = await confirmApprovalCode(phone);
      if (done.step !== 'done')
        throw new Error('Expected completed comparison');
      expect(ready(done.state).unlocked).toBe(true);
    }
  );

  it.each(['open', 'hourly'] as const)(
    'atomically enforces the %s approval cap',
    async (cap) => {
      const srv = server();
      const token = 'q'.repeat(43);
      const tokenHash = Buffer.from(
        await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token))
      ).toString('hex');
      srv.credential = { token, desktop: false };
      srv.db
        .prepare('INSERT INTO auth_sessions VALUES (?, ?, ?, ?)')
        .run(tokenHash, USER, 0, 9_999_999_999);
      await setUp(srv);
      for (
        let i = 0;
        i < (cap === 'open' ? 2 : MAX_APPROVALS_PER_HOUR - 1);
        i += 1
      ) {
        await requestApproval(device(srv), null, `Existing ${i}`);
        if (cap === 'hourly')
          srv.db.exec("UPDATE e2ee_device_approvals SET state = 'completed'");
      }
      let arrived = 0;
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      srv.beforeWrite = async (sql) => {
        if (!sql.includes('INSERT INTO e2ee_device_approvals')) return;
        arrived += 1;
        if (arrived === 2) release();
        await gate;
      };
      const results = await Promise.allSettled([
        requestApproval(device(srv), null, 'Contender A'),
        requestApproval(device(srv), null, 'Contender B')
      ]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      const failed = results.find(
        (r) => r.status === 'rejected'
      ) as PromiseRejectedResult;
      expect(failed.reason).toMatchObject({
        status: 429,
        code: 'E2EE_APPROVAL_RATE_LIMITED'
      });
      expect(
        count(srv.db, 'SELECT COUNT(*) AS n FROM e2ee_device_approvals')
      ).toBe(cap === 'open' ? 3 : MAX_APPROVALS_PER_HOUR);
    }
  );

  it('does not rewrite a completed approval wrap when a grant is replayed', async () => {
    const srv = server();
    const { laptop, account } = await setUp(srv);
    const phone = device(srv);
    const request = await requestApproval(phone, null, 'Phone');
    if (request.step !== 'waiting')
      throw new Error('Expected pending approval');
    const [approval] = (await laptop.api.listApprovals()).approvals;
    const original = laptop.api.completeApproval;
    let captured!: Parameters<typeof original>[1];
    const intercept = {
      ...laptop,
      api: {
        ...laptop.api,
        completeApproval: async (
          id: string,
          body: Parameters<typeof original>[1]
        ) => {
          captured = body;
          return original(id, body);
        }
      }
    };
    await approveDevice(
      intercept,
      account,
      approval!,
      { kind: 'scan', code: request.scanCode },
      null
    );
    const before = srv.db
      .prepare(
        "SELECT * FROM e2ee_key_wraps WHERE purpose = 'account-key-approval'"
      )
      .get();
    await refusal(
      original(approval!.id, {
        ...captured,
        sealedAccountKey: toBase64Url(generateSymmetricKey())
      })
    );
    expect(
      srv.db
        .prepare(
          "SELECT * FROM e2ee_key_wraps WHERE purpose = 'account-key-approval'"
        )
        .get()
    ).toEqual(before);
  });

  it.each(['rotation', 'replacement', 'append'] as const)(
    'does not commit an approval across a concurrent %s',
    async (change) => {
      const srv = server();
      const { recovery, laptop } = await setUp(srv);
      const other = await enrolled(srv, recovery.secret, 'Device to remove');
      const account = ready(await loadEncryption(laptop));
      const phone = device(srv);
      const request = await requestApproval(phone, null, 'Phone');
      if (request.step !== 'waiting')
        throw new Error('Expected pending approval');
      const [approval] = (await laptop.api.listApprovals()).approvals;
      let moved = false;
      srv.beforeWrite = async (sql) => {
        if (!sql.includes("SET state = 'completed'")) return;
        srv.beforeWrite = undefined;
        moved = true;
        if (change === 'rotation')
          await removeDevice(
            laptop,
            account,
            other.account.device!.deviceId,
            recovery.secret
          );
        else if (change === 'append') {
          const newcomer = device(srv);
          await enrollWithRecoveryKey(
            newcomer,
            ready(await loadEncryption(newcomer)),
            recovery.secret,
            'New device'
          );
        } else
          await replaceRecoveryKey(
            laptop,
            account,
            (await generateRecoveryKey()).secret,
            null
          );
      };
      await refusal(
        approveDevice(
          laptop,
          account,
          approval!,
          { kind: 'scan', code: request.scanCode },
          null
        )
      );
      expect(moved).toBe(true);
      expect(
        count(
          srv.db,
          "SELECT COUNT(*) AS n FROM e2ee_key_wraps WHERE purpose = 'account-key-approval'"
        )
      ).toBe(0);
      if (change !== 'replacement')
        expect((await laptop.api.getApproval(approval!.id)).state).toBe(
          'requested'
        );
    }
  );

  it('certifies a device approved by scanning its key hash', async () => {
    const srv = server();
    const { recovery, laptop } = await setUp(srv);
    const phone = device(srv);
    const request = await requestApproval(
      phone,
      ready(await loadEncryption(phone)),
      'Phone'
    );
    if (request.step !== 'waiting') throw new Error('expected a request');
    expect(request.scanCode).toMatch(/^OZD1:[0-9A-Z]{52}$/);
    expect(parseScanCode(request.scanCode)).toHaveLength(32);
    const approver = ready(await loadEncryption(laptop));
    const pending = (await laptop.api.listApprovals()).approvals;
    expect(pending.map((a) => a.label)).toEqual(['Phone']);
    // A code from another device is refused.
    const intruder = device(srv);
    const intruderRequest = await requestApproval(intruder, null, 'Intruder');
    if (intruderRequest.step !== 'waiting') throw new Error('expected');
    await flowRefusal(
      approveDevice(
        laptop,
        approver,
        pending[0]!,
        { kind: 'scan', code: intruderRequest.scanCode },
        recovery.secret
      ),
      'scan-mismatch'
    );
    ready(
      await approveDevice(
        laptop,
        approver,
        pending[0]!,
        { kind: 'scan', code: request.scanCode },
        recovery.secret
      )
    );
    lockAccount(USER);
    const done = await advanceApprovalAsNewDevice(phone);
    expect(done.step).toBe('done');
    if (done.step !== 'done') throw new Error('unreachable');
    const account = ready(done.state);
    expect(account.deviceStatus).toBe('certified');
    expect(account.unlocked).toBe(true);
  });

  it('runs the six-digit comparison and approves read-only without the recovery key', async () => {
    const srv = server();
    const { recovery, laptop } = await setUp(srv);
    const phone = device(srv);
    await requestApproval(phone, null, 'Phone');
    const approver = ready(await loadEncryption(laptop));
    const [approval] = (await laptop.api.listApprovals()).approvals;
    await beginCompareApproval(laptop, approver, approval!.id);
    // The phone reveals its nonce only now, and shows its code.
    const shown = await advanceApprovalAsNewDevice(phone);
    expect(shown.step).toBe('compare');
    if (shown.step !== 'compare') throw new Error('unreachable');
    expect(shown.confirmed).toBe(false);
    const revealed = await laptop.api.getApproval(approval!.id);
    const approverCode = await approverComparisonCode(
      laptop,
      approver,
      revealed
    );
    expect(approverCode).toBe(shown.code);
    expect(approverCode).toMatch(/^\d{3} \d{3}$/);
    await approveDevice(laptop, approver, revealed, { kind: 'compare' }, null);
    lockAccount(USER);
    // The phone waits for its own confirmation even though the approval is
    // complete; then it finishes.
    const waiting = await advanceApprovalAsNewDevice(phone);
    expect(waiting).toMatchObject({ step: 'compare', confirmed: false });
    const done = await confirmApprovalCode(phone);
    if (done.step !== 'done') throw new Error(`got ${done.step}`);
    const readOnly = ready(done.state);
    expect(readOnly.deviceStatus).toBe('approved');
    expect(readOnly.unlocked).toBe(true);
    expect(readOnly.approvedDevices).toHaveLength(1);
    // It certifies itself later with the recovery key.
    const certified = ready(
      await enrollWithRecoveryKey(phone, readOnly, recovery.secret, 'Phone')
    );
    expect(certified.deviceStatus).toBe('certified');
    expect(certified.approvedDevices).toEqual([]);
    expect(
      count(
        srv.db,
        `SELECT COUNT(*) AS n FROM e2ee_key_wraps WHERE purpose = 'account-key-approval'`
      )
    ).toBe(0);
  });

  it('ignores a grant from whoever answered unless the user confirmed its digits', async () => {
    const srv = server();
    await setUp(srv);
    const phone = device(srv);
    await requestApproval(phone, null, 'Phone');
    const [approval] = (
      await createE2eeApi(fetcherFor(srv, USER)).listApprovals()
    ).approvals;
    // The server answers in the approver's place, with a key of its own,
    // and completes the approval itself.
    const impostor = await generateSigningKeyPair(false);
    srv.db
      .prepare(
        `UPDATE e2ee_device_approvals SET state = 'responded', approver_key = ?, approver_nonce = ? WHERE id = ?`
      )
      .run(
        toBase64Url(await exportPublicKey(impostor.publicKey)),
        toBase64Url(generateSymmetricKey()),
        approval!.id
      );
    const shown = await advanceApprovalAsNewDevice(phone);
    expect(shown).toMatchObject({ step: 'compare', confirmed: false });
    srv.db
      .prepare(
        `UPDATE e2ee_device_approvals SET state = 'completed', grant_statement = 'AAAA', grant_signature = 'AAAA' WHERE id = ?`
      )
      .run(approval!.id);
    // Unconfirmed, the phone keeps showing the code and accepts nothing.
    expect(await advanceApprovalAsNewDevice(phone)).toMatchObject({
      step: 'compare',
      confirmed: false
    });
    expect(ready(await loadEncryption(phone)).deviceStatus).toBe('pending');
  });

  it('refuses keys swapped after the commitment', async () => {
    const srv = server();
    const { laptop } = await setUp(srv);
    const phone = device(srv);
    await requestApproval(phone, null, 'Phone');
    const approver = ready(await loadEncryption(laptop));
    const [approval] = (await laptop.api.listApprovals()).approvals;
    await beginCompareApproval(laptop, approver, approval!.id);
    await advanceApprovalAsNewDevice(phone);
    // The server swaps in an unlock key of its own.
    const swapped = await exportPublicKey(
      (await generateEncryptionKeyPair()).publicKey
    );
    srv.db
      .prepare('UPDATE e2ee_device_approvals SET unlock_key = ? WHERE id = ?')
      .run(toBase64Url(swapped), approval!.id);
    const revealed = await laptop.api.getApproval(approval!.id);
    await flowRefusal(
      approverComparisonCode(laptop, approver, revealed),
      'commitment-mismatch'
    );
  });

  it('enforces the exchange order, expiry and rate limits', async () => {
    const srv = server();
    const { laptop } = await setUp(srv);
    const phone = device(srv);
    const request = await requestApproval(phone, null, 'Phone');
    if (request.step !== 'waiting') throw new Error('expected a request');
    const scanCode = request.scanCode;
    const approver = ready(await loadEncryption(laptop));
    const [approval] = (await laptop.api.listApprovals()).approvals;
    const early = await refusal(
      laptop.api.revealApproval(approval!.id, {
        nonce: toBase64Url(generateSymmetricKey())
      })
    );
    expect([early.status, early.code]).toEqual([409, 'E2EE_APPROVAL_STATE']);
    await beginCompareApproval(laptop, approver, approval!.id);
    const twice = await refusal(
      beginCompareApproval(laptop, approver, approval!.id)
    );
    expect(twice.status).toBe(409);
    // Responded but not revealed: completing now would skip the code.
    const skipped = await refusal(
      approveDevice(
        laptop,
        approver,
        await laptop.api.getApproval(approval!.id),
        { kind: 'scan', code: scanCode },
        null
      )
    );
    expect([skipped.status, skipped.code]).toEqual([
      409,
      'E2EE_APPROVAL_STATE'
    ]);

    srv.db
      .prepare('UPDATE e2ee_device_approvals SET expires_at = ? WHERE id = ?')
      .run(new Date(Date.now() - 1).toISOString(), approval!.id);
    expect((await advanceApprovalAsNewDevice(phone)).step).toBe('expired');

    for (let i = 0; i < 3; i += 1) {
      await requestApproval(device(srv), null, `Device ${i}`);
    }
    const open = await refusal(requestApproval(device(srv), null, 'One more'));
    expect([open.status, open.code]).toEqual([
      429,
      'E2EE_APPROVAL_RATE_LIMITED'
    ]);
    srv.db.exec(
      `UPDATE e2ee_device_approvals SET expires_at = '2000-01-01T00:00:00.000Z'`
    );
    const created = count(
      srv.db,
      'SELECT COUNT(*) AS n FROM e2ee_device_approvals'
    );
    for (let i = created; i < MAX_APPROVALS_PER_HOUR; i += 1) {
      srv.db
        .prepare(
          `INSERT INTO e2ee_device_approvals (id, user_id, device_id, label, signing_key, unlock_key, state, created_at, expires_at)
           SELECT 'apr_fill_' || ?, user_id, 'dev_fill', 'x', signing_key, unlock_key, 'completed', ?, ? FROM e2ee_device_approvals LIMIT 1`
        )
        .run(
          String(i),
          new Date().toISOString(),
          new Date(Date.now() + APPROVAL_TTL_MS).toISOString()
        );
    }
    const hourly = await refusal(requestApproval(device(srv), null, 'Again'));
    expect(hourly.status).toBe(429);
  });

  it('refuses a grant from a device outside the list', async () => {
    const srv = server();
    const { laptop } = await setUp(srv);
    const phone = device(srv);
    const request = await requestApproval(phone, null, 'Phone');
    if (request.step !== 'waiting') throw new Error('expected');
    const approver = ready(await loadEncryption(laptop));
    const [approval] = (await laptop.api.listApprovals()).approvals;
    const stranger = await generateSigningKeyPair(false);
    const refused = await refusal(
      approveDevice(
        laptop,
        {
          ...approver,
          device: {
            ...approver.device!,
            signing: stranger,
            signingPublicKey: await exportPublicKey(stranger.publicKey)
          }
        },
        approval!,
        { kind: 'scan', code: request.scanCode },
        null
      )
    );
    expect([refused.status, refused.code]).toEqual([
      403,
      'E2EE_APPROVER_UNKNOWN'
    ]);
  });
});

describe('the Worker refuses malformed device-list writes', () => {
  async function chainOf(srv: Server) {
    const rows = srv.db
      .prepare(
        'SELECT entry, signature FROM e2ee_device_list_entries ORDER BY sequence'
      )
      .all() as { entry: string; signature: string }[];
    const identity = srv.db
      .prepare('SELECT identity_key FROM e2ee_identities')
      .get() as { identity_key: string };
    return verifyDeviceList(
      fromBase64Url(identity.identity_key),
      rows.map((row) => ({
        entry: fromBase64Url(row.entry),
        signature: fromBase64Url(row.signature)
      }))
    );
  }

  it('refuses an entry not signed by the identity, a stale sequence and unknown targets', async () => {
    const srv = server();
    const { laptop } = await setUp(srv);
    const list = await chainOf(srv);
    const impostor = await generateSigningKeyPair(false);
    const entry = nextDeviceListEntry(list, { issuedAt: 1 });
    const forged = await signDeviceListEntry(impostor.privateKey, entry);
    const bad = await refusal(
      laptop.api.appendDeviceList({
        generation: 1,
        entry: toBase64Url(forged.entry),
        signature: toBase64Url(forged.signature),
        wraps: []
      })
    );
    expect([bad.status, bad.code]).toEqual([400, 'E2EE_KEYS_INVALID']);
    const stale = await refusal(
      laptop.api.appendDeviceList({
        generation: 1,
        entry: srv.db
          .prepare('SELECT entry FROM e2ee_device_list_entries')
          .get()!.entry as string,
        signature: srv.db
          .prepare('SELECT signature FROM e2ee_device_list_entries')
          .get()!.signature as string,
        wraps: []
      })
    );
    expect([stale.status, stale.code]).toEqual([
      409,
      'E2EE_DEVICE_LIST_CONFLICT'
    ]);
    const decoded = decodeDeviceListEntry(
      fromBase64Url(
        srv.db.prepare('SELECT entry FROM e2ee_device_list_entries').get()!
          .entry as string
      )
    );
    expect(decoded.sequence).toBe(0);
    expect(await accountKeyCommitment(generateSymmetricKey())).not.toEqual(
      decoded.accountKeyCommitment
    );
  });

  it('refuses oversized bodies', async () => {
    const srv = server();
    const { laptop } = await setUp(srv);
    const huge = await refusal(
      laptop.api.appendDeviceList({
        generation: 1,
        entry: 'A'.repeat(600 * 1024),
        signature: '',
        wraps: []
      })
    );
    expect(huge.status).toBe(413);
  });
});

describe('erasure and sign-out', () => {
  it('erases every key row with the account', async () => {
    const srv = server();
    await setUp(srv);
    await requestApproval(device(srv), null, 'Phone');
    srv.db.prepare('DELETE FROM users WHERE id = ?').run(USER);
    for (const table of [
      'e2ee_identities',
      'e2ee_device_list_entries',
      'e2ee_key_wraps',
      'e2ee_device_approvals'
    ]) {
      expect(count(srv.db, `SELECT COUNT(*) AS n FROM ${table}`)).toBe(0);
    }
  });

  it('deletes this device’s keys when sign-out does not keep it unlocked', async () => {
    const srv = server();
    const { laptop } = await setUp(srv);
    await forgetThisDevice(laptop);
    expect(await laptop.store.loadDevice(USER)).toBeNull();
    expect(unlockedEncryptionKey(USER)).toBeNull();
    expect(ready(await loadEncryption(laptop)).deviceStatus).toBe('none');
  });

  it('builds scan codes from both device keys', async () => {
    const srv = server();
    const { laptop } = await setUp(srv);
    const stored = (await laptop.store.loadDevice(USER))!;
    const code = await deviceScanCode(stored);
    expect(parseScanCode(code)).toEqual(
      parseScanCode(code.toLowerCase().replace('ozd1:', ''))
    );
    expect(parseScanCode('not a code')).toBeNull();
  });
});

describe('the Worker entry point', () => {
  async function workerFetch(
    env: Record<string, unknown>,
    path: string,
    init?: RequestInit
  ) {
    const { default: worker } = await import('../apps/web/worker/index');
    return worker.fetch(new Request(`https://example.com${path}`, init), env);
  }

  const devEnv = (extra: Record<string, unknown> = {}) => ({
    ENVIRONMENT: 'development',
    AUTH_MODE: 'development',
    DB: d1Database(migratedDatabase()),
    ...extra
  });

  it('keeps the routes closed until E2EE_KEYS_ENABLED is set', async () => {
    const closed = await workerFetch(devEnv(), '/api/e2ee/config');
    expect(await closed.json()).toEqual({ enabled: false });
    expect((await workerFetch(devEnv(), '/api/e2ee/account')).status).toBe(501);
    const open = devEnv({ E2EE_KEYS_ENABLED: 'true' });
    expect(await (await workerFetch(open, '/api/e2ee/config')).json()).toEqual({
      enabled: true
    });
    expect(await (await workerFetch(open, '/api/e2ee/account')).json()).toEqual(
      { current: null, previous: [] }
    );
  });

  it('refuses cross-origin writes and unauthenticated reads', async () => {
    const open = devEnv({ E2EE_KEYS_ENABLED: 'true' });
    const crossOrigin = await workerFetch(open, '/api/e2ee/approvals', {
      method: 'POST',
      headers: {
        origin: 'https://attacker.example',
        'content-type': 'application/json'
      },
      body: '{}'
    });
    expect(crossOrigin.status).toBe(403);
    const signedOut = await workerFetch(
      { ...open, AUTH_MODE: 'email-code', ENVIRONMENT: 'beta' },
      '/api/e2ee/account'
    );
    expect(signedOut.status).toBe(401);
  });
});

describe('session teardown', () => {
  it('locks every other account’s keys and zeroes them', async () => {
    const srv = server();
    await setUp(srv);
    const { lockAccountsExcept, unlockedAccount } =
      await import('../apps/web/src/lib/e2ee/unlockedKeys');
    const held = unlockedAccount(USER)!;
    lockAccountsExcept(USER);
    expect(unlockedEncryptionKey(USER)).not.toBeNull();
    lockAccountsExcept(null);
    expect(unlockedEncryptionKey(USER)).toBeNull();
    expect(held.accountKey.every((byte) => byte === 0)).toBe(true);
  });
});

describe('profile deletion', () => {
  it('still deletes a profile before the E2EE schema exists', async () => {
    const srv = server();
    srv.db.exec(
      'DROP TABLE e2ee_device_approvals; DROP TABLE e2ee_key_wraps; DROP TABLE e2ee_device_list_entries; DROP TABLE e2ee_identities'
    );
    const { deleteAccountData } =
      await import('../apps/web/worker/accountDeletion');
    await expect(
      deleteAccountData(
        { userId: USER as never, displayName: 'Alice', mode: 'development' },
        { scope: 'profile', confirmation: 'DELETE CLOUD PROFILE' },
        { DB: d1Database(srv.db) },
        {} as never
      )
    ).resolves.toMatchObject({ ok: true, signedOut: true });
    expect(
      srv.db.prepare('SELECT email FROM users WHERE id = ?').get(USER)
    ).toEqual({ email: null });
  });

  it.each(['query failure', 'missing result', 'partial schema'] as const)(
    'retains the erasure fence and refuses success after an E2EE readiness %s',
    async (fault) => {
      const srv = server();
      await setUp(srv);
      const base = d1Database(srv.db);
      let fail = true;
      const db: D1Database = {
        prepare: (sql) => {
          const statement = base.prepare(sql);
          if (!sql.includes('COUNT(*) AS tables')) return statement;
          return {
            bind: (...values) => statement.bind(...values),
            all: () => statement.all(),
            run: () => statement.run(),
            first: async <T>() => {
              if (!fail) return statement.first<T>();
              if (fault === 'query failure')
                throw new Error('Transient D1 error');
              return (
                fault === 'missing result' ? null : { tables: 3 }
              ) as T | null;
            }
          };
        },
        batch: (statements) => base.batch(statements)
      };
      const { deleteAccountData } =
        await import('../apps/web/worker/accountDeletion');
      const erase = () =>
        deleteAccountData(
          { userId: USER as never, displayName: 'Alice', mode: 'development' },
          { scope: 'profile', confirmation: 'DELETE CLOUD PROFILE' },
          { DB: db },
          {} as never
        );
      await expect(erase()).rejects.toThrow();
      expect(
        count(srv.db, 'SELECT COUNT(*) AS n FROM account_erasure_requests')
      ).toBe(1);
      expect(count(srv.db, 'SELECT COUNT(*) AS n FROM e2ee_identities')).toBe(
        1
      );
      expect(
        srv.db.prepare('SELECT email FROM users WHERE id = ?').get(USER)
      ).toEqual({ email: 'alice@example.com' });
      fail = false;
      expect(await erase()).toMatchObject({ ok: true, signedOut: true });
      for (const table of [
        'e2ee_identities',
        'e2ee_device_list_entries',
        'e2ee_key_wraps',
        'e2ee_device_approvals'
      ])
        expect(count(srv.db, `SELECT COUNT(*) AS n FROM ${table}`)).toBe(0);
      expect(
        count(srv.db, 'SELECT COUNT(*) AS n FROM account_erasure_requests')
      ).toBe(0);
    }
  );

  it.each(['profile', 'all'] as const)(
    'does not reacquire development authority after %s erasure before route readiness',
    async (scope) => {
      const srv = server();
      const base = d1Database(srv.db);
      let raced = false;
      const racing: D1Database = {
        prepare: (sql) => {
          const statement = base.prepare(sql);
          if (!sql.includes('COUNT(*) AS tables')) return statement;
          return {
            bind: (...values) => statement.bind(...values),
            all: () => statement.all(),
            run: () => statement.run(),
            first: async <T>() => {
              if (!raced) {
                raced = true;
                expect(
                  count(srv.db, 'SELECT COUNT(*) AS n FROM auth_sessions')
                ).toBe(1);
                const { deleteAccountData } =
                  await import('../apps/web/worker/accountDeletion');
                await deleteAccountData(
                  {
                    userId: USER as never,
                    displayName: 'Alice',
                    mode: 'development'
                  },
                  {
                    scope,
                    confirmation:
                      scope === 'all'
                        ? 'DELETE ALL CLOUD DATA'
                        : 'DELETE CLOUD PROFILE'
                  },
                  {
                    DB: base,
                    PROJECT_STORAGE: {
                      put: async () => {},
                      get: async () => null,
                      delete: async () => {}
                    } as never,
                    PROJECT_ROOM: {} as never
                  },
                  { deleteOwnedProjects: async () => [] } as never
                );
              }
              return statement.first<T>();
            }
          };
        },
        batch: (statements) => base.batch(statements)
      };
      const { default: worker } = await import('../apps/web/worker/index');
      const ctx = {
        ...device(srv),
        api: createE2eeApi((path, init) =>
          worker.fetch(
            new Request(`https://zcad.test${path}`, {
              ...init,
              headers: { ...init?.headers, 'x-openzcad-development-user': USER }
            }),
            {
              DB: racing,
              AUTH_MODE: 'development',
              ENVIRONMENT: 'development',
              E2EE_KEYS_ENABLED: 'true'
            }
          )
        )
      };
      await expect(
        setUpEncryption(ctx, {
          recoverySecret: (await generateRecoveryKey()).secret,
          label: 'Laptop'
        })
      ).rejects.toBeInstanceOf(E2eeApiError);
      expect(raced).toBe(true);
      expect(count(srv.db, 'SELECT COUNT(*) AS n FROM e2ee_identities')).toBe(
        0
      );
      expect(count(srv.db, 'SELECT COUNT(*) AS n FROM auth_sessions')).toBe(0);
      expect(count(srv.db, 'SELECT COUNT(*) AS n FROM users')).toBe(
        scope === 'all' ? 0 : 1
      );
    }
  );

  it.each(['profile', 'all'] as const)(
    'refuses setup admitted before %s erasure, even after a new sign-in',
    async (scope) => {
      const srv = server();
      const base = d1Database(srv.db);
      let erased = false;
      const racing = {
        prepare: (sql: string) => base.prepare(sql),
        batch: async (statements: D1PreparedStatement[]) => {
          if (
            !erased &&
            statements.some((s) =>
              (s as unknown as { sql: string }).sql.includes(
                'INSERT INTO e2ee_identities'
              )
            )
          ) {
            erased = true;
            const { deleteAccountData } =
              await import('../apps/web/worker/accountDeletion');
            await deleteAccountData(
              {
                userId: USER as never,
                displayName: 'Alice',
                mode: 'development'
              },
              {
                scope,
                confirmation:
                  scope === 'all'
                    ? 'DELETE ALL CLOUD DATA'
                    : 'DELETE CLOUD PROFILE'
              },
              {
                DB: base,
                PROJECT_STORAGE: {
                  put: async () => {},
                  get: async () => null,
                  delete: async () => {}
                } as never,
                PROJECT_ROOM: {} as never
              },
              { deleteOwnedProjects: async () => [] } as never
            );
            // A fresh sign-in must not reauthorize the old request.
            srv.db
              .prepare(
                'INSERT INTO users (id, email, created_at) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET email = excluded.email'
              )
              .run(USER, 'alice@example.com', new Date().toISOString());
            srv.db
              .prepare('INSERT INTO auth_sessions VALUES (?, ?, ?, ?)')
              .run('new-session', USER, 0, 9_999_999_999);
          }
          return base.batch(statements);
        }
      };
      const ctx = { ...device(srv) };
      ctx.api = createE2eeApi(async (path, init) => {
        const session = { userId: USER };
        if (!['GET', 'HEAD', 'OPTIONS'].includes(init?.method ?? 'GET'))
          await admitDevelopmentE2eeWrite(racing, session);
        return handleE2eeRequest(
          new Request(`https://zcad.test${path}`, init),
          { DB: racing, AUTH_MODE: 'development', ENVIRONMENT: 'development' },
          session,
          true
        );
      });
      await expect(
        setUpEncryption(ctx, {
          recoverySecret: (await generateRecoveryKey()).secret,
          label: 'Laptop'
        })
      ).rejects.toBeInstanceOf(E2eeApiError);
      expect(count(srv.db, 'SELECT COUNT(*) AS n FROM e2ee_identities')).toBe(
        0
      );
    }
  );

  it('erases every key row although the users row survives', async () => {
    const srv = server();
    await setUp(srv);
    await requestApproval(device(srv), null, 'Phone');
    const { deleteAccountData } =
      await import('../apps/web/worker/accountDeletion');
    const result = await deleteAccountData(
      { userId: USER as never, displayName: 'Alice', mode: 'development' },
      { scope: 'profile', confirmation: 'DELETE CLOUD PROFILE' },
      { DB: d1Database(srv.db) },
      {} as never
    );
    expect(result.scope).toBe('profile');
    expect(count(srv.db, 'SELECT COUNT(*) AS n FROM users')).toBe(1);
    for (const table of [
      'e2ee_identities',
      'e2ee_device_list_entries',
      'e2ee_key_wraps',
      'e2ee_device_approvals'
    ]) {
      expect(count(srv.db, `SELECT COUNT(*) AS n FROM ${table}`)).toBe(0);
    }
  });
});

describe.each(['development', 'browser', 'desktop'] as const)(
  '%s mutation authority',
  (backend) => {
    describe.each(['revoked', 'erasing'] as const)('%s authority', (phase) => {
      it.each([
        'setup',
        'replace',
        'append',
        'create',
        'prune',
        'respond',
        'reveal',
        'complete',
        'cancel'
      ] as const)(
        'does not commit %s after its admitted authority is revoked',
        async (operation) => {
          const srv = server();
          if (backend !== 'development') {
            const token = 'a'.repeat(43);
            const tokenHash = Buffer.from(
              await crypto.subtle.digest(
                'SHA-256',
                new TextEncoder().encode(token)
              )
            ).toString('hex');
            srv.credential = { token, desktop: backend === 'desktop' };
            if (backend === 'browser') {
              srv.db
                .prepare('INSERT INTO auth_sessions VALUES (?, ?, ?, ?)')
                .run(tokenHash, USER, 0, 9_999_999_999);
            } else {
              srv.db
                .prepare(
                  'INSERT INTO desktop_access_tokens VALUES (?, ?, ?, ?, ?, ?, NULL)'
                )
                .run(
                  tokenHash,
                  'desktop-session',
                  USER,
                  'openzcad-macos',
                  0,
                  9_999_999_999
                );
            }
          }
          const recovery = await generateRecoveryKey();
          const laptop = device(srv);
          let action: () => Promise<unknown>;
          let target: string;
          if (operation === 'setup') {
            action = () =>
              setUpEncryption(laptop, {
                recoverySecret: recovery.secret,
                label: 'Laptop'
              });
            target = 'INSERT INTO e2ee_identities';
          } else {
            const account = ready(
              await setUpEncryption(laptop, {
                recoverySecret: recovery.secret,
                label: 'Laptop'
              })
            );
            const phone = device(srv);
            if (operation === 'replace') {
              action = async () =>
                replaceRecoveryKey(
                  laptop,
                  account,
                  (await generateRecoveryKey()).secret,
                  null
                );
              target = 'INSERT INTO e2ee_identities';
            } else if (operation === 'append') {
              action = async () =>
                enrollWithRecoveryKey(
                  phone,
                  ready(await loadEncryption(phone)),
                  recovery.secret,
                  'Phone'
                );
              target = 'INSERT INTO e2ee_device_list_entries';
            } else if (operation === 'create') {
              action = () => requestApproval(phone, null, 'Phone');
              target = 'INSERT INTO e2ee_device_approvals';
            } else {
              const request = await requestApproval(phone, null, 'Phone');
              if (request.step !== 'waiting')
                throw new Error('Expected pending approval');
              const [approval] = (await laptop.api.listApprovals()).approvals;
              if (operation === 'respond') {
                action = () =>
                  beginCompareApproval(laptop, account, approval!.id);
                target = "state = 'responded'";
              } else if (operation === 'reveal') {
                await beginCompareApproval(laptop, account, approval!.id);
                action = () => advanceApprovalAsNewDevice(phone);
                target = "state = 'revealed'";
              } else if (operation === 'complete') {
                action = () =>
                  approveDevice(
                    laptop,
                    account,
                    approval!,
                    { kind: 'scan', code: request.scanCode },
                    null
                  );
                target = "SET state = 'completed'";
              } else if (operation === 'prune') {
                srv.db
                  .prepare(
                    "UPDATE e2ee_device_approvals SET created_at = '2000-01-01', expires_at = '2000-01-02'"
                  )
                  .run();
                action = () => requestApproval(device(srv), null, 'Tablet');
                target = 'AND created_at < ?';
              } else {
                action = () => phone.api.cancelApproval(approval!.id);
                target = 'SET expires_at = MIN(expires_at, ?)';
              }
            }
          }
          const snapshot = () =>
            [
              'e2ee_identities',
              'e2ee_device_list_entries',
              'e2ee_key_wraps',
              'e2ee_device_approvals'
            ].map((table) => srv.db.prepare(`SELECT * FROM ${table}`).all());
          const before = snapshot();
          let raced = false;
          srv.beforeWrite = async (sql) => {
            if (!sql.includes(target)) return;
            raced = true;
            srv.beforeWrite = undefined;
            if (phase === 'erasing') {
              srv.db
                .prepare(
                  'INSERT INTO account_erasure_requests VALUES (?, ?, ?, ?)'
                )
                .run(USER, 'profile', 1, 1);
              return;
            }
            srv.db.exec(
              'DELETE FROM auth_sessions; DELETE FROM desktop_access_tokens'
            );
            // New authority must not authorize this already-admitted operation.
            srv.db
              .prepare('INSERT INTO auth_sessions VALUES (?, ?, ?, ?)')
              .run('fresh-login', USER, 0, 9_999_999_999);
          };
          if (operation === 'cancel')
            await action(); // Cancellation remains idempotent.
          else await expect(action()).rejects.toBeInstanceOf(E2eeApiError);
          expect(raced).toBe(true);
          expect(snapshot()).toEqual(before);
        }
      );
    });
  }
);

describe.each(['development', 'browser', 'desktop'] as const)(
  '%s expiry during a key-write batch',
  (backend) => {
    it.each(['setup', 'rotation'] as const)(
      'keeps every %s statement under the same expiry decision',
      async (operation) => {
        const srv = server();
        if (backend !== 'development') {
          const token = 'b'.repeat(43);
          const hash = Buffer.from(
            await crypto.subtle.digest(
              'SHA-256',
              new TextEncoder().encode(token)
            )
          ).toString('hex');
          srv.credential = { token, desktop: backend === 'desktop' };
          if (backend === 'browser')
            srv.db
              .prepare('INSERT INTO auth_sessions VALUES (?, ?, ?, ?)')
              .run(hash, USER, 0, 9_999_999_999);
          else
            srv.db
              .prepare(
                'INSERT INTO desktop_access_tokens VALUES (?, ?, ?, ?, ?, ?, NULL)'
              )
              .run(
                hash,
                'desktop-expiry',
                USER,
                'openzcad-macos',
                0,
                9_999_999_999
              );
        }
        const laptop = device(srv);
        const recovery = await generateRecoveryKey();
        let action: () => Promise<EncryptionState>;
        if (operation === 'setup') {
          action = () =>
            setUpEncryption(laptop, {
              recoverySecret: recovery.secret,
              label: 'Laptop'
            });
        } else {
          await setUpEncryption(laptop, {
            recoverySecret: recovery.secret,
            label: 'Laptop'
          });
          const phone = await enrolled(srv, recovery.secret, 'Phone');
          const account = ready(await loadEncryption(laptop));
          action = () =>
            removeDevice(
              laptop,
              account,
              phone.account.device!.deviceId,
              recovery.secret
            );
        }
        let crossed = false;
        srv.beforeWrite = async (sql) => {
          if (
            !sql.includes(
              operation === 'setup'
                ? 'INSERT INTO e2ee_identities'
                : 'INSERT INTO e2ee_device_list_entries'
            )
          )
            return;
          srv.beforeWrite = undefined;
          crossed = true;
          const cutoff = Math.floor(Date.now() / 1000) + 5;
          // The first SQL clock read admits, the next is already expired.
          // These are real SQLite statements, not query-text return values.
          let second = cutoff;
          srv.db.function('unixepoch', () => second++);
          const table =
            backend === 'desktop' ? 'desktop_access_tokens' : 'auth_sessions';
          srv.db
            .prepare(`UPDATE ${table} SET expires_at = ? WHERE user_id = ?`)
            .run(cutoff, USER);
        };
        expect(ready(await action()).unlocked).toBe(true);
        expect(crossed).toBe(true);
        lockAccount(USER);
        expect(ready(await loadEncryption(laptop)).unlocked).toBe(true);
      }
    );
  }
);

describe('setup device persistence', () => {
  it('keeps the certified keys when two tabs set up concurrently', async () => {
    const srv = server();
    const first = { ...device(srv) };
    const api = first.api;
    let entered!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    first.api = {
      ...api,
      setup: async (body) => {
        entered();
        await released;
        return api.setup(body);
      }
    };
    const secret = (await generateRecoveryKey()).secret;
    const pending = setUpEncryption(first, {
      recoverySecret: secret,
      label: 'First tab'
    });
    await started;
    const winningKeys = await first.store.loadDevice(USER);
    let secondEntered!: () => void;
    let secondRelease!: () => void;
    const secondStarted = new Promise<void>((resolve) => {
      secondEntered = resolve;
    });
    const secondReleased = new Promise<void>((resolve) => {
      secondRelease = resolve;
    });
    const second = {
      ...device(srv),
      store: first.store,
      api: {
        ...api,
        setup: async (body: E2eeSetupRequest) => {
          secondEntered();
          await secondReleased;
          return api.setup(body);
        }
      }
    };
    const secondSetup = setUpEncryption(second, {
      recoverySecret: secret,
      label: 'Second tab'
    });
    await secondStarted;
    release();
    await pending;
    secondRelease();
    await expect(secondSetup).rejects.toBeInstanceOf(E2eeApiError);
    lockAccount(USER);
    expect((await first.store.loadDevice(USER))?.deviceId).toBe(
      winningKeys?.deviceId
    );
    expect(ready(await loadEncryption(first)).deviceStatus).toBe('certified');
    expect(unlockedEncryptionKey(USER)).not.toBeNull();
  });

  it('preserves keys when retrying a committed setup whose response was lost', async () => {
    const srv = server();
    const ctx = { ...device(srv) };
    const api = ctx.api;
    ctx.api = {
      ...api,
      setup: async (body) => {
        await api.setup(body);
        throw new Error('Response lost');
      }
    };
    const options = {
      recoverySecret: (await generateRecoveryKey()).secret,
      label: 'Laptop'
    };
    await expect(setUpEncryption(ctx, options)).rejects.toThrow(
      'Response lost'
    );
    const committed = await ctx.store.loadDevice(USER);
    ctx.api = api;
    await expect(setUpEncryption(ctx, options)).rejects.toBeInstanceOf(
      E2eeApiError
    );
    expect((await ctx.store.loadDevice(USER))?.deviceId).toBe(
      committed?.deviceId
    );
    lockAccount(USER);
    expect(ready(await loadEncryption(ctx)).deviceStatus).toBe('certified');
    expect(unlockedEncryptionKey(USER)).not.toBeNull();
  });
});

describe('identity replacement races', () => {
  it('conflicts when the device list moves between check and write', async () => {
    const srv = server();
    const { laptop, account } = await setUp(srv);
    const base = d1Database(srv.db);
    // A device-list append (a removal of the signing device, say) commits
    // after the Worker verified the transition and before its batch runs.
    const racing = {
      prepare: (sql: string) => base.prepare(sql),
      batch: async (statements: D1PreparedStatement[]) => {
        if (
          statements.some((s) =>
            (s as unknown as { sql: string }).sql.includes(
              'INSERT INTO e2ee_identities'
            )
          )
        )
          srv.db
            .prepare(
              `INSERT INTO e2ee_device_list_entries (user_id, generation, sequence, entry, signature, entry_hash, created_at)
             SELECT user_id, generation, sequence + 1, entry, signature, ?, created_at
             FROM e2ee_device_list_entries WHERE generation = 1 ORDER BY sequence DESC LIMIT 1`
            )
            .run('f'.repeat(64));
        return base.batch(statements);
      }
    };
    const api = createE2eeApi(async (path, init) => {
      const session = { userId: USER };
      if (!['GET', 'HEAD', 'OPTIONS'].includes(init?.method ?? 'GET'))
        await admitDevelopmentE2eeWrite(racing, session);
      return handleE2eeRequest(
        new Request(`https://zcad.test${path}`, init),
        { DB: racing, AUTH_MODE: 'development', ENVIRONMENT: 'development' },
        session,
        true
      );
    });
    const refused = await refusal(
      replaceRecoveryKey(
        { ...laptop, api },
        account,
        (await generateRecoveryKey()).secret,
        null
      )
    );
    expect([refused.status, refused.code]).toEqual([
      409,
      'E2EE_GENERATION_CONFLICT'
    ]);
    expect(count(srv.db, 'SELECT COUNT(*) AS n FROM e2ee_identities')).toBe(1);
    expect(
      count(
        srv.db,
        'SELECT COUNT(*) AS n FROM e2ee_key_wraps WHERE generation = 1'
      )
    ).toBeGreaterThan(0);
  });
});

function deferredPinWrite(store: DeviceKeyStore) {
  let start!: () => void;
  let resume!: () => void;
  const started = new Promise<void>((resolve) => {
    start = resolve;
  });
  const released = new Promise<void>((resolve) => {
    resume = resolve;
  });
  return {
    started,
    resume,
    store: {
      ...store,
      savePin: async (...args: Parameters<DeviceKeyStore['savePin']>) => {
        start();
        await released;
        return store.savePin(...args);
      }
    }
  };
}

describe('cross-tab pin persistence', () => {
  it('refuses a delayed load after another tab pins a newer head, keeping the pin and locking', async () => {
    const srv = server();
    const { laptop, recovery } = await setUp(srv);
    const delayed = deferredPinWrite(laptop.store);
    const loading = loadEncryption({ ...laptop, store: delayed.store });
    await delayed.started;
    await enrolled(srv, recovery.secret, 'Phone');
    const newer = ready(await loadEncryption(laptop));
    const pin = await laptop.store.loadPin(USER);
    expect(pin?.sequence).toBe(newer.list.head.sequence);
    delayed.resume();
    expect((await loading).kind).toBe('fork');
    expect(await laptop.store.loadPin(USER)).toEqual(pin);
    expect(unlockedEncryptionKey(USER)).toBeNull();
  });

  it('refuses a delayed old-identity load after another tab replaces the identity', async () => {
    const srv = server();
    const { laptop, account, recovery } = await setUp(srv);
    const delayed = deferredPinWrite(laptop.store);
    const loading = loadEncryption({ ...laptop, store: delayed.store });
    await delayed.started;
    const replaced = ready(
      await replaceRecoveryKey(
        laptop,
        account,
        (await generateRecoveryKey()).secret,
        recovery.secret
      )
    );
    delayed.resume();
    expect((await loading).kind).toBe('identity-changed');
    expect(await laptop.store.loadPin(USER)).toEqual(replaced.list.pin);
    expect(unlockedEncryptionKey(USER)).toBeNull();
  });

  it('refuses an old first-sight load when another tab first pins a different identity', async () => {
    const srv = server();
    const { laptop, account, recovery } = await setUp(srv);
    const fresh = device(srv);
    const delayed = deferredPinWrite(fresh.store);
    const loading = loadEncryption({ ...fresh, store: delayed.store });
    await delayed.started;
    await replaceRecoveryKey(
      laptop,
      account,
      (await generateRecoveryKey()).secret,
      recovery.secret
    );
    const newer = ready(await loadEncryption(fresh));
    delayed.resume();
    expect((await loading).kind).toBe('identity-changed');
    expect(await fresh.store.loadPin(USER)).toEqual(newer.list.pin);
    expect(unlockedEncryptionKey(USER)).toBeNull();
  });

  it('refuses a delayed write response after another tab accepts a later head', async () => {
    const srv = server();
    const { laptop, recovery } = await setUp(srv);
    const phone = await enrolled(srv, recovery.secret, 'Phone');
    const before = ready(await loadEncryption(laptop));
    const delayed = deferredPinWrite(laptop.store);
    const writing = removeDevice(
      { ...laptop, store: delayed.store },
      before,
      phone.account.device!.deviceId,
      recovery.secret
    );
    await delayed.started;
    await enrolled(srv, recovery.secret, 'Tablet');
    const newer = ready(await loadEncryption(laptop));
    delayed.resume();
    await expect(writing).rejects.toHaveProperty(
      'name',
      'DeviceListPinConflict'
    );
    expect(await laptop.store.loadPin(USER)).toEqual(newer.list.pin);
    expect(unlockedEncryptionKey(USER)).toBeNull();
  });

  it('refuses a delayed authorized replacement after another identity is accepted', async () => {
    const srv = server();
    const { laptop, account, recovery } = await setUp(srv);
    const next = await generateRecoveryKey();
    const delayed = deferredPinWrite(laptop.store);
    const replacing = replaceRecoveryKey(
      { ...laptop, store: delayed.store },
      account,
      next.secret,
      recovery.secret
    );
    await delayed.started;
    const response = await laptop.api.account();
    const current = response.current!;
    const intermediate = await verifyDeviceList(
      fromBase64Url(current.identityKey),
      current.entries.map((e) => ({
        entry: fromBase64Url(e.entry),
        signature: fromBase64Url(e.signature)
      }))
    );
    await laptop.store.savePin(USER, intermediate, {
      replaceIdentityFrom: account.persistedPin
    });
    const b = ready(await loadEncryption(laptop));
    const newer = ready(
      await replaceRecoveryKey(
        laptop,
        b,
        (await generateRecoveryKey()).secret,
        next.secret
      )
    );
    delayed.resume();
    await expect(replacing).rejects.toHaveProperty(
      'name',
      'DeviceListPinConflict'
    );
    expect(await laptop.store.loadPin(USER)).toEqual(newer.list.pin);
    expect(unlockedEncryptionKey(USER)).toBeNull();
  });

  it('binds a pending approval to its original pin across identity changes', async () => {
    const srv = server();
    const { laptop, account, recovery } = await setUp(srv);
    const phone = device(srv);
    const fresh = ready(await loadEncryption(phone));
    const request = await requestApproval(phone, fresh, 'Phone');
    if (request.step !== 'waiting')
      throw new Error('Expected a waiting approval');
    ready(await loadEncryption(laptop));
    await approveDevice(
      laptop,
      account,
      request.approval,
      { kind: 'scan', code: request.scanCode },
      recovery.secret
    );
    const before = ready(await loadEncryption(laptop));
    const delayed = deferredPinWrite(phone.store);
    const approving = advanceApprovalAsNewDevice({
      ...phone,
      store: delayed.store
    });
    await delayed.started;
    const newer = ready(
      await replaceRecoveryKey(
        laptop,
        before,
        (await generateRecoveryKey()).secret,
        recovery.secret
      )
    );
    await phone.store.savePin(USER, newer.list, {
      replaceIdentityFrom: fresh.persistedPin
    });
    delayed.resume();
    await expect(approving).rejects.toHaveProperty(
      'name',
      'DeviceListPinConflict'
    );
    expect(await phone.store.loadPin(USER)).toEqual(newer.list.pin);
    expect((await phone.store.loadDevice(USER))?.approval).not.toBeNull();
    expect(unlockedEncryptionKey(USER)).toBeNull();
  });

  async function replacedUnderPhone() {
    const srv = server();
    const { laptop, recovery } = await setUp(srv);
    const phone = await enrolled(srv, recovery.secret, 'Phone');
    const next = await generateRecoveryKey();
    const newer = ready(
      await replaceRecoveryKey(
        laptop,
        ready(await loadEncryption(laptop)),
        next.secret,
        recovery.secret
      )
    );
    const stale = await loadEncryption(phone.ctx);
    if (stale.kind !== 'identity-changed')
      throw new Error('Expected an identity change');
    const oldPin = await phone.ctx.store.loadPin(USER);
    return { laptop, phone, next, newer, stale, oldPin };
  }

  // The scan form authenticates only the phone to the approver: the approver
  // key would come from the unpinned list itself, which a server could
  // fabricate along with a new identity, so it cannot replace the identity
  // this browser pinned.
  async function refusedScan(
    setup: Awaited<ReturnType<typeof replacedUnderPhone>>,
    recoverySecret: Uint8Array | null
  ) {
    const { laptop, phone, newer, stale, oldPin } = setup;
    const request = await requestApproval(
      phone.ctx,
      stale.account,
      'Phone again'
    );
    if (request.step !== 'waiting')
      throw new Error('Expected a waiting approval');
    ready(await loadEncryption(laptop));
    await approveDevice(
      laptop,
      newer,
      request.approval,
      { kind: 'scan', code: request.scanCode },
      recoverySecret
    );
    lockAccount(USER);
    await flowRefusal(advanceApprovalAsNewDevice(phone.ctx), 'grant-invalid');
    expect(await phone.ctx.store.loadPin(USER)).toEqual(oldPin);
    expect((await phone.ctx.store.loadDevice(USER))?.approval).toBeNull();
    expect(unlockedEncryptionKey(USER)).toBeNull();
    const after = await loadEncryption(phone.ctx);
    expect(after.kind).toBe('identity-changed');
    return after;
  }

  it('re-approves a replaced identity by comparing codes, not by a scan', async () => {
    const setup = await replacedUnderPhone();
    const { laptop, phone, newer } = setup;
    const after = await refusedScan(setup, null);
    if (after.kind !== 'identity-changed') throw new Error('unreachable');
    // The six digits authenticate the approver, so the compare form may.
    const request = await requestApproval(
      phone.ctx,
      after.account,
      'Phone again'
    );
    if (request.step !== 'waiting')
      throw new Error('Expected a waiting approval');
    const approver = ready(await loadEncryption(laptop));
    await beginCompareApproval(laptop, approver, request.approval.id);
    const shown = await advanceApprovalAsNewDevice(phone.ctx);
    if (shown.step !== 'compare') throw new Error(`got ${shown.step}`);
    const revealed = await laptop.api.getApproval(request.approval.id);
    expect(await approverComparisonCode(laptop, approver, revealed)).toBe(
      shown.code
    );
    await approveDevice(laptop, approver, revealed, { kind: 'compare' }, null);
    lockAccount(USER);
    const completed = await confirmApprovalCode(phone.ctx);
    if (completed.step !== 'done')
      throw new Error('Expected a completed approval');
    expect(ready(completed.state).unlocked).toBe(true);
    expect(ready(completed.state).fingerprint).toBe(newer.fingerprint);
  });

  it('recovers with the new recovery key after a refused certifying scan', async () => {
    const setup = await replacedUnderPhone();
    const after = await refusedScan(setup, setup.next.secret);
    if (after.kind !== 'identity-changed') throw new Error('unreachable');
    const recovered = ready(
      await enrollWithRecoveryKey(
        setup.phone.ctx,
        after.account,
        setup.next.secret,
        'Phone again'
      )
    );
    expect(recovered.deviceStatus).toBe('certified');
    expect(recovered.unlocked).toBe(true);
    expect(recovered.fingerprint).toBe(setup.newer.fingerprint);
  });

  it('recovers a certified browser when replacement committed but its pin snapshot was stale', async () => {
    const srv = server();
    const { laptop, account, recovery } = await setUp(srv);
    await enrolled(srv, recovery.secret, 'Phone');
    const advanced = ready(await loadEncryption(laptop));
    const next = await generateRecoveryKey();
    await expect(
      replaceRecoveryKey(laptop, account, next.secret, recovery.secret)
    ).rejects.toHaveProperty('name', 'DeviceListPinConflict');
    expect(await laptop.store.loadPin(USER)).toEqual(advanced.list.pin);
    const state = await loadEncryption(laptop);
    if (state.kind !== 'identity-changed')
      throw new Error('Expected changed identity');
    expect(state.account.deviceStatus).toBe('certified');
    await flowRefusal(
      enrollWithRecoveryKey(laptop, state.account, recovery.secret, 'Laptop'),
      'wrong-recovery-key'
    );
    expect(await laptop.store.loadPin(USER)).toEqual(advanced.list.pin);
    const trusted = ready(
      await enrollWithRecoveryKey(laptop, state.account, next.secret, 'Laptop')
    );
    expect(trusted.unlocked).toBe(true);
    expect(trusted.device?.deviceId).toBe(account.device?.deviceId);
    expect(trusted.list.devices).toHaveLength(1);
    expect(trusted.list.head.sequence).toBe(0);
    expect(await laptop.store.loadPin(USER)).toEqual(trusted.list.pin);
  });
});
