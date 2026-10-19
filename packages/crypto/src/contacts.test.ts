import { describe, expect, it } from 'vitest';
import {
  contactsEntryHash,
  decodeContactsEntry,
  encodeContactsEntry,
  isVerifiedContact,
  signContactsEntry,
  verifyContactsList,
  type ContactsListEntry,
  type SignedContactsEntry
} from './contacts';
import { E2eeError, type E2eeErrorCode } from './errors';
import { generateIdentityKeyPair } from './keys';
import { patternBytes } from './test-support';

async function rejectsWith(
  promise: Promise<unknown>,
  code: E2eeErrorCode
): Promise<void> {
  await expect(promise).rejects.toSatisfy(
    (error: unknown) => error instanceof E2eeError && error.code === code
  );
}

const ALICE_KEY = patternBytes(32, 0x10);
const ALICE_NEW_KEY = patternBytes(32, 0x30);
const BOB_KEY = patternBytes(32, 0x50);

type Step = Pick<
  ContactsListEntry,
  'action' | 'contactUserId' | 'identityKeyHash' | 'replacementKeyHash'
>;

async function build(
  identity: CryptoKeyPair,
  steps: readonly Step[]
): Promise<SignedContactsEntry[]> {
  const chain: SignedContactsEntry[] = [];
  for (const [sequence, step] of steps.entries()) {
    const before = chain.at(-1);
    chain.push(
      await signContactsEntry(identity.privateKey, {
        ownerUserId: 'owner',
        sequence,
        previousEntryHash: before
          ? await contactsEntryHash(before.entry)
          : null,
        ...step
      })
    );
  }
  return chain;
}

const verify = (contactUserId: string, identityKeyHash: Uint8Array): Step => ({
  action: 'verify',
  contactUserId,
  identityKeyHash,
  replacementKeyHash: null
});

const STEPS: Step[] = [
  verify('alice', ALICE_KEY),
  verify('bob', BOB_KEY),
  {
    action: 'replace',
    contactUserId: 'alice',
    identityKeyHash: ALICE_KEY,
    replacementKeyHash: ALICE_NEW_KEY
  },
  {
    action: 'distrust',
    contactUserId: 'bob',
    identityKeyHash: BOB_KEY,
    replacementKeyHash: null
  },
  verify('alice', ALICE_NEW_KEY)
];

describe('contacts list', () => {
  it('folds verifications, replacements and distrust into pins', async () => {
    const identity = await generateIdentityKeyPair();
    const chain = await build(identity, STEPS);
    const after = async (count: number) =>
      verifyContactsList(identity.publicKey, chain.slice(0, count));

    const two = await after(2);
    expect(isVerifiedContact(two, 'alice', ALICE_KEY)).toBe(true);
    expect(isVerifiedContact(two, 'bob', BOB_KEY)).toBe(true);
    expect(isVerifiedContact(two, 'bob', ALICE_KEY)).toBe(false);

    const replaced = await after(3);
    expect(replaced.contacts.find((c) => c.userId === 'alice')).toMatchObject({
      status: 'replaced',
      identityKeyHash: ALICE_KEY,
      replacementKeyHash: ALICE_NEW_KEY
    });
    expect(isVerifiedContact(replaced, 'alice', ALICE_KEY)).toBe(false);
    expect(isVerifiedContact(replaced, 'alice', ALICE_NEW_KEY)).toBe(false);

    const all = await after(5);
    expect(all.ownerUserId).toBe('owner');
    expect(all.latestSequence).toBe(4);
    expect(isVerifiedContact(all, 'alice', ALICE_NEW_KEY)).toBe(true);
    expect(all.contacts.find((c) => c.userId === 'bob')?.status).toBe(
      'distrusted'
    );
    expect(isVerifiedContact(all, 'bob', BOB_KEY)).toBe(false);
  });

  it('refuses a rolled-back list that would revive a replaced pin', async () => {
    const identity = await generateIdentityKeyPair();
    const chain = await build(identity, STEPS);
    const newest = await verifyContactsList(identity.publicKey, chain);
    // The server serves the list from before Alice's key was replaced.
    await rejectsWith(
      verifyContactsList(identity.publicKey, chain.slice(0, 2), {
        pinnedEntryHash: newest.latestHash
      }),
      'chain-broken'
    );
    // A fork from entry 2 that verifies an attacker's key for Alice.
    const fork = [
      ...chain.slice(0, 2),
      ...(
        await build(identity, [
          ...STEPS.slice(0, 2),
          {
            action: 'replace',
            contactUserId: 'alice',
            identityKeyHash: ALICE_KEY,
            replacementKeyHash: patternBytes(32, 0x99)
          }
        ])
      ).slice(2)
    ];
    await verifyContactsList(identity.publicKey, fork);
    await rejectsWith(
      verifyContactsList(identity.publicKey, fork, {
        pinnedEntryHash: newest.latestHash
      }),
      'chain-broken'
    );
  });

  it('refuses another identity, broken links and impossible transitions', async () => {
    const identity = await generateIdentityKeyPair();
    const intruder = await generateIdentityKeyPair();
    const chain = await build(identity, STEPS);
    await rejectsWith(
      verifyContactsList(intruder.publicKey, chain),
      'authentication-failed'
    );
    await rejectsWith(
      verifyContactsList(identity.publicKey, [chain[0]!, chain[2]!]),
      'chain-broken'
    );
    await rejectsWith(
      verifyContactsList(identity.publicKey, chain.slice(1)),
      'chain-broken'
    );
    await rejectsWith(
      verifyContactsList(identity.publicKey, []),
      'chain-broken'
    );
    for (const bad of [
      // Replacing a key that is not the verified one.
      [verify('alice', ALICE_KEY), { ...STEPS[2]!, identityKeyHash: BOB_KEY }],
      // Distrusting someone never verified.
      [verify('alice', ALICE_KEY), { ...STEPS[3]! }]
    ]) {
      await rejectsWith(
        verifyContactsList(identity.publicKey, await build(identity, bad)),
        'chain-broken'
      );
    }
  });

  it('encodes canonically and rejects invalid entries', async () => {
    const identity = await generateIdentityKeyPair();
    const [first] = await build(identity, STEPS.slice(0, 1));
    const decoded = decodeContactsEntry(first!.entry);
    expect(encodeContactsEntry(decoded)).toEqual(first!.entry);
    const base: ContactsListEntry = decoded;
    for (const bad of [
      { ...base, contactUserId: 'owner' },
      { ...base, replacementKeyHash: ALICE_NEW_KEY },
      { ...base, action: 'replace' as const },
      {
        ...base,
        action: 'replace' as const,
        replacementKeyHash: base.identityKeyHash
      },
      { ...base, identityKeyHash: patternBytes(31) },
      { ...base, sequence: 1 },
      { ...base, action: 'pin' as never }
    ]) {
      expect(() => encodeContactsEntry(bad)).toThrow(E2eeError);
    }
    const future = new Uint8Array(first!.entry);
    future[3] = 2;
    expect(() => decodeContactsEntry(future)).toThrow(
      expect.objectContaining({ code: 'unsupported-version' })
    );
    expect(() => decodeContactsEntry(first!.entry.subarray(0, 20))).toThrow(
      E2eeError
    );
  });
});
