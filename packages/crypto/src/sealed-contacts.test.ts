import { describe, expect, it } from 'vitest';
import { fromHex, toHex } from './bytes';
import {
  SEALED_CONTACTS_RECORD_BYTES,
  contactsEntryHash,
  encodeContactsEntry,
  isSealedContactsRecord,
  nextContactsEntry,
  openSealedContactsRecord,
  readSealedContactsHeader,
  sealContactsEntries,
  sealContactsEntryWith,
  sealedContactsRecordHash,
  signContactsEntry,
  signSealedContactsRecord,
  verifyContactsList,
  verifySealedContactsChain,
  verifySealedContactsList,
  type ContactsChange,
  type ContactsEntry,
  type SignedContactsEntry,
  type VerifiedContactsList
} from './contacts';
import { isE2eeError } from './errors';
import { exportPublicKey, generateSigningKeyPair } from './keys';
import { patternBytes, queuedRandom } from './test-support';

const ALICE = 'user_alice';
const BOB = 'user_bob';
const CAROL = 'user_carol_with_a_much_longer_identifier';

/**
 * Fixed vector (ADR-024 amendment 2026-11-14): account key 00..1f, user
 * "user_alice", account-key sequence 3, previous record hash 80..9f, IV
 * 40..4b, sealing the entry below. Checked against an independent
 * implementation (Python `cryptography`: HKDF-SHA-256, AES-GCM and
 * SHA-256, built from the documented layout, not from this code). A change
 * here is a storage-format change.
 */
const VECTOR_ENTRY: ContactsEntry = {
  userId: ALICE,
  sequence: 1,
  previousEntryHash: patternBytes(32, 0x60),
  issuedAt: 1_760_000_000_000,
  action: 'verify',
  contactUserId: BOB,
  identityKeyHash: patternBytes(32, 0x10),
  deviceListHead: { sequence: 2, entryHash: patternBytes(32, 0x20) }
};
const VECTOR_HEX =
  '4f5a43010000000120808182838485868788898a8b8c8d8e8f909192939495969798' +
  '999a9b9c9d9e9f00000003404142434445464748494a4bc86636e856e153c07bcad8' +
  'abf8bb63c99b68b2eea4f6727a4a4737d72402177b4d14fb7bbbb0720d5a89bde4e1' +
  'f1ddd23d6d2601e7cf5eaf6a92debec480cc802a45e628e4183b8c928fe522495220' +
  '89643c7ff6d3218483eaed118eb5a6de981a132a6ac28c09da379865e5c95cc28228' +
  '41ba35a24e97ac99b19dbacbf8fb925e624dc045056daf98527062990a1457a4b396' +
  '6f4980e774ed246afb509a59cb3f2ce6447ed8f7dec9b0a9a49daf80fa38312086ee' +
  '71b22dc537344647879ef69774b84907be3251f54b48762e251a41f188ccc7049741' +
  '7d6e94a5ac39e6f48d5ad31c2074c794bf62a2ba06cb3fa476d12b5a7b6410e519a5' +
  'b05c4dc3b6e15f96f672769f16c915f5800ed0c8bf8dc3634b73e74ca9cf5efc7edb' +
  '58e18de22530a7aba32b96953be865c1df6de4f8af4eed0381defe1ffbd3b62e0641' +
  'bc73d3703d5e4d28c0672a043ebdaf261d3fcc9a46797b26ffcf9c8760d6f3386e80' +
  'dfcd06fd3ee4fcab6c2c8ab5988ab8c76b4035690941a51524be67e5bcbe81ae2c5d' +
  '3e71df34645a1b991e0647d78b91d7';
const VECTOR_RECORD_HASH =
  '5d93b3b5ed293720d615f2c32899c3749f053b0b747063594bad9089f72a52be';
const VECTOR_ENTRY_HASH =
  'bf09575969e008dadb0734ee84a3ba71923a569b37b599e82dd78578afea4935';

const code = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    return isE2eeError(error) ? error.code : error;
  }
  return 'passed';
};

/** One account's identity, its account keys by sequence, and its list. */
async function account() {
  const identity = await generateSigningKeyPair(false);
  const raw = await exportPublicKey(identity.publicKey);
  const keys = new Map<number, Uint8Array>([[0, patternBytes(32, 0xa0)]]);
  let keySequence = 0;
  const chain: SignedContactsEntry[] = [];
  let list: VerifiedContactsList | null = null;
  const openKey = async (sequence: number) => {
    const key = keys.get(sequence);
    if (!key) throw new Error(`no account key ${sequence}`);
    return new Uint8Array(key);
  };
  return {
    identity,
    raw,
    chain,
    keys,
    openKey,
    get list() {
      return list;
    },
    /** Rotates the account key, as a device removal does. */
    rotate(sequence: number) {
      keys.set(sequence, patternBytes(32, sequence * 16));
      keySequence = sequence;
    },
    async append(change: Omit<ContactsChange, 'issuedAt'>) {
      const entry = nextContactsEntry(list, ALICE, {
        issuedAt: 1_760_000_000_000 + chain.length,
        ...change
      });
      chain.push(
        ...(await sealContactsEntries(
          identity.privateKey,
          keys.get(keySequence)!,
          {
            userId: ALICE,
            accountKeySequence: keySequence,
            previous: list?.sealed ?? null,
            entries: [entry]
          }
        ))
      );
      list = await verifySealedContactsList(raw, chain, {
        userId: ALICE,
        openKey
      });
      return list;
    }
  };
}

const verifyBob = (fill: number, sequence = 0) => ({
  action: 'verify' as const,
  contactUserId: BOB,
  identityKeyHash: patternBytes(32, fill),
  deviceListHead: { sequence, entryHash: patternBytes(32, sequence) }
});

describe('sealed contacts records (ADR-024 amendment 2026-11-14)', () => {
  it('matches the fixed vector and opens to the same entry', async () => {
    const record = await sealContactsEntryWith(
      queuedRandom(patternBytes(12, 0x40)),
      patternBytes(32),
      {
        userId: ALICE,
        accountKeySequence: 3,
        previous: {
          sequence: 0,
          recordHash: patternBytes(32, 0x80),
          accountKeySequence: 3
        },
        entry: VECTOR_ENTRY
      }
    );
    expect(toHex(record)).toBe(VECTOR_HEX);
    expect(record.byteLength).toBe(SEALED_CONTACTS_RECORD_BYTES.next);
    expect(toHex(await sealedContactsRecordHash(record))).toBe(
      VECTOR_RECORD_HASH
    );
    expect(isSealedContactsRecord(record)).toBe(true);
    expect(readSealedContactsHeader(record)).toEqual({
      sequence: 1,
      previousRecordHash: patternBytes(32, 0x80),
      accountKeySequence: 3
    });
    const opened = await openSealedContactsRecord(
      patternBytes(32),
      ALICE,
      fromHex(VECTOR_HEX)
    );
    expect(opened.entry).toEqual(VECTOR_ENTRY);
    // The entry inside is the plaintext format, byte for byte, so its hash
    // (what every pin and approval head names) is unchanged by sealing.
    expect(opened.bytes).toEqual(encodeContactsEntry(VECTOR_ENTRY));
    expect(toHex(await contactsEntryHash(opened.bytes))).toBe(
      VECTOR_ENTRY_HASH
    );
  });

  it('shows the server nothing but order, links, key sequence and a fixed size', async () => {
    const plaintext = encodeContactsEntry(VECTOR_ENTRY);
    const record = fromHex(VECTOR_HEX);
    const text = new TextDecoder('latin1').decode(record);
    expect(text).not.toContain(BOB);
    expect(text).not.toContain(ALICE);
    expect(toHex(record)).not.toContain(toHex(patternBytes(32, 0x10)));
    expect(toHex(record)).not.toContain(toHex(plaintext.subarray(-36)));
    // Every action and id length seals to the same size.
    const sizes = new Set<number>();
    for (const entry of [
      VECTOR_ENTRY,
      {
        ...VECTOR_ENTRY,
        action: 'untrust' as const,
        contactUserId: CAROL,
        deviceListHead: null
      },
      { ...VECTOR_ENTRY, contactUserId: 'u'.repeat(128) }
    ]) {
      sizes.add(
        (
          await sealContactsEntryWith(
            queuedRandom(patternBytes(12)),
            patternBytes(32),
            {
              userId: ALICE,
              accountKeySequence: 0,
              previous: {
                sequence: 0,
                recordHash: patternBytes(32),
                accountKeySequence: 0
              },
              entry
            }
          )
        ).byteLength
      );
    }
    expect([...sizes]).toEqual([SEALED_CONTACTS_RECORD_BYTES.next]);
  });

  it('opens only with its account key, for its account, unaltered', async () => {
    const record = fromHex(VECTOR_HEX);
    expect(
      await code(openSealedContactsRecord(patternBytes(32, 1), ALICE, record))
    ).toBe('authentication-failed');
    expect(
      await code(openSealedContactsRecord(patternBytes(32), BOB, record))
    ).toBe('authentication-failed');
    for (const index of [10, 41, 44, 45, 60, record.byteLength - 1]) {
      const altered = new Uint8Array(record);
      altered[index]! ^= 1;
      expect(
        await code(openSealedContactsRecord(patternBytes(32), ALICE, altered)),
        `byte ${index}`
      ).toBe('authentication-failed');
    }
    const version = new Uint8Array(record);
    version[3] = 2;
    expect(() => readSealedContactsHeader(version)).toThrow(
      expect.objectContaining({ code: 'unsupported-version' })
    );
    expect(() => readSealedContactsHeader(record.subarray(0, 300))).toThrow(
      expect.objectContaining({ code: 'malformed' })
    );
    expect(() =>
      readSealedContactsHeader(encodeContactsEntry(VECTOR_ENTRY))
    ).toThrow(expect.objectContaining({ code: 'malformed' }));
    // A record whose sequence is not its entry's never seals.
    await expect(
      sealContactsEntryWith(queuedRandom(patternBytes(12)), patternBytes(32), {
        userId: ALICE,
        accountKeySequence: 0,
        previous: null,
        entry: VECTOR_ENTRY
      })
    ).rejects.toMatchObject({ code: 'invalid-argument' });
  });

  it('verifies a list sealed across account-key rotations, with the same rules and pins', async () => {
    const me = await account();
    await me.append(verifyBob(0x10, 1));
    // A device removal rotated the account key: later records use the new
    // key, earlier ones stay under the old key, reachable through history.
    me.rotate(4);
    await me.append({
      ...verifyBob(0x10, 3),
      action: 'advance'
    });
    const list = await me.append({
      action: 'verify',
      contactUserId: CAROL,
      identityKeyHash: patternBytes(32, 0x30),
      deviceListHead: { sequence: 0, entryHash: patternBytes(32) }
    });
    expect(list.contacts.get(BOB)?.deviceListHead.sequence).toBe(3);
    expect(list.sealed).toMatchObject({ sequence: 2, accountKeySequence: 4 });
    expect(
      me.chain.map((r) => readSealedContactsHeader(r.entry).accountKeySequence)
    ).toEqual([0, 4, 4]);
    // A removed device holds only the old key: it opens nothing newer.
    expect(
      await code(
        verifySealedContactsList(me.raw, me.chain, {
          userId: ALICE,
          openKey: async (sequence) =>
            sequence === 0 ? patternBytes(32, 0xa0) : patternBytes(32, 0xee)
        })
      )
    ).toBe('authentication-failed');
    // The list rules still hold inside the seal.
    await expect(me.append({ ...verifyBob(0x10, 9) })).rejects.toMatchObject({
      code: 'invalid-argument'
    });
  });

  it('refuses a sealed list rolled back or forked behind the pin', async () => {
    const me = await account();
    await me.append(verifyBob(0x10));
    const full = await me.append({
      action: 'key-changed',
      contactUserId: BOB,
      identityKeyHash: patternBytes(32, 0x10)
    });
    const verify = (chain: SignedContactsEntry[]) =>
      verifySealedContactsList(me.raw, chain, {
        userId: ALICE,
        openKey: me.openKey,
        pin: full.pin
      });
    expect(await code(verify(me.chain))).toBe('passed');
    // Rolled back to before the key change: the old key would be verified.
    expect(await code(verify(me.chain.slice(0, 1)))).toBe('chain-broken');
    // A fork: a different, validly signed second record.
    const first = await verifySealedContactsList(me.raw, me.chain.slice(0, 1), {
      userId: ALICE,
      openKey: me.openKey
    });
    const fork = await sealContactsEntries(
      me.identity.privateKey,
      me.keys.get(0)!,
      {
        userId: ALICE,
        accountKeySequence: 0,
        previous: first.sealed,
        entries: [
          nextContactsEntry(first, ALICE, {
            issuedAt: 9,
            action: 'untrust',
            contactUserId: BOB,
            identityKeyHash: patternBytes(32, 0x10)
          })
        ]
      }
    );
    expect(await code(verify([me.chain[0]!, ...fork]))).toBe('chain-broken');
  });

  it('keeps every plaintext pin valid when a plaintext list is resealed', async () => {
    const identity = await generateSigningKeyPair(false);
    const raw = await exportPublicKey(identity.publicKey);
    const plaintext: SignedContactsEntry[] = [];
    let list: VerifiedContactsList | null = null;
    for (const change of [
      verifyBob(0x10),
      { ...verifyBob(0x10, 2), action: 'advance' as const },
      {
        action: 'untrust' as const,
        contactUserId: BOB,
        identityKeyHash: patternBytes(32, 0x10)
      }
    ]) {
      const entry = nextContactsEntry(list, ALICE, { issuedAt: 5, ...change });
      plaintext.push(await signContactsEntry(identity.privateKey, entry));
      list = await verifyContactsList(raw, plaintext);
    }
    expect(list!.sealed).toBeNull();
    const pins = await Promise.all(
      [1, 2, 3].map(
        async (n) => (await verifyContactsList(raw, plaintext.slice(0, n))).pin
      )
    );
    const resealed = await sealContactsEntries(
      identity.privateKey,
      patternBytes(32, 0xa0),
      {
        userId: ALICE,
        accountKeySequence: 0,
        previous: null,
        entries: list!.entries.map(({ entry }) => entry)
      }
    );
    for (const pin of pins) {
      const sealed = await verifySealedContactsList(raw, resealed, {
        userId: ALICE,
        openKey: async () => patternBytes(32, 0xa0),
        pin
      });
      expect(sealed.pin).toEqual(list!.pin);
      expect(sealed.contacts).toEqual(list!.contacts);
    }
  });

  it('lets a key-less store check order, links, key sequence and signatures', async () => {
    const me = await account();
    await me.append(verifyBob(0x10));
    me.rotate(2);
    await me.append({ ...verifyBob(0x10, 1), action: 'advance' });
    const checked = await verifySealedContactsChain(me.raw, me.chain);
    expect(checked.head).toMatchObject({ sequence: 1, accountKeySequence: 2 });
    expect(checked.head.recordHash).toEqual(
      await sealedContactsRecordHash(me.chain[1]!.entry)
    );
    // Another identity's signature.
    const intruder = await generateSigningKeyPair(false);
    const reSigned = await signSealedContactsRecord(
      intruder.privateKey,
      me.chain[1]!.entry
    );
    expect(
      await code(verifySealedContactsChain(me.raw, [me.chain[0]!, reSigned]))
    ).toBe('authentication-failed');
    // Stored records are not re-checked; the new one is.
    expect(
      await code(
        verifySealedContactsChain(me.raw, [me.chain[0]!, reSigned], {
          signaturesFrom: 1
        })
      )
    ).toBe('authentication-failed');
    expect(
      await code(
        verifySealedContactsChain(me.raw, me.chain, { signaturesFrom: 1 })
      )
    ).toBe('passed');
    // Out of order, and back to an older account key.
    expect(await code(verifySealedContactsChain(me.raw, [me.chain[1]!]))).toBe(
      'chain-broken'
    );
    const backwards = await sealContactsEntries(
      me.identity.privateKey,
      me.keys.get(0)!,
      {
        userId: ALICE,
        accountKeySequence: 0,
        previous: { ...me.list!.sealed!, accountKeySequence: 0 },
        entries: [
          nextContactsEntry(me.list, ALICE, {
            issuedAt: 9,
            action: 'untrust',
            contactUserId: BOB,
            identityKeyHash: patternBytes(32, 0x10)
          })
        ]
      }
    );
    expect(
      await code(verifySealedContactsChain(me.raw, [...me.chain, ...backwards]))
    ).toBe('chain-broken');
  });

  it('refuses a list that mixes sealed and plaintext entries', async () => {
    const me = await account();
    await me.append(verifyBob(0x10));
    const plaintext = await signContactsEntry(
      me.identity.privateKey,
      nextContactsEntry(me.list, ALICE, {
        issuedAt: 9,
        action: 'untrust',
        contactUserId: BOB,
        identityKeyHash: patternBytes(32, 0x10)
      })
    );
    expect(
      await code(verifySealedContactsChain(me.raw, [...me.chain, plaintext]))
    ).toBe('malformed');
    expect(
      await code(
        verifySealedContactsList(me.raw, [...me.chain, plaintext], {
          userId: ALICE,
          openKey: me.openKey
        })
      )
    ).toBe('malformed');
    expect(await code(verifyContactsList(me.raw, me.chain))).toBe('malformed');
  });
});
