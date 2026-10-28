import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  accountKeyCommitment,
  encryptContentBlob,
  encryptProjectEnvelope,
  encodeEncryptedDocumentBody,
  EnvelopeKey,
  exportPublicKey,
  generateEncryptionKeyPair,
  generateSigningKeyPair,
  generateSymmetricKey,
  nextDeviceListEntry,
  signDeviceListEntry,
  toHex,
  verifyDeviceList,
  type DeviceListEntry,
  type ProjectInfoBody,
  type ProjectEnvelopeHeaderInit
} from '@openzcad/crypto';
import type { AccountView } from './accountKeys';
import type { E2eeDecoder } from './decodeWorker';
import type { EnvelopeOpener } from './encryptedProjectStore';
import type { E2eeProjectEnvelopeRecord } from '@openzcad/shared';

beforeEach(() => {
  vi.resetModules();
  globalThis.indexedDB = new IDBFactory();
  localStorage.clear();
});

afterEach(() => vi.restoreAllMocks());

async function fixture() {
  const keys = await import('./unlockedKeys');
  const accountKeys = await import('./accountKeys');
  const bridge = await import('../desktopBridge');
  const userId = 'page_owner';
  const fetcher = vi
    .spyOn(bridge, 'desktopFetch')
    .mockImplementation(async (path) => {
      if (path !== '/api/session') throw new Error('Unexpected request');
      return new Response(JSON.stringify({ userId, email: null }));
    });
  const identity = await generateSigningKeyPair(false);
  const signing = await generateSigningKeyPair(false);
  const unlock = await generateEncryptionKeyPair(false);
  let encryption = await generateEncryptionKeyPair(false);
  const accountKey = generateSymmetricKey();
  const signingPublicKey = await exportPublicKey(signing.publicKey);
  const unlockPublicKey = await exportPublicKey(unlock.publicKey);
  const entry: DeviceListEntry = {
    userId,
    sequence: 0,
    previousEntryHash: null,
    previousIdentityKeyHash: null,
    issuedAt: 1_700_000_000_000,
    encryptionKey: await exportPublicKey(encryption.publicKey),
    accountKeyCommitment: await accountKeyCommitment(accountKey),
    devices: [
      {
        deviceId: 'browser',
        label: 'Browser',
        signingKey: signingPublicKey,
        unlockKey: unlockPublicKey,
        addedAt: 1_700_000_000_000
      }
    ],
    unlockTargets: [
      {
        kind: 'recovery-key',
        targetId: 'recovery',
        publicKey: await exportPublicKey(
          (await generateEncryptionKeyPair(false)).publicKey
        ),
        addedAt: 1_700_000_000_000
      }
    ],
    revoked: []
  };
  const chain = [await signDeviceListEntry(identity.privateKey, entry)];
  const list = await verifyDeviceList(identity.publicKey, chain);
  let account: AccountView = {
    userId,
    generation: 1,
    createdAt: '2026-01-01T00:00:00Z',
    list,
    persistedPin: list.pin,
    fingerprint: '',
    wraps: [],
    approvedDevices: [],
    device: {
      userId,
      deviceId: 'browser',
      label: 'Browser',
      signing,
      unlock,
      signingPublicKey,
      unlockPublicKey,
      createdAt: 1_700_000_000_000,
      approval: null
    },
    deviceStatus: 'certified',
    unlocked: true,
    unlockError: null,
    previous: []
  };
  const remember = (key: Uint8Array) =>
    keys.rememberUnlockedAccount(userId, {
      generation: account.generation,
      commitment: toHex(account.list.head.accountKeyCommitment),
      accountKey: key.slice(),
      encryptionPrivateKey: encryption.privateKey
    });
  remember(accountKey);
  const load = vi
    .spyOn(accountKeys, 'loadEncryption')
    .mockImplementation(async () => ({ kind: 'ready', account }));
  const page = await import('./encryptedProjects');
  const events = await import('./encryptionStateEvents');
  return {
    page,
    events,
    load,
    fetcher,
    userId,
    accountKey,
    lock() {
      keys.lockAccount(userId);
      account = { ...account, unlocked: false };
      events.encryptionStateChanged(userId);
    },
    async rotate() {
      const nextKey = generateSymmetricKey();
      encryption = await generateEncryptionKeyPair(false);
      const next = nextDeviceListEntry(account.list, {
        issuedAt: entry.issuedAt + 1,
        encryptionKey: await exportPublicKey(encryption.publicKey),
        accountKeyCommitment: await accountKeyCommitment(nextKey)
      });
      chain.push(await signDeviceListEntry(identity.privateKey, next));
      account = {
        ...account,
        list: await verifyDeviceList(identity.publicKey, chain)
      };
      remember(nextKey);
      events.encryptionStateChanged(userId);
      return nextKey;
    }
  };
}

/** Real blob encryption/decoding; only HTTP and the Worker transport are local. */
async function blobFixture() {
  const f = await fixture();
  const registry = await import('./blobReferences');
  const worker = await import('./decodeWorker');
  const jobs = await import('./decodeJobs');
  const plaintext = new TextEncoder().encode('Private encrypted QA source');
  const encrypted = await encryptContentBlob(
    EnvelopeKey.generate(),
    'import-source',
    plaintext,
    { compression: 'none' }
  );
  const envelope = new Blob([encrypted.envelope]);
  const download = vi.fn(async () => envelope);
  const projectId = 'blob_project';
  const blobId = encrypted.reference.blobId;
  const realFetch = f.fetcher.getMockImplementation()!;
  f.fetcher.mockImplementation(async (path, init) => {
    if (path === `/api/e2ee/projects/${projectId}/blobs/${blobId}`) {
      return new Response(await download());
    }
    return realFetch(path, init);
  });
  const decode = vi.fn<E2eeDecoder['decodeContentBlob']>((job) =>
    jobs.decodeContentBlobJob({ type: 'content-blob', ...job })
  );
  const realDecoder = worker.createE2eeDecoder;
  vi.spyOn(worker, 'createE2eeDecoder').mockImplementation(() => ({
    ...realDecoder(),
    decodeContentBlob: decode
  }));
  return {
    ...f,
    registry,
    plaintext,
    envelope,
    download,
    decode,
    jobs,
    projectId,
    blobId,
    async source() {
      const sharing = await f.page.encryptedShareLinks();
      sharing.ctx.blobReferences!.remember(projectId, encrypted.reference);
      return registry.encryptedBlobSource(blobId)!;
    }
  };
}

it('refreshes sharing, invitations and project clients after Settings rotates account keys without reloading', async () => {
  const f = await fixture();
  const oldShare = await f.page.encryptedShareLinks();
  const oldStore = await f.page.encryptedProjectStore();
  const oldInvitations = await f.page.encryptedInvitations();
  expect((await oldShare.ctx.groups.account.currentAccountKey()).key).toEqual(
    f.accountKey
  );
  f.events.encryptionStateChanged('another_account');
  expect(await f.page.encryptedShareLinks()).toBe(oldShare);
  const nextKey = await f.rotate();
  // A retired account view must fail before it can use the rotated key.
  await expect(oldShare.ctx.groups.account.currentAccountKey()).rejects.toThrow(
    'The account session ended.'
  );
  const nextShare = await f.page.encryptedShareLinks();
  expect((await nextShare.ctx.groups.account.currentAccountKey()).key).toEqual(
    nextKey
  );
  expect(await f.page.encryptedProjectStore()).not.toBe(oldStore);
  expect(await f.page.encryptedInvitations()).not.toBe(oldInvitations);
  expect(await f.page.encryptedShareLinks()).toBe(nextShare);
  expect(f.load).toHaveBeenCalledTimes(2);
});

it('keeps a fresh store usable after repeated encryption-settings rechecks', async () => {
  const f = await fixture();
  await f.page.encryptedShareLinks();
  f.events.encryptionStateChanged(f.userId);
  f.events.encryptionStateChanged(f.userId);
  const current = await f.page.encryptedShareLinks();
  expect((await current.ctx.groups.account.currentAccountKey()).key).toEqual(
    f.accountKey
  );
  expect(f.load).toHaveBeenCalledTimes(2);
});

it('refuses cached sharing clients once Settings reports the account locked', async () => {
  const f = await fixture();
  await f.page.encryptedShareLinks();
  f.lock();
  await expect(f.page.encryptedShareLinks()).rejects.toMatchObject({
    code: 'E2EE_KEYS_LOCKED'
  });
});

it('revokes a captured encrypted source and its registry entry when Settings locks', async () => {
  const f = await blobFixture();
  const source = await f.source();
  expect(await source.read()).toEqual(f.plaintext);
  f.lock();
  expect(f.registry.encryptedBlobSource(f.blobId)).toBeNull();
  expect(f.registry.pageBlobReferences.get(f.projectId, f.blobId)).toBeNull();
  await expect(source.read()).rejects.toMatchObject({
    name: 'KeySessionEndedError'
  });
  expect(f.download).toHaveBeenCalledOnce();
});

it('refuses a download that finishes after locking before submitting it for decoding', async () => {
  const f = await blobFixture();
  const source = await f.source();
  let finish!: (body: Blob) => void;
  f.download.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      })
  );
  const pending = source.read();
  const refused = expect(pending).rejects.toMatchObject({
    name: 'KeySessionEndedError'
  });
  await vi.waitFor(() => expect(f.download).toHaveBeenCalledOnce());
  f.lock();
  finish(f.envelope);
  await refused;
  expect(f.decode).not.toHaveBeenCalled();
});

it('wipes and refuses decoded chunks that finish after locking', async () => {
  const f = await blobFixture();
  const source = await f.source();
  let finish!: () => void;
  let chunks: Uint8Array[] | undefined;
  const gate = new Promise<void>((resolve) => {
    finish = resolve;
  });
  f.decode.mockImplementationOnce(async (job) => {
    const result = await f.jobs.decodeContentBlobJob({
      type: 'content-blob',
      ...job
    });
    if ('chunks' in result) chunks = result.chunks;
    await gate;
    return result;
  });
  const refused = expect(source.read()).rejects.toMatchObject({
    name: 'KeySessionEndedError'
  });
  await vi.waitFor(() => expect(chunks).toBeDefined());
  expect(chunks![0]).toEqual(f.plaintext);
  f.lock();
  finish();
  await refused;
  expect(chunks!.every((chunk) => chunk.every((byte) => byte === 0))).toBe(
    true
  );
});

it('refuses plaintext if locking lands between decoder completion and reader return', async () => {
  const f = await blobFixture();
  const source = await f.source();
  f.decode.mockImplementationOnce(async (job) => {
    const result = await f.jobs.decodeContentBlobJob({
      type: 'content-blob',
      ...job
    });
    queueMicrotask(() => queueMicrotask(f.lock));
    return result;
  });
  await expect(source.read()).rejects.toMatchObject({
    name: 'KeySessionEndedError'
  });
});

it('preserves unlocked blob reads through rechecks and rotation using a fresh reader', async () => {
  const f = await blobFixture();
  const oldSource = await f.source();
  const oldSharing = await f.page.encryptedShareLinks();
  expect(await oldSource.read()).toEqual(f.plaintext);
  for (const change of [
    async () => f.events.encryptionStateChanged(f.userId),
    () => f.rotate()
  ]) {
    await change();
    const fresh = f.registry.encryptedBlobSource(f.blobId);
    expect(fresh).not.toBeNull();
    const concurrent = f.registry.encryptedBlobSource(f.blobId)!;
    expect(await Promise.all([fresh!.read(), concurrent.read()])).toEqual([
      f.plaintext,
      f.plaintext
    ]);
    expect(
      oldSharing.ctx.blobReferences!.get(f.projectId, f.blobId)
    ).toBeNull();
  }
  await expect(oldSource.read()).rejects.toMatchObject({
    name: 'KeySessionEndedError'
  });
});

it('revokes a lazy source if Settings locks before any client reopens', async () => {
  const f = await blobFixture();
  await f.source();
  f.events.encryptionStateChanged(f.userId);
  const lazy = f.registry.encryptedBlobSource(f.blobId)!;
  expect(lazy).not.toBeNull();
  f.lock();
  expect(f.registry.encryptedBlobSource(f.blobId)).toBeNull();
  expect(f.registry.pageBlobReferences.get(f.projectId, f.blobId)).toBeNull();
  await expect(lazy.read()).rejects.toMatchObject({
    name: 'KeySessionEndedError'
  });
  expect(f.download).not.toHaveBeenCalled();
});

it('keeps concurrent blob lookups encrypted while the fresh account view is opening', async () => {
  const f = await blobFixture();
  await f.source();
  f.events.encryptionStateChanged(f.userId);
  const realLoad = f.load.getMockImplementation()!;
  let finish!: () => void;
  const gate = new Promise<void>((resolve) => {
    finish = resolve;
  });
  f.load.mockImplementationOnce(async (ctx) => {
    const state = await realLoad(ctx);
    await gate;
    return state;
  });
  const first = f.registry.encryptedBlobSource(f.blobId)!.read();
  try {
    await vi.waitFor(() => expect(f.load).toHaveBeenCalledTimes(2));
    const concurrent = f.registry.encryptedBlobSource(f.blobId);
    expect(concurrent).not.toBeNull();
    const second = concurrent!.read();
    finish();
    expect(await Promise.all([first, second])).toEqual([
      f.plaintext,
      f.plaintext
    ]);
    expect(f.load).toHaveBeenCalledTimes(2);
  } finally {
    finish();
    await first.catch(() => undefined);
  }
});

it('keeps lazy encrypted blob access retryable after a transient account fetch failure', async () => {
  const f = await blobFixture();
  await f.source();
  f.events.encryptionStateChanged(f.userId);
  f.load.mockRejectedValueOnce(new Error('Temporary account fetch failure'));
  const attempted = f.registry.encryptedBlobSource(f.blobId)!;
  await expect(attempted.read()).rejects.toThrow(
    'Temporary account fetch failure'
  );
  const retry = f.registry.encryptedBlobSource(f.blobId);
  expect(retry).not.toBeNull();
  expect(await retry!.read()).toEqual(f.plaintext);
  expect(f.load).toHaveBeenCalledTimes(3);
  expect(f.download).toHaveBeenCalledOnce();
});

it('clears retryable lazy file access when locking after a failed reopen', async () => {
  const f = await blobFixture();
  await f.source();
  f.events.encryptionStateChanged(f.userId);
  f.load.mockRejectedValueOnce(new Error('Temporary account fetch failure'));
  await expect(
    f.registry.encryptedBlobSource(f.blobId)!.read()
  ).rejects.toThrow('Temporary account fetch failure');
  const retry = f.registry.encryptedBlobSource(f.blobId)!;
  expect(retry).not.toBeNull();
  f.lock();
  expect(f.registry.encryptedBlobSource(f.blobId)).toBeNull();
  expect(f.registry.pageBlobReferences.get(f.projectId, f.blobId)).toBeNull();
  await expect(retry.read()).rejects.toMatchObject({
    name: 'KeySessionEndedError'
  });
  expect(f.load).toHaveBeenCalledTimes(2);
  expect(f.download).not.toHaveBeenCalled();
});

it('refuses a lazy source if locking lands during its session check', async () => {
  const f = await blobFixture();
  await f.source();
  f.events.encryptionStateChanged(f.userId);
  const lazy = f.registry.encryptedBlobSource(f.blobId)!;
  let finish!: (response: Response) => void;
  f.fetcher.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      })
  );
  const refused = expect(lazy.read()).rejects.toMatchObject({
    name: 'KeySessionEndedError'
  });
  f.lock();
  finish(new Response(JSON.stringify({ userId: f.userId, email: null })));
  await refused;
  expect(f.load).toHaveBeenCalledOnce();
  expect(f.download).not.toHaveBeenCalled();
});

it('refuses a no-blob project envelope decoded after Settings locks', async () => {
  const f = await fixture();
  const stores = await import('./encryptedProjectStore');
  const realStore = stores.createEncryptedProjectStore;
  let open!: EnvelopeOpener;
  vi.spyOn(stores, 'createEncryptedProjectStore').mockImplementation((ctx) => {
    open = ctx.open!;
    return realStore(ctx);
  });
  const worker = await import('./decodeWorker');
  const jobs = await import('./decodeJobs');
  const decode = vi.fn<E2eeDecoder['decodeProjectEnvelope']>((job) =>
    jobs.decodeProjectEnvelopeJob({ type: 'project-envelope', ...job })
  );
  const realDecoder = worker.createE2eeDecoder;
  vi.spyOn(worker, 'createE2eeDecoder').mockImplementation(() => ({
    ...realDecoder(),
    decodeProjectEnvelope: decode
  }));
  await f.page.encryptedProjectStore();
  const header: ProjectEnvelopeHeaderInit = {
    kind: 'document',
    projectId: 'private_project',
    documentVersion: 1,
    previousVersionHash: null,
    epochBindingHash: new Uint8Array(32).fill(1),
    schemaVersion: 1,
    keyEpoch: 1
  };
  const document = {
    projectId: header.projectId,
    name: 'Private no-blob document'
  };
  const key = EnvelopeKey.generate();
  const job = {
    kind: 'document' as const,
    versionKey: key.bytes,
    envelope: await encryptProjectEnvelope(
      key,
      header,
      encodeEncryptedDocumentBody(
        {
          document,
          blobs: [],
          revisionVersionHashes: new Map()
        },
        header
      )
    )
  };
  expect((await open(job)).value).toMatchObject({ document, blobs: [] });
  let finish!: () => void;
  let decoded = false;
  const gate = new Promise<void>((resolve) => {
    finish = resolve;
  });
  decode.mockImplementationOnce(async (input) => {
    const result = await jobs.decodeProjectEnvelopeJob({
      type: 'project-envelope',
      ...input
    });
    decoded = true;
    await gate;
    return result;
  });
  const refused = expect(open(job)).rejects.toMatchObject({
    name: 'KeySessionEndedError'
  });
  await vi.waitFor(() => expect(decoded).toBe(true));
  f.lock();
  finish();
  await refused;
});

it('does not let a superseded opening install a reader or access fresh references', async () => {
  const f = await blobFixture();
  const realLoad = f.load.getMockImplementation()!;
  let finish!: () => void;
  const gate = new Promise<void>((resolve) => {
    finish = resolve;
  });
  f.load.mockImplementationOnce(async (ctx) => {
    const state = await realLoad(ctx);
    await gate;
    return state;
  });
  const pending = f.page.encryptedShareLinks();
  const refused = expect(pending).rejects.toMatchObject({
    name: 'KeySessionEndedError'
  });
  await vi.waitFor(() => expect(f.load).toHaveBeenCalledOnce());
  f.events.encryptionStateChanged(f.userId);
  const fresh = await f.source();
  finish();
  await refused;
  expect(await fresh.read()).toEqual(f.plaintext);
  expect(await f.registry.encryptedBlobSource(f.blobId)!.read()).toEqual(
    f.plaintext
  );
});

it('does not let a superseded opening failure overwrite fresh verification status', async () => {
  const f = await fixture();
  const status = await import('./encryptionStatus');
  const failure = vi.spyOn(status, 'reportEncryptedFailure');
  let reject!: (error: Error) => void;
  f.load.mockImplementationOnce(
    () =>
      new Promise((_, fail) => {
        reject = fail;
      })
  );
  const oldOpening = f.page.encryptedShareLinks();
  const refused = expect(oldOpening).rejects.toThrow('Old opening failed');
  await vi.waitFor(() => expect(f.load).toHaveBeenCalledOnce());
  f.events.encryptionStateChanged(f.userId);
  const fresh = await f.page.encryptedShareLinks();
  reject(new Error('Old opening failed'));
  await refused;
  expect(await f.page.encryptedShareLinks()).toBe(fresh);
  expect(failure).not.toHaveBeenCalled();
});

it.each([false, true])(
  'retries progressive shelf verification after an unlocked recheck (old verifier fails=%s)',
  async (failOld) => {
    const f = await fixture();
    const stores = await import('./encryptedProjectStore');
    const real = stores.createEncryptedProjectStore;
    const verify = vi.fn(
      async () => ({ name: 'Fresh project name' }) as ProjectInfoBody
    );
    verify.mockImplementationOnce(async () => {
      f.events.encryptionStateChanged(f.userId);
      if (failOld) throw new Error('Retired verifier failed');
      return { name: 'Retired result' } as ProjectInfoBody;
    });
    vi.spyOn(stores, 'createEncryptedProjectStore').mockImplementation(
      (ctx) => {
        const store = real(ctx);
        vi.spyOn(store.info, 'verify').mockImplementation(verify);
        return store;
      }
    );
    const record = { projectId: 'shelf_project' } as E2eeProjectEnvelopeRecord;
    const onEntry = vi.fn();
    const result = await f.page.encryptedProjectShelf([record], {
      isCurrent: () => true,
      onEntry
    });
    expect(result.get(record.projectId)).toEqual({
      name: 'Fresh project name'
    });
    expect(onEntry).toHaveBeenCalledExactlyOnceWith(record.projectId, {
      name: 'Fresh project name'
    });
    expect(verify).toHaveBeenCalledTimes(2);
    expect(f.load).toHaveBeenCalledTimes(2);
  }
);

it('does not retry or publish progressive shelf data after locking', async () => {
  const f = await fixture();
  const stores = await import('./encryptedProjectStore');
  const real = stores.createEncryptedProjectStore;
  const verify = vi.fn(async () => {
    f.lock();
    return { name: 'Private project name' } as ProjectInfoBody;
  });
  vi.spyOn(stores, 'createEncryptedProjectStore').mockImplementation((ctx) => {
    const store = real(ctx);
    vi.spyOn(store.info, 'verify').mockImplementation(verify);
    return store;
  });
  const onEntry = vi.fn();
  const result = await f.page.encryptedProjectShelf(
    [{ projectId: 'shelf_project' } as E2eeProjectEnvelopeRecord],
    { isCurrent: () => true, onEntry }
  );
  expect(result.size).toBe(0);
  expect(onEntry).not.toHaveBeenCalled();
  expect(verify).toHaveBeenCalledOnce();
  expect(f.load).toHaveBeenCalledOnce();
});
