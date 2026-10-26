import { describe, expect, it } from 'vitest';
import { deviceKeysHash, publicKeyHash } from './codes';
import {
  accountKeyCommitment,
  accountKeySequence,
  accountKeySequences,
  decodeDeviceApprovalGrant,
  decodeDeviceListEntry,
  DEVICE_APPROVAL_GRANT_VERSION_1,
  DEVICE_APPROVAL_GRANT_VERSION_2,
  decodeGroupReset,
  decodeRevocationCutoffs,
  deviceListEntryHash,
  encodeDeviceListEntry,
  encodeGroupReset,
  encodeRevocationCutoffs,
  MAX_REVOCATION_CUTOFFS,
  MAX_REVOCATION_CUTOFFS_BYTES,
  MAX_REVOCATION_CUTOFFS_V1_BYTES,
  nextDeviceListEntry,
  publicKeyOfPrivateKey,
  recoveryTarget,
  signDeviceApprovalGrant,
  signDeviceListEntry,
  signIdentityTransition,
  signGroupReset,
  signRevocationCutoffs,
  verifyDeviceApprovalGrant,
  verifyDeviceList,
  verifyIdentityTransition,
  verifyGroupReset,
  verifyRevocationCutoffs,
  type DeviceListEntry,
  type GroupReset,
  type ListedDevice,
  type RevocationCutoffs,
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
    future[3] = 3;
    throwsWith(() => decodeDeviceListEntry(future), 'unsupported-version');
    // Version 2 is reserved for entries that name a replacement.
    const relabelled = new Uint8Array(bytes);
    relabelled[3] = 2;
    throwsWith(() => decodeDeviceListEntry(relabelled), 'malformed');
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

  it('carries the approver’s contacts head in a version 2 grant and still reads version 1', async () => {
    const f = await fixture();
    const list = await verifyDeviceList(f.identityRaw, f.chain);
    const approver = await generateSigningKeyPair(false);
    const approverRaw = await exportPublicKey(approver.publicKey);
    const newDevice = await device('dev_new');
    const v1 = {
      userId: USER,
      deviceKeysHash: await deviceKeysHash(
        newDevice.signingKey,
        newDevice.unlockKey
      ),
      deviceId: 'dev_new',
      identityKeyHash: list.identityKeyHash,
      headSequence: list.head.sequence,
      headHash: list.headHash,
      certified: false,
      approverKeyHash: await publicKeyHash(approverRaw),
      issuedAt: 99
    };
    // An older build's grant: version 1, no contacts head.
    const old = await signDeviceApprovalGrant(approver.privateKey, v1);
    expect(old.statement[3]).toBe(DEVICE_APPROVAL_GRANT_VERSION_1);
    const readOld = await verifyDeviceApprovalGrant(old, approverRaw);
    expect(readOld).toEqual(v1);
    expect(readOld.contacts).toBeUndefined();

    const entryHash = new Uint8Array(32).fill(7);
    for (const contacts of [
      { head: { sequence: 4, entryHash }, confirmed: true },
      { head: { sequence: 0, entryHash }, confirmed: false },
      { head: null, confirmed: true },
      { head: null, confirmed: false }
    ]) {
      const grant = { ...v1, contacts };
      const signed = await signDeviceApprovalGrant(approver.privateKey, grant);
      expect(signed.statement[3]).toBe(DEVICE_APPROVAL_GRANT_VERSION_2);
      expect(signed.statement.byteLength).toBe(
        old.statement.byteLength + 1 + (contacts.head ? 36 : 0)
      );
      expect(decodeDeviceApprovalGrant(signed.statement)).toEqual(grant);
      expect(await verifyDeviceApprovalGrant(signed, approverRaw)).toEqual(
        grant
      );
    }

    // The head is signed: a server swapping in an older one breaks it.
    const signed = await signDeviceApprovalGrant(approver.privateKey, {
      ...v1,
      contacts: { head: { sequence: 4, entryHash }, confirmed: true }
    });
    const older = new Uint8Array(signed.statement);
    older[older.byteLength - 33] = 3; // big-endian u32 sequence 4 -> 3
    expect(decodeDeviceApprovalGrant(older).contacts?.head?.sequence).toBe(3);
    await rejectsWith(
      verifyDeviceApprovalGrant(
        { statement: older, signature: signed.signature },
        approverRaw
      ),
      'authentication-failed'
    );
    // Nor can it drop the head by relabelling the grant as version 1.
    const relabelled = new Uint8Array(signed.statement.slice(0, -37));
    relabelled[3] = DEVICE_APPROVAL_GRANT_VERSION_1;
    expect(decodeDeviceApprovalGrant(relabelled).contacts).toBeUndefined();
    await rejectsWith(
      verifyDeviceApprovalGrant(
        { statement: relabelled, signature: signed.signature },
        approverRaw
      ),
      'authentication-failed'
    );
    // Unknown flags, a truncated head and an unknown version are refused.
    const flags = new Uint8Array(signed.statement);
    flags[flags.byteLength - 37] = 4 | 1;
    expect(() => decodeDeviceApprovalGrant(flags)).toThrow(/contacts flags/);
    expect(() =>
      decodeDeviceApprovalGrant(signed.statement.slice(0, -1))
    ).toThrow(E2eeError);
    const future = new Uint8Array(signed.statement);
    future[3] = 3;
    expect(() => decodeDeviceApprovalGrant(future)).toThrow(/version 3/);
    await expect(
      signDeviceApprovalGrant(approver.privateKey, {
        ...v1,
        contacts: { head: { sequence: -1, entryHash }, confirmed: true }
      })
    ).rejects.toThrow(/Not a device approval grant/);
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

describe('replacement devices (entry version 2)', () => {
  async function removal(f: Fixture, replacedBy?: string) {
    const keys = await rotated();
    return append(f, (list) =>
      nextDeviceListEntry(list, {
        issuedAt: 2,
        removeDeviceIds: ['dev_1'],
        ...(replacedBy === undefined ? {} : { replacedBy }),
        ...keys
      })
    );
  }

  it('encodes a named replacement as version 2 and nothing else changes', async () => {
    const f = await fixture(3);
    const plain = await removal(f);
    const replaced = await removal(f, 'dev_0');
    // Without a replacement the entry keeps version 1.
    expect(plain[1]!.entry[3]).toBe(1);
    expect(replaced[1]!.entry[3]).toBe(2);
    const decoded = decodeDeviceListEntry(replaced[1]!.entry);
    expect(decoded.revoked).toEqual([
      { kind: 'device', id: 'dev_1', replacedBy: 'dev_0' }
    ]);
    expect(encodeDeviceListEntry(decoded)).toEqual(replaced[1]!.entry);
    // A version 1 revocation decodes without the key at all.
    expect(
      Object.hasOwn(
        decodeDeviceListEntry(plain[1]!.entry).revoked[0]!,
        'replacedBy'
      )
    ).toBe(false);
  });

  it('refuses to encode an entry larger than verifiers decode', async () => {
    const { genesis } = await fixture(3);
    // Every count at its limit with the longest ids, each revocation naming
    // a replacement: within the shape rules, but past the decoder's bound.
    const long = (prefix: string, index: number) =>
      `${prefix}${String(index).padStart(3, '0')}`.padEnd(128, 'x');
    const device = genesis.devices[0]!;
    const distinct = (key: Uint8Array, index: number) => {
      const copy = new Uint8Array(key);
      copy[64] = index;
      copy[63] = 0xa5;
      return copy;
    };
    const oversized: DeviceListEntry = {
      ...genesis,
      sequence: 1,
      previousEntryHash: new Uint8Array(32),
      devices: Array.from({ length: 64 }, (_, index) => ({
        ...device,
        deviceId: long('dev_', index),
        label: 'L'.repeat(64),
        // Distinct bytes are enough here: encoding checks shape, not points.
        signingKey: distinct(device.signingKey, 2 * index),
        unlockKey: distinct(device.unlockKey, 2 * index + 1)
      })),
      revoked: Array.from({ length: 80 }, (_, index) => ({
        kind: 'device' as const,
        id: long('gone_', index),
        replacedBy: long('dev_', 0)
      }))
    };
    throwsWith(() => encodeDeviceListEntry(oversized), 'limit-exceeded');
  });

  it('exposes the replacement on the revoked record across mixed versions', async () => {
    const f = await fixture(3);
    f.chain = await removal(f, 'dev_2');
    // A later version 1 entry follows the version 2 one.
    const added = await device('dev_9');
    f.chain = await append(f, (list) =>
      nextDeviceListEntry(list, { issuedAt: 3, addDevices: [added] })
    );
    expect(f.chain.map((signed) => signed.entry[3])).toEqual([1, 2, 1]);
    const list = await verifyDeviceList(f.identityRaw, f.chain);
    expect(list.revoked).toEqual([
      expect.objectContaining({
        kind: 'device',
        id: 'dev_1',
        revokedAt: 1,
        replacedBy: 'dev_2'
      })
    ]);
    // The signature covers the replacement: stripping it is caught.
    const stripped = encodeDeviceListEntry({
      ...decodeDeviceListEntry(f.chain[1]!.entry),
      revoked: [{ kind: 'device', id: 'dev_1' }]
    });
    await rejectsWith(
      verifyDeviceList(f.identityRaw, [
        f.chain[0]!,
        { entry: stripped, signature: f.chain[1]!.signature }
      ]),
      'authentication-failed'
    );
  });

  it('names a replacement added in the same entry', async () => {
    const f = await fixture(2);
    const fresh = await device('dev_new');
    const keys = await rotated();
    f.chain = await append(f, (list) =>
      nextDeviceListEntry(list, {
        issuedAt: 2,
        addDevices: [fresh],
        removeDeviceIds: ['dev_1'],
        replacedBy: 'dev_new',
        ...keys
      })
    );
    const list = await verifyDeviceList(f.identityRaw, f.chain);
    expect(list.revoked[0]!.replacedBy).toBe('dev_new');
  });

  it('refuses a replacement that is not a live device of the entry', async () => {
    const f = await fixture(3);
    const list = await verifyDeviceList(f.identityRaw, f.chain);
    const keys = await rotated();
    // nextDeviceListEntry checks first.
    for (const replacedBy of ['dev_1', 'dev_9', 'rk_1']) {
      expect(() =>
        nextDeviceListEntry(list, {
          issuedAt: 2,
          removeDeviceIds: ['dev_1'],
          replacedBy,
          ...keys
        })
      ).toThrow(E2eeError);
    }
    expect(() =>
      nextDeviceListEntry(list, { issuedAt: 2, replacedBy: 'dev_0' })
    ).toThrow(E2eeError);
    // The encoder refuses hand-built entries the same way.
    const base = nextDeviceListEntry(list, {
      issuedAt: 2,
      removeDeviceIds: ['dev_1'],
      ...keys
    });
    const bad: DeviceListEntry['revoked'][] = [
      [{ kind: 'device', id: 'dev_1', replacedBy: 'dev_1' }],
      [{ kind: 'device', id: 'dev_1', replacedBy: 'dev_9' }],
      [{ kind: 'device', id: 'dev_1', replacedBy: 'rk_1' }],
      [{ kind: 'device', id: 'dev_1', replacedBy: '' }],
      [{ kind: 'device', id: 'dev_1', replacedBy: 'has space' }]
    ];
    for (const revoked of bad) {
      throwsWith(
        () => encodeDeviceListEntry({ ...base, revoked }),
        'invalid-argument'
      );
    }
  });

  it('refuses a replacement on an unlock-target revocation', async () => {
    const f = await fixture(2);
    const passkey = {
      kind: 'passkey' as const,
      targetId: 'pk_1',
      publicKey: await rawKey('ECDH'),
      addedAt: 1
    };
    f.chain = await append(f, (list) =>
      nextDeviceListEntry(list, { issuedAt: 2, addUnlockTargets: [passkey] })
    );
    const list = await verifyDeviceList(f.identityRaw, f.chain);
    const entry = nextDeviceListEntry(list, {
      issuedAt: 3,
      removeUnlockTargetIds: ['pk_1'],
      ...(await rotated())
    });
    throwsWith(
      () =>
        encodeDeviceListEntry({
          ...entry,
          revoked: [{ kind: 'unlock-target', id: 'pk_1', replacedBy: 'dev_0' }]
        }),
      'invalid-argument'
    );
  });

  it('refuses version 2 bytes that name no replacement or a bad one', async () => {
    const f = await fixture(3);
    const replaced = (await removal(f, 'dev_0'))[1]!.entry;
    // The replacement id is the last field: "dev_0" behind its length byte.
    const tail = replaced.byteLength - 6;
    expect(replaced[tail]).toBe(5);
    // A version 2 entry whose only revocation names none is not canonical.
    const none = new Uint8Array(replaced.subarray(0, tail + 1));
    none[tail] = 0;
    throwsWith(() => decodeDeviceListEntry(none), 'malformed');
    // Naming a device that is not live in the entry.
    const unknown = new Uint8Array(replaced);
    unknown.set(new TextEncoder().encode('dev_7'), tail + 1);
    throwsWith(() => decodeDeviceListEntry(unknown), 'malformed');
  });
});

describe('account key sequences', () => {
  it('names each account key by the entry that first committed to it', async () => {
    const f = await fixture(3);
    const rotate = async (issuedAt: number, removed: string) => {
      const keys = await rotated();
      f.chain = await append(f, (list) =>
        nextDeviceListEntry(list, {
          issuedAt,
          removeDeviceIds: [removed],
          ...keys
        })
      );
    };
    const add = async (issuedAt: number, id: string) => {
      const added = await device(id);
      f.chain = await append(f, (list) =>
        nextDeviceListEntry(list, { issuedAt, addDevices: [added] })
      );
    };
    // 0: first key; 1: add (same key); 2: rotation; 3: add; 4: rotation.
    await add(1, 'dev_9');
    await rotate(2, 'dev_1');
    await add(3, 'dev_10');
    await rotate(4, 'dev_2');
    const list = await verifyDeviceList(f.identityRaw, f.chain);
    expect(accountKeySequences(list)).toEqual([0, 2, 4]);
    expect([0, 1, 2, 3, 4].map((at) => accountKeySequence(list, at))).toEqual([
      0, 0, 2, 2, 4
    ]);
    expect(accountKeySequence(list)).toBe(4);
    expect(() => accountKeySequence(list, 5)).toThrow(E2eeError);
    expect(() => accountKeySequence(list, -1)).toThrow(E2eeError);
  });
});

describe('revocation cutoffs', () => {
  async function revoked() {
    const f = await fixture(3);
    const keys = await rotated();
    f.chain = await append(f, (list) =>
      nextDeviceListEntry(list, {
        issuedAt: 2,
        removeDeviceIds: ['dev_1'],
        replacedBy: 'dev_0',
        ...keys
      })
    );
    const list = await verifyDeviceList(f.identityRaw, f.chain);
    const value: RevocationCutoffs = {
      userId: USER,
      generation: 1,
      entrySequence: 1,
      entryHash: list.headHash,
      issuedAt: 1_700_000_000_002,
      cutoffs: [
        { projectId: 'prj_b', cutoffEpoch: 7 },
        { projectId: 'prj_a', cutoffEpoch: 0 },
        { projectId: 'prj_c', cutoffEpoch: Number.MAX_SAFE_INTEGER }
      ]
    };
    return { f, list, value };
  }

  it('signs and verifies cutoffs bound to the revoking entry', async () => {
    const { f, list, value } = await revoked();
    const signed = await signRevocationCutoffs(f.identity.privateKey, value);
    expect([...signed.statement.subarray(0, 4)]).toEqual([0x4f, 0x5a, 0x52, 1]);
    const verified = await verifyRevocationCutoffs(signed, list, {
      generation: 1
    });
    // Sorted by project id, whatever the input order.
    expect(verified.cutoffs.map((c) => c.projectId)).toEqual([
      'prj_a',
      'prj_b',
      'prj_c'
    ]);
    expect(verified.cutoffs[2]!.cutoffEpoch).toBe(Number.MAX_SAFE_INTEGER);
    expect(encodeRevocationCutoffs(verified)).toEqual(signed.statement);
    // An empty statement is valid: a user with no projects yet.
    const none = await signRevocationCutoffs(f.identity.privateKey, {
      ...value,
      cutoffs: []
    });
    expect(
      (await verifyRevocationCutoffs(none, list, { generation: 1 })).cutoffs
    ).toEqual([]);
  });

  it('refuses another signer, user, generation or entry', async () => {
    const { f, list, value } = await revoked();
    const other = await generateSigningKeyPair(false);
    await rejectsWith(
      verifyRevocationCutoffs(
        await signRevocationCutoffs(other.privateKey, value),
        list,
        { generation: 1 }
      ),
      'authentication-failed'
    );
    const signed = await signRevocationCutoffs(f.identity.privateKey, value);
    const tampered = new Uint8Array(signed.statement);
    tampered[tampered.byteLength - 1]! ^= 1;
    await rejectsWith(
      verifyRevocationCutoffs(
        { statement: tampered, signature: signed.signature },
        list,
        { generation: 1 }
      ),
      'authentication-failed'
    );
    await rejectsWith(
      verifyRevocationCutoffs(signed, list, { generation: 2 }),
      'context-mismatch'
    );
    const cases: Partial<RevocationCutoffs>[] = [
      { userId: 'user_2' },
      { entrySequence: 2 },
      { entryHash: new Uint8Array(32) }
    ];
    for (const change of cases) {
      await rejectsWith(
        verifyRevocationCutoffs(
          await signRevocationCutoffs(f.identity.privateKey, {
            ...value,
            ...change
          }),
          list,
          { generation: 1 }
        ),
        'context-mismatch'
      );
    }
  });

  it('refuses an entry that revokes no device', async () => {
    const f = await fixture(2);
    const passkey = {
      kind: 'passkey' as const,
      targetId: 'pk_1',
      publicKey: await rawKey('ECDH'),
      addedAt: 1
    };
    f.chain = await append(f, (list) =>
      nextDeviceListEntry(list, { issuedAt: 2, addUnlockTargets: [passkey] })
    );
    const keys = await rotated();
    f.chain = await append(f, (list) =>
      nextDeviceListEntry(list, {
        issuedAt: 3,
        removeUnlockTargetIds: ['pk_1'],
        ...keys
      })
    );
    const list = await verifyDeviceList(f.identityRaw, f.chain);
    for (const entrySequence of [1, 2]) {
      await rejectsWith(
        verifyRevocationCutoffs(
          await signRevocationCutoffs(f.identity.privateKey, {
            userId: USER,
            generation: 1,
            entrySequence,
            entryHash: list.entries[entrySequence]!.hash,
            issuedAt: 3,
            cutoffs: [{ projectId: 'prj_a', cutoffEpoch: 1 }]
          }),
          list,
          { generation: 1 }
        ),
        'context-mismatch'
      );
    }
  });

  it('refuses malformed values and non-canonical bytes', async () => {
    const { value } = await revoked();
    const bad: Partial<RevocationCutoffs>[] = [
      { userId: '' },
      { generation: 0 },
      { generation: 2 ** 32 },
      { entrySequence: 0 },
      { entryHash: new Uint8Array(31) },
      { issuedAt: -1 },
      {
        cutoffs: [
          { projectId: 'prj_a', cutoffEpoch: 1 },
          { projectId: 'prj_a', cutoffEpoch: 2 }
        ]
      },
      { cutoffs: [{ projectId: 'prj a', cutoffEpoch: 1 }] },
      { cutoffs: [{ projectId: 'prj_a', cutoffEpoch: -1 }] },
      { cutoffs: [{ projectId: 'prj_a', cutoffEpoch: 1.5 }] },
      {
        cutoffs: [
          { projectId: 'prj_a', cutoffEpoch: Number.MAX_SAFE_INTEGER + 1 }
        ]
      },
      {
        cutoffs: Array.from({ length: MAX_REVOCATION_CUTOFFS + 1 }, (_, i) => ({
          projectId: `p${i}`,
          cutoffEpoch: 1
        }))
      }
    ];
    for (const change of bad) {
      throwsWith(
        () => encodeRevocationCutoffs({ ...value, ...change }),
        'invalid-argument'
      );
    }
    const bytes = encodeRevocationCutoffs(value);
    expect(decodeRevocationCutoffs(bytes).cutoffs).toHaveLength(3);
    throwsWith(
      () => decodeRevocationCutoffs(bytes.subarray(0, 50)),
      'malformed'
    );
    const trailing = new Uint8Array(bytes.byteLength + 1);
    trailing.set(bytes);
    throwsWith(() => decodeRevocationCutoffs(trailing), 'malformed');
    const future = new Uint8Array(bytes);
    future[3] = 3;
    throwsWith(() => decodeRevocationCutoffs(future), 'unsupported-version');
    const magic = new Uint8Array(bytes);
    magic[2] = 0x44;
    throwsWith(() => decodeRevocationCutoffs(magic), 'malformed');
    // Swap the first two cutoffs (each is 1 + 5 + 8 bytes): out of order.
    const first = bytes.byteLength - 3 * 14;
    const swapped = new Uint8Array(bytes);
    swapped.set(bytes.subarray(first + 14, first + 28), first);
    swapped.set(bytes.subarray(first, first + 14), first + 14);
    throwsWith(() => decodeRevocationCutoffs(swapped), 'malformed');
    throwsWith(
      () =>
        decodeRevocationCutoffs(
          new Uint8Array(MAX_REVOCATION_CUTOFFS_BYTES + 1)
        ),
      'limit-exceeded'
    );
    // The largest statement the format allows still decodes.
    const largest = encodeRevocationCutoffs({
      ...value,
      userId: 'u'.repeat(128),
      cutoffs: Array.from({ length: MAX_REVOCATION_CUTOFFS }, (_, i) => ({
        projectId: `${String(i).padStart(4, '0')}${'p'.repeat(124)}`,
        cutoffEpoch: Number.MAX_SAFE_INTEGER
      }))
    });
    expect(largest.byteLength).toBe(MAX_REVOCATION_CUTOFFS_V1_BYTES);
    expect(decodeRevocationCutoffs(largest).cutoffs).toHaveLength(
      MAX_REVOCATION_CUTOFFS
    );
  });
});

describe('revocation cutoff heads (version 2)', () => {
  async function revokedList() {
    const f = await fixture(2);
    const keys = await rotated();
    f.chain = await append(f, (list) =>
      nextDeviceListEntry(list, {
        issuedAt: 2,
        removeDeviceIds: ['dev_1'],
        ...keys
      })
    );
    return { f, list: await verifyDeviceList(f.identityRaw, f.chain) };
  }

  it('signs heads in version 2 and keeps version 1 byte for byte', async () => {
    const { f, list } = await revokedList();
    const base: RevocationCutoffs = {
      userId: USER,
      generation: 1,
      entrySequence: 1,
      entryHash: list.headHash,
      issuedAt: 3,
      cutoffs: [
        { projectId: 'prj_a', cutoffEpoch: 4 },
        { projectId: 'prj_b', cutoffEpoch: 2 }
      ]
    };
    expect(encodeRevocationCutoffs(base)[3]).toBe(1);
    const head = {
      documentVersion: 7,
      versionHash: new Uint8Array(32).fill(9)
    };
    const withHead: RevocationCutoffs = {
      ...base,
      cutoffs: [
        { projectId: 'prj_a', cutoffEpoch: 4, head },
        { projectId: 'prj_b', cutoffEpoch: 2 }
      ]
    };
    const signed = await signRevocationCutoffs(f.identity.privateKey, withHead);
    expect(signed.statement[3]).toBe(2);
    const verified = await verifyRevocationCutoffs(signed, list, {
      generation: 1
    });
    expect(verified.cutoffs).toEqual([
      { projectId: 'prj_a', cutoffEpoch: 4, head },
      { projectId: 'prj_b', cutoffEpoch: 2 }
    ]);
    expect(encodeRevocationCutoffs(verified)).toEqual(signed.statement);
    // An empty head slot must be all zero.
    const bytes = new Uint8Array(signed.statement);
    bytes[bytes.byteLength - 1] = 1;
    throwsWith(() => decodeRevocationCutoffs(bytes), 'malformed');
    // Version 2 with no head at all is not canonical: it is version 1.
    const v2 = encodeRevocationCutoffs(withHead);
    const noHeads = new Uint8Array(v2);
    const first = noHeads.byteLength - 2 * (1 + 5 + 8 + 8 + 32);
    noHeads.fill(0, first + 1 + 5 + 8, first + 1 + 5 + 8 + 40);
    throwsWith(() => decodeRevocationCutoffs(noHeads), 'malformed');
    for (const bad of [
      { documentVersion: 0, versionHash: new Uint8Array(32) },
      { documentVersion: 1, versionHash: new Uint8Array(31) },
      { documentVersion: 1.5, versionHash: new Uint8Array(32) }
    ]) {
      throwsWith(
        () =>
          encodeRevocationCutoffs({
            ...base,
            cutoffs: [{ projectId: 'prj_a', cutoffEpoch: 1, head: bad }]
          }),
        'invalid-argument'
      );
    }
    // The largest version 2 statement is the format's largest.
    const largest = encodeRevocationCutoffs({
      ...base,
      userId: 'u'.repeat(128),
      cutoffs: Array.from({ length: MAX_REVOCATION_CUTOFFS }, (_, i) => ({
        projectId: `${String(i).padStart(4, '0')}${'p'.repeat(124)}`,
        cutoffEpoch: Number.MAX_SAFE_INTEGER,
        head: {
          documentVersion: Number.MAX_SAFE_INTEGER,
          versionHash: new Uint8Array(32).fill(1)
        }
      }))
    });
    expect(largest.byteLength).toBe(MAX_REVOCATION_CUTOFFS_BYTES);
  });
});

describe('group resets', () => {
  async function resetFixture() {
    const f = await fixture(2);
    const list = await verifyDeviceList(f.identityRaw, f.chain);
    const value: GroupReset = {
      userId: USER,
      generation: 1,
      entrySequence: 0,
      entryHash: list.headHash,
      projectId: 'prj_a',
      priorGroupGeneration: 0,
      priorKeyEpoch: 5,
      issuedAt: 1_700_000_000_000
    };
    return { f, list, value };
  }

  it('signs and verifies a reset bound to the signer’s device list', async () => {
    const { f, list, value } = await resetFixture();
    const signed = await signGroupReset(f.identity.privateKey, value);
    expect([...signed.statement.subarray(0, 4)]).toEqual([0x4f, 0x5a, 0x58, 1]);
    const verified = await verifyGroupReset(signed, list, { generation: 1 });
    expect(verified).toEqual(value);
    expect(encodeGroupReset(verified)).toEqual(signed.statement);
  });

  it('refuses another signer, user, generation, entry or malformed bytes', async () => {
    const { f, list, value } = await resetFixture();
    const other = await generateSigningKeyPair(false);
    await rejectsWith(
      verifyGroupReset(await signGroupReset(other.privateKey, value), list, {
        generation: 1
      }),
      'authentication-failed'
    );
    const signed = await signGroupReset(f.identity.privateKey, value);
    await rejectsWith(
      verifyGroupReset(signed, list, { generation: 2 }),
      'context-mismatch'
    );
    for (const change of [
      { userId: 'user_2' },
      { entrySequence: 1 },
      { entryHash: new Uint8Array(32) }
    ]) {
      await rejectsWith(
        verifyGroupReset(
          await signGroupReset(f.identity.privateKey, { ...value, ...change }),
          list,
          { generation: 1 }
        ),
        'context-mismatch'
      );
    }
    for (const change of [
      { generation: 0 },
      { projectId: 'prj a' },
      { priorKeyEpoch: 2 ** 32 - 1 },
      { priorGroupGeneration: -1 },
      { issuedAt: 1.5 }
    ]) {
      throwsWith(
        () => encodeGroupReset({ ...value, ...change }),
        'invalid-argument'
      );
    }
    const trailing = new Uint8Array(signed.statement.byteLength + 1);
    trailing.set(signed.statement);
    throwsWith(() => decodeGroupReset(trailing), 'malformed');
    const future = new Uint8Array(signed.statement);
    future[3] = 2;
    throwsWith(() => decodeGroupReset(future), 'unsupported-version');
    // A cutoff statement is not a reset, whatever its signature.
    throwsWith(
      () =>
        decodeGroupReset(
          encodeRevocationCutoffs({
            userId: USER,
            generation: 1,
            entrySequence: 1,
            entryHash: new Uint8Array(32),
            issuedAt: 1,
            cutoffs: []
          })
        ),
      'malformed'
    );
  });
});
