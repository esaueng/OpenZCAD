import { beforeEach, describe, expect, it, vi } from 'vitest';
import { admitDevelopmentE2eeWrite } from '../apps/web/worker/e2eeWriteAuthorization';
import type { DatabaseSync } from 'node:sqlite';
import {
  accountKeyCommitment,
  accountKeySequence,
  exportPrivateKey,
  publicKeyHash,
  toHex,
  wrapKey,
  decodeDeviceApprovalGrant,
  decodeDeviceListEntry,
  exportPublicKey,
  fromBase64Url,
  generateEncryptionKeyPair,
  generateRecoveryKey,
  generateSigningKeyPair,
  generateSymmetricKey,
  isExternalAgreementKey,
  isExternalSigningKey,
  nextDeviceListEntry,
  sealKey,
  signDeviceListEntry,
  signDeviceApprovalGrant,
  toBase64Url,
  unwrapKey,
  verifyDeviceList
} from '@openzcad/crypto';
import {
  APPROVAL_TTL_MS,
  MAX_APPROVALS_PER_HOUR,
  handleE2eeRequest
} from '../apps/web/worker/e2ee';
import {
  advanceApprovalAsNewDevice,
  addPasskey,
  enrollWithPasskey,
  removePasskey,
  approveDevice,
  confirmApprovalCode,
  cancelApprovalRequest,
  approverComparisonCode,
  beginCompareApproval,
  deviceScanCode,
  enrollWithRecoveryKey,
  EncryptionFlowError,
  forgetThisDevice,
  loadEncryption,
  lockAccount,
  openAccountKeyChain,
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
  lockAccountsExcept,
  unlockedAccount
} from '../apps/web/src/lib/e2ee/unlockedKeys';
import {
  PasskeyError,
  browserPasskeys,
  passkeyEnrollmentCleanup,
  type PasskeyPrf,
  type PasskeySecret
} from '../apps/web/src/lib/e2ee/passkeys';
import {
  memoryDeviceStore,
  type DeviceKeyStore
} from '../apps/web/src/lib/e2ee/deviceStore';
import type { E2eeSetupRequest } from '@openzcad/shared';
import { d1Database, migratedDatabase } from './d1-sqlite';
import { eraseAccountWithKeyCleanup } from '../apps/web/src/lib/e2ee/accountErasure';
import { signOutAfterSaving } from '../apps/web/src/lib/e2ee/signOut';
import {
  createKeychainDeviceKeys,
  keychainDeviceStore,
  type KeychainHost
} from '../apps/web/src/lib/e2ee/keychainDeviceKeys';
import * as deviceStores from '../apps/web/src/lib/e2ee/deviceStore';
import * as mlsStores from '../apps/web/src/lib/e2ee/mls/sessionStore';
import {
  allowKeySession,
  confirmKeySessionEnded,
  getKeySessionRevision
} from '../apps/web/src/lib/e2ee/keySession';

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
  it('preserves a newer unlock when an old view finishes crypto after teardown', async () => {
    const srv = server();
    const { laptop } = await setUp(srv);
    lockAccount(USER);
    let entered!: () => void, release!: () => void;
    const waiting = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const decrypt = crypto.subtle.decrypt.bind(crypto.subtle);
    let first = true,
      active = true;
    vi.spyOn(crypto.subtle, 'decrypt').mockImplementation(async (...args) => {
      const value = await decrypt(...args);
      if (first) {
        first = false;
        entered();
        await held;
      }
      return value;
    });
    try {
      const old = loadEncryption({ ...laptop, isCurrent: () => active });
      await waiting;
      active = false;
      lockAccountsExcept(null);
      expect(ready(await loadEncryption(laptop)).unlocked).toBe(true);
      const fresh = unlockedAccount(USER)!;
      release();
      await expect(old).rejects.toThrow('session');
      expect(unlockedAccount(USER)).toBe(fresh);
      expect(fresh.accountKey.some((byte) => byte !== 0)).toBe(true);
    } finally {
      release();
      vi.restoreAllMocks();
      lockAccount(USER);
    }
  });

  it('refuses an already-unmounted context before making its account request', async () => {
    const srv = server();
    let requests = 0;
    const ctx = device(srv);
    await expect(
      loadEncryption({
        ...ctx,
        isCurrent: () => false,
        api: {
          ...ctx.api,
          account: async () => {
            requests++;
            return { current: null, previous: [] };
          }
        }
      })
    ).rejects.toThrow('session');
    expect(requests).toBe(0);
  });
  it.each(['account response', 'pin read', 'device read', 'crypto'] as const)(
    'does not resurrect raw keys after teardown during %s',
    async (phase) => {
      const srv = server();
      const { laptop } = await setUp(srv);
      lockAccount(USER);
      let entered!: () => void, release!: () => void;
      const waiting = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const pause = async <T>(value: T) => {
        entered();
        await held;
        return value;
      };
      const ctx: E2eeContext = {
        ...laptop,
        api: {
          ...laptop.api,
          account: async () => {
            const value = await laptop.api.account();
            return phase === 'account response' ? pause(value) : value;
          }
        },
        store: {
          ...laptop.store,
          loadPin: async (id) => {
            const value = await laptop.store.loadPin(id);
            return phase === 'pin read' ? pause(value) : value;
          },
          loadDevice: async (id) => {
            const value = await laptop.store.loadDevice(id);
            return phase === 'device read' ? pause(value) : value;
          }
        }
      };
      if (phase === 'crypto') {
        const decrypt = crypto.subtle.decrypt.bind(crypto.subtle);
        let first = true;
        vi.spyOn(crypto.subtle, 'decrypt').mockImplementation(
          async (...args) => {
            const value = await decrypt(...args);
            if (!first) return value;
            first = false;
            return pause(value);
          }
        );
      }
      try {
        const loading = loadEncryption(ctx);
        await waiting;
        // No raw cache entry exists yet; pending loads must still be fenced.
        lockAccountsExcept(null);
        release();
        await expect(loading).rejects.toThrow('session');
        expect(unlockedEncryptionKey(USER)).toBeNull();
      } finally {
        release();
        vi.restoreAllMocks();
        lockAccount(USER);
      }
    }
  );
  it('refuses a missing pinned account and keeps its pin and private keys', async () => {
    const srv = server();
    const { laptop } = await setUp(srv);
    const pin = await laptop.store.loadPin(USER);
    const keys = await laptop.store.loadDevice(USER);
    srv.tamper = (path, body) =>
      path === '/api/e2ee/account' ? { current: null, previous: [] } : body;
    expect(await loadEncryption(laptop)).toMatchObject({ kind: 'fork' });
    expect(unlockedEncryptionKey(USER)).toBeNull();
    expect(await laptop.store.loadPin(USER)).toEqual(pin);
    expect(await laptop.store.loadDevice(USER)).toEqual(keys);
    expect(await loadEncryption(device(srv))).toEqual({
      kind: 'not-set-up',
      previous: []
    });
    let requested = false;
    const guarded = {
      ...laptop,
      api: {
        ...laptop.api,
        setup: async () => {
          requested = true;
          throw new Error('Unexpected replacement');
        }
      }
    };
    await flowRefusal(
      setUpEncryption(guarded, {
        recoverySecret: (await generateRecoveryKey()).secret,
        label: 'Laptop'
      }),
      'invalid-request'
    );
    expect(requested).toBe(false);
    expect(await laptop.store.loadPin(USER)).toEqual(pin);
  });

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
    expect(await api.config()).toEqual({
      enabled: false,
      projectsEnabled: false
    });
    const closed = await refusal(api.account());
    expect([closed.status, closed.code]).toEqual([501, 'FEATURE_DISABLED']);

    const bare = migratedDatabase();
    bare.exec(
      'DROP TABLE e2ee_account_key_history; DROP TABLE e2ee_device_approvals; DROP TABLE e2ee_key_wraps; DROP TABLE e2ee_device_list_entries; DROP TABLE e2ee_identities'
    );
    const unmigrated = { db: bare, enabled: true };
    const unmigratedApi = createE2eeApi(fetcherFor(unmigrated, USER));
    expect(await unmigratedApi.config()).toEqual({
      enabled: false,
      projectsEnabled: false
    });
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
    expect(
      (stored?.signing.privateKey as CryptoKey | undefined)?.extractable
    ).toBe(false);
    expect(
      (stored?.unlock.privateKey as CryptoKey | undefined)?.extractable
    ).toBe(false);
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

/** `deviceId` of USER holds a leaf in 'proj_staged''s MLS group. */
function joinStagedGroup(srv: Server, deviceId: string) {
  srv.db
    .prepare(
      `INSERT INTO e2ee_project_leaves (project_id, user_id, device_id,
         leaf_key, certification, created_at)
       VALUES ('proj_staged', ?, ?, ?, ?, '2026-10-25T00:00:00.000Z')`
    )
    .run(USER, deviceId, deviceId.padEnd(87, 'k').slice(0, 87), 'c'.repeat(98));
}

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
    // This device takes over from the removed one.
    expect(after.list.head.revoked).toEqual([
      {
        kind: 'device',
        id: phone.account.device!.deviceId,
        replacedBy: before.device!.deviceId
      }
    ]);
    expect(after.list.revoked.at(-1)?.replacedBy).toBe(before.device!.deviceId);
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

  /**
   * A plaintext project staged for encryption (slice 7-1) by `deviceId`:
   * still format 1, so no revocation cutoff names it. `stageInfo` has that
   * device sign its staged project info, which the cutover turns into the
   * encrypted project's.
   */
  function stagedProject(srv: Server, deviceId: string) {
    const now = '2026-10-25T00:00:00.000Z';
    srv.db
      .prepare(
        `INSERT INTO projects (id, user_id, name, document_json,
           document_version, updated_at, storage_format)
         VALUES ('proj_staged', ?, '', '{}', 1, ?, 1)`
      )
      .run(USER, now);
    srv.db
      .prepare(
        `INSERT INTO e2ee_project_migrations (project_id, direction, state,
           owner_user_id, device_id, lease_id, lease_expires_at,
           source_version, started_at, updated_at)
         VALUES ('proj_staged', 'encrypt', 'staging', ?, ?, ?, ?, 1, ?, ?)`
      )
      .run(USER, deviceId, 'l'.repeat(43), Date.now() + 60_000, now, now);
    return {
      stageInfo: () =>
        srv.db
          .prepare(
            `INSERT INTO e2ee_project_envelopes (project_id, kind, scope,
               sequence, key_epoch, envelope, wrapped_version_key, signature,
               signer_device_id, updated_at)
             VALUES ('proj_staged', 'project-info', '', 1, 0, 'e', ?, ?, ?, ?)`
          )
          .run('w'.repeat(55), 's'.repeat(98), deviceId, now),
      // `joiner` joins the staged MLS group: a leaf, and nothing signed.
      join: (joiner: string) => joinStagedGroup(srv, joiner),
      setState: (state: string, storageFormat: 1 | 2) => {
        srv.db
          .prepare(
            `UPDATE e2ee_project_migrations
             SET state = ?, lease_id = NULL, lease_expires_at = NULL
             WHERE project_id = 'proj_staged'`
          )
          .run(state);
        srv.db
          .prepare(
            `UPDATE projects SET storage_format = ? WHERE id = 'proj_staged'`
          )
          .run(storageFormat);
      }
    };
  }

  it('waits while the device signed a project staged for encryption (#914 review)', async () => {
    const srv = server();
    const { recovery, laptop } = await setUp(srv);
    const phone = await enrolled(srv, recovery.secret, 'Phone');
    const tablet = await enrolled(srv, recovery.secret, 'Tablet');
    const phoneId = phone.account.device!.deviceId;
    const staging = stagedProject(srv, phoneId);
    const entries = () =>
      count(srv.db, 'SELECT COUNT(*) AS n FROM e2ee_device_list_entries');
    const remove = async (deviceId: string) =>
      removeDevice(
        laptop,
        ready(await loadEncryption(laptop)),
        deviceId,
        recovery.secret
      );
    const before = entries();
    // The phone stages the info between the check and the append's batch:
    // the batch's fence refuses it.
    srv.beforeWrite = async (sql) => {
      if (!sql.includes('INSERT INTO e2ee_device_list_entries')) return;
      srv.beforeWrite = undefined;
      staging.stageInfo();
    };
    expect((await refusal(remove(phoneId))).code).toBe(
      'E2EE_DEVICE_SIGNED_PROJECTS'
    );
    expect(srv.beforeWrite).toBeUndefined();
    expect(entries()).toBe(before);
    // Staged before the request: the check refuses it.
    expect((await refusal(remove(phoneId))).code).toBe(
      'E2EE_DEVICE_SIGNED_PROJECTS'
    );
    expect(entries()).toBe(before);
    // A device that signed nothing staged is removed as before.
    ready(await remove(tablet.account.device!.deviceId));
    expect(entries()).toBe(before + 1);
    // An abandoned staging is never cut over: its leftovers hold nothing up.
    staging.setState('abandoned', 1);
    ready(await remove(phoneId));
    expect(entries()).toBe(before + 2);
  });

  it('waits while the device joined the group of a project staged for encryption (#914 review)', async () => {
    const srv = server();
    const { recovery, laptop, account } = await setUp(srv);
    const phone = await enrolled(srv, recovery.secret, 'Phone');
    const tablet = await enrolled(srv, recovery.secret, 'Tablet');
    const phoneId = phone.account.device!.deviceId;
    // The laptop stages and signs; the phone only joins the staged group.
    const staging = stagedProject(srv, account.device!.deviceId);
    staging.stageInfo();
    const entries = () =>
      count(srv.db, 'SELECT COUNT(*) AS n FROM e2ee_device_list_entries');
    const remove = async (deviceId: string) =>
      removeDevice(
        laptop,
        ready(await loadEncryption(laptop)),
        deviceId,
        recovery.secret
      );
    const before = entries();
    // The phone joins between the check and the append's batch: the
    // batch's fence refuses it.
    srv.beforeWrite = async (sql) => {
      if (!sql.includes('INSERT INTO e2ee_device_list_entries')) return;
      srv.beforeWrite = undefined;
      staging.join(phoneId);
    };
    expect((await refusal(remove(phoneId))).code).toBe(
      'E2EE_DEVICE_SIGNED_PROJECTS'
    );
    expect(srv.beforeWrite).toBeUndefined();
    expect(entries()).toBe(before);
    // Joined before the request: the check refuses it.
    expect((await refusal(remove(phoneId))).code).toBe(
      'E2EE_DEVICE_SIGNED_PROJECTS'
    );
    expect(entries()).toBe(before);
    // A device with no staged leaf is removed as before.
    ready(await remove(tablet.account.device!.deviceId));
    expect(entries()).toBe(before + 1);
    // Once abandoned, the staged group never becomes the project's.
    staging.setState('abandoned', 1);
    ready(await remove(phoneId));
    expect(entries()).toBe(before + 2);
  });

  it('waits while the device was re-added to another owner’s project staged for encryption (slice 7-4)', async () => {
    const srv = server();
    const { recovery, laptop } = await setUp(srv);
    const phone = await enrolled(srv, recovery.secret, 'Phone');
    const phoneId = phone.account.device!.deviceId;
    // Bob's plaintext project, shared with USER, staged for encryption by
    // Bob's laptop; Bob re-added USER's phone there (slice 7-4's Add).
    const now = '2026-10-25T00:00:00.000Z';
    srv.db
      .prepare('INSERT INTO users (id, email, created_at) VALUES (?, ?, ?)')
      .run('user_bob', 'bob@example.com', now);
    srv.db
      .prepare(
        `INSERT INTO projects (id, user_id, name, document_json,
           document_version, updated_at, storage_format)
         VALUES ('proj_bobs', 'user_bob', '', '{}', 1, ?, 1)`
      )
      .run(now);
    srv.db
      .prepare(
        `INSERT INTO project_members
           (project_id, user_id, role, added_by_user_id, created_at, updated_at)
         VALUES ('proj_bobs', ?, 'editor', 'user_bob', 1, 1)`
      )
      .run(USER);
    srv.db
      .prepare(
        `INSERT INTO e2ee_project_migrations (project_id, direction, state,
           owner_user_id, device_id, lease_id, lease_expires_at,
           source_version, started_at, updated_at)
         VALUES ('proj_bobs', 'encrypt', 'staging', 'user_bob', 'bob_laptop',
                 ?, ?, 1, ?, ?)`
      )
      .run('l'.repeat(43), Date.now() + 60_000, now, now);
    const readd = () =>
      srv.db
        .prepare(
          `INSERT INTO e2ee_project_leaves (project_id, user_id, device_id,
             leaf_key, certification, created_at)
           VALUES ('proj_bobs', ?, ?, ?, ?, ?)`
        )
        .run(
          USER,
          phoneId,
          phoneId.padEnd(87, 'k').slice(0, 87),
          'c'.repeat(98),
          now
        );
    const entries = () =>
      count(srv.db, 'SELECT COUNT(*) AS n FROM e2ee_device_list_entries');
    const remove = async () =>
      removeDevice(
        laptop,
        ready(await loadEncryption(laptop)),
        phoneId,
        recovery.secret
      );
    const before = entries();
    // Re-added between the check and the append's batch: its fence refuses.
    srv.beforeWrite = async (sql) => {
      if (!sql.includes('INSERT INTO e2ee_device_list_entries')) return;
      srv.beforeWrite = undefined;
      readd();
    };
    expect((await refusal(remove())).code).toBe('E2EE_DEVICE_SIGNED_PROJECTS');
    expect(srv.beforeWrite).toBeUndefined();
    expect(entries()).toBe(before);
    // Re-added before the request: the check refuses it.
    expect((await refusal(remove())).code).toBe('E2EE_DEVICE_SIGNED_PROJECTS');
    expect(entries()).toBe(before);
    // Once Bob abandons, the staged group never becomes the project's.
    srv.db
      .prepare(
        `UPDATE e2ee_project_migrations
         SET state = 'abandoned', lease_id = NULL, lease_expires_at = NULL
         WHERE project_id = 'proj_bobs'`
      )
      .run();
    ready(await remove());
    expect(entries()).toBe(before + 1);
  });

  it('signs cutoffs again when a staging cuts over during the removal (#914 review)', async () => {
    const srv = server();
    const { recovery, laptop } = await setUp(srv);
    const phone = await enrolled(srv, recovery.secret, 'Phone');
    const phoneId = phone.account.device!.deviceId;
    const staging = stagedProject(srv, phoneId);
    const entries = () =>
      count(srv.db, 'SELECT COUNT(*) AS n FROM e2ee_device_list_entries');
    const before = entries();
    // Checked with nothing staged and no encrypted project to name; then,
    // before the append's batch, the phone stages its info and the cutover
    // makes the project encrypted. No cutoff names it: nothing lands.
    srv.beforeWrite = async (sql) => {
      if (!sql.includes('INSERT INTO e2ee_device_list_entries')) return;
      srv.beforeWrite = undefined;
      staging.stageInfo();
      staging.setState('cutover', 2);
    };
    const refused = await refusal(
      removeDevice(
        laptop,
        ready(await loadEncryption(laptop)),
        phoneId,
        recovery.secret
      )
    );
    expect(srv.beforeWrite).toBeUndefined();
    expect(refused.code).toBe('E2EE_CUTOFFS_INCOMPLETE');
    expect(entries()).toBe(before);
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
  it('keeps a device that signed encrypted projects out of a replacement that drops it', async () => {
    const srv = server();
    const { laptop, recovery } = await setUp(srv);
    const phone = await enrolled(srv, recovery.secret, 'Phone');
    // An encrypted project whose project info the phone signed.
    const now = '2026-10-25T00:00:00.000Z';
    srv.db
      .prepare(
        `INSERT INTO projects (id, user_id, name, document_json,
           document_version, updated_at, storage_format)
         VALUES ('proj_signed', ?, '', '{}', 1, ?, 2)`
      )
      .run(USER, now);
    srv.db
      .prepare(
        `INSERT INTO e2ee_project_envelopes (project_id, kind, scope, sequence,
           key_epoch, envelope, wrapped_version_key, signature,
           signer_device_id, updated_at)
         VALUES ('proj_signed', 'project-info', '', 1, 0, 'e', ?, ?, ?, ?)`
      )
      .run('w'.repeat(55), 's'.repeat(98), phone.account.device!.deviceId, now);
    // The replacement's genesis lists only the laptop: the phone's
    // signature would no longer resolve.
    const refused = await refusal(
      replaceRecoveryKey(
        laptop,
        ready(await loadEncryption(laptop)),
        (await generateRecoveryKey()).secret,
        recovery.secret
      )
    );
    expect(refused.code).toBe('E2EE_DEVICE_SIGNED_PROJECTS');
    expect(
      srv.db
        .prepare(
          'SELECT MAX(generation) AS generation FROM e2ee_identities WHERE user_id = ?'
        )
        .get(USER)
    ).toMatchObject({ generation: 1 });
  });

  it('keeps a device that signed a project staged for encryption out of a replacement (#914 review)', async () => {
    const srv = server();
    const { laptop, recovery } = await setUp(srv);
    const phone = await enrolled(srv, recovery.secret, 'Phone');
    const phoneId = phone.account.device!.deviceId;
    // A plaintext project staged for encryption (slice 7-1): still format
    // 1, but the phone signed its staged project info, which the cutover
    // turns into the encrypted project's.
    const now = '2026-10-25T00:00:00.000Z';
    srv.db
      .prepare(
        `INSERT INTO projects (id, user_id, name, document_json,
           document_version, updated_at, storage_format)
         VALUES ('proj_staged', ?, '', '{}', 1, ?, 1)`
      )
      .run(USER, now);
    srv.db
      .prepare(
        `INSERT INTO e2ee_project_migrations (project_id, direction, state,
           owner_user_id, device_id, lease_id, lease_expires_at,
           source_version, started_at, updated_at)
         VALUES ('proj_staged', 'encrypt', 'staging', ?, ?, ?, ?, 1, ?, ?)`
      )
      .run(USER, phoneId, 'l'.repeat(43), Date.now() + 60_000, now, now);
    srv.db
      .prepare(
        `INSERT INTO e2ee_project_envelopes (project_id, kind, scope, sequence,
           key_epoch, envelope, wrapped_version_key, signature,
           signer_device_id, updated_at)
         VALUES ('proj_staged', 'project-info', '', 1, 0, 'e', ?, ?, ?, ?)`
      )
      .run('w'.repeat(55), 's'.repeat(98), phoneId, now);
    const replace = async () =>
      replaceRecoveryKey(
        laptop,
        ready(await loadEncryption(laptop)),
        (await generateRecoveryKey()).secret,
        recovery.secret
      );
    const generation = () =>
      srv.db
        .prepare(
          'SELECT MAX(generation) AS generation FROM e2ee_identities WHERE user_id = ?'
        )
        .get(USER);
    expect((await refusal(replace())).code).toBe('E2EE_DEVICE_SIGNED_PROJECTS');
    expect(generation()).toMatchObject({ generation: 1 });
    // An abandoned staging is never cut over: its leftovers hold nothing up.
    srv.db
      .prepare(
        `UPDATE e2ee_project_migrations
         SET state = 'abandoned', lease_id = NULL, lease_expires_at = NULL
         WHERE project_id = 'proj_staged'`
      )
      .run();
    ready(await replace());
    expect(generation()).toMatchObject({ generation: 2 });
  });

  it('keeps a device that joined the group of a project staged for encryption out of a replacement (#914 review)', async () => {
    const srv = server();
    const { laptop, recovery, account } = await setUp(srv);
    const phone = await enrolled(srv, recovery.secret, 'Phone');
    const phoneId = phone.account.device!.deviceId;
    // The laptop stages and signs; the phone only joins the staged group,
    // so it holds the key the cutover exposes ciphertext under.
    const now = '2026-10-25T00:00:00.000Z';
    srv.db
      .prepare(
        `INSERT INTO projects (id, user_id, name, document_json,
           document_version, updated_at, storage_format)
         VALUES ('proj_staged', ?, '', '{}', 1, ?, 1)`
      )
      .run(USER, now);
    srv.db
      .prepare(
        `INSERT INTO e2ee_project_migrations (project_id, direction, state,
           owner_user_id, device_id, lease_id, lease_expires_at,
           source_version, started_at, updated_at)
         VALUES ('proj_staged', 'encrypt', 'staging', ?, ?, ?, ?, 1, ?, ?)`
      )
      .run(
        USER,
        account.device!.deviceId,
        'l'.repeat(43),
        Date.now() + 60_000,
        now,
        now
      );
    const replace = async () =>
      replaceRecoveryKey(
        laptop,
        ready(await loadEncryption(laptop)),
        (await generateRecoveryKey()).secret,
        recovery.secret
      );
    const generation = () =>
      srv.db
        .prepare(
          'SELECT MAX(generation) AS generation FROM e2ee_identities WHERE user_id = ?'
        )
        .get(USER);
    // The phone joins between the check and the identity write: the
    // write's fence refuses it.
    srv.beforeWrite = async (sql) => {
      if (!sql.includes('INSERT INTO e2ee_identities')) return;
      srv.beforeWrite = undefined;
      joinStagedGroup(srv, phoneId);
    };
    expect((await refusal(replace())).code).toBe('E2EE_DEVICE_SIGNED_PROJECTS');
    expect(srv.beforeWrite).toBeUndefined();
    expect(generation()).toMatchObject({ generation: 1 });
    // Joined before the request: the check refuses it.
    expect((await refusal(replace())).code).toBe('E2EE_DEVICE_SIGNED_PROJECTS');
    expect(generation()).toMatchObject({ generation: 1 });
    // Once abandoned, the staged group never becomes the project's.
    srv.db
      .prepare(
        `UPDATE e2ee_project_migrations
         SET state = 'abandoned', lease_id = NULL, lease_expires_at = NULL
         WHERE project_id = 'proj_staged'`
      )
      .run();
    ready(await replace());
    expect(generation()).toMatchObject({ generation: 2 });
  });

  it('keeps a device re-added to another owner’s staged project out of a replacement (slice 7-4)', async () => {
    const srv = server();
    const { laptop, recovery } = await setUp(srv);
    const phone = await enrolled(srv, recovery.secret, 'Phone');
    const phoneId = phone.account.device!.deviceId;
    const now = '2026-10-25T00:00:00.000Z';
    srv.db
      .prepare('INSERT INTO users (id, email, created_at) VALUES (?, ?, ?)')
      .run('user_bob', 'bob@example.com', now);
    srv.db
      .prepare(
        `INSERT INTO projects (id, user_id, name, document_json,
           document_version, updated_at, storage_format)
         VALUES ('proj_bobs', 'user_bob', '', '{}', 1, ?, 1)`
      )
      .run(now);
    srv.db
      .prepare(
        `INSERT INTO e2ee_project_migrations (project_id, direction, state,
           owner_user_id, device_id, lease_id, lease_expires_at,
           source_version, started_at, updated_at)
         VALUES ('proj_bobs', 'encrypt', 'staging', 'user_bob', 'bob_laptop',
                 ?, ?, 1, ?, ?)`
      )
      .run('l'.repeat(43), Date.now() + 60_000, now, now);
    srv.db
      .prepare(
        `INSERT INTO e2ee_project_leaves (project_id, user_id, device_id,
           leaf_key, certification, created_at)
         VALUES ('proj_bobs', ?, ?, ?, ?, ?)`
      )
      .run(
        USER,
        phoneId,
        phoneId.padEnd(87, 'k').slice(0, 87),
        'c'.repeat(98),
        now
      );
    const replace = async () =>
      replaceRecoveryKey(
        laptop,
        ready(await loadEncryption(laptop)),
        (await generateRecoveryKey()).secret,
        recovery.secret
      );
    const generation = () =>
      srv.db
        .prepare(
          'SELECT MAX(generation) AS generation FROM e2ee_identities WHERE user_id = ?'
        )
        .get(USER);
    expect((await refusal(replace())).code).toBe('E2EE_DEVICE_SIGNED_PROJECTS');
    expect(generation()).toMatchObject({ generation: 1 });
    srv.db
      .prepare(
        `UPDATE e2ee_project_migrations
         SET state = 'abandoned', lease_id = NULL, lease_expires_at = NULL
         WHERE project_id = 'proj_bobs'`
      )
      .run();
    ready(await replace());
    expect(generation()).toMatchObject({ generation: 2 });
  });

  it('keeps a removed device that signed encrypted projects out of a replacement too (#894 review)', async () => {
    const srv = server();
    const { laptop, recovery } = await setUp(srv);
    const phone = await enrolled(srv, recovery.secret, 'Phone');
    const phoneId = phone.account.device!.deviceId;
    const now = '2026-10-25T00:00:00.000Z';
    srv.db
      .prepare(
        `INSERT INTO projects (id, user_id, name, document_json,
           document_version, updated_at, storage_format)
         VALUES ('proj_signed', ?, '', '{}', 1, ?, 2)`
      )
      .run(USER, now);
    srv.db
      .prepare(
        `INSERT INTO e2ee_project_envelopes (project_id, kind, scope, sequence,
           key_epoch, envelope, wrapped_version_key, signature,
           signer_device_id, updated_at)
         VALUES ('proj_signed', 'project-info', '', 1, 0, 'e', ?, ?, ?, ?)`
      )
      .run('w'.repeat(55), 's'.repeat(98), phoneId, now);
    // The phone is removed first: its cutoffs name this generation's list.
    ready(
      await removeDevice(
        laptop,
        ready(await loadEncryption(laptop)),
        phoneId,
        recovery.secret
      )
    );
    // A replacement would carry neither that list nor the phone.
    const refused = await refusal(
      replaceRecoveryKey(
        laptop,
        ready(await loadEncryption(laptop)),
        (await generateRecoveryKey()).secret,
        recovery.secret
      )
    );
    expect(refused.code).toBe('E2EE_DEVICE_SIGNED_PROJECTS');
  });

  it('keeps a removed device that signed a key archive out of a replacement (#894 review)', async () => {
    const srv = server();
    const { laptop, recovery } = await setUp(srv);
    const phone = await enrolled(srv, recovery.secret, 'Phone');
    const phoneId = phone.account.device!.deviceId;
    const now = '2026-10-25T00:00:00.000Z';
    srv.db
      .prepare(
        `INSERT INTO projects (id, user_id, name, document_json,
           document_version, updated_at, storage_format)
         VALUES ('proj_archived', ?, '', '{}', 1, ?, 2)`
      )
      .run(USER, now);
    // The phone signed only a key archive: no version, no envelope.
    srv.db
      .prepare(
        `INSERT INTO e2ee_key_archives (project_id, key_epoch, envelope,
           wrapped_version_key, signature, signer_device_id, created_at)
         VALUES ('proj_archived', 1, 'e', ?, ?, ?, ?)`
      )
      .run('w'.repeat(55), 's'.repeat(98), phoneId, now);
    ready(
      await removeDevice(
        laptop,
        ready(await loadEncryption(laptop)),
        phoneId,
        recovery.secret
      )
    );
    const refused = await refusal(
      replaceRecoveryKey(
        laptop,
        ready(await loadEncryption(laptop)),
        (await generateRecoveryKey()).secret,
        recovery.secret
      )
    );
    expect(refused.code).toBe('E2EE_DEVICE_SIGNED_PROJECTS');
  });

  it('bounds retained generations and cascades old entries without touching another account', async () => {
    const srv = server();
    const { laptop, recovery } = await setUp(srv);
    await enrolled(srv, recovery.secret, 'Phone');
    srv.db
      .prepare('INSERT INTO users (id, email, created_at) VALUES (?, NULL, ?)')
      .run('user_other', new Date().toISOString());
    srv.db
      .prepare(
        `INSERT INTO e2ee_identities SELECT 'user_other', generation, identity_key, transition_statement, transition_signature, created_at FROM e2ee_identities WHERE user_id = ?`
      )
      .run(USER);
    srv.db
      .prepare(
        `INSERT INTO e2ee_device_list_entries SELECT 'user_other', generation, sequence, entry, signature, entry_hash, created_at FROM e2ee_device_list_entries WHERE user_id = ?`
      )
      .run(USER);
    let account = ready(await loadEncryption(laptop));
    for (let generation = 2; generation <= 8; generation++) {
      account = ready(
        await replaceRecoveryKey(
          laptop,
          account,
          (await generateRecoveryKey()).secret,
          null
        )
      );
      expect(account.generation).toBe(generation);
      expect(account.previous.map((previous) => previous.generation)).toEqual(
        Array.from(
          { length: Math.min(3, generation - 1) },
          (_, index) => generation - index - 1
        )
      );
      expect(account.unlocked).toBe(true);
      expect(
        count(
          srv.db,
          'SELECT COUNT(*) AS n FROM e2ee_identities WHERE user_id = ?',
          USER
        )
      ).toBeLessThanOrEqual(4);
    }
    expect(
      srv.db
        .prepare(
          'SELECT generation FROM e2ee_identities WHERE user_id = ? ORDER BY generation'
        )
        .all(USER)
    ).toEqual([5, 6, 7, 8].map((generation) => ({ generation })));
    expect(
      count(
        srv.db,
        'SELECT COUNT(*) AS n FROM e2ee_device_list_entries WHERE user_id = ? AND generation < 5',
        USER
      )
    ).toBe(0);
    expect(
      count(
        srv.db,
        'SELECT COUNT(*) AS n FROM e2ee_key_wraps WHERE user_id = ? AND generation < 8',
        USER
      )
    ).toBe(0);
    expect(
      count(
        srv.db,
        'SELECT COUNT(*) AS n FROM e2ee_identities WHERE user_id = ?',
        'user_other'
      )
    ).toBe(1);
    expect(
      count(
        srv.db,
        'SELECT COUNT(*) AS n FROM e2ee_device_list_entries WHERE user_id = ?',
        'user_other'
      )
    ).toBe(2);
  });

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

/** Key flows run many WebCrypto rounds; the shared runner is often loaded. */
const KEY_FLOW_TIMEOUT_MS = 30_000;

describe('account-key history', () => {
  /** The account key this page holds unlocked now, copied. */
  const currentKey = () => new Uint8Array(unlockedAccount(USER)!.accountKey);

  const historyRows = (db: DatabaseSync, userId = USER) =>
    db
      .prepare(
        'SELECT generation, key_sequence, wrapped FROM e2ee_account_key_history WHERE user_id = ? ORDER BY generation, key_sequence'
      )
      .all(userId) as {
      generation: number;
      key_sequence: number;
      wrapped: string;
    }[];

  /** Setup plus three rotations: two removals and a read-only revocation. */
  async function rotatedThrice(srv: Server) {
    const { recovery, laptop } = await setUp(srv);
    const phone = await enrolled(srv, recovery.secret, 'Phone');
    const tablet = await enrolled(srv, recovery.secret, 'Tablet');
    lockAccount(USER);
    let account = ready(await loadEncryption(laptop));
    const keys = [
      { keySequence: accountKeySequence(account.list), key: currentKey() }
    ];
    account = ready(
      await removeDevice(
        laptop,
        account,
        phone.account.device!.deviceId,
        recovery.secret
      )
    );
    keys.push({
      keySequence: accountKeySequence(account.list),
      key: currentKey()
    });
    account = ready(
      await removeDevice(
        laptop,
        account,
        tablet.account.device!.deviceId,
        recovery.secret
      )
    );
    keys.push({
      keySequence: accountKeySequence(account.list),
      key: currentKey()
    });
    account = ready(
      await revokeReadOnlyDevices(laptop, account, recovery.secret)
    );
    keys.push({
      keySequence: accountKeySequence(account.list),
      key: currentKey()
    });
    return { recovery, laptop, phone, tablet, account, keys };
  }

  it(
    'opens all four keys after three rotations',
    async () => {
      const srv = server();
      const { laptop, account, keys } = await rotatedThrice(srv);
      // Entries 0 setup, 1 and 2 enrolments, 3 and 4 removals, 5 revocation.
      expect(keys.map((k) => k.keySequence)).toEqual([0, 3, 4, 5]);
      expect(new Set(keys.map((k) => toHex(k.key))).size).toBe(4);
      // One row per replaced key, named by the entry that committed to it.
      const rows = historyRows(srv.db);
      expect(rows.map((r) => [r.generation, r.key_sequence])).toEqual([
        [1, 0],
        [1, 3],
        [1, 4]
      ]);
      expect(rows.every((r) => r.wrapped.length === 55)).toBe(true);
      for (const { keySequence, key } of keys) {
        const opened = await openAccountKeyChain(laptop, account, keySequence);
        expect(toHex(opened)).toBe(toHex(key));
      }
      // A sequence that names no account key, or a later one, is refused.
      await flowRefusal(
        openAccountKeyChain(laptop, account, 1),
        'invalid-request'
      );
      await flowRefusal(
        openAccountKeyChain(laptop, account, 6),
        'invalid-request'
      );
      await flowRefusal(
        openAccountKeyChain(laptop, account, 0, 2),
        'invalid-request'
      );
      // Locked, nothing opens.
      lockAccount(USER);
      await flowRefusal(
        openAccountKeyChain(laptop, account, 0),
        'not-unlocked'
      );
    },
    KEY_FLOW_TIMEOUT_MS
  );

  it(
    'carries every key across replaced and pruned identities',
    async () => {
      const srv = server();
      const { laptop, keys } = await rotatedThrice(srv);
      lockAccount(USER);
      let account = ready(await loadEncryption(laptop));
      // Five replacements signed by this device: generations 1 and 2 are
      // pruned from e2ee_identities, but their history stays.
      const generationKeys = [currentKey()];
      for (let replacement = 0; replacement < 5; replacement += 1) {
        const next = (await generateRecoveryKey()).secret;
        account = ready(await replaceRecoveryKey(laptop, account, next, null));
        generationKeys.push(currentKey());
      }
      expect(account.generation).toBe(6);
      expect(
        count(
          srv.db,
          'SELECT COUNT(*) AS n FROM e2ee_identities WHERE user_id = ? AND generation = 1',
          USER
        )
      ).toBe(0);
      expect(
        historyRows(srv.db).map((r) => [r.generation, r.key_sequence])
      ).toEqual([
        [1, 0],
        [1, 3],
        [1, 4],
        [1, 5],
        [2, 0],
        [3, 0],
        [4, 0],
        [5, 0]
      ]);
      for (const { keySequence, key } of keys) {
        expect(
          toHex(await openAccountKeyChain(laptop, account, keySequence, 1))
        ).toBe(toHex(key));
      }
      for (let generation = 2; generation <= 6; generation += 1) {
        expect(
          toHex(await openAccountKeyChain(laptop, account, 0, generation))
        ).toBe(toHex(generationKeys[generation - 1]!));
      }
    },
    KEY_FLOW_TIMEOUT_MS
  );

  it(
    'writes the history when the old recovery key signs the replacement',
    async () => {
      const srv = server();
      const { recovery, laptop, account } = await setUp(srv);
      const first = currentKey();
      const after = ready(
        await replaceRecoveryKey(
          laptop,
          account,
          (await generateRecoveryKey()).secret,
          recovery.secret
        )
      );
      expect(after.generation).toBe(2);
      expect(toHex(await openAccountKeyChain(laptop, after, 0, 1))).toBe(
        toHex(first)
      );
    },
    KEY_FLOW_TIMEOUT_MS
  );

  it(
    'gives a removed device’s old key no way into the newer ones',
    async () => {
      const srv = server();
      const { recovery, laptop } = await setUp(srv);
      const phone = await enrolled(srv, recovery.secret, 'Phone');
      lockAccount(USER);
      // What the phone held before it was removed.
      const phoneView = ready(await loadEncryption(phone.ctx));
      expect(phoneView.unlocked).toBe(true);
      const stolen = currentKey();
      const stolenSequence = accountKeySequence(phoneView.list);
      lockAccount(USER);
      let account = ready(await loadEncryption(laptop));
      account = ready(
        await removeDevice(
          laptop,
          account,
          phone.account.device!.deviceId,
          recovery.secret
        )
      );
      account = ready(
        await revokeReadOnlyDevices(laptop, account, recovery.secret)
      );
      const newer = [currentKey()];
      // The laptop's chain opens the stolen key: history only goes back.
      expect(
        toHex(await openAccountKeyChain(laptop, account, stolenSequence))
      ).toBe(toHex(stolen));
      // The stolen key opens no history row, so none of the newer keys.
      const rows = historyRows(srv.db);
      expect(rows).toHaveLength(2);
      for (const row of rows) {
        await expect(
          unwrapKey(stolen, fromBase64Url(row.wrapped), {
            purpose: 'previous-account-key',
            userId: USER,
            generation: row.generation,
            keySequence: row.key_sequence
          })
        ).rejects.toMatchObject({ code: 'authentication-failed' });
      }
      expect(newer.map(toHex)).not.toContain(toHex(stolen));
      // Nor is anything sealed to the removed device any more.
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
      await flowRefusal(
        openAccountKeyChain(phone.ctx, removed, stolenSequence),
        'not-unlocked'
      );
    },
    KEY_FLOW_TIMEOUT_MS
  );

  it(
    'refuses a history row the newer key did not make',
    async () => {
      const srv = server();
      const { laptop, account, keys } = await rotatedThrice(srv);
      // A server that swaps a row for a wrap under the wrong key.
      srv.db
        .prepare(
          'UPDATE e2ee_account_key_history SET wrapped = ? WHERE key_sequence = 3'
        )
        .run(
          toBase64Url(
            await wrapKey(generateSymmetricKey(), keys[1]!.key, {
              purpose: 'previous-account-key',
              userId: USER,
              generation: 1,
              keySequence: 3
            })
          )
        );
      await flowRefusal(
        openAccountKeyChain(laptop, account, 0),
        'key-mismatch'
      );
      // A server that omits a row.
      srv.db
        .prepare('DELETE FROM e2ee_account_key_history WHERE key_sequence = 4')
        .run();
      await flowRefusal(
        openAccountKeyChain(laptop, account, 0),
        'missing-wrap'
      );
    },
    KEY_FLOW_TIMEOUT_MS
  );

  it(
    'is refused by the Worker when a rotation omits or misnames it',
    async () => {
      const srv = server();
      const { recovery, laptop } = await setUp(srv);
      const phone = await enrolled(srv, recovery.secret, 'Phone');
      lockAccount(USER);
      const account = ready(await loadEncryption(laptop));
      const entries = () =>
        count(srv.db, 'SELECT COUNT(*) AS n FROM e2ee_device_list_entries');
      const before = entries();
      const tampered = (
        change: (
          request: Parameters<E2eeContext['api']['appendDeviceList']>[0]
        ) => Parameters<E2eeContext['api']['appendDeviceList']>[0]
      ): E2eeContext => ({
        ...laptop,
        api: {
          ...laptop.api,
          appendDeviceList: (request) =>
            laptop.api.appendDeviceList(change(request))
        }
      });
      const cases: ((
        request: Parameters<E2eeContext['api']['appendDeviceList']>[0]
      ) => Parameters<E2eeContext['api']['appendDeviceList']>[0])[] = [
        ({ history: _history, ...request }) => request,
        (request) => ({
          ...request,
          history: { ...request.history!, keySequence: 1 }
        }),
        (request) => ({
          ...request,
          history: { ...request.history!, generation: 2 }
        }),
        (request) => ({
          ...request,
          history: {
            ...request.history!,
            wrapped: toBase64Url(new Uint8Array(40))
          }
        }),
        (request) => ({
          ...request,
          history: {
            ...request.history!,
            wrapped: toBase64Url(new Uint8Array(41).fill(1))
          }
        })
      ];
      for (const change of cases) {
        const refused = await refusal(
          removeDevice(
            tampered(change),
            account,
            phone.account.device!.deviceId,
            recovery.secret
          )
        );
        expect([refused.status, refused.code]).toEqual([
          400,
          'E2EE_REQUEST_INVALID'
        ]);
      }
      expect(entries()).toBe(before);
      expect(historyRows(srv.db)).toEqual([]);
      // A history wrap on an entry that rotates nothing is refused too.
      const tablet = device(srv);
      const fresh = ready(await loadEncryption(tablet));
      const extra = await refusal(
        enrollWithRecoveryKey(
          {
            ...tablet,
            api: {
              ...tablet.api,
              appendDeviceList: (request) =>
                tablet.api.appendDeviceList({
                  ...request,
                  history: {
                    generation: 1,
                    keySequence: 0,
                    wrapped: toBase64Url(new Uint8Array(41).fill(2))
                  }
                })
            }
          },
          fresh,
          recovery.secret,
          'Tablet'
        )
      );
      expect([extra.status, extra.code]).toEqual([400, 'E2EE_REQUEST_INVALID']);
      expect(entries()).toBe(before);
    },
    KEY_FLOW_TIMEOUT_MS
  );

  it(
    'is refused by the Worker when a replacement or a setup misuses it',
    async () => {
      const srv = server();
      const { laptop, account } = await setUp(srv);
      const refused = await refusal(
        replaceRecoveryKey(
          {
            ...laptop,
            api: {
              ...laptop.api,
              replaceIdentity: ({ history: _history, ...request }) =>
                laptop.api.replaceIdentity(
                  request as Parameters<
                    E2eeContext['api']['replaceIdentity']
                  >[0]
                )
            }
          },
          account,
          (await generateRecoveryKey()).secret,
          null
        )
      );
      expect([refused.status, refused.code]).toEqual([
        400,
        'E2EE_REQUEST_INVALID'
      ]);
      expect(count(srv.db, 'SELECT COUNT(*) AS n FROM e2ee_identities')).toBe(
        1
      );
      const other = server(migratedDatabase());
      const ctx = device(other);
      const setupRefused = await refusal(
        setUpEncryption(
          {
            ...ctx,
            api: {
              ...ctx.api,
              setup: (request) =>
                ctx.api.setup({
                  ...request,
                  history: {
                    generation: 1,
                    keySequence: 0,
                    wrapped: toBase64Url(new Uint8Array(41).fill(2))
                  }
                } as E2eeSetupRequest)
            }
          },
          {
            recoverySecret: (await generateRecoveryKey()).secret,
            label: 'Laptop'
          }
        )
      );
      expect([setupRefused.status, setupRefused.code]).toEqual([
        400,
        'E2EE_REQUEST_INVALID'
      ]);
    },
    KEY_FLOW_TIMEOUT_MS
  );

  it(
    'serves only the caller’s own history',
    async () => {
      const srv = server();
      await rotatedThrice(srv);
      const BOB = 'user_bob';
      srv.db
        .prepare('INSERT INTO users (id, email, created_at) VALUES (?, ?, ?)')
        .run(BOB, 'bob@example.com', '2026-10-20T00:00:00.000Z');
      const bob = device(srv, BOB);
      const bobRecovery = await generateRecoveryKey();
      // Before Bob has any history, his answer is empty, not Alice's.
      expect(await bob.api.accountKeyHistory()).toEqual({ history: [] });
      const bobAccount = ready(
        await setUpEncryption(bob, {
          recoverySecret: bobRecovery.secret,
          label: 'Bob laptop'
        })
      );
      await revokeReadOnlyDevices(bob, bobAccount, bobRecovery.secret);
      const aliceRows = historyRows(srv.db, USER).map((r) => r.wrapped);
      const bobHistory = (await bob.api.accountKeyHistory()).history;
      expect(bobHistory.map((r) => [r.generation, r.keySequence])).toEqual([
        [1, 0]
      ]);
      expect(bobHistory.map((r) => r.wrapped)).toEqual(
        historyRows(srv.db, BOB).map((r) => r.wrapped)
      );
      expect(bobHistory.some((r) => aliceRows.includes(r.wrapped))).toBe(false);
      const aliceHistory = (await device(srv).api.accountKeyHistory()).history;
      expect(aliceHistory.map((r) => r.wrapped)).toEqual(aliceRows);
    },
    KEY_FLOW_TIMEOUT_MS
  );

  it(
    'is erased with the account, with or without the users row',
    async () => {
      const srv = server();
      await rotatedThrice(srv);
      expect(historyRows(srv.db)).toHaveLength(3);
      const { deleteAccountData } =
        await import('../apps/web/worker/accountDeletion');
      await deleteAccountData(
        { userId: USER as never, displayName: 'Alice', mode: 'development' },
        { scope: 'profile', confirmation: 'DELETE CLOUD PROFILE' },
        { DB: d1Database(srv.db) },
        {} as never
      );
      expect(count(srv.db, 'SELECT COUNT(*) AS n FROM users')).toBe(1);
      expect(
        count(srv.db, 'SELECT COUNT(*) AS n FROM e2ee_account_key_history')
      ).toBe(0);

      const cascade = server();
      await rotatedThrice(cascade);
      expect(historyRows(cascade.db)).toHaveLength(3);
      cascade.db.prepare('DELETE FROM users WHERE id = ?').run(USER);
      expect(
        count(cascade.db, 'SELECT COUNT(*) AS n FROM e2ee_account_key_history')
      ).toBe(0);
    },
    KEY_FLOW_TIMEOUT_MS
  );

  it(
    'is fenced while an erasure is in progress',
    async () => {
      const srv = server();
      srv.db
        .prepare('INSERT INTO account_erasure_requests VALUES (?, ?, ?, ?)')
        .run(USER, 'profile', 1, 1);
      expect(() =>
        srv.db
          .prepare(
            'INSERT INTO e2ee_account_key_history VALUES (?, 1, 0, ?, ?)'
          )
          .run(USER, 'A'.repeat(55), '2026-10-24T00:00:00.000Z')
      ).toThrow(/ACCOUNT_ERASURE_IN_PROGRESS/);
    },
    KEY_FLOW_TIMEOUT_MS
  );

  it(
    'keeps routes closed but erasure working before migration 0030',
    async () => {
      const srv = server();
      await setUp(srv);
      srv.db.exec('DROP TABLE e2ee_account_key_history');
      const api = createE2eeApi(fetcherFor(srv, USER));
      expect(await api.config()).toEqual({
        enabled: false,
        projectsEnabled: false
      });
      const closed = await refusal(api.account());
      expect([closed.status, closed.code]).toEqual([503, 'E2EE_UNAVAILABLE']);
      const { deleteAccountData } =
        await import('../apps/web/worker/accountDeletion');
      await expect(
        deleteAccountData(
          { userId: USER as never, displayName: 'Alice', mode: 'development' },
          { scope: 'profile', confirmation: 'DELETE CLOUD PROFILE' },
          { DB: d1Database(srv.db) },
          {} as never
        )
      ).resolves.toMatchObject({ ok: true });
      for (const table of [
        'e2ee_identities',
        'e2ee_device_list_entries',
        'e2ee_key_wraps',
        'e2ee_device_approvals'
      ]) {
        expect(count(srv.db, `SELECT COUNT(*) AS n FROM ${table}`)).toBe(0);
      }
    },
    KEY_FLOW_TIMEOUT_MS
  );
});

describe('recovery-key replacement lock', () => {
  /**
   * The browser's device store with every critical section numbered, and
   * the replacement's server call held until `release`.
   */
  function instrumented(laptop: E2eeContext) {
    const events: string[] = [];
    let sections = 0;
    let release!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    let replacements = 0;
    const ctx: E2eeContext = {
      ...laptop,
      store: {
        ...laptop.store,
        withDeviceLock: (userId, run) =>
          laptop.store.withDeviceLock(userId, async () => {
            const section = (sections += 1);
            events.push(`lock:${section}`);
            try {
              return await run();
            } finally {
              events.push(`unlock:${section}`);
            }
          })
      },
      api: {
        ...laptop.api,
        replaceIdentity: async (request) => {
          const call = (replacements += 1);
          events.push(`replace:${call}`);
          if (call === 1) await released;
          return laptop.api.replaceIdentity(request);
        },
        appendDeviceList: async (request) => {
          events.push('append');
          return laptop.api.appendDeviceList(request);
        }
      }
    };
    const settle = () => new Promise((resolve) => setTimeout(resolve, 50));
    return { ctx, events, release, settle };
  }

  it(
    'serializes a replacement and a removal from the same browser',
    async () => {
      const srv = server();
      const { recovery, laptop } = await setUp(srv);
      const phone = await enrolled(srv, recovery.secret, 'Phone');
      lockAccount(USER);
      const account = ready(await loadEncryption(laptop));
      const { ctx, events, release, settle } = instrumented(laptop);
      const replaced = replaceRecoveryKey(
        ctx,
        account,
        (await generateRecoveryKey()).secret,
        null
      );
      while (!events.includes('replace:1')) await settle();
      const removal = removeDevice(
        ctx,
        account,
        phone.account.device!.deviceId,
        recovery.secret
      );
      // The replacement holds the lock; the removal waits however long.
      await settle();
      expect(events).toEqual(['lock:1', 'replace:1']);
      release();
      expect(ready(await replaced).generation).toBe(2);
      // It then runs against the identity it was given, which is gone.
      const refused = await refusal(removal);
      expect([refused.status, refused.code]).toEqual([
        409,
        'E2EE_GENERATION_CONFLICT'
      ]);
      expect(events).toEqual([
        'lock:1',
        'replace:1',
        'unlock:1',
        'lock:2',
        'append',
        'unlock:2'
      ]);
    },
    KEY_FLOW_TIMEOUT_MS
  );

  it(
    'serializes two replacements from the same browser',
    async () => {
      const srv = server();
      const { laptop, account } = await setUp(srv);
      const { ctx, events, release, settle } = instrumented(laptop);
      const first = replaceRecoveryKey(
        ctx,
        account,
        (await generateRecoveryKey()).secret,
        null
      );
      while (!events.includes('replace:1')) await settle();
      const second = replaceRecoveryKey(
        ctx,
        account,
        (await generateRecoveryKey()).secret,
        null
      );
      await settle();
      expect(events).toEqual(['lock:1', 'replace:1']);
      release();
      expect(ready(await first).generation).toBe(2);
      const refused = await refusal(second);
      expect([refused.status, refused.code]).toEqual([
        409,
        'E2EE_GENERATION_CONFLICT'
      ]);
      expect(events).toEqual([
        'lock:1',
        'replace:1',
        'unlock:1',
        'lock:2',
        'replace:2',
        'unlock:2'
      ]);
      expect(count(srv.db, 'SELECT COUNT(*) AS n FROM e2ee_identities')).toBe(
        2
      );
    },
    KEY_FLOW_TIMEOUT_MS
  );
});

describe('device approval', () => {
  it('stages one key pair and serializes approval requests from two tabs', async () => {
    const srv = server();
    const { laptop, account, recovery } = await setUp(srv);
    const phone = device(srv);
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started!: () => void;
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    const create = phone.api.createApproval;
    const first = requestApproval(
      {
        ...phone,
        api: {
          ...phone.api,
          createApproval: async (input) => {
            const result = await create(input);
            started();
            await held;
            return result;
          }
        }
      },
      null,
      'First tab'
    );
    await entered;
    let second: ReturnType<typeof requestApproval> | undefined;
    try {
      const staged = await phone.store.loadDevice(USER);
      expect(staged).not.toBeNull();
      second = requestApproval({ ...phone }, null, 'Second tab');
    } finally {
      release();
    }
    const a = await first;
    const b = await second;
    if (a.step !== 'waiting' || b.step !== 'waiting')
      throw new Error('Expected both sequential requests');
    expect(a.scanCode).toBe(b.scanCode);
    expect(a.approval.deviceId).toBe(b.approval.deviceId);
    await expect(phone.api.getApproval(a.approval.id)).rejects.toHaveProperty(
      'status',
      404
    );
    await approveDevice(
      laptop,
      account,
      b.approval,
      { kind: 'scan', code: b.scanCode },
      recovery.secret
    );
    const completed = await advanceApprovalAsNewDevice(phone);
    expect(completed.step).toBe('done');
    expect((await advanceApprovalAsNewDevice({ ...phone })).step).toBe('done');
    expect(ready(await loadEncryption(phone)).deviceStatus).toBe('certified');
  });

  it('does not restore device keys deleted while approval creation is in flight', async () => {
    const srv = server();
    await setUp(srv);
    const phone = device(srv);
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started!: () => void;
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    const create = phone.api.createApproval;
    let approvalId = '';
    const result = requestApproval(
      {
        ...phone,
        api: {
          ...phone.api,
          createApproval: async (input) => {
            const approval = await create(input);
            approvalId = approval.id;
            started();
            await held;
            return approval;
          }
        }
      },
      null,
      'Departing tab'
    );
    const outcome = result.then(
      () => null,
      (error: unknown) => error
    );
    await entered;
    await phone.store.deleteDevice(USER);
    release();
    expect(await outcome).toBeInstanceOf(Error);
    expect(await phone.store.loadDevice(USER)).toBeNull();
    await expect(phone.api.getApproval(approvalId)).rejects.toHaveProperty(
      'status',
      404
    );
  });

  it('retains the current approval on a failed restart and releases its lock for retry', async () => {
    const srv = server();
    await setUp(srv);
    const phone = device(srv);
    await requestApproval(phone, null, 'Original request');
    const before = await phone.store.loadDevice(USER);
    const create = vi.fn(phone.api.createApproval);
    await expect(
      requestApproval(
        {
          ...phone,
          api: {
            ...phone.api,
            createApproval: create,
            cancelApproval: async () => {
              throw new E2eeApiError(503, 'OFFLINE', 'Try again');
            }
          }
        },
        null,
        'Failed restart'
      )
    ).rejects.toHaveProperty('status', 503);
    expect(create).not.toHaveBeenCalled();
    expect(await phone.store.loadDevice(USER)).toEqual(before);
    expect((await requestApproval(phone, null, 'Successful retry')).step).toBe(
      'waiting'
    );
    expect((await phone.store.loadDevice(USER))?.deviceId).toBe(
      before?.deviceId
    );
  });

  it('does not replace newly staged keys again for a stale removed-device view', async () => {
    const srv = server();
    await setUp(srv);
    const phone = device(srv);
    await requestApproval(phone, null, 'Old device');
    await cancelApprovalRequest(phone);
    const removed = {
      deviceStatus: 'removed' as const,
      device: await phone.store.loadDevice(USER)
    };
    const first = await requestApproval(phone, removed, 'Replacement');
    const second = await requestApproval(phone, removed, 'Other tab');
    if (first.step !== 'waiting' || second.step !== 'waiting')
      throw new Error('Expected requests');
    expect(first.approval.deviceId).not.toBe(removed.device?.deviceId);
    expect(second.approval.deviceId).toBe(first.approval.deviceId);
    expect(second.scanCode).toBe(first.scanCode);
  });

  it('atomically caps durable read-only approvals and frees capacity on revocation', async () => {
    const limit = 64;
    const srv = server();
    const { recovery, laptop, account } = await setUp(srv);
    const first = device(srv);
    const original = await requestApproval(
      first,
      null,
      'First read-only device'
    );
    if (original.step !== 'waiting') throw new Error('Expected request');
    await approveDevice(
      laptop,
      account,
      original.approval,
      { kind: 'scan', code: original.scanCode },
      null
    );
    const originalId = (await first.store.loadDevice(USER))!.deviceId;
    // Fill stored capacity independently of creation quotas. The Worker cannot
    // verify these encrypted payloads; every retained wrap must count.
    for (let i = 1; i < limit - 1; i++)
      srv.db
        .prepare(
          `
      INSERT INTO e2ee_key_wraps
      SELECT user_id, generation, purpose, ?, key_sequence, wrapped, updated_at
      FROM e2ee_key_wraps WHERE user_id = ? AND purpose = 'account-key-approval' AND target_id = ?
    `
        )
        .run(`retained_device_${i}`, USER, originalId);
    const pending = await Promise.all(
      [0, 1].map(async (i) => {
        const phone = device(srv);
        const request = await requestApproval(phone, null, `Contender ${i}`);
        if (request.step !== 'waiting') throw new Error('Expected request');
        return request;
      })
    );
    const current = ready(await loadEncryption(laptop));
    let arrived = 0,
      release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    srv.beforeWrite = async (sql) => {
      if (!sql.includes("SET state = 'completed'")) return;
      if (++arrived === 2) release();
      await held;
    };
    const results = await Promise.allSettled(
      pending.map((request) =>
        approveDevice(
          laptop,
          current,
          request.approval,
          { kind: 'scan', code: request.scanCode },
          null
        )
      )
    );
    srv.beforeWrite = undefined;
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
    expect(
      count(
        srv.db,
        "SELECT COUNT(*) AS n FROM e2ee_key_wraps WHERE user_id = ? AND purpose = 'account-key-approval'",
        USER
      )
    ).toBe(limit);
    const loser = pending[results.findIndex((r) => r.status === 'rejected')]!;
    await expect(
      approveDevice(
        laptop,
        ready(await loadEncryption(laptop)),
        loser.approval,
        { kind: 'scan', code: loser.scanCode },
        null
      )
    ).rejects.toHaveProperty('code', 'E2EE_READ_ONLY_DEVICE_LIMIT');
    const rotated = ready(
      await revokeReadOnlyDevices(
        laptop,
        ready(await loadEncryption(laptop)),
        recovery.secret
      )
    );
    expect(rotated.approvedDevices).toHaveLength(0);
    const fresh = await requestApproval(device(srv), null, 'After revocation');
    if (fresh.step !== 'waiting') throw new Error('Expected request');
    await approveDevice(
      laptop,
      rotated,
      fresh.approval,
      { kind: 'scan', code: fresh.scanCode },
      null
    );
    expect(
      count(
        srv.db,
        "SELECT COUNT(*) AS n FROM e2ee_key_wraps WHERE user_id = ? AND purpose = 'account-key-approval'",
        USER
      )
    ).toBe(1);
  });
  it.each(['cancel failure', 'read failure', 'still live'] as const)(
    'approval cancellation preserves its retry ID and keys after %s',
    async (fault) => {
      const srv = server();
      await setUp(srv);
      const phone = device(srv);
      const requested = await requestApproval(phone, null, 'Phone');
      if (requested.step !== 'waiting') throw new Error('Expected request');
      const before = await phone.store.loadDevice(USER);
      const retry = {
        ...phone,
        api: {
          ...phone.api,
          cancelApproval: async () => {
            if (fault === 'cancel failure')
              throw new Error('Network unavailable');
            return { ok: true as const };
          },
          getApproval: async (id: string) => {
            if (fault === 'read failure')
              throw new E2eeApiError(401, 'Session expired');
            return phone.api.getApproval(id);
          }
        }
      };
      await expect(cancelApprovalRequest(retry)).rejects.toThrow();
      expect(await phone.store.loadDevice(USER)).toEqual(before);
      expect((await phone.api.getApproval(requested.approval.id)).state).toBe(
        requested.approval.state
      );
      await cancelApprovalRequest(phone);
      expect((await phone.store.loadDevice(USER))?.approval).toBeNull();
      await expect(
        phone.api.getApproval(requested.approval.id)
      ).rejects.toHaveProperty('status', 404);
    }
  );
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
    // Past the body limit, which leaves room for a revocation's cutoff
    // statement naming every project (e2eeDeviceRemoval.ts).
    const huge = await refusal(
      laptop.api.appendDeviceList({
        generation: 1,
        entry: 'A'.repeat(1600 * 1024),
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
      'e2ee_account_key_history',
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
    expect(await closed.json()).toEqual({
      enabled: false,
      projectsEnabled: false
    });
    expect((await workerFetch(devEnv(), '/api/e2ee/account')).status).toBe(501);
    const open = devEnv({ E2EE_KEYS_ENABLED: 'true' });
    expect(await (await workerFetch(open, '/api/e2ee/config')).json()).toEqual({
      enabled: true,
      projectsEnabled: false
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
  it('does not tear down a replacement session after an older erasure response', async () => {
    const srv = server();
    const { laptop } = await setUp(srv);
    // The erased account's MLS state on this device goes with its keys.
    const mls = mlsStores.memoryMlsSessionStore();
    await mls.getOrCreateStateKey(
      USER,
      await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, [
        'encrypt'
      ])
    );
    const forget = vi
      .spyOn(mlsStores, 'indexedDbMlsSessionStore')
      .mockReturnValue(mls);
    let current = true;
    let ended = false;
    await eraseAccountWithKeyCleanup({
      userId: USER,
      store: laptop.store,
      isCurrentSession: () => current,
      erase: async () => {
        current = false;
        return { signedOut: true };
      },
      onSignedOut: () => {
        ended = true;
      }
    });
    expect(ended).toBe(false);
    expect(unlockedEncryptionKey(USER)).toBeNull();
    expect(await laptop.store.loadPin(USER)).toBeNull();
    expect(await mls.loadStateKey(USER)).toBeNull();
    forget.mockRestore();
  });

  it('still forgets the MLS state when device-key cleanup fails after erasure', async () => {
    const srv = server();
    const { laptop } = await setUp(srv);
    const journal = (await import('../apps/web/src/lib/e2ee/shareWorkStore')).shareWorkStore();
    await journal.update(USER, 'project', (current) => ({ ...current, notice: 'saved' }));
    const mls = mlsStores.memoryMlsSessionStore();
    await mls.getOrCreateStateKey(
      USER,
      await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, [
        'encrypt'
      ])
    );
    const forget = vi
      .spyOn(mlsStores, 'indexedDbMlsSessionStore')
      .mockReturnValue(mls);
    await expect(
      eraseAccountWithKeyCleanup({
        userId: USER,
        store: {
          ...laptop.store,
          forgetErasedIdentity: async () => {
            throw new Error('Device database unavailable');
          }
        },
        isCurrentSession: () => true,
        erase: async () => ({ signedOut: true }),
        onSignedOut: () => {}
      })
    ).rejects.toThrow('Device database unavailable');
    // The separate MLS database was still cleared.
    expect(await mls.loadStateKey(USER)).toBeNull();
    expect((await journal.read(USER, 'project')).notice).toBeNull();
    forget.mockRestore();
  });

  it.each(['profile', 'all'] as const)(
    'allows fresh encryption setup after confirmed %s erasure',
    async (scope) => {
      const srv = server();
      const { laptop } = await setUp(srv);
      const oldPin = await laptop.store.loadPin(USER);
      expect(oldPin).not.toBeNull();
      expect(unlockedEncryptionKey(USER)).not.toBeNull();
      const { deleteAccountData } =
        await import('../apps/web/worker/accountDeletion');
      let signedOut = false;
      await eraseAccountWithKeyCleanup({
        userId: USER,
        store: laptop.store,
        isCurrentSession: () => true,
        erase: () =>
          deleteAccountData(
            {
              userId: USER as never,
              displayName: 'Alice',
              mode: 'development'
            },
            {
              scope,
              confirmation:
                scope === 'profile'
                  ? 'DELETE CLOUD PROFILE'
                  : 'DELETE ALL CLOUD DATA'
            },
            {
              DB: d1Database(srv.db),
              PROJECT_STORAGE: {
                put: async () => {},
                get: async () => null,
                delete: async () => {}
              } as never,
              PROJECT_ROOM: {} as never
            },
            { deleteOwnedProjects: async () => [] } as never
          ),
        onSignedOut: () => {
          expect(unlockedEncryptionKey(USER)).toBeNull();
          signedOut = true;
        }
      });
      expect(signedOut).toBe(true);
      expect(await laptop.store.loadPin(USER)).toBeNull();
      expect(await loadEncryption(laptop)).toMatchObject({
        kind: 'not-set-up'
      });
      const recovery = await generateRecoveryKey();
      expect(
        ready(
          await setUpEncryption(laptop, {
            recoverySecret: recovery.secret,
            label: 'Same browser'
          })
        ).unlocked
      ).toBe(true);
      expect(await laptop.store.loadPin(USER)).not.toEqual(oldPin);
    }
  );

  it('locks the raw key and ends the session before fallible local erasure cleanup', async () => {
    const srv = server();
    const { laptop } = await setUp(srv);
    let ended = false;
    await expect(
      eraseAccountWithKeyCleanup({
        userId: USER,
        store: {
          ...laptop.store,
          forgetErasedIdentity: async () => {
            expect(ended).toBe(true);
            expect(unlockedEncryptionKey(USER)).toBeNull();
            throw new Error('IndexedDB unavailable');
          }
        },
        isCurrentSession: () => true,
        erase: async () => ({ signedOut: true }),
        onSignedOut: () => {
          ended = true;
        }
      })
    ).rejects.toThrow('IndexedDB unavailable');
    expect(unlockedEncryptionKey(USER)).toBeNull();
  });

  it('retains trusted state after a failed erasure and refuses a replacement session before the request', async () => {
    const srv = server();
    const { laptop } = await setUp(srv);
    const before = await laptop.store.loadPin(USER);
    let current = true,
      requests = 0;
    const input = {
      userId: USER,
      store: laptop.store,
      isCurrentSession: () => current,
      erase: async () => {
        requests++;
        throw new Error('Server unavailable');
      },
      onSignedOut: () => {
        throw new Error('Unexpected teardown');
      }
    };
    await expect(eraseAccountWithKeyCleanup(input)).rejects.toThrow(
      'Server unavailable'
    );
    expect(await laptop.store.loadPin(USER)).toEqual(before);
    expect(unlockedEncryptionKey(USER)).not.toBeNull();
    current = false;
    await expect(eraseAccountWithKeyCleanup(input)).rejects.toThrow(
      'account changed'
    );
    expect(requests).toBe(1);
  });
  it('still deletes a profile before the E2EE schema exists', async () => {
    const srv = server();
    srv.db.exec(
      'DROP TABLE e2ee_account_key_history; DROP TABLE e2ee_device_approvals; DROP TABLE e2ee_key_wraps; DROP TABLE e2ee_device_list_entries; DROP TABLE e2ee_identities'
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
        'e2ee_account_key_history',
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
      'e2ee_account_key_history',
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
        'rotate',
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
            } else if (operation === 'rotate') {
              const phoneKeys = await enrolled(srv, recovery.secret, 'Phone');
              const current = ready(await loadEncryption(laptop));
              action = () =>
                removeDevice(
                  laptop,
                  current,
                  phoneKeys.account.device!.deviceId,
                  recovery.secret
                );
              target = 'INSERT INTO e2ee_account_key_history';
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
              'e2ee_account_key_history',
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
    const secondRequest = vi.fn(api.setup);
    const second = {
      ...device(srv),
      store: first.store,
      api: {
        ...api,
        setup: secondRequest
      }
    };
    const secondSetup = setUpEncryption(second, {
      recoverySecret: secret,
      label: 'Second tab'
    });
    const secondOutcome = secondSetup.then(
      () => null,
      (error: unknown) => error
    );
    await Promise.resolve();
    expect(secondRequest).not.toHaveBeenCalled();
    release();
    await pending;
    expect(await secondOutcome).toBeInstanceOf(EncryptionFlowError);
    expect(secondRequest).not.toHaveBeenCalled();
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

function fakePasskey(id = 'pk_test', byte = 0x71) {
  const issued: Uint8Array[] = [];
  const select = async (): Promise<PasskeySecret> => {
    const secret = new Uint8Array(32).fill(byte);
    issued.push(secret);
    return {
      targetId: id,
      secret,
      enrollmentLabel: `OpenZCAD encryption ${id}`
    };
  };
  return { create: vi.fn(select), get: vi.fn(select), issued };
}

async function withPasskey(srv: Server) {
  const setup = await setUp(srv);
  const passkeys = fakePasskey();
  const laptop = { ...setup.laptop, passkeys };
  const account = ready(
    await addPasskey(laptop, setup.account, setup.recovery.secret)
  );
  return { ...setup, laptop, account, passkeys };
}

async function passkeyDevice(srv: Server, passkeys: PasskeyPrf) {
  const ctx = { ...device(srv), passkeys };
  const account = ready(await loadEncryption(ctx));
  return { ctx, account };
}

describe('passkey PRF unlock', () => {
  it.each(['create', 'get', 'rotation'] as const)(
    'signs out without waiting for a pending browser %s ceremony',
    async (operation) => {
      const srv = server();
      const { laptop, account, recovery } = await withPasskey(srv);
      const fresh =
        operation === 'get'
          ? await passkeyDevice(srv, browserPasskeys)
          : { ctx: { ...laptop, passkeys: browserPasskeys }, account };
      let cancelPrompt!: () => void;
      let started!: () => void;
      const waiting = new Promise<void>((resolve) => {
        started = resolve;
      });
      const prompt = (
        options: CredentialCreationOptions | CredentialRequestOptions
      ) =>
        new Promise<Credential | null>((_resolve, reject) => {
          cancelPrompt = () =>
            reject(new DOMException('Canceled', 'AbortError'));
          options.signal?.addEventListener('abort', cancelPrompt, {
            once: true
          });
          started();
        });
      vi.stubGlobal('PublicKeyCredential', class {});
      vi.stubGlobal('isSecureContext', true);
      vi.stubGlobal('location', { hostname: 'zcad.test' });
      vi.stubGlobal('navigator', {
        credentials: { create: prompt, get: prompt }
      });
      const storeSpy = vi
        .spyOn(deviceStores, 'indexedDbDeviceStore')
        .mockReturnValue(fresh.ctx.store);
      let revoked = false;
      const work =
        operation === 'create'
          ? addPasskey(fresh.ctx, fresh.account, recovery.secret)
          : operation === 'get'
            ? enrollWithPasskey(fresh.ctx, fresh.account, 'Prompt browser')
            : revokeReadOnlyDevices(fresh.ctx, fresh.account, 'passkey');
      const outcome = work.then(
        () => null,
        (error: unknown) => error
      );
      await waiting;
      const signingOut = signOutAfterSaving({
        userId: USER,
        keepDevice: true,
        isCurrentSession: () => !revoked,
        savePending: async () => {},
        revokeSession: async () => {
          revoked = true;
        }
      });
      try {
        // Abort and lock release require promise jobs only. Reach the next
        // event-loop turn without resolving the authenticator ourselves.
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(revoked).toBe(true);
        expect(await outcome).toBeInstanceOf(PasskeyError);
        expect(unlockedEncryptionKey(USER)).toBeNull();
        expect(
          count(srv.db, 'SELECT COUNT(*) AS n FROM e2ee_device_list_entries')
        ).toBe(2);
      } finally {
        cancelPrompt();
        await outcome;
        await signingOut;
        storeSpy.mockRestore();
        vi.unstubAllGlobals();
      }
    }
  );

  it('keeps passkey certification behind the same-device writer lock and refuses it after logout', async () => {
    const srv = server();
    const { passkeys } = await withPasskey(srv);
    const fresh = await passkeyDevice(srv, passkeys);
    let release!: () => void;
    let entered!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const holding = fresh.ctx.store.withDeviceLock(USER, async () => {
      entered();
      await held;
    });
    await started;
    let sessionLive = true;
    const writing = enrollWithPasskey(
      { ...fresh.ctx, isCurrent: () => sessionLive },
      fresh.account,
      'Logged-out browser'
    );
    const outcome = writing.then(
      () => null,
      (error: unknown) => error
    );
    try {
      await Promise.resolve();
      await Promise.resolve();
      expect(passkeys.get).not.toHaveBeenCalled();
      sessionLive = false;
      lockAccountsExcept(null);
    } finally {
      release();
      await holding;
    }
    expect(await outcome).toBeInstanceOf(EncryptionFlowError);
    expect(passkeys.get).not.toHaveBeenCalled();
    expect(await fresh.ctx.store.loadDevice(USER)).toBeNull();
    expect(
      count(srv.db, 'SELECT COUNT(*) AS n FROM e2ee_device_list_entries')
    ).toBe(2);
  });

  it.each(['create', 'get', 'revoke-read-only'] as const)(
    'refuses a delayed %s after its settings view closes',
    async (operation) => {
      const srv = server();
      const { laptop, account, recovery } = await withPasskey(srv);
      let finish!: (value: PasskeySecret) => void;
      let started!: () => void;
      const waiting = new Promise<void>((resolve) => {
        started = resolve;
      });
      const provider = fakePasskey();
      provider[operation === 'create' ? 'create' : 'get'].mockImplementation(
        () => {
          started();
          return new Promise<PasskeySecret>((resolve) => {
            finish = resolve;
          });
        }
      );
      let currentView = true;
      const fresh =
        operation === 'get'
          ? await passkeyDevice(srv, provider)
          : { ctx: { ...laptop, passkeys: provider }, account };
      const ctx = { ...fresh.ctx, isCurrent: () => currentView };
      const work =
        operation === 'create'
          ? addPasskey(ctx, fresh.account, recovery.secret)
          : operation === 'get'
            ? enrollWithPasskey(ctx, fresh.account, 'Closed view')
            : revokeReadOnlyDevices(ctx, fresh.account, 'passkey');
      const outcome = work.then(
        () => null,
        (error: unknown) => error
      );
      await waiting;
      currentView = false;
      const bytes = new Uint8Array(32).fill(0x71);
      finish({ targetId: 'pk_test', secret: bytes });
      expect(await outcome).toBeInstanceOf(EncryptionFlowError);
      expect(bytes.every((byte) => byte === 0)).toBe(true);
      expect(
        count(srv.db, 'SELECT COUNT(*) AS n FROM e2ee_device_list_entries')
      ).toBe(2);
      expect(await ctx.store.loadDevice(USER)).toEqual(fresh.account.device);
    }
  );

  it('does not resume an old passkey prompt after session teardown and a fresh authenticated recheck', async () => {
    const srv = server();
    const { laptop, account, recovery } = await withPasskey(srv);
    let finish!: (value: PasskeySecret) => void;
    let started!: () => void;
    const waiting = new Promise<void>((resolve) => {
      started = resolve;
    });
    const provider = fakePasskey('pk_late');
    provider.create.mockImplementation(() => {
      started();
      return new Promise<PasskeySecret>((resolve) => {
        finish = resolve;
      });
    });
    const work = addPasskey(
      { ...laptop, passkeys: provider },
      account,
      recovery.secret
    );
    const outcome = work.then(
      () => null,
      (error: unknown) => error
    );
    await waiting;
    confirmKeySessionEnded();
    // A later authenticated session must not revive a previous prompt.
    allowKeySession(getKeySessionRevision());
    const bytes = new Uint8Array(32).fill(0x71);
    finish({ targetId: 'pk_late', secret: bytes });
    expect(await outcome).toHaveProperty('name', 'AbortError');
    expect(bytes.every((byte) => byte === 0)).toBe(true);
    expect(unlockedEncryptionKey(USER)).toBeNull();
    expect(
      count(srv.db, 'SELECT COUNT(*) AS n FROM e2ee_device_list_entries')
    ).toBe(2);
  });

  beforeEach(() => {
    // Each fixture starts with a fresh authenticated server session. Prior
    // account-erasure tests intentionally leave the app-wide session closed.
    allowKeySession(getKeySessionRevision());
  });

  it('certifies a public target with exactly three wraps, never sends PRF material, and enrolls a fresh browser', async () => {
    const srv = server();
    const { account, passkeys } = await withPasskey(srv);
    expect(passkeys.create).toHaveBeenCalledExactlyOnceWith();
    expect(account.list.unlockTargets.map((t) => t.kind)).toEqual([
      'passkey',
      'recovery-key'
    ]);
    expect(
      account.wraps
        .filter((w) => w.targetId === 'pk_test')
        .map((w) => w.purpose)
        .sort()
    ).toEqual(['account-key', 'identity-key', 'unlock-target-key']);
    const fresh = await passkeyDevice(srv, passkeys);
    expect(fresh.account.unlocked).toBe(false);
    const unlocked = ready(
      await enrollWithPasskey(fresh.ctx, fresh.account, 'Passkey browser')
    );
    expect(unlocked.deviceStatus).toBe('certified');
    expect(unlocked.unlocked).toBe(true);
    expect(unlocked.fingerprint).toBe(account.fingerprint);
    expect(unlockedEncryptionKey(USER)?.extractable).toBe(false);
    expect(Object.keys(unlockedAccount(USER)!)).toEqual([
      'generation',
      'commitment',
      'accountKey',
      'encryptionPrivateKey'
    ]);
    expect(passkeys.issued.every((bytes) => bytes.every((b) => b === 0))).toBe(
      true
    );
    lockAccount(USER);
    expect(ready(await loadEncryption(fresh.ctx)).unlocked).toBe(true);
    expect(passkeys.get).toHaveBeenCalledTimes(1);
  });

  it('requires the recovery secret before creating a passkey', async () => {
    const srv = server();
    const { laptop, account } = await setUp(srv);
    const passkeys = fakePasskey();
    await flowRefusal(
      addPasskey({ ...laptop, passkeys }, account, generateSymmetricKey()),
      'wrong-recovery-key'
    );
    expect(passkeys.create).not.toHaveBeenCalled();
    expect(
      count(srv.db, 'SELECT COUNT(*) AS n FROM e2ee_device_list_entries')
    ).toBe(1);
  });

  it.each(['unsupported', 'canceled'])(
    'leaves enrollment unchanged when PRF is %s',
    async (reason) => {
      const srv = server();
      const { laptop, account, recovery } = await setUp(srv);
      const passkeys = fakePasskey();
      passkeys.create.mockRejectedValue(new PasskeyError(reason));
      await expect(
        addPasskey({ ...laptop, passkeys }, account, recovery.secret)
      ).rejects.toThrow(reason);
      expect(
        count(srv.db, 'SELECT COUNT(*) AS n FROM e2ee_device_list_entries')
      ).toBe(1);
      expect(count(srv.db, 'SELECT COUNT(*) AS n FROM e2ee_key_wraps')).toBe(5);
    }
  );

  it('refuses unknown and wrong-secret passkeys without certifying or saving a device', async () => {
    const srv = server();
    await withPasskey(srv);
    for (const passkeys of [
      fakePasskey('other'),
      fakePasskey('pk_test', 0x72)
    ]) {
      const fresh = await passkeyDevice(srv, passkeys);
      await flowRefusal(
        enrollWithPasskey(fresh.ctx, fresh.account, 'Impostor'),
        'wrong-passkey'
      );
      expect(await fresh.ctx.store.loadDevice(USER)).toBeNull();
      expect(unlockedEncryptionKey(USER)).toBeNull();
      expect(
        passkeys.issued.every((bytes) => bytes.every((b) => b === 0))
      ).toBe(true);
    }
    expect(
      count(srv.db, 'SELECT COUNT(*) AS n FROM e2ee_device_list_entries')
    ).toBe(2);
  });

  it('revokes read-only access with a passkey while retaining certified and recovery targets', async () => {
    const srv = server();
    const { laptop, account, recovery, passkeys } = await withPasskey(srv);
    const phone = device(srv);
    const request = await requestApproval(phone, null, 'Read-only phone');
    if (request.step !== 'waiting') throw new Error('Expected request');
    await approveDevice(
      laptop,
      account,
      request.approval,
      { kind: 'scan', code: request.scanCode },
      null
    );
    expect((await advanceApprovalAsNewDevice(phone)).step).toBe('done');
    const before = ready(await loadEncryption(laptop));
    const rotated = ready(
      await revokeReadOnlyDevices(laptop, before, 'passkey')
    );
    expect(rotated.fingerprint).toBe(before.fingerprint);
    expect(rotated.list.devices).toEqual(before.list.devices);
    expect(rotated.list.unlockTargets).toEqual(before.list.unlockTargets);
    expect(rotated.list.head.accountKeyCommitment).not.toEqual(
      before.list.head.accountKeyCommitment
    );
    expect(rotated.list.head.encryptionKey).not.toEqual(
      before.list.head.encryptionKey
    );
    expect(rotated.approvedDevices).toEqual([]);
    lockAccount(USER);
    expect(ready(await loadEncryption(phone)).unlocked).toBe(false);
    lockAccount(USER);
    expect(ready(await loadEncryption(laptop)).unlocked).toBe(true);
    const fresh = await passkeyDevice(srv, passkeys);
    expect(
      ready(
        await enrollWithPasskey(fresh.ctx, fresh.account, 'Passkey survivor')
      ).unlocked
    ).toBe(true);
    expect(
      (await enrolled(srv, recovery.secret, 'Recovery survivor')).account
        .unlocked
    ).toBe(true);
    expect(
      passkeys.issued.every((bytes) => bytes.every((byte) => byte === 0))
    ).toBe(true);
  });

  it('keeps every surviving passkey and recovery target usable after passkey-authorized device removal', async () => {
    const srv = server();
    const { laptop, account, recovery, passkeys } = await withPasskey(srv);
    const second = fakePasskey('pk_second', 0x72);
    await addPasskey({ ...laptop, passkeys: second }, account, recovery.secret);
    const other = await enrolled(srv, recovery.secret, 'To remove');
    const before = ready(await loadEncryption(laptop));
    const rotated = ready(
      await removeDevice(
        laptop,
        before,
        other.account.device!.deviceId,
        'passkey'
      )
    );
    expect(rotated.fingerprint).toBe(account.fingerprint);
    expect(rotated.list.head.accountKeyCommitment).not.toEqual(
      before.list.head.accountKeyCommitment
    );
    expect(rotated.list.head.encryptionKey).not.toEqual(
      before.list.head.encryptionKey
    );
    expect(ready(await loadEncryption(other.ctx)).unlocked).toBe(false);
    for (const provider of [passkeys, second]) {
      const fresh = await passkeyDevice(srv, provider);
      expect(
        ready(await enrollWithPasskey(fresh.ctx, fresh.account, 'Survivor'))
          .unlocked
      ).toBe(true);
    }
    expect(
      (await enrolled(srv, recovery.secret, 'Recovery browser')).account
        .unlocked
    ).toBe(true);
  });

  it('revokes a passkey, erases all its wraps and rotates both keys while retaining recovery', async () => {
    const srv = server();
    const { laptop, account, recovery, passkeys } = await withPasskey(srv);
    const removed = ready(
      await removePasskey(laptop, account, 'pk_test', 'passkey')
    );
    expect(removed.fingerprint).toBe(account.fingerprint);
    expect(removed.list.head.accountKeyCommitment).not.toEqual(
      account.list.head.accountKeyCommitment
    );
    expect(removed.list.head.encryptionKey).not.toEqual(
      account.list.head.encryptionKey
    );
    expect(removed.list.unlockTargets.map((t) => t.kind)).toEqual([
      'recovery-key'
    ]);
    expect(removed.wraps.some((w) => w.targetId === 'pk_test')).toBe(false);
    const fresh = await passkeyDevice(srv, passkeys);
    await flowRefusal(
      enrollWithPasskey(fresh.ctx, fresh.account, 'Removed'),
      'wrong-passkey'
    );
    expect(
      (await enrolled(srv, recovery.secret, 'Recovery browser')).account
        .unlocked
    ).toBe(true);
  });

  it('drops passkeys on recovery/identity replacement and refuses their old secrets', async () => {
    const srv = server();
    const { laptop, account, recovery, passkeys } = await withPasskey(srv);
    const replacement = await generateRecoveryKey();
    const changed = ready(
      await replaceRecoveryKey(
        laptop,
        account,
        replacement.secret,
        recovery.secret
      )
    );
    expect(changed.list.unlockTargets.map((t) => t.kind)).toEqual([
      'recovery-key'
    ]);
    expect(changed.fingerprint).not.toBe(account.fingerprint);
    const fresh = await passkeyDevice(srv, passkeys);
    await flowRefusal(
      enrollWithPasskey(fresh.ctx, fresh.account, 'Old identity'),
      'wrong-passkey'
    );
    expect(changed.wraps.some((w) => w.targetId === 'pk_test')).toBe(false);
  });

  it.each(['account-key', 'identity-key', 'unlock-target-key'] as const)(
    'requires the %s wrap atomically when adding a passkey',
    async (purpose) => {
      const srv = server();
      const { laptop, account, recovery } = await setUp(srv);
      const ctx = {
        ...laptop,
        passkeys: fakePasskey(),
        api: {
          ...laptop.api,
          appendDeviceList: (
            request: Parameters<typeof laptop.api.appendDeviceList>[0]
          ) =>
            laptop.api.appendDeviceList({
              ...request,
              wraps: request.wraps.filter((w) => w.purpose !== purpose)
            })
        }
      };
      expect(
        (await refusal(addPasskey(ctx, account, recovery.secret))).status
      ).toBe(400);
      expect(
        count(srv.db, 'SELECT COUNT(*) AS n FROM e2ee_device_list_entries')
      ).toBe(1);
      expect(count(srv.db, 'SELECT COUNT(*) AS n FROM e2ee_key_wraps')).toBe(5);
    }
  );

  it('rejects enrollment that overwrites an existing target wrap', async () => {
    const srv = server();
    const { laptop, account, recovery } = await withPasskey(srv);
    const ctx = {
      ...laptop,
      passkeys: fakePasskey('pk_second'),
      api: {
        ...laptop.api,
        appendDeviceList: (
          request: Parameters<typeof laptop.api.appendDeviceList>[0]
        ) =>
          laptop.api.appendDeviceList({
            ...request,
            wraps: [
              ...request.wraps,
              {
                purpose: 'unlock-target-key',
                targetId: 'pk_test',
                wrapped: toBase64Url(Uint8Array.of(1))
              }
            ]
          })
      }
    };
    expect(
      (await refusal(addPasskey(ctx, account, recovery.secret))).status
    ).toBe(400);
    expect(
      count(srv.db, 'SELECT COUNT(*) AS n FROM e2ee_device_list_entries')
    ).toBe(2);
  });

  it('refuses a server-substituted account key sealed to the genuine passkey target', async () => {
    const srv = server();
    const { account, passkeys } = await withPasskey(srv);
    const target = account.list.unlockTargets.find(
      (t) => t.kind === 'passkey'
    )!;
    const malicious = toBase64Url(
      await sealKey(target.publicKey, generateSymmetricKey(), {
        purpose: 'account-key',
        userId: USER,
        method: 'passkey-prf',
        unlockId: target.targetId
      })
    );
    srv.db
      .prepare(
        "UPDATE e2ee_key_wraps SET wrapped = ? WHERE purpose = 'account-key' AND target_id = ?"
      )
      .run(malicious, target.targetId);
    const fresh = await passkeyDevice(srv, passkeys);
    await flowRefusal(
      enrollWithPasskey(fresh.ctx, fresh.account, 'Substituted'),
      'key-mismatch'
    );
    expect(await fresh.ctx.store.loadDevice(USER)).toBeNull();
  });

  it('checks the target private key against the signed public half', async () => {
    const srv = server();
    const { account, passkeys } = await withPasskey(srv);
    const otherTarget = await generateEncryptionKeyPair(true);
    const wrong = await wrapKey(
      new Uint8Array(32).fill(0x71),
      await exportPrivateKey(otherTarget.privateKey),
      {
        purpose: 'unlock-target-key',
        userId: USER,
        method: 'passkey-prf',
        unlockId: 'pk_test',
        identityKeyHash: toHex(await publicKeyHash(account.list.identityKey))
      }
    );
    srv.db
      .prepare(
        "UPDATE e2ee_key_wraps SET wrapped = ? WHERE purpose = 'unlock-target-key' AND target_id = 'pk_test'"
      )
      .run(toBase64Url(wrong));
    const fresh = await passkeyDevice(srv, passkeys);
    await flowRefusal(
      enrollWithPasskey(fresh.ctx, fresh.account, 'Wrong target'),
      'key-mismatch'
    );
  });

  it('binds target-key wraps to the expected identity hash', async () => {
    const srv = server();
    const { passkeys } = await withPasskey(srv);
    const target = await generateEncryptionKeyPair(true);
    const wrong = await wrapKey(
      new Uint8Array(32).fill(0x71),
      await exportPrivateKey(target.privateKey),
      {
        purpose: 'unlock-target-key',
        userId: USER,
        method: 'passkey-prf',
        unlockId: 'pk_test',
        identityKeyHash: '00'.repeat(32)
      }
    );
    srv.db
      .prepare(
        "UPDATE e2ee_key_wraps SET wrapped = ? WHERE purpose = 'unlock-target-key' AND target_id = 'pk_test'"
      )
      .run(toBase64Url(wrong));
    const fresh = await passkeyDevice(srv, passkeys);
    await expect(
      enrollWithPasskey(fresh.ctx, fresh.account, 'Wrong identity')
    ).rejects.toThrow();
    expect(await fresh.ctx.store.loadDevice(USER)).toBeNull();
  });

  it('keeps the existing pin when a passkey write is answered with an old prefix', async () => {
    const srv = server();
    const { laptop, account, recovery } = await setUp(srv);
    const old = await laptop.api.account();
    const pin = await laptop.store.loadPin(USER);
    srv.tamper = (path, body) =>
      path === '/api/e2ee/device-list' ? old : body;
    await flowRefusal(
      addPasskey(
        { ...laptop, passkeys: fakePasskey() },
        account,
        recovery.secret
      ),
      'key-mismatch'
    );
    expect(await laptop.store.loadPin(USER)).toEqual(pin);
  });

  it('conflicts on a stale device-list append without partial passkey wraps', async () => {
    const srv = server();
    const { laptop, account, recovery } = await setUp(srv);
    await addPasskey(
      { ...laptop, passkeys: fakePasskey() },
      account,
      recovery.secret
    );
    const conflict = await refusal(
      addPasskey(
        { ...laptop, passkeys: fakePasskey('pk_stale') },
        account,
        recovery.secret
      )
    );
    expect(conflict.status).toBe(409);
    expect(passkeyEnrollmentCleanup(conflict)).toContain(
      'OpenZCAD encryption pk_stale'
    );
    expect(passkeyEnrollmentCleanup(conflict)).toContain(
      'unlock method marked stale'
    );
    expect(
      count(
        srv.db,
        "SELECT COUNT(*) AS n FROM e2ee_key_wraps WHERE target_id = 'pk_stale'"
      )
    ).toBe(0);
  });

  it('identifies both the provider credential and a possibly committed target after a lost response', async () => {
    const srv = server();
    const { laptop, account, recovery } = await setUp(srv);
    const passkeys = fakePasskey();
    const failure = new Error('Enrollment response was lost');
    const api = {
      ...laptop.api,
      appendDeviceList: async (
        input: Parameters<typeof laptop.api.appendDeviceList>[0]
      ) => {
        await laptop.api.appendDeviceList(input);
        throw failure;
      }
    };
    const caught: unknown = await addPasskey(
      { ...laptop, api, passkeys },
      account,
      recovery.secret
    ).catch((error: unknown) => error);
    expect(caught).toBe(failure);
    expect(passkeyEnrollmentCleanup(caught)).toContain(
      'remove only "OpenZCAD encryption pk_test"'
    );
    expect(passkeyEnrollmentCleanup(caught)).toContain(
      'unlock method marked test'
    );
    expect(
      count(
        srv.db,
        "SELECT COUNT(*) AS n FROM e2ee_key_wraps WHERE target_id = 'pk_test'"
      )
    ).toBe(3);
    expect(
      ready(await loadEncryption(laptop)).list.unlockTargets.some(
        (target) => target.targetId === 'pk_test'
      )
    ).toBe(true);
    expect(
      passkeys.issued.every((bytes) => bytes.every((byte) => byte === 0))
    ).toBe(true);
  });

  it.each(['create', 'get', 'revoke-read-only'] as const)(
    'does not resume %s after session teardown',
    async (operation) => {
      const srv = server();
      const { laptop, account, recovery } = await withPasskey(srv);
      let finish!: (value: PasskeySecret) => void;
      let started!: () => void;
      const waiting = new Promise<void>((resolve) => {
        started = resolve;
      });
      const provider = fakePasskey();
      provider[operation === 'create' ? 'create' : 'get'].mockImplementation(
        () => {
          started();
          return new Promise<PasskeySecret>((resolve) => {
            finish = resolve;
          });
        }
      );
      const fresh =
        operation === 'get'
          ? await passkeyDevice(srv, provider)
          : { ctx: { ...laptop, passkeys: provider }, account };
      const work =
        operation === 'create'
          ? addPasskey(fresh.ctx, fresh.account, recovery.secret)
          : operation === 'get'
            ? enrollWithPasskey(fresh.ctx, fresh.account, 'Too late')
            : revokeReadOnlyDevices(fresh.ctx, fresh.account, 'passkey');
      await waiting;
      lockAccountsExcept(null);
      const bytes = new Uint8Array(32).fill(0x71);
      finish({ targetId: 'pk_test', secret: bytes });
      await expect(work).rejects.toHaveProperty('name', 'AbortError');
      expect(bytes.every((b) => b === 0)).toBe(true);
      expect(unlockedEncryptionKey(USER)).toBeNull();
      expect(
        count(srv.db, 'SELECT COUNT(*) AS n FROM e2ee_device_list_entries')
      ).toBe(2);
    }
  );
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
    // Replacements now hold the device lock, which the delayed one keeps;
    // this writer skips it to prove the pin compare-and-swap still refuses
    // the delayed write on its own.
    const newer = ready(
      await replaceRecoveryKey(
        {
          ...laptop,
          store: { ...laptop.store, withDeviceLock: (_, run) => run() }
        },
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

/**
 * A stand-in for the desktop host: it holds non-extractable WebCrypto keys
 * and hands back only public keys, signatures and secrets, as the Rust
 * commands do (`apps/desktop/device-keys`).
 */
function fakeKeychainHost() {
  const keys = new Map<string, { signing: CryptoKey; unlock: CryptoKey }>();
  const calls = { sign: 0, derive: 0 };
  let next = 0;
  const host: KeychainHost = {
    create: async () => {
      const signing = await generateSigningKeyPair(false);
      const unlock = await generateEncryptionKeyPair(false);
      const keyId = `dk_${(++next).toString(16).padStart(32, '0')}`;
      keys.set(keyId, {
        signing: signing.privateKey,
        unlock: unlock.privateKey
      });
      return {
        keyId,
        signingPublicKey: await exportPublicKey(signing.publicKey),
        unlockPublicKey: await exportPublicKey(unlock.publicKey)
      };
    },
    sign: async (keyId, message) => {
      calls.sign++;
      const key = keys.get(keyId);
      if (!key) throw new Error('This device key is not in the Keychain.');
      return new Uint8Array(
        await crypto.subtle.sign(
          { name: 'ECDSA', hash: 'SHA-256' },
          key.signing,
          new Uint8Array(message)
        )
      );
    },
    derive: async (keyId, peer) => {
      calls.derive++;
      const key = keys.get(keyId);
      if (!key) throw new Error('This device key is not in the Keychain.');
      const peerKey = await crypto.subtle.importKey(
        'raw',
        new Uint8Array(peer),
        { name: 'ECDH', namedCurve: 'P-256' },
        false,
        []
      );
      return new Uint8Array(
        await crypto.subtle.deriveBits(
          { name: 'ECDH', public: peerKey },
          key.unlock,
          256
        )
      );
    },
    remove: async (keyId) => {
      keys.delete(keyId);
    }
  };
  return { host, keys, calls };
}

describe('desktop Keychain device keys', () => {
  it('sets up, unlocks, signs and forgets a device whose private keys stay in the host', async () => {
    const srv = server();
    const keychain = fakeKeychainHost();
    const mac: E2eeContext = {
      ...device(srv),
      store: keychainDeviceStore(memoryDeviceStore(), keychain.host),
      createDeviceKeys: createKeychainDeviceKeys(keychain.host)
    };
    const recovery = await generateRecoveryKey();
    const account = ready(
      await setUpEncryption(mac, {
        recoverySecret: recovery.secret,
        label: 'Mac'
      })
    );
    expect(keychain.keys.size).toBe(1);
    const stored = (await mac.store.loadDevice(USER))!;
    expect(isExternalSigningKey(stored.signing.privateKey)).toBe(true);
    expect(isExternalAgreementKey(stored.unlock.privateKey)).toBe(true);

    // A fresh session unlocks through the host's ECDH, never a CryptoKey.
    lockAccount(USER);
    const derives = keychain.calls.derive;
    expect(ready(await loadEncryption(mac)).unlocked).toBe(true);
    expect(keychain.calls.derive).toBeGreaterThan(derives);

    // The device key signs the identity transition the server verifies.
    const signs = keychain.calls.sign;
    ready(
      await replaceRecoveryKey(
        mac,
        ready(await loadEncryption(mac)),
        (await generateRecoveryKey()).secret,
        null
      )
    );
    expect(keychain.calls.sign).toBeGreaterThan(signs);
    expect(account.device?.deviceId).toBe(stored.deviceId);

    // Forgetting the device removes its Keychain keys as well as the record.
    await forgetThisDevice(mac);
    expect(await mac.store.loadDevice(USER)).toBeNull();
    expect(keychain.keys.size).toBe(0);
    lockAccount(USER);
  });

  /**
   * A Keychain whose key creation waits for `release`, so a test can end the
   * session while native creation is still in flight.
   */
  function gatedCreation(keychain: ReturnType<typeof fakeKeychainHost>) {
    let release!: () => void;
    let started!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const creating = new Promise<void>((resolve) => {
      started = resolve;
    });
    const host: KeychainHost = {
      ...keychain.host,
      create: async () => {
        const created = await keychain.host.create();
        started();
        await gate;
        return created;
      }
    };
    return { host, release, creating };
  }

  function macContext(
    srv: Server,
    keychain: ReturnType<typeof fakeKeychainHost>,
    host: KeychainHost = keychain.host
  ) {
    const session = { current: true };
    const mac: E2eeContext = {
      ...device(srv),
      store: keychainDeviceStore(memoryDeviceStore(), keychain.host),
      createDeviceKeys: createKeychainDeviceKeys(host),
      isCurrent: () => session.current
    };
    return { mac, session };
  }

  it.each(['setup', 'enrollment', 'approval'] as const)(
    'removes native keys when the session ends while %s is creating them',
    async (flow) => {
      allowKeySession(getKeySessionRevision());
      const srv = server();
      const keychain = fakeKeychainHost();
      const gated = gatedCreation(keychain);
      const { mac, session } = macContext(srv, keychain, gated.host);
      let running: Promise<unknown>;
      if (flow === 'setup') {
        running = setUpEncryption(mac, {
          recoverySecret: (await generateRecoveryKey()).secret,
          label: 'Mac'
        });
      } else {
        const { recovery } = await setUp(srv);
        lockAccount(USER);
        const fresh = ready(await loadEncryption(mac));
        running =
          flow === 'enrollment'
            ? enrollWithRecoveryKey(mac, fresh, recovery.secret, 'Mac')
            : requestApproval(mac, fresh, 'Mac');
      }
      // The settings close while the Keychain is still creating the keys.
      await gated.creating;
      expect(keychain.keys.size).toBe(1);
      session.current = false;
      gated.release();
      await flowRefusal(running, 'invalid-request');
      // No record took the candidate, so its keys are gone too.
      expect(keychain.keys.size).toBe(0);
      expect(await mac.store.loadDevice(USER)).toBeNull();
      lockAccount(USER);
    }
  );

  it('removes native keys when IndexedDB rejects the new device during setup', async () => {
    allowKeySession(getKeySessionRevision());
    const srv = server();
    const keychain = fakeKeychainHost();
    const inner = memoryDeviceStore();
    const mac: E2eeContext = {
      ...device(srv),
      store: keychainDeviceStore(
        {
          ...inner,
          getOrCreateDevice: async () => {
            throw new Error('IndexedDB transaction aborted');
          }
        },
        keychain.host
      ),
      createDeviceKeys: createKeychainDeviceKeys(keychain.host)
    };
    await expect(
      setUpEncryption(mac, {
        recoverySecret: (await generateRecoveryKey()).secret,
        label: 'Mac'
      })
    ).rejects.toThrow('IndexedDB transaction aborted');
    expect(keychain.keys.size).toBe(0);
    expect(count(srv.db, 'SELECT COUNT(*) AS n FROM e2ee_identities')).toBe(0);
  });

  it('removes the device and its native keys with a confirmed erasure, and retries a refused removal', async () => {
    allowKeySession(getKeySessionRevision());
    const srv = server();
    const keychain = fakeKeychainHost();
    const { mac } = macContext(srv, keychain);
    ready(
      await setUpEncryption(mac, {
        recoverySecret: (await generateRecoveryKey()).secret,
        label: 'Mac'
      })
    );
    expect(keychain.keys.size).toBe(1);
    const mls = mlsStores.memoryMlsSessionStore();
    await mls.getOrCreateStateKey(
      USER,
      await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, [
        'encrypt'
      ])
    );
    const mlsStore = vi
      .spyOn(mlsStores, 'indexedDbMlsSessionStore')
      .mockReturnValue(mls);
    const erase = () =>
      eraseAccountWithKeyCleanup({
        userId: USER,
        store: mac.store,
        isCurrentSession: () => true,
        erase: async () => ({ signedOut: true }),
        onSignedOut: () => {}
      });
    // The Keychain refuses: erasure reports it, the record keeps the key id,
    // and the pin and MLS cleanups still finish.
    const remove = keychain.host.remove;
    keychain.host.remove = async () => {
      throw new Error('Keychain locked');
    };
    await expect(erase()).rejects.toThrow('Keychain locked');
    expect(keychain.keys.size).toBe(1);
    expect(await mac.store.loadDevice(USER)).not.toBeNull();
    expect(await mac.store.loadPin(USER)).toBeNull();
    expect(await mls.loadStateKey(USER)).toBeNull();
    // The next removal for the account (here, another erasure) finishes it.
    keychain.host.remove = remove;
    await erase();
    expect(keychain.keys.size).toBe(0);
    expect(await mac.store.loadDevice(USER)).toBeNull();
    mlsStore.mockRestore();
    lockAccount(USER);
  });
});
