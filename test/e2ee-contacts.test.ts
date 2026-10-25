/**
 * Contacts and verified pins (ADR-024 Phase 5, slice 5-1): the contacts and
 * device-list routes over the real Worker and SQLite, and the browser's
 * contacts module (`contacts.ts`) driven by Node devices of two accounts.
 */
import { readFileSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  generateRecoveryKey,
  generateSigningKeyPair,
  nextContactsEntry,
  publicKeyHash,
  toHex,
  signContactsEntry,
  toBase64Url,
  type Bytes
} from '@openzcad/crypto';
import type { E2eeContactsResponse } from '@openzcad/shared';
import {
  enrollWithRecoveryKey,
  loadEncryption,
  replaceRecoveryKey,
  setUpEncryption,
  type AccountView,
  type E2eeContext,
  type EncryptionState
} from '../apps/web/src/lib/e2ee/accountKeys';
import { createE2eeApi, E2eeApiError } from '../apps/web/src/lib/e2ee/e2eeApi';
import { memoryDeviceStore } from '../apps/web/src/lib/e2ee/deviceStore';
import {
  ContactsError,
  createContactsApi,
  inspectContact,
  loadContacts,
  ownVerificationCode,
  parseContactScan,
  contactScanText,
  recordKeyChange,
  untrustContact,
  verifiedEncryptionKey,
  verifyContact,
  type ContactsContext
} from '../apps/web/src/lib/e2ee/contacts';
import {
  memoryContactPins,
  type ContactPinStore
} from '../apps/web/src/lib/e2ee/contactPins';
import {
  databaseBefore,
  newServer,
  type Server
} from './support/e2ee-documents';

const ALICE = 'user_alice';
const BOB = 'user_bob';
const CAROL = 'user_carol';
const STRANGER = 'user_stranger';
const EMAILS: Record<string, string> = {
  [ALICE]: 'alice@example.com',
  [BOB]: 'bob@example.com',
  [CAROL]: 'carol@example.com',
  [STRANGER]: 'stranger@example.com'
};

afterEach(() => {
  vi.useRealTimers();
});

function serverWith(db?: DatabaseSync): Server {
  const srv = newServer([], db);
  for (const [id, email] of Object.entries(EMAILS)) {
    srv.db
      .prepare('INSERT INTO users (id, email, created_at) VALUES (?, ?, ?)')
      .run(id, email, '2026-10-24T00:00:00.000Z');
  }
  return srv;
}

/** Alice owns a project Bob and Carol are members of. */
function share(srv: Server, projectId = 'proj_shared'): void {
  srv.db
    .prepare(
      `INSERT INTO projects (id, user_id, name, document_json, updated_at)
       VALUES (?, ?, 'Shared', '{}', '2026-10-24T00:00:00.000Z')`
    )
    .run(projectId, ALICE);
  for (const member of [BOB, CAROL]) {
    srv.db
      .prepare(
        `INSERT INTO project_members
           (project_id, user_id, role, added_by_user_id, created_at, updated_at)
         VALUES (?, ?, 'editor', ?, 1, 1)`
      )
      .run(projectId, member, ALICE);
  }
}

function fetcher(srv: Server, user: string) {
  return (path: string, init: RequestInit = {}) =>
    srv.call(init.method ?? 'GET', path, {
      user,
      ...(typeof init.body === 'string' ? { body: JSON.parse(init.body) } : {})
    });
}

function keysFor(srv: Server, user: string): E2eeContext {
  return {
    userId: user,
    api: createE2eeApi(fetcher(srv, user)),
    store: memoryDeviceStore(),
    now: () => 1_760_000_000_000
  };
}

function ready(state: EncryptionState): AccountView {
  if (state.kind !== 'ready') throw new Error(`Not ready: ${state.kind}`);
  return state.account;
}

interface Person {
  keys: E2eeContext;
  account: AccountView;
  recovery: { secret: Bytes; formatted: string };
  contacts: ContactsContext;
  pins: ContactPinStore;
}

async function person(srv: Server, user: string): Promise<Person> {
  const recovery = await generateRecoveryKey();
  const keys = keysFor(srv, user);
  const account = ready(
    await setUpEncryption(keys, {
      recoverySecret: recovery.secret,
      label: `${user} laptop`
    })
  );
  const pins = memoryContactPins();
  return {
    keys,
    account,
    recovery,
    pins,
    contacts: { keys, api: createContactsApi(fetcher(srv, user)), pins }
  };
}

async function refresh(p: Person): Promise<AccountView> {
  p.account = ready(await loadEncryption(p.keys));
  return p.account;
}

async function json<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

async function signedEntry(
  identity: CryptoKeyPair,
  userId: string,
  contactUserId: string
) {
  return signContactsEntry(
    identity.privateKey,
    nextContactsEntry(null, userId, {
      issuedAt: 1,
      action: 'verify',
      contactUserId,
      identityKeyHash: new Uint8Array(32).fill(1),
      deviceListHead: { sequence: 0, entryHash: new Uint8Array(32).fill(2) }
    })
  );
}

describe('contacts routes', () => {
  it('append only entries signed by the identity that extend the stored head', async () => {
    const srv = serverWith();
    expect(
      await json(await srv.call('GET', '/api/e2ee/contacts', { user: ALICE }))
    ).toEqual({ generation: null, entries: [], people: [] });
    const alice = await person(srv, ALICE);
    const contacts = alice.contacts;
    // A browser-built entry, through the module, is the valid path.
    const bob = await person(srv, BOB);
    share(srv);
    let book = await loadContacts(contacts, alice.account);
    const view = await inspectContact(contacts, book, BOB);
    book = await verifyContact(
      contacts,
      alice.account,
      book,
      view,
      alice.recovery.secret
    );
    expect(book.list?.pin.sequence).toBe(0);

    const post = (body: unknown) =>
      srv.call('POST', '/api/e2ee/contacts', { user: ALICE, body });
    const intruder = await generateSigningKeyPair(false);
    // Not signed by Alice's identity (and a stale sequence 0).
    const forged = await signedEntry(intruder, ALICE, CAROL);
    let response = await post({
      generation: alice.account.generation,
      entry: toBase64Url(forged.entry),
      signature: toBase64Url(forged.signature)
    });
    expect(response.status).toBe(409);
    expect(await json(response)).toMatchObject({
      code: 'E2EE_CONTACTS_CONFLICT'
    });
    const next = await signContactsEntry(
      intruder.privateKey,
      nextContactsEntry(book.list, ALICE, {
        issuedAt: 2,
        action: 'verify',
        contactUserId: CAROL,
        identityKeyHash: new Uint8Array(32).fill(3),
        deviceListHead: { sequence: 0, entryHash: new Uint8Array(32).fill(4) }
      })
    );
    response = await post({
      generation: alice.account.generation,
      entry: toBase64Url(next.entry),
      signature: toBase64Url(next.signature)
    });
    expect(response.status).toBe(400);
    expect(await json(response)).toMatchObject({
      code: 'E2EE_CONTACTS_INVALID'
    });
    // Another generation, garbage, and an oversized entry.
    for (const [body, code] of [
      [
        {
          generation: 9,
          entry: toBase64Url(next.entry),
          signature: toBase64Url(next.signature)
        },
        'E2EE_GENERATION_CONFLICT'
      ],
      [
        {
          generation: 1,
          entry: 'AAAA',
          signature: toBase64Url(next.signature)
        },
        'E2EE_CONTACTS_INVALID'
      ],
      [
        {
          generation: 1,
          entry: 'A'.repeat(800),
          signature: toBase64Url(next.signature)
        },
        'E2EE_REQUEST_INVALID'
      ],
      [
        { generation: 1, entry: toBase64Url(next.entry), signature: 'AAAA' },
        'E2EE_REQUEST_INVALID'
      ]
    ] as const) {
      response = await post(body);
      expect(response.status, code).toBeGreaterThanOrEqual(400);
      expect(await json(response)).toMatchObject({ code });
    }
    // Nothing but the one valid entry was stored.
    expect(
      srv.db.prepare('SELECT COUNT(*) AS n FROM e2ee_contact_entries').get()
    ).toEqual({ n: 1 });
    // Bob reads only his own (empty) list, never Alice's.
    const bobList = await json<E2eeContactsResponse>(
      await srv.call('GET', '/api/e2ee/contacts', { user: BOB })
    );
    expect(bobList).toMatchObject({
      generation: bob.account.generation,
      entries: []
    });
    // Stored rows never change.
    expect(() =>
      srv.db.prepare("UPDATE e2ee_contact_entries SET created_at = 'x'").run()
    ).toThrow(/E2EE_CONTACT_ENTRY_IMMUTABLE/);
  });

  it('serve device lists only to people who share a project or an invitation (M2)', async () => {
    const srv = serverWith();
    await person(srv, ALICE);
    await person(srv, BOB);
    await person(srv, STRANGER);
    const lookUp = (user: string, target: string) =>
      srv.call(
        'GET',
        `/api/e2ee/users/${encodeURIComponent(target)}/device-list`,
        {
          user
        }
      );
    // Before sharing anything, an existing account, a missing one and a
    // malformed id are indistinguishable.
    const refusals = [];
    for (const target of [BOB, 'user_nobody', '%E0%A4%A', 'x'.repeat(200)]) {
      const response = await lookUp(ALICE, target);
      expect(response.status, target).toBe(404);
      refusals.push(await response.json());
    }
    expect(new Set(refusals.map((r) => JSON.stringify(r))).size).toBe(1);
    expect(refusals[0]).toMatchObject({ code: 'E2EE_CONTACT_NOT_FOUND' });

    share(srv);
    for (const [user, target] of [
      [ALICE, BOB],
      [BOB, ALICE],
      // Co-members of one project.
      [BOB, CAROL],
      [CAROL, BOB]
    ] as const) {
      const response = await lookUp(user, target);
      expect(response.status, `${user} -> ${target}`).toBe(200);
    }
    // Carol is related but has no keys yet.
    expect(await json(await lookUp(BOB, CAROL))).toEqual({
      userId: CAROL,
      identity: null
    });
    const found = await json<{ identity: { entries: unknown[] } }>(
      await lookUp(ALICE, BOB)
    );
    expect(found.identity.entries).toHaveLength(1);
    // The stranger is still nobody to either side.
    expect((await lookUp(STRANGER, ALICE)).status).toBe(404);
    expect((await lookUp(ALICE, STRANGER)).status).toBe(404);

    // A pending invitation relates inviter and invitee; a revoked one not.
    const invite = (id: string, revokedAt: number | null) =>
      srv.db
        .prepare(
          `INSERT INTO project_invitations
             (id, project_id, email, role, token_hash, invited_by_user_id,
              created_at, expires_at, revoked_at)
           VALUES (?, 'proj_shared', ?, 'viewer', ?, ?, 1, ?, ?)`
        )
        .run(
          id,
          EMAILS[STRANGER]!,
          `hash_${id}`,
          ALICE,
          Math.floor(Date.now() / 1000) + 3600,
          revokedAt
        );
    invite('inv_revoked', 2);
    expect((await lookUp(ALICE, STRANGER)).status).toBe(404);
    invite('inv_live', null);
    expect((await lookUp(ALICE, STRANGER)).status).toBe(200);
    expect((await lookUp(STRANGER, ALICE)).status).toBe(200);
    expect((await lookUp(STRANGER, BOB)).status).toBe(404);

    // Who each side may look up, with emails only where sharing shows them.
    const people = async (user: string) =>
      (
        await json<E2eeContactsResponse>(
          await srv.call('GET', '/api/e2ee/contacts', { user })
        )
      ).people;
    expect(await people(ALICE)).toEqual([
      { userId: BOB, email: EMAILS[BOB] },
      { userId: CAROL, email: EMAILS[CAROL] },
      { userId: STRANGER, email: EMAILS[STRANGER] }
    ]);
    expect(await people(BOB)).toEqual([
      { userId: ALICE, email: EMAILS[ALICE] },
      { userId: CAROL, email: null }
    ]);
    expect(await people(STRANGER)).toEqual([
      { userId: ALICE, email: EMAILS[ALICE] }
    ]);

    // The browser module surfaces the refusal as the API error it is.
    const stranger = createContactsApi(fetcher(srv, STRANGER));
    await expect(stranger.deviceList(CAROL)).rejects.toSatisfy(
      (error: unknown) => error instanceof E2eeApiError && error.status === 404
    );
  });
});

describe('verifying contacts in the browser', () => {
  async function pair() {
    const srv = serverWith();
    const alice = await person(srv, ALICE);
    const bob = await person(srv, BOB);
    share(srv);
    return { srv, alice, bob };
  }

  it('verifies each other by comparing the same digit groups', async () => {
    const { alice, bob } = await pair();
    let aliceBook = await loadContacts(alice.contacts, alice.account);
    expect(aliceBook.contacts).toEqual([
      { userId: BOB, email: EMAILS[BOB], standing: 'not-checked' },
      { userId: CAROL, email: EMAILS[CAROL], standing: 'not-checked' }
    ]);
    const bobSeen = await inspectContact(alice.contacts, aliceBook, BOB);
    expect(bobSeen).toMatchObject({ status: 'seen', keyChanged: false });
    // Not verified: nothing may be wrapped to Bob yet.
    expect(verifiedEncryptionKey(bobSeen)).toBeNull();
    // What Alice's browser shows for Bob is what Bob reads out, and the
    // other way round: the mutual comparison.
    expect(bobSeen.code).toBe((await ownVerificationCode(bob.account)).code);
    expect(bobSeen.code).toMatch(/^(\d{5} ){7}\d{5}$/);
    let bobBook = await loadContacts(bob.contacts, bob.account);
    const aliceSeen = await inspectContact(bob.contacts, bobBook, ALICE);
    expect(aliceSeen.code).toBe(
      (await ownVerificationCode(alice.account)).code
    );
    // The QR form carries the same hash.
    const scanned = parseContactScan(
      contactScanText((await ownVerificationCode(bob.account)).hash)
    );
    expect(scanned).toEqual(bobSeen.codeHash);

    aliceBook = await verifyContact(
      alice.contacts,
      alice.account,
      aliceBook,
      bobSeen,
      alice.recovery.secret
    );
    bobBook = await verifyContact(
      bob.contacts,
      bob.account,
      bobBook,
      aliceSeen,
      bob.recovery.secret
    );
    expect(aliceBook.contacts.find((c) => c.userId === BOB)?.standing).toBe(
      'verified'
    );
    expect(bobBook.contacts.find((c) => c.userId === ALICE)?.standing).toBe(
      'verified'
    );
    const bobVerified = await inspectContact(alice.contacts, aliceBook, BOB);
    expect(bobVerified.status).toBe('verified');
    expect(verifiedEncryptionKey(bobVerified)).toEqual(
      bobVerified.list!.head.encryptionKey
    );

    // Another browser of Alice's starts from the signed list alone.
    const elsewhere: ContactsContext = {
      ...alice.contacts,
      pins: memoryContactPins()
    };
    const fresh = await loadContacts(elsewhere, alice.account);
    expect(fresh.contacts.find((c) => c.userId === BOB)?.standing).toBe(
      'verified'
    );
    expect((await inspectContact(elsewhere, fresh, BOB)).status).toBe(
      'verified'
    );

    // A wrong recovery key signs nothing.
    await expect(
      untrustContact(
        alice.contacts,
        alice.account,
        aliceBook,
        BOB,
        (await generateRecoveryKey()).secret
      )
    ).rejects.toMatchObject({ code: 'wrong-recovery-key' });
    aliceBook = await untrustContact(
      alice.contacts,
      alice.account,
      aliceBook,
      BOB,
      alice.recovery.secret
    );
    expect(aliceBook.contacts.find((c) => c.userId === BOB)?.standing).toBe(
      'untrusted'
    );
    const untrusted = await inspectContact(alice.contacts, aliceBook, BOB);
    expect(untrusted.status).toBe('seen');
    expect(verifiedEncryptionKey(untrusted)).toBeNull();
  });

  it('refuses a rolled-back or forked contacts list', async () => {
    const { srv, alice } = await pair();
    let book = await loadContacts(alice.contacts, alice.account);
    book = await verifyContact(
      alice.contacts,
      alice.account,
      book,
      await inspectContact(alice.contacts, book, BOB),
      alice.recovery.secret
    );
    book = await untrustContact(
      alice.contacts,
      alice.account,
      book,
      BOB,
      alice.recovery.secret
    );
    expect(book.list?.pin.sequence).toBe(1);
    // Rollback: the server hides the untrust, reviving the verification.
    srv.db.prepare('DELETE FROM e2ee_contact_entries WHERE sequence = 1').run();
    await expect(loadContacts(alice.contacts, alice.account)).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof ContactsError && error.code === 'fork'
    );
    // Fork: another browser of Alice's that never saw the untrust signs a
    // different, valid entry at the same height.
    const other: ContactsContext = {
      ...alice.contacts,
      pins: memoryContactPins()
    };
    const behind = await loadContacts(other, alice.account);
    expect(behind.list?.pin.sequence).toBe(0);
    const forked = await recordKeyChange(
      other,
      alice.account,
      behind,
      BOB,
      alice.recovery.secret
    );
    expect(forked.list?.pin.sequence).toBe(1);
    expect(forked.list?.pin.entryHash).not.toEqual(book.list?.pin.entryHash);
    await expect(
      loadContacts(alice.contacts, alice.account)
    ).rejects.toMatchObject({ code: 'fork' });
    // Hiding every entry is a rollback too.
    srv.db.prepare('DELETE FROM e2ee_contact_entries').run();
    await expect(
      loadContacts(alice.contacts, alice.account)
    ).rejects.toMatchObject({ code: 'fork' });
  });

  it('drops a contact whose key changed back to seen, and blocks wraps until verified again', async () => {
    const { alice, bob } = await pair();
    let book = await loadContacts(alice.contacts, alice.account);
    book = await verifyContact(
      alice.contacts,
      alice.account,
      book,
      await inspectContact(alice.contacts, book, BOB),
      alice.recovery.secret
    );
    // Bob replaces his recovery key, which replaces his identity.
    const replacement = await generateRecoveryKey();
    bob.account = ready(
      await replaceRecoveryKey(
        bob.keys,
        bob.account,
        replacement.secret,
        bob.recovery.secret
      )
    );
    const changed = await inspectContact(alice.contacts, book, BOB);
    expect(changed).toMatchObject({
      status: 'seen',
      keyChanged: true,
      keyChangeUnsigned: true
    });
    expect(verifiedEncryptionKey(changed)).toBeNull();
    expect(changed.code).toBe((await ownVerificationCode(bob.account)).code);
    // The downgrade is kept locally before anything is signed.
    book = await loadContacts(alice.contacts, alice.account);
    expect(book.contacts.find((c) => c.userId === BOB)?.standing).toBe(
      'key-changed'
    );
    book = await recordKeyChange(
      alice.contacts,
      alice.account,
      book,
      BOB,
      alice.recovery.secret
    );
    expect(book.list?.contacts.get(BOB)?.status).toBe('key-changed');
    const afterRecord = await inspectContact(alice.contacts, book, BOB);
    expect(afterRecord).toMatchObject({
      status: 'seen',
      keyChanged: true,
      keyChangeUnsigned: false
    });
    // Verifying the new key after comparing codes again.
    book = await verifyContact(
      alice.contacts,
      alice.account,
      book,
      afterRecord,
      alice.recovery.secret
    );
    const reverified = await inspectContact(alice.contacts, book, BOB);
    expect(reverified).toMatchObject({ status: 'verified', keyChanged: false });
    expect(book.list?.contacts.get(BOB)?.identityKeyHash).toEqual(
      await publicKeyHash(bob.account.list.identityKey)
    );
    expect(book.list?.entries.map((e) => e.entry.action)).toEqual([
      'verify',
      'key-changed',
      'verify'
    ]);
  });

  it('refuses the old verified identity once a replacement was seen (#898 review)', async () => {
    const { srv, alice, bob } = await pair();
    let book = await loadContacts(alice.contacts, alice.account);
    book = await verifyContact(
      alice.contacts,
      alice.account,
      book,
      await inspectContact(alice.contacts, book, BOB),
      alice.recovery.secret
    );
    // A device-list answer for Bob's first identity, held back for later.
    const path = `/api/e2ee/users/${BOB}/device-list`;
    const oldAnswer = await (await srv.call('GET', path, { user: ALICE })).text();
    const replacement = await generateRecoveryKey();
    bob.account = ready(
      await replaceRecoveryKey(
        bob.keys,
        bob.account,
        replacement.secret,
        bob.recovery.secret
      )
    );
    // Alice sees the replacement: the downgrade is pinned.
    expect(await inspectContact(alice.contacts, book, BOB)).toMatchObject({
      keyChanged: true
    });
    // A delayed answer (another tab, say) brings the old identity back.
    const replaying: ContactsContext = {
      ...alice.contacts,
      api: createContactsApi(async (p, init) =>
        p === path
          ? new Response(oldAnswer, {
              status: 200,
              headers: { 'content-type': 'application/json' }
            })
          : fetcher(srv, ALICE)(p, init)
      )
    };
    await expect(inspectContact(replaying, book, BOB)).rejects.toMatchObject({
      code: 'fork'
    });
    expect(
      (await alice.pins.readContact(ALICE, BOB))?.identityKeyHash
    ).toBe(toHex(await publicKeyHash(bob.account.list.identityKey)));
  });

  it('refuses a result whose pin another tab moved past (#898 review)', async () => {
    const { alice } = await pair();
    let book = await loadContacts(alice.contacts, alice.account);
    book = await verifyContact(
      alice.contacts,
      alice.account,
      book,
      await inspectContact(alice.contacts, book, BOB),
      alice.recovery.secret
    );
    const lostRace: ContactsContext = {
      ...alice.contacts,
      pins: {
        ...alice.pins,
        advanceList: async () => false,
        advanceContact: async () => false
      }
    };
    await expect(
      loadContacts(lostRace, alice.account)
    ).rejects.toMatchObject({ code: 'fork' });
    await expect(inspectContact(lostRace, book, BOB)).rejects.toMatchObject({
      code: 'fork'
    });
  });

  it('signs a key change and the new verification in one step', async () => {
    const { alice, bob } = await pair();
    let book = await loadContacts(alice.contacts, alice.account);
    book = await verifyContact(
      alice.contacts,
      alice.account,
      book,
      await inspectContact(alice.contacts, book, BOB),
      alice.recovery.secret
    );
    bob.account = ready(
      await replaceRecoveryKey(
        bob.keys,
        bob.account,
        (await generateRecoveryKey()).secret,
        bob.recovery.secret
      )
    );
    book = await verifyContact(
      alice.contacts,
      alice.account,
      book,
      await inspectContact(alice.contacts, book, BOB),
      alice.recovery.secret
    );
    expect(book.list?.entries.map((e) => e.entry.action)).toEqual([
      'verify',
      'key-changed',
      'verify'
    ]);
  });

  it("refuses a verified contact's device list rolled back behind the pin", async () => {
    const { srv, alice, bob } = await pair();
    let book = await loadContacts(alice.contacts, alice.account);
    book = await verifyContact(
      alice.contacts,
      alice.account,
      book,
      await inspectContact(alice.contacts, book, BOB),
      alice.recovery.secret
    );
    // Bob certifies a second device: his head moves forward.
    const phone = keysFor(srv, BOB);
    ready(
      await enrollWithRecoveryKey(
        phone,
        ready(await loadEncryption(phone)),
        bob.recovery.secret,
        'Bob phone'
      )
    );
    const moved = await inspectContact(alice.contacts, book, BOB);
    expect(moved).toMatchObject({ status: 'verified' });
    expect(moved.list!.pin.sequence).toBe(1);
    // The new head changes Bob's code: it covers his current devices.
    const before = (await ownVerificationCode(bob.account)).code;
    expect(moved.code).not.toBe(before);
    expect(moved.code).toBe(
      (await ownVerificationCode(await refresh(bob))).code
    );
    // The server goes back to the list before the new device.
    srv.db
      .prepare(
        'DELETE FROM e2ee_device_list_entries WHERE user_id = ? AND sequence = 1'
      )
      .run(BOB);
    await expect(
      inspectContact(alice.contacts, book, BOB)
    ).rejects.toMatchObject({ code: 'fork' });
  });

  it('refuses to look up someone it shares nothing with', async () => {
    const { srv, alice } = await pair();
    await person(srv, STRANGER);
    const book = await loadContacts(alice.contacts, alice.account);
    await expect(
      inspectContact(alice.contacts, book, STRANGER)
    ).rejects.toSatisfy(
      (error: unknown) => error instanceof E2eeApiError && error.status === 404
    );
    expect(book.contacts.map((c) => c.userId)).not.toContain(STRANGER);
  });
});

// --- Migration 0037 ----------------------------------------------------------

/** Statements that name the contacts table, other than the probe. */
function namedContacts(statements: string[]): string[] {
  return statements.filter(
    (sql) =>
      sql.includes('e2ee_contact_entries') && !/FROM sqlite_master/.test(sql)
  );
}

/**
 * Merging deploys to the live beta, which applies migrations. If 0037 fails
 * or is delayed (here: every migration this branch has, through the latest
 * present before it), the key routes, device lists and erasure must not
 * notice; only the contacts list answers 503.
 */
describe('without migration 0037', () => {
  it('keeps key routes, device lists and erasure working; contacts answer 503', async () => {
    const srv = serverWith(databaseBefore(37));
    const alice = await person(srv, ALICE);
    await person(srv, BOB);
    share(srv);
    for (const [method, body] of [
      ['GET', undefined],
      ['POST', { generation: 1, entry: 'AAAA', signature: 'AAAA' }]
    ] as const) {
      const response = await srv.call(method, '/api/e2ee/contacts', {
        user: ALICE,
        ...(body ? { body } : {})
      });
      expect(response.status, method).toBe(503);
      expect(await response.json()).toMatchObject({ code: 'E2EE_UNAVAILABLE' });
    }
    expect(
      (
        await srv.call('GET', `/api/e2ee/users/${BOB}/device-list`, {
          user: ALICE
        })
      ).status
    ).toBe(200);
    expect(
      (await srv.call('GET', '/api/e2ee/account', { user: ALICE })).status
    ).toBe(200);
    await expect(loadContacts(alice.contacts, alice.account)).rejects.toSatisfy(
      (error: unknown) => error instanceof E2eeApiError && error.status === 503
    );
    for (const [user, scope, confirmation] of [
      [ALICE, 'profile', 'DELETE CLOUD PROFILE'],
      [BOB, 'all', 'DELETE ALL CLOUD DATA']
    ] as const) {
      expect(
        (
          await srv.call('POST', '/api/account/delete-data', {
            user,
            body: { scope, confirmation }
          })
        ).status
      ).toBe(200);
    }
    expect(namedContacts(srv.statements)).toEqual([]);
  });

  it('notices the migration once it lands, without a redeploy', async () => {
    const db = databaseBefore(37);
    const srv = serverWith(db);
    await person(srv, ALICE);
    expect(
      (await srv.call('GET', '/api/e2ee/contacts', { user: ALICE })).status
    ).toBe(503);
    db.exec(
      readFileSync(
        new URL(
          '../apps/web/migrations/0037_e2ee_contacts.sql',
          import.meta.url
        ),
        'utf8'
      )
    );
    vi.useFakeTimers({ now: Date.now() + 61_000, toFake: ['Date'] });
    expect(
      (await srv.call('GET', '/api/e2ee/contacts', { user: ALICE })).status
    ).toBe(200);
  });
});

describe('erasure', () => {
  it('deletes the contacts list with the profile and leaves other lists alone', async () => {
    const srv = serverWith();
    const alice = await person(srv, ALICE);
    const bob = await person(srv, BOB);
    share(srv);
    for (const [me, other] of [
      [alice, BOB],
      [bob, ALICE]
    ] as const) {
      const book = await loadContacts(me.contacts, me.account);
      await verifyContact(
        me.contacts,
        me.account,
        book,
        await inspectContact(me.contacts, book, other),
        me.recovery.secret
      );
    }
    expect(
      (
        await srv.call('POST', '/api/account/delete-data', {
          user: ALICE,
          body: { scope: 'profile', confirmation: 'DELETE CLOUD PROFILE' }
        })
      ).status
    ).toBe(200);
    expect(
      srv.db
        .prepare('SELECT user_id FROM e2ee_contact_entries ORDER BY user_id')
        .all()
    ).toEqual([{ user_id: BOB }]);
    // Erased keys are gone for everyone else too.
    expect(
      await json(
        await srv.call('GET', `/api/e2ee/users/${ALICE}/device-list`, {
          user: BOB
        })
      )
    ).toEqual({ userId: ALICE, identity: null });
  });

  it('starts a new list when the identity is replaced', async () => {
    const srv = serverWith();
    const alice = await person(srv, ALICE);
    await person(srv, BOB);
    share(srv);
    let book = await loadContacts(alice.contacts, alice.account);
    await verifyContact(
      alice.contacts,
      alice.account,
      book,
      await inspectContact(alice.contacts, book, BOB),
      alice.recovery.secret
    );
    alice.account = ready(
      await replaceRecoveryKey(
        alice.keys,
        alice.account,
        (await generateRecoveryKey()).secret,
        alice.recovery.secret
      )
    );
    book = await loadContacts(alice.contacts, alice.account);
    expect(book.generation).toBe(2);
    expect(book.list).toBeNull();
    expect(book.contacts.find((c) => c.userId === BOB)?.standing).toBe('seen');
  });
});
