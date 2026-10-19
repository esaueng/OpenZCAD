import { describe, expect, it } from 'vitest';
import { concatBytes } from './bytes';
import { identityFingerprint, publicKeyHash } from './codes';
import {
  currentEncryptionKey,
  decodeDeviceListEntry,
  encodeDeviceListEntry,
  findDevice,
  readDeviceSignature,
  signDeviceListEntry,
  signWithDevice,
  verifyDeviceList,
  verifyDeviceSignature
} from './devices';
import { E2eeError, type E2eeErrorCode } from './errors';
import { generateIdentityKeyPair } from './keys';
import { TestUser, patternBytes } from './test-support';

async function rejectsWith(
  promise: Promise<unknown>,
  code: E2eeErrorCode
): Promise<void> {
  await expect(promise).rejects.toSatisfy(
    (error: unknown) => error instanceof E2eeError && error.code === code
  );
}

const SUBJECT = patternBytes(40, 3);

describe('device lists', () => {
  it('certifies devices and the encryption key under the identity key', async () => {
    const user = await TestUser.create('user-1', ['laptop', 'phone']);
    const { list } = user;
    expect(list.userId).toBe('user-1');
    expect(list.latestSequence).toBe(0);
    expect(list.identityKeyHash).toEqual(await publicKeyHash(user.identityKey));
    expect((await identityFingerprint(user.identityKey)).hash).toEqual(
      list.identityKeyHash
    );
    expect(
      list.devices.map((d) => [d.deviceId, d.certifiedAt, d.revokedAt])
    ).toEqual([
      ['laptop', 0, null],
      ['phone', 0, null]
    ]);
    expect(currentEncryptionKey(list)).toEqual(user.encryptionKey);
  });

  it('records revocations and encryption key replacements', async () => {
    const user = await TestUser.create('user-1', ['laptop', 'phone']);
    const phone = user.devices[1]!;
    await user.revoke('phone');
    await user.addDevice('tablet');
    const before = user.encryptionKey;
    await user.replaceEncryptionKey();
    const { list } = user;
    expect(list.latestSequence).toBe(3);
    expect(findDevice(list, phone.keyHash)).toMatchObject({
      deviceId: 'phone',
      certifiedAt: 0,
      revokedAt: 1
    });
    expect(findDevice(list, user.devices[1]!.keyHash)).toMatchObject({
      deviceId: 'tablet',
      certifiedAt: 2,
      revokedAt: null
    });
    expect(
      list.encryptionKeys.map((k) => [k.certifiedAt, k.replacedAt])
    ).toEqual([
      [0, 3],
      [3, null]
    ]);
    expect(list.encryptionKeys[0]!.key).toEqual(before);
    expect(currentEncryptionKey(list)).toEqual(user.encryptionKey);
  });

  it('encodes canonically, sorted by device id', async () => {
    const user = await TestUser.create('user-1', ['b', 'a']);
    const entry = decodeDeviceListEntry(user.chain[0]!.entry);
    expect(entry.devices.map((d) => d.deviceId)).toEqual(['a', 'b']);
    expect(
      encodeDeviceListEntry({ ...entry, devices: [...entry.devices].reverse() })
    ).toEqual(user.chain[0]!.entry);
  });

  it('refuses another identity, broken links, rollback and returning devices', async () => {
    const user = await TestUser.create('user-1', ['laptop', 'phone']);
    const phone = user.devices[1]!;
    await user.revoke('phone');
    await user.addDevice('tablet');
    const chain = user.chain;
    const intruder = await generateIdentityKeyPair();
    await rejectsWith(
      verifyDeviceList(intruder.publicKey, chain),
      'authentication-failed'
    );
    const identity = user.identity.publicKey;
    await rejectsWith(
      verifyDeviceList(identity, [chain[0]!, chain[2]!]),
      'chain-broken'
    );
    await rejectsWith(
      verifyDeviceList(identity, chain.slice(1)),
      'chain-broken'
    );
    await rejectsWith(verifyDeviceList(identity, []), 'chain-broken');
    // Rolled back to before the revocation, while the browser pinned it.
    await rejectsWith(
      verifyDeviceList(identity, chain.slice(0, 1), {
        pinnedEntryHash: user.list.entries[1]!.hash
      }),
      'chain-broken'
    );
    // The identity key re-certifying a revoked device is refused.
    const back = await signDeviceListEntry(user.identity.privateKey, {
      ...decodeDeviceListEntry(chain[2]!.entry),
      sequence: 3,
      previousEntryHash: user.list.latestHash,
      devices: [
        ...decodeDeviceListEntry(chain[2]!.entry).devices,
        { deviceId: 'phone', signingKey: phone.signingKey }
      ]
    });
    await rejectsWith(
      verifyDeviceList(identity, [...chain, back]),
      'chain-broken'
    );
    // A tampered entry no longer matches its identity signature.
    const tampered = new Uint8Array(chain[0]!.entry);
    tampered[tampered.byteLength - 1]! ^= 1;
    await expect(
      verifyDeviceList(identity, [{ ...chain[0]!, entry: tampered }])
    ).rejects.toBeInstanceOf(E2eeError);
  });

  it('rejects invalid and non-canonical entries', async () => {
    const user = await TestUser.create('user-1', ['a', 'b']);
    const entry = decodeDeviceListEntry(user.chain[0]!.entry);
    for (const bad of [
      { ...entry, sequence: 1 },
      { ...entry, previousEntryHash: patternBytes(32) },
      { ...entry, encryptionKey: patternBytes(65) },
      { ...entry, devices: [entry.devices[0]!, entry.devices[0]!] },
      { ...entry, devices: [{ ...entry.devices[0]!, deviceId: 'has space' }] },
      { ...entry, userId: '' }
    ]) {
      expect(() => encodeDeviceListEntry(bad)).toThrow(E2eeError);
    }
    const bytes = user.chain[0]!.entry;
    const deviceBytes = 1 + 1 + 65;
    const start = bytes.byteLength - 2 * deviceBytes;
    const swapped = concatBytes(
      bytes.subarray(0, start),
      bytes.subarray(start + deviceBytes),
      bytes.subarray(start, start + deviceBytes)
    );
    expect(() => decodeDeviceListEntry(swapped)).toThrow(E2eeError);
    const future = new Uint8Array(bytes);
    future[3] = 2;
    expect(() => decodeDeviceListEntry(future)).toThrow(
      expect.objectContaining({ code: 'unsupported-version' })
    );
  });
});

describe('revocation cutoffs', () => {
  const HEAD = patternBytes(32, 0x10);
  const ROSTER_HEAD = patternBytes(32, 0x20);

  async function revokedPhone() {
    const user = await TestUser.create('user-1', ['laptop', 'phone']);
    const phone = user.signer('phone');
    await user.revoke('phone', [
      { projectId: 'project-a', versionHead: HEAD, rosterHead: ROSTER_HEAD },
      { projectId: 'project-b', versionHead: HEAD, rosterHead: null }
    ]);
    return { user, phone };
  }

  const subject = (
    hash: Uint8Array,
    isAncestor: boolean,
    projectId = 'project-a',
    head: 'version' | 'roster' = 'version'
  ) => ({
    projectId,
    head,
    hash,
    isAncestorOrSelf: () => isAncestor
  });

  it('records the cutoffs on the revoked device', async () => {
    const { user } = await revokedPhone();
    const phone = user.list.devices.find((d) => d.deviceId === 'phone')!;
    expect(phone.revokedAt).toBe(1);
    expect(phone.cutoffs.map((c) => c.projectId)).toEqual([
      'project-a',
      'project-b'
    ]);
    const laptop = user.list.devices.find((d) => d.deviceId === 'laptop')!;
    expect(laptop.cutoffs).toEqual([]);
    const entry = decodeDeviceListEntry(user.chain[1]!.entry);
    expect(encodeDeviceListEntry(entry)).toEqual(user.chain[1]!.entry);
  });

  it('accepts the cutoff head and its ancestors only', async () => {
    const { user, phone } = await revokedPhone();
    const sign = (hash: Uint8Array) => signWithDevice(phone, 'version', hash);
    const atHead = await sign(HEAD);
    expect(
      await verifyDeviceSignature(user.list, 'version', HEAD, atHead, {
        cutoff: subject(HEAD, false)
      })
    ).toMatchObject({ deviceId: 'phone' });
    const ancestor = patternBytes(32, 0x11);
    const onAncestor = await sign(ancestor);
    expect(
      await verifyDeviceSignature(user.list, 'version', ancestor, onAncestor, {
        cutoff: subject(ancestor, true)
      })
    ).not.toBeNull();
    // A later or forked version, whatever parent it claims.
    await rejectsWith(
      verifyDeviceSignature(user.list, 'version', ancestor, onAncestor, {
        cutoff: subject(ancestor, false)
      }),
      'key-revoked'
    );
    // Another project with no cutoff, or a roster head the entry omitted.
    await rejectsWith(
      verifyDeviceSignature(user.list, 'version', HEAD, atHead, {
        cutoff: subject(HEAD, true, 'project-c')
      }),
      'key-revoked'
    );
    await rejectsWith(
      verifyDeviceSignature(user.list, 'version', HEAD, atHead, {
        cutoff: subject(HEAD, true, 'project-b', 'roster')
      }),
      'key-revoked'
    );
    // The roster head applies to roster entries.
    const onRoster = await signWithDevice(phone, 'roster', ROSTER_HEAD);
    expect(
      await verifyDeviceSignature(user.list, 'roster', ROSTER_HEAD, onRoster, {
        cutoff: subject(ROSTER_HEAD, false, 'project-a', 'roster')
      })
    ).not.toBeNull();
  });

  it('a live device needs no cutoff, and cutoffs need a revocation', async () => {
    const user = await TestUser.create('user-1', ['laptop']);
    const signature = await signWithDevice(user.signer(), 'version', SUBJECT);
    expect(
      await verifyDeviceSignature(user.list, 'version', SUBJECT, signature, {
        cutoff: subject(SUBJECT, false)
      })
    ).not.toBeNull();
    await user.addDevice('phone', false);
    await rejectsWith(
      user.revoke('nobody', [
        { projectId: 'project-a', versionHead: HEAD, rosterHead: null }
      ]),
      'chain-broken'
    );
    for (const cutoffs of [
      [{ projectId: 'p', versionHead: patternBytes(31), rosterHead: null }],
      [
        { projectId: 'p', versionHead: HEAD, rosterHead: null },
        { projectId: 'p', versionHead: HEAD, rosterHead: null }
      ],
      [{ projectId: '', versionHead: HEAD, rosterHead: null }]
    ]) {
      expect(() =>
        encodeDeviceListEntry({
          ...decodeDeviceListEntry(user.chain[0]!.entry),
          cutoffs
        })
      ).toThrow(E2eeError);
    }
  });
});

describe('device signatures', () => {
  it('verify against the signer’s device list', async () => {
    const user = await TestUser.create('user-1', ['laptop']);
    const signature = await signWithDevice(
      user.signer(),
      'version',
      SUBJECT,
      1234
    );
    expect(readDeviceSignature(signature)).toMatchObject({
      userId: 'user-1',
      deviceListSequence: 0,
      signedAt: 1234
    });
    expect(
      await verifyDeviceSignature(user.list, 'version', SUBJECT, signature)
    ).toMatchObject({ userId: 'user-1', deviceId: 'laptop', signedAt: 1234 });
  });

  it('are bound to the subject, purpose and every signer field', async () => {
    const user = await TestUser.create('user-1', ['laptop']);
    const signature = await signWithDevice(user.signer(), 'version', SUBJECT);
    expect(
      await verifyDeviceSignature(user.list, 'roster', SUBJECT, signature)
    ).toBeNull();
    expect(
      await verifyDeviceSignature(
        user.list,
        'version',
        patternBytes(40, 4),
        signature
      )
    ).toBeNull();
    // signedAt is the 8 bytes before r || s.
    const backdated = new Uint8Array(signature);
    backdated[backdated.byteLength - 65]! ^= 1;
    expect(
      await verifyDeviceSignature(user.list, 'version', SUBJECT, backdated)
    ).toBeNull();
  });

  it('refuse uncertified, revoked, stale-list and foreign signers', async () => {
    const user = await TestUser.create('user-1', ['laptop', 'phone']);
    const other = await TestUser.create('user-2');
    const phoneSigner = user.signer('phone');
    const signed = await signWithDevice(phoneSigner, 'version', SUBJECT);
    await user.revoke('phone');
    // Once revoked, a device's signatures need a cutoff check, whatever
    // sequence or timestamp it claims.
    await rejectsWith(
      verifyDeviceSignature(user.list, 'version', SUBJECT, signed),
      'key-revoked'
    );
    const late = await signWithDevice(
      { ...phoneSigner, deviceListSequence: 1 },
      'version',
      SUBJECT
    );
    await rejectsWith(
      verifyDeviceSignature(user.list, 'version', SUBJECT, late),
      'key-revoked'
    );
    // A device the list never certified, here another user's.
    await rejectsWith(
      verifyDeviceSignature(
        user.list,
        'version',
        SUBJECT,
        await signWithDevice(
          { ...other.signer(), userId: 'user-1' },
          'version',
          SUBJECT
        )
      ),
      'authentication-failed'
    );
    // A device certified after the sequence it cites.
    await user.addDevice('tablet');
    await rejectsWith(
      verifyDeviceSignature(
        user.list,
        'version',
        SUBJECT,
        await signWithDevice(
          { ...user.signer('tablet'), deviceListSequence: 0 },
          'version',
          SUBJECT
        )
      ),
      'authentication-failed'
    );
    // The reader's list is older than the signature claims.
    await rejectsWith(
      verifyDeviceSignature(
        user.list,
        'version',
        SUBJECT,
        await signWithDevice(
          { ...user.signer(), deviceListSequence: 9 },
          'version',
          SUBJECT
        )
      ),
      'chain-broken'
    );
    await rejectsWith(
      verifyDeviceSignature(
        other.list,
        'version',
        SUBJECT,
        await signWithDevice(user.signer(), 'version', SUBJECT)
      ),
      'context-mismatch'
    );
  });

  it('reject malformed signatures and signers', async () => {
    const user = await TestUser.create('user-1');
    const signature = await signWithDevice(user.signer(), 'version', SUBJECT);
    const future = new Uint8Array(signature);
    future[0] = 2;
    expect(() => readDeviceSignature(future)).toThrow(
      expect.objectContaining({ code: 'unsupported-version' })
    );
    for (const bad of [
      signature.subarray(0, 70),
      new Uint8Array(),
      concatBytes(signature, patternBytes(1))
    ]) {
      expect(() => readDeviceSignature(bad)).toThrow(E2eeError);
    }
    await rejectsWith(
      signWithDevice(
        { ...user.signer(), deviceKeyHash: patternBytes(31) },
        'version',
        SUBJECT
      ),
      'invalid-argument'
    );
    await rejectsWith(
      signWithDevice(
        { ...user.signer(), privateKey: user.identity.publicKey },
        'version',
        SUBJECT
      ),
      'invalid-argument'
    );
  });
});
