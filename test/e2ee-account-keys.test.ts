import { describe, expect, it } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import {
  accountKeyCommitment,
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
  replaceRecoveryKey,
  requestApproval,
  setUpEncryption,
  unlockedEncryptionKey,
  type AccountView,
  type E2eeContext,
  type EncryptionState
} from '../apps/web/src/lib/e2ee/accountKeys';
import { createE2eeApi, E2eeApiError } from '../apps/web/src/lib/e2ee/e2eeApi';
import { memoryDeviceStore } from '../apps/web/src/lib/e2ee/deviceStore';
import type { E2eeSetupRequest } from '@openzcad/shared';
import { d1Database, migratedDatabase } from './d1-sqlite';

const USER = 'user_alice';

interface Server {
  db: DatabaseSync;
  enabled: boolean;
  /** Rewrites a response body before the browser sees it. */
  tamper?: (path: string, body: unknown) => unknown;
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
  const env = { DB: d1Database(srv.db) };
  return async (path: string, init?: RequestInit) => {
    const response = await handleE2eeRequest(
      new Request(`https://zcad.test${path}`, init),
      env,
      { userId },
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
    expect(account.wraps.map((w) => `${w.purpose}:${w.targetId}`).sort()).toEqual(
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
    const phoneId = account.list.devices.find((d) => d.label === 'Phone')!
      .deviceId;
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
    const forged = await sealKey(stored.unlockPublicKey, generateSymmetricKey(), {
      purpose: 'account-key',
      userId: USER,
      method: 'device',
      unlockId: stored.deviceId
    });
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
    // It certifies itself later with the recovery key.
    const certified = ready(
      await enrollWithRecoveryKey(phone, readOnly, recovery.secret, 'Phone')
    );
    expect(certified.deviceStatus).toBe('certified');
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
    expect([skipped.status, skipped.code]).toEqual([409, 'E2EE_APPROVAL_STATE']);

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
    expect(
      await accountKeyCommitment(generateSymmetricKey())
    ).not.toEqual(decoded.accountKeyCommitment);
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
    return worker.fetch(
      new Request(`https://example.com${path}`, init),
      env
    );
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
    expect((await workerFetch(devEnv(), '/api/e2ee/account')).status).toBe(
      501
    );
    const open = devEnv({ E2EE_KEYS_ENABLED: 'true' });
    expect(await (await workerFetch(open, '/api/e2ee/config')).json()).toEqual(
      { enabled: true }
    );
    expect(
      await (await workerFetch(open, '/api/e2ee/account')).json()
    ).toEqual({ current: null, previous: [] });
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
    const { lockAccountsExcept, unlockedAccount } = await import(
      '../apps/web/src/lib/e2ee/unlockedKeys'
    );
    const held = unlockedAccount(USER)!;
    lockAccountsExcept(USER);
    expect(unlockedEncryptionKey(USER)).not.toBeNull();
    lockAccountsExcept(null);
    expect(unlockedEncryptionKey(USER)).toBeNull();
    expect(held.accountKey.every((byte) => byte === 0)).toBe(true);
  });
});
