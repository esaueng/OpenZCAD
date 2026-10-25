import { describe, expect, it } from 'vitest';
import { concatBytes } from './bytes';
import { publicKeyHash } from './codes';
import {
  MAX_CONTACTS_ENTRIES,
  contactDeviceListPin,
  contactsEntryHash,
  decodeContactsEntry,
  encodeContactsEntry,
  nextContactsEntry,
  signContactsEntry,
  verifyContactsList,
  type ContactsChange,
  type ContactsEntry,
  type SignedContactsEntry,
  type VerifiedContactsList
} from './contacts';
import {
  accountKeyCommitment,
  deviceListEntryHash,
  nextDeviceListEntry,
  signDeviceListEntry,
  verifyDeviceList
} from './devices';
import {
  exportPublicKey,
  generateEncryptionKeyPair,
  generateSigningKeyPair
} from './keys';
import { patternBytes } from './test-support';

const OWNER = 'user_owner';
const BOB = 'user_bob';
const CAROL = 'user_carol';

const head = (sequence: number, fill = sequence) => ({
  sequence,
  entryHash: patternBytes(32, fill)
});

async function owner() {
  const identity = await generateSigningKeyPair(false);
  const raw = await exportPublicKey(identity.publicKey);
  const chain: SignedContactsEntry[] = [];
  let list: VerifiedContactsList | null = null;
  return {
    identity,
    raw,
    chain,
    get list() {
      return list;
    },
    async append(change: Omit<ContactsChange, 'issuedAt'>) {
      const entry = nextContactsEntry(list, OWNER, {
        issuedAt: 1_760_000_000_000 + chain.length,
        ...change
      });
      chain.push(await signContactsEntry(identity.privateKey, entry));
      list = await verifyContactsList(raw, chain);
      return list;
    }
  };
}

/** Signs an entry without the builder's checks, as a hostile client could. */
async function forged(
  identity: CryptoKeyPair,
  list: VerifiedContactsList | null,
  change: Omit<ContactsEntry, 'userId' | 'sequence' | 'previousEntryHash'>
): Promise<SignedContactsEntry> {
  return signContactsEntry(identity.privateKey, {
    userId: OWNER,
    sequence: list ? list.head.sequence + 1 : 0,
    previousEntryHash: list ? list.headHash : null,
    ...change
  });
}

describe('contacts entries', () => {
  it('round-trips canonical bytes and refuses anything else', () => {
    const entry: ContactsEntry = {
      userId: OWNER,
      sequence: 0,
      previousEntryHash: null,
      issuedAt: 1,
      action: 'verify',
      contactUserId: BOB,
      identityKeyHash: patternBytes(32, 7),
      deviceListHead: head(3)
    };
    const bytes = encodeContactsEntry(entry);
    expect(decodeContactsEntry(bytes)).toEqual(entry);
    expect(() =>
      decodeContactsEntry(concatBytes(bytes, Uint8Array.of(0)))
    ).toThrow(expect.objectContaining({ code: 'malformed' }));
    const unknownVersion = new Uint8Array(bytes);
    unknownVersion[3] = 2;
    expect(() => decodeContactsEntry(unknownVersion)).toThrow(
      expect.objectContaining({ code: 'unsupported-version' })
    );
    expect(() => encodeContactsEntry({ ...entry, action: 'untrust' })).toThrow(
      expect.objectContaining({ code: 'invalid-argument' })
    );
    expect(() =>
      encodeContactsEntry({ ...entry, deviceListHead: null })
    ).toThrow(expect.objectContaining({ code: 'invalid-argument' }));
    expect(() =>
      encodeContactsEntry({ ...entry, contactUserId: OWNER })
    ).toThrow(/own user/);
    expect(() =>
      encodeContactsEntry({ ...entry, previousEntryHash: patternBytes(32) })
    ).toThrow(/first entry/);
  });

  it('follows verify, advance, key change, a new verification and untrust', async () => {
    const me = await owner();
    const old = patternBytes(32, 0x10);
    const replacement = patternBytes(32, 0x20);
    let list = await me.append({
      action: 'verify',
      contactUserId: BOB,
      identityKeyHash: old,
      deviceListHead: head(2)
    });
    expect(list.contacts.get(BOB)).toMatchObject({
      status: 'verified',
      deviceListHead: { sequence: 2 },
      verifiedAt: 0
    });
    list = await me.append({
      action: 'advance',
      contactUserId: BOB,
      identityKeyHash: old,
      deviceListHead: head(5)
    });
    expect(list.contacts.get(BOB)?.deviceListHead.sequence).toBe(5);
    list = await me.append({
      action: 'key-changed',
      contactUserId: BOB,
      identityKeyHash: old
    });
    expect(list.contacts.get(BOB)?.status).toBe('key-changed');
    list = await me.append({
      action: 'verify',
      contactUserId: BOB,
      identityKeyHash: replacement,
      deviceListHead: head(0)
    });
    expect(list.contacts.get(BOB)).toMatchObject({
      status: 'verified',
      verifiedAt: 3,
      identityKeyHash: replacement
    });
    await me.append({
      action: 'verify',
      contactUserId: CAROL,
      identityKeyHash: old,
      deviceListHead: head(1)
    });
    list = await me.append({
      action: 'untrust',
      contactUserId: CAROL,
      identityKeyHash: old
    });
    expect(list.contacts.get(CAROL)?.status).toBe('untrusted');
    expect(list.pin.sequence).toBe(5);
    expect(list.pin.entryHash).toEqual(
      await contactsEntryHash(me.chain.at(-1)!.entry)
    );
  });

  it('refuses changes the list state does not allow', async () => {
    const me = await owner();
    const key = patternBytes(32, 0x10);
    const other = patternBytes(32, 0x30);
    const verify = {
      action: 'verify' as const,
      contactUserId: BOB,
      identityKeyHash: key,
      deviceListHead: head(4)
    };
    // Nothing to advance, withdraw or mark changed yet.
    for (const change of [
      { ...verify, action: 'advance' as const },
      { action: 'untrust' as const, contactUserId: BOB, identityKeyHash: key },
      {
        action: 'key-changed' as const,
        contactUserId: BOB,
        identityKeyHash: key
      }
    ]) {
      expect(() =>
        nextContactsEntry(null, OWNER, { issuedAt: 1, ...change })
      ).toThrow(expect.objectContaining({ code: 'invalid-argument' }));
      await expect(
        verifyContactsList(me.raw, [
          await forged(me.identity, null, {
            issuedAt: 1,
            deviceListHead: null,
            ...change
          })
        ])
      ).rejects.toMatchObject({ code: 'chain-broken' });
    }
    const list = await me.append(verify);
    const refused: [string, Omit<ContactsChange, 'issuedAt'>][] = [
      ['already verified', verify],
      [
        'before recording the key change',
        { ...verify, identityKeyHash: other }
      ],
      ['backwards', { ...verify, action: 'advance', deviceListHead: head(4) }],
      [
        'not verified',
        {
          ...verify,
          action: 'advance',
          identityKeyHash: other,
          deviceListHead: head(9)
        }
      ],
      [
        'not verified',
        { action: 'key-changed', contactUserId: BOB, identityKeyHash: other }
      ]
    ];
    for (const [message, change] of refused) {
      expect(() =>
        nextContactsEntry(list, OWNER, { issuedAt: 2, ...change })
      ).toThrow(message);
      await expect(
        verifyContactsList(me.raw, [
          ...me.chain,
          await forged(me.identity, list, {
            issuedAt: 2,
            deviceListHead: null,
            ...change
          })
        ])
      ).rejects.toMatchObject({ code: 'chain-broken' });
    }
    expect(() =>
      nextContactsEntry(list, 'user_someone_else', { issuedAt: 2, ...verify })
    ).toThrow(/another user/);
  });

  it('refuses a rolled-back or forked list against the pin', async () => {
    const me = await owner();
    await me.append({
      action: 'verify',
      contactUserId: BOB,
      identityKeyHash: patternBytes(32, 1),
      deviceListHead: head(0)
    });
    const before = me.list!;
    const after = await me.append({
      action: 'untrust',
      contactUserId: BOB,
      identityKeyHash: patternBytes(32, 1)
    });
    // Rollback: the server hides the newest entry.
    await expect(
      verifyContactsList(me.raw, me.chain.slice(0, 1), { pin: after.pin })
    ).rejects.toMatchObject({ code: 'chain-broken' });
    // Fork: another entry at the pinned height, validly signed.
    const fork = await signContactsEntry(
      me.identity.privateKey,
      nextContactsEntry(before, OWNER, {
        issuedAt: 99,
        action: 'advance',
        contactUserId: BOB,
        identityKeyHash: patternBytes(32, 1),
        deviceListHead: head(7)
      })
    );
    await expect(
      verifyContactsList(me.raw, [me.chain[0]!, fork], { pin: after.pin })
    ).rejects.toMatchObject({ code: 'chain-broken' });
    // A longer list that extends the pin is accepted and moves it.
    const longer = await me.append({
      action: 'verify',
      contactUserId: CAROL,
      identityKeyHash: patternBytes(32, 2),
      deviceListHead: head(0)
    });
    await expect(
      verifyContactsList(me.raw, me.chain, { pin: before.pin })
    ).resolves.toMatchObject({ pin: longer.pin });
    // A list under another identity is not this browser's list at all.
    const stranger = await owner();
    await stranger.append({
      action: 'verify',
      contactUserId: BOB,
      identityKeyHash: patternBytes(32, 1),
      deviceListHead: head(0)
    });
    await expect(
      verifyContactsList(stranger.raw, stranger.chain, { pin: after.pin })
    ).rejects.toMatchObject({ code: 'context-mismatch' });
  });

  it('refuses entries not signed by the identity, a gap and a change of user', async () => {
    const me = await owner();
    const intruder = await generateSigningKeyPair(false);
    const first = await me.append({
      action: 'verify',
      contactUserId: BOB,
      identityKeyHash: patternBytes(32, 1),
      deviceListHead: head(0)
    });
    const change = {
      issuedAt: 2,
      action: 'verify' as const,
      contactUserId: CAROL,
      identityKeyHash: patternBytes(32, 2),
      deviceListHead: head(0)
    };
    const unsigned = await signContactsEntry(
      intruder.privateKey,
      nextContactsEntry(first, OWNER, change)
    );
    await expect(
      verifyContactsList(me.raw, [...me.chain, unsigned])
    ).rejects.toMatchObject({ code: 'authentication-failed' });
    // The Worker re-checks only the entry it is appending.
    await expect(
      verifyContactsList(me.raw, [...me.chain, unsigned], { signaturesFrom: 1 })
    ).rejects.toMatchObject({ code: 'authentication-failed' });
    await expect(
      verifyContactsList(
        me.raw,
        [
          { entry: me.chain[0]!.entry, signature: unsigned.signature },
          await signContactsEntry(
            me.identity.privateKey,
            nextContactsEntry(first, OWNER, change)
          )
        ],
        { signaturesFrom: 1 }
      )
    ).resolves.toMatchObject({ pin: { sequence: 1 } });
    const gap = await signContactsEntry(me.identity.privateKey, {
      ...nextContactsEntry(first, OWNER, change),
      sequence: 2
    });
    await expect(
      verifyContactsList(me.raw, [...me.chain, gap])
    ).rejects.toMatchObject({
      code: 'chain-broken'
    });
    const otherUser = await signContactsEntry(me.identity.privateKey, {
      ...nextContactsEntry(first, OWNER, change),
      userId: 'user_mallory'
    });
    await expect(
      verifyContactsList(me.raw, [...me.chain, otherUser])
    ).rejects.toThrow(/changes user/);
    await expect(
      verifyContactsList(
        me.raw,
        Array.from({ length: MAX_CONTACTS_ENTRIES + 1 }, () => me.chain[0]!)
      )
    ).rejects.toMatchObject({ code: 'limit-exceeded' });
  });

  it("pins a verified contact's device list so a rollback behind it fails", async () => {
    const identity = await generateSigningKeyPair(false);
    const identityRaw = await exportPublicKey(identity.publicKey);
    const ecdh = async () =>
      exportPublicKey((await generateEncryptionKeyPair()).publicKey);
    const genesis = await signDeviceListEntry(identity.privateKey, {
      userId: BOB,
      sequence: 0,
      previousEntryHash: null,
      issuedAt: 1,
      previousIdentityKeyHash: null,
      encryptionKey: await ecdh(),
      accountKeyCommitment: await accountKeyCommitment(patternBytes(32)),
      devices: [
        {
          deviceId: 'd1',
          label: 'd1',
          signingKey: await exportPublicKey(
            (await generateSigningKeyPair()).publicKey
          ),
          unlockKey: await ecdh(),
          addedAt: 1
        }
      ],
      unlockTargets: [
        {
          kind: 'recovery-key',
          targetId: 'rk',
          publicKey: await ecdh(),
          addedAt: 1
        }
      ],
      revoked: []
    });
    const first = await verifyDeviceList(identityRaw, [genesis]);
    const rotated = await signDeviceListEntry(
      identity.privateKey,
      nextDeviceListEntry(first, {
        issuedAt: 2,
        encryptionKey: await ecdh(),
        accountKeyCommitment: await accountKeyCommitment(patternBytes(32, 9))
      })
    );
    const bobKey = await publicKeyHash(identityRaw);
    const me = await owner();
    const list = await me.append({
      action: 'verify',
      contactUserId: BOB,
      identityKeyHash: bobKey,
      deviceListHead: {
        sequence: 1,
        entryHash: await deviceListEntryHash(rotated.entry)
      }
    });
    const pin = contactDeviceListPin(list.contacts.get(BOB)!);
    await expect(
      verifyDeviceList(identityRaw, [genesis, rotated], { pin })
    ).resolves.toMatchObject({ pin: { sequence: 1 } });
    // The server shows the older list, whose encryption key was replaced.
    await expect(
      verifyDeviceList(identityRaw, [genesis], { pin })
    ).rejects.toMatchObject({ code: 'chain-broken' });
  });
});
