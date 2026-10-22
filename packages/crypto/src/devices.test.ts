import { describe, expect, it } from 'vitest';
import { deviceKeysHash, publicKeyHash } from './codes';
import {
  accountKeyCommitment,
  decodeDeviceApprovalGrant,
  decodeDeviceListEntry,
  deviceListEntryHash,
  encodeDeviceListEntry,
  nextDeviceListEntry,
  publicKeyOfPrivateKey,
  recoveryTarget,
  signDeviceApprovalGrant,
  signDeviceListEntry,
  signIdentityTransition,
  verifyDeviceApprovalGrant,
  verifyDeviceList,
  verifyIdentityTransition,
  type DeviceListEntry,
  type ListedDevice,
  type SignedDeviceListEntry
} from './devices';
import { E2eeError, type E2eeErrorCode } from './errors';
import {
  exportPrivateKey,
  exportPublicKey,
  generateEncryptionKeyPair,
  generateSigningKeyPair
} from './keys';
import { generateSymmetricKey } from './primitives';

async function rejectsWith(
  promise: Promise<unknown>,
  code: E2eeErrorCode
): Promise<void> {
  await expect(promise).rejects.toSatisfy(
    (error: unknown) => error instanceof E2eeError && error.code === code
  );
}

function throwsWith(run: () => unknown, code: E2eeErrorCode): void {
  expect(run).toThrow(
    expect.objectContaining({ name: 'E2eeError', code }) as unknown
  );
}

const USER = 'user_1';

async function rawKey(algorithm: 'ECDH' | 'ECDSA'): Promise<Uint8Array> {
  const pair =
    algorithm === 'ECDH'
      ? await generateEncryptionKeyPair()
      : await generateSigningKeyPair();
  return exportPublicKey(pair.publicKey);
}

async function device(id: string, label = id): Promise<ListedDevice> {
  return {
    deviceId: id,
    label,
    signingKey: await rawKey('ECDSA'),
    unlockKey: await rawKey('ECDH'),
    addedAt: 1_700_000_000_000
  };
}

interface Fixture {
  identity: CryptoKeyPair;
  identityRaw: Uint8Array;
  chain: SignedDeviceListEntry[];
  genesis: DeviceListEntry;
}

async function fixture(devices = 2): Promise<Fixture> {
  const identity = await generateSigningKeyPair(false);
  const identityRaw = await exportPublicKey(identity.publicKey);
  const listed: ListedDevice[] = [];
  for (let i = 0; i < devices; i += 1) listed.push(await device(`dev_${i}`));
  const genesis: DeviceListEntry = {
    userId: USER,
    sequence: 0,
    previousEntryHash: null,
    issuedAt: 1_700_000_000_000,
    previousIdentityKeyHash: null,
    encryptionKey: await rawKey('ECDH'),
    accountKeyCommitment: await accountKeyCommitment(generateSymmetricKey()),
    devices: listed,
    unlockTargets: [
      {
        kind: 'recovery-key',
        targetId: 'rk_1',
        publicKey: await rawKey('ECDH'),
        addedAt: 1_700_000_000_000
      }
    ],
    revoked: []
  };
  return {
    identity,
    identityRaw,
    genesis,
    chain: [await signDeviceListEntry(identity.privateKey, genesis)]
  };
}

async function append(
  f: Fixture,
  build: (
    list: Awaited<ReturnType<typeof verifyDeviceList>>
  ) => Promise<DeviceListEntry> | DeviceListEntry
): Promise<SignedDeviceListEntry[]> {
  const list = await verifyDeviceList(f.identityRaw, f.chain);
  const entry = await build(list);
  return [...f.chain, await signDeviceListEntry(f.identity.privateKey, entry)];
}

async function rotated() {
  return {
    encryptionKey: await rawKey('ECDH'),
    accountKeyCommitment: await accountKeyCommitment(generateSymmetricKey())
  };
}

describe('device list entries', () => {
  it('encode canonically and decode back', async () => {
    const { genesis } = await fixture(3);
    const bytes = encodeDeviceListEntry(genesis);
    expect([...bytes.subarray(0, 4)]).toEqual([0x4f, 0x5a, 0x44, 1]);
    const decoded = decodeDeviceListEntry(bytes);
    expect(decoded.devices.map((d) => d.deviceId)).toEqual([
      'dev_0',
      'dev_1',
      'dev_2'
    ]);
    // Input order does not matter: the encoding sorts.
    const shuffled = { ...genesis, devices: [...genesis.devices].reverse() };
    expect(encodeDeviceListEntry(shuffled)).toEqual(bytes);
    expect(encodeDeviceListEntry(decoded)).toEqual(bytes);
  });

  it('refuses non-canonical, truncated and unknown bytes', async () => {
    const { genesis } = await fixture();
    const bytes = encodeDeviceListEntry(genesis);
    throwsWith(() => decodeDeviceListEntry(bytes.subarray(0, 40)), 'malformed');
    const trailing = new Uint8Array(bytes.byteLength + 1);
    trailing.set(bytes);
    throwsWith(() => decodeDeviceListEntry(trailing), 'malformed');
    const future = new Uint8Array(bytes);
    future[3] = 2;
    throwsWith(() => decodeDeviceListEntry(future), 'unsupported-version');
    const magic = new Uint8Array(bytes);
    magic[0] = 0;
    throwsWith(() => decodeDeviceListEntry(magic), 'malformed');
  });

  it('refuses entries that break the shape rules', async () => {
    const { genesis } = await fixture();
    const bad: Partial<DeviceListEntry>[] = [
      { devices: [] },
      { unlockTargets: [] },
      {
        unlockTargets: [
          ...genesis.unlockTargets,
          {
            ...genesis.unlockTargets[0]!,
            targetId: 'rk_2',
            publicKey: genesis.devices[0]!.unlockKey
          }
        ]
      },
      {
        devices: [
          genesis.devices[0]!,
          { ...genesis.devices[1]!, deviceId: 'dev_0' }
        ]
      },
      { devices: [{ ...genesis.devices[0]!, label: '' }] },
      { devices: [{ ...genesis.devices[0]!, label: 'tab\there' }] },
      { devices: [{ ...genesis.devices[0]!, label: 'x'.repeat(65) }] },
      {
        devices: [
          { ...genesis.devices[0]!, unlockKey: genesis.devices[0]!.signingKey }
        ]
      },
      { revoked: [{ kind: 'device', id: 'dev_9' }] },
      { sequence: 1 },
      { previousIdentityKeyHash: new Uint8Array(31) },
      { accountKeyCommitment: new Uint8Array(31) }
    ];
    for (const change of bad) {
      throwsWith(
        () => encodeDeviceListEntry({ ...genesis, ...change }),
        'invalid-argument'
      );
    }
  });
});

describe('verifying a device list', () => {
  it('accepts a signed chain and reports the head', async () => {
    const f = await fixture();
    const list = await verifyDeviceList(f.identityRaw, f.chain);
    expect(list.userId).toBe(USER);
    expect(list.devices.map((d) => d.deviceId)).toEqual(['dev_0', 'dev_1']);
    expect(list.devices[0]!.certifiedAt).toBe(0);
    expect(list.identityKeyHash).toEqual(await publicKeyHash(f.identityRaw));
    expect(recoveryTarget(list).targetId).toBe('rk_1');
    expect(list.pin).toEqual({
      identityKeyHash: list.identityKeyHash,
      sequence: 0,
      entryHash: await deviceListEntryHash(f.chain[0]!.entry)
    });
  });

  it('refuses another identity, a bad signature and a broken link', async () => {
    const f = await fixture();
    const other = await generateSigningKeyPair();
    await rejectsWith(
      verifyDeviceList(await exportPublicKey(other.publicKey), f.chain),
      'authentication-failed'
    );
    const tampered = new Uint8Array(f.chain[0]!.signature);
    tampered[10]! ^= 1;
    await rejectsWith(
      verifyDeviceList(f.identityRaw, [
        { entry: f.chain[0]!.entry, signature: tampered }
      ]),
      'authentication-failed'
    );
    const added = await device('dev_9');
    const next = await append(f, (list) =>
      nextDeviceListEntry(list, { issuedAt: 1, addDevices: [added] })
    );
    // Skipping the first entry, or reordering, breaks the chain.
    await rejectsWith(
      verifyDeviceList(f.identityRaw, [next[1]!]),
      'chain-broken'
    );
    await rejectsWith(
      verifyDeviceList(f.identityRaw, [next[1]!, next[0]!]),
      'chain-broken'
    );
    await rejectsWith(verifyDeviceList(f.identityRaw, []), 'chain-broken');
  });

  it('adds a device without rotating, and removes one only with rotation', async () => {
    const f = await fixture();
    const added = await device('dev_2', 'Phone');
    f.chain = await append(f, (list) =>
      nextDeviceListEntry(list, { issuedAt: 2, addDevices: [added] })
    );
    let list = await verifyDeviceList(f.identityRaw, f.chain);
    expect(list.devices.find((d) => d.deviceId === 'dev_2')?.certifiedAt).toBe(
      1
    );
    expect(() =>
      nextDeviceListEntry(list, { issuedAt: 3, removeDeviceIds: ['dev_1'] })
    ).toThrow(E2eeError);
    // A hand-built removal that keeps the old keys is refused on read.
    const lazy = await append(f, (current) => ({
      ...nextDeviceListEntry(current, {
        issuedAt: 3,
        removeDeviceIds: ['dev_1'],
        encryptionKey: current.head.encryptionKey,
        accountKeyCommitment: current.head.accountKeyCommitment
      })
    }));
    await rejectsWith(verifyDeviceList(f.identityRaw, lazy), 'chain-broken');
    const keys = await rotated();
    f.chain = await append(f, (current) =>
      nextDeviceListEntry(current, {
        issuedAt: 3,
        removeDeviceIds: ['dev_1'],
        ...keys
      })
    );
    list = await verifyDeviceList(f.identityRaw, f.chain);
    expect(list.devices.map((d) => d.deviceId).sort()).toEqual([
      'dev_0',
      'dev_2'
    ]);
    expect(list.revoked).toEqual([
      expect.objectContaining({ kind: 'device', id: 'dev_1', revokedAt: 2 })
    ]);
    expect(list.revoked[0]!.device?.signingKeyHash).toHaveLength(32);
    expect(list.head.encryptionKey).toEqual(keys.encryptionKey);
  });

  it.each(['encryptionKey', 'accountKeyCommitment'] as const)(
    'refuses a signed one-sided %s rotation even without revocations',
    async (field) => {
      const f = await fixture();
      const keys = await rotated();
      const chain = await append(f, (list) => ({
        ...nextDeviceListEntry(list, { issuedAt: 2 }),
        [field]: keys[field]
      }));
      await rejectsWith(verifyDeviceList(f.identityRaw, chain), 'chain-broken');
      const paired = await append(f, (list) =>
        nextDeviceListEntry(list, { issuedAt: 2, ...keys })
      );
      expect(
        (await verifyDeviceList(f.identityRaw, paired)).head.sequence
      ).toBe(1);
    }
  );

  it('refuses a silent drop, a returning device and a returning key', async () => {
    const f = await fixture(3);
    const silent = await append(f, async (list) => ({
      ...nextDeviceListEntry(list, {
        issuedAt: 2,
        removeDeviceIds: ['dev_2'],
        ...(await rotated())
      }),
      revoked: []
    }));
    await rejectsWith(verifyDeviceList(f.identityRaw, silent), 'chain-broken');

    const keys = await rotated();
    const removed = f.genesis.devices.find((d) => d.deviceId === 'dev_2')!;
    f.chain = await append(f, (list) =>
      nextDeviceListEntry(list, {
        issuedAt: 2,
        removeDeviceIds: ['dev_2'],
        ...keys
      })
    );
    const back = await append(f, (list) =>
      nextDeviceListEntry(list, { issuedAt: 3, addDevices: [removed] })
    );
    await rejectsWith(verifyDeviceList(f.identityRaw, back), 'chain-broken');
    const sameKeyNewId = await append(f, (list) =>
      nextDeviceListEntry(list, {
        issuedAt: 3,
        addDevices: [{ ...removed, deviceId: 'dev_new' }]
      })
    );
    await rejectsWith(
      verifyDeviceList(f.identityRaw, sameKeyNewId),
      'chain-broken'
    );
    const oldEncryption = await append(f, async (list) =>
      nextDeviceListEntry(list, {
        issuedAt: 3,
        removeDeviceIds: ['dev_1'],
        encryptionKey: f.genesis.encryptionKey,
        accountKeyCommitment: (await rotated()).accountKeyCommitment
      })
    );
    await rejectsWith(
      verifyDeviceList(f.identityRaw, oldEncryption),
      'chain-broken'
    );
  });

  it('keeps the recovery-key target for the life of the identity', async () => {
    const f = await fixture();
    expect(() =>
      nextDeviceListEntry(
        { head: f.genesis } as Awaited<ReturnType<typeof verifyDeviceList>>,
        { issuedAt: 1, removeUnlockTargetIds: ['rk_1'] }
      )
    ).toThrow(E2eeError);
    const swapped = await append(f, async (list) => ({
      ...nextDeviceListEntry(list, { issuedAt: 1 }),
      unlockTargets: [
        { ...list.unlockTargets[0]!, publicKey: await rawKey('ECDH') }
      ]
    }));
    await rejectsWith(verifyDeviceList(f.identityRaw, swapped), 'chain-broken');
    const passkey = {
      kind: 'passkey' as const,
      targetId: 'pk_1',
      publicKey: await rawKey('ECDH'),
      addedAt: 5
    };
    f.chain = await append(f, (list) =>
      nextDeviceListEntry(list, { issuedAt: 5, addUnlockTargets: [passkey] })
    );
    const keys = await rotated();
    f.chain = await append(f, (list) =>
      nextDeviceListEntry(list, {
        issuedAt: 6,
        removeUnlockTargetIds: ['pk_1'],
        ...keys
      })
    );
    const list = await verifyDeviceList(f.identityRaw, f.chain);
    expect(list.unlockTargets.map((t) => t.targetId)).toEqual(['rk_1']);
    expect(list.revoked[0]).toMatchObject({
      kind: 'unlock-target',
      id: 'pk_1'
    });
  });

  it('pins the head and refuses rollback, forks and a replaced identity', async () => {
    const f = await fixture();
    const first = await verifyDeviceList(f.identityRaw, f.chain);
    f.chain = await append(f, async (list) =>
      nextDeviceListEntry(list, {
        issuedAt: 2,
        addDevices: [await device('dev_2')]
      })
    );
    const second = await verifyDeviceList(f.identityRaw, f.chain, {
      pin: first.pin
    });
    expect(second.pin.sequence).toBe(1);
    // Rolled back to before the pin.
    await rejectsWith(
      verifyDeviceList(f.identityRaw, f.chain.slice(0, 1), { pin: second.pin }),
      'chain-broken'
    );
    // A fork: a different entry 1.
    const fork = [
      f.chain[0]!,
      await signDeviceListEntry(
        f.identity.privateKey,
        nextDeviceListEntry(first, {
          issuedAt: 9,
          addDevices: [await device('dev_fork')]
        })
      )
    ];
    await rejectsWith(
      verifyDeviceList(f.identityRaw, fork, { pin: second.pin }),
      'chain-broken'
    );
    const other = await fixture();
    await rejectsWith(
      verifyDeviceList(other.identityRaw, other.chain, { pin: second.pin }),
      'context-mismatch'
    );
  });

  it('checks every listed key is a real P-256 point', async () => {
    const f = await fixture();
    const offCurve = new Uint8Array(65);
    offCurve[0] = 4;
    offCurve[64] = 1;
    const entry = { ...f.genesis, encryptionKey: offCurve };
    const chain = [await signDeviceListEntry(f.identity.privateKey, entry)];
    await rejectsWith(verifyDeviceList(f.identityRaw, chain), 'malformed');
  });
});

describe('identity transitions and approval grants', () => {
  it('signs and verifies a transition by the old identity or a device', async () => {
    const old = await fixture();
    const next = await fixture();
    const value = {
      userId: USER,
      oldIdentityKeyHash: await publicKeyHash(old.identityRaw),
      newIdentityKey: next.identityRaw,
      newGenesisHash: await deviceListEntryHash(next.chain[0]!.entry),
      signer: 'identity' as const,
      signerKeyHash: await publicKeyHash(old.identityRaw),
      signedAt: 10
    };
    const signed = await signIdentityTransition(old.identity.privateKey, value);
    expect(await verifyIdentityTransition(signed, old.identityRaw)).toEqual(
      value
    );
    await rejectsWith(
      verifyIdentityTransition(signed, next.identityRaw),
      'context-mismatch'
    );
    const forged = new Uint8Array(signed.signature);
    forged[5]! ^= 1;
    await rejectsWith(
      verifyIdentityTransition(
        { statement: signed.statement, signature: forged },
        old.identityRaw
      ),
      'authentication-failed'
    );
    const deviceKey = await generateSigningKeyPair(false);
    const deviceRaw = await exportPublicKey(deviceKey.publicKey);
    const byDevice = await signIdentityTransition(deviceKey.privateKey, {
      ...value,
      signer: 'device',
      signerKeyHash: await publicKeyHash(deviceRaw)
    });
    expect((await verifyIdentityTransition(byDevice, deviceRaw)).signer).toBe(
      'device'
    );
  });

  it('signs and verifies an approval grant', async () => {
    const f = await fixture();
    const list = await verifyDeviceList(f.identityRaw, f.chain);
    const approver = await generateSigningKeyPair(false);
    const approverRaw = await exportPublicKey(approver.publicKey);
    const newDevice = await device('dev_new');
    const grant = {
      userId: USER,
      deviceKeysHash: await deviceKeysHash(
        newDevice.signingKey,
        newDevice.unlockKey
      ),
      deviceId: 'dev_new',
      identityKeyHash: list.identityKeyHash,
      headSequence: list.head.sequence,
      headHash: list.headHash,
      certified: true,
      approverKeyHash: await publicKeyHash(approverRaw),
      issuedAt: 99
    };
    const signed = await signDeviceApprovalGrant(approver.privateKey, grant);
    expect(decodeDeviceApprovalGrant(signed.statement)).toEqual(grant);
    expect(await verifyDeviceApprovalGrant(signed, approverRaw)).toEqual(grant);
    await rejectsWith(
      verifyDeviceApprovalGrant(signed, newDevice.signingKey),
      'context-mismatch'
    );
    const flipped = new Uint8Array(signed.statement);
    flipped[flipped.byteLength - 41]! ^= 1;
    await rejectsWith(
      verifyDeviceApprovalGrant(
        { statement: flipped, signature: signed.signature },
        approverRaw
      ),
      'authentication-failed'
    );
  });
});

describe('account key commitments and key pairs', () => {
  it('commits to the account key without revealing it', async () => {
    const key = generateSymmetricKey();
    const commitment = await accountKeyCommitment(key);
    expect(commitment).toHaveLength(32);
    expect(commitment).not.toEqual(key);
    expect(await accountKeyCommitment(key)).toEqual(commitment);
    expect(await accountKeyCommitment(generateSymmetricKey())).not.toEqual(
      commitment
    );
    await rejectsWith(
      accountKeyCommitment(new Uint8Array(16)),
      'invalid-argument'
    );
  });

  it('reads the public key out of an unwrapped private key', async () => {
    const pair = await generateEncryptionKeyPair();
    expect(
      await publicKeyOfPrivateKey(
        await exportPrivateKey(pair.privateKey),
        'ECDH'
      )
    ).toEqual(await exportPublicKey(pair.publicKey));
    const signing = await generateSigningKeyPair();
    expect(
      await publicKeyOfPrivateKey(
        await exportPrivateKey(signing.privateKey),
        'ECDSA'
      )
    ).toEqual(await exportPublicKey(signing.publicKey));
    await rejectsWith(
      publicKeyOfPrivateKey(new Uint8Array(40), 'ECDH'),
      'malformed'
    );
  });
});
