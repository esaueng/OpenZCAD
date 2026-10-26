/**
 * Contacts and verified pins (ADR-024 Phase 5, slice 5-1): the contacts and
 * device-list routes over the real Worker and SQLite, and the browser's
 * contacts module (`contacts.ts`) driven by Node devices of two accounts.
 */
import { readFileSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  decodeDeviceApprovalGrant,
  fromBase64Url,
  generateRecoveryKey,
  generateSigningKeyPair,
  signDeviceApprovalGrant,
  nextContactsEntry,
  publicKeyHash,
  toHex,
  signContactsEntry,
  toBase64Url,
  type Bytes
} from '@openzcad/crypto';
import type { E2eeContactsResponse } from '@openzcad/shared';
import {
  EncryptionFlowError,
  advanceApprovalAsNewDevice,
  approveDevice,
  enrollWithRecoveryKey,
  loadEncryption,
  requestApproval,
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
  // One pin store per browser, as `contactPins()` is in the app: setup and
  // device approval record where its contacts trust starts.
  const pins = memoryContactPins();
  const keys = { ...keysFor(srv, user), contactPins: pins };
  const account = ready(
    await setUpEncryption(keys, {
      recoverySecret: recovery.secret,
      label: `${user} laptop`
    })
  );
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

  it('ends an invitation’s relation with the membership it led to (#898, #902 review)', async () => {
    const srv = serverWith();
    await person(srv, ALICE);
    await person(srv, STRANGER);
    share(srv);
    const lookUp = async (user: string, target: string) =>
      (
        await srv.call(
          'GET',
          `/api/e2ee/users/${encodeURIComponent(target)}/device-list`,
          { user }
        )
      ).status;
    const people = async (user: string) =>
      (
        await json<E2eeContactsResponse>(
          await srv.call('GET', '/api/e2ee/contacts', { user })
        )
      ).people.map((p) => p.userId);
    const nowSeconds = Math.floor(Date.now() / 1000);
    const removeMember = (user: string) =>
      srv.db.prepare('DELETE FROM project_members WHERE user_id = ?').run(user);

    // A plaintext invitation the stranger accepted, then removal from the
    // project: nothing relates them any more.
    srv.db
      .prepare(
        `INSERT INTO project_invitations
           (id, project_id, email, role, token_hash, invited_by_user_id,
            created_at, expires_at, accepted_by_user_id, accepted_at)
         VALUES ('inv_done', 'proj_shared', ?, 'viewer', 'hash_done', ?, 1, ?, ?, 2)`
      )
      .run(EMAILS[STRANGER]!, ALICE, nowSeconds + 3600, STRANGER);
    srv.db
      .prepare(
        `INSERT INTO project_members
           (project_id, user_id, role, added_by_user_id, created_at, updated_at)
         VALUES ('proj_shared', ?, 'viewer', ?, 1, 1)`
      )
      .run(STRANGER, ALICE);
    expect(await lookUp(ALICE, STRANGER)).toBe(200);
    removeMember(STRANGER);
    expect(await lookUp(ALICE, STRANGER)).toBe(404);
    expect(await lookUp(STRANGER, ALICE)).toBe(404);
    expect(await people(ALICE)).not.toContain(STRANGER);
    expect(await people(STRANGER)).toEqual([]);

    // An accepted encrypted invitation relates both sides while it is open,
    // and not once it expires or its Add completes it.
    const encrypted = (completedAt: string | null, expiresAt: number) => {
      srv.db.prepare('DELETE FROM e2ee_invitations').run();
      srv.db
        .prepare(
          `INSERT INTO e2ee_invitations
             (invitation_id, project_id, invited_by_user_id, email_hash, role,
              token_hash, statement, signature, signer_device_id, created_at,
              expires_at, accepted_by_user_id, accepted_at, completed_at,
              completed_epoch)
           VALUES ('einv', 'proj_shared', ?, ?, 'viewer', ?, 'statement', ?,
                   'device', '2026-10-24', ?, ?, '2026-10-24', ?, ?)`
        )
        .run(
          ALICE,
          'e'.repeat(64),
          't'.repeat(64),
          's'.repeat(87),
          expiresAt,
          STRANGER,
          completedAt,
          completedAt === null ? null : 1
        );
    };
    encrypted(null, Date.now() + 3_600_000);
    expect(await lookUp(ALICE, STRANGER)).toBe(200);
    expect(await lookUp(STRANGER, ALICE)).toBe(200);
    expect(await people(ALICE)).toContain(STRANGER);
    encrypted(null, Date.now() - 1);
    expect(await lookUp(ALICE, STRANGER)).toBe(404);
    expect(await lookUp(STRANGER, ALICE)).toBe(404);
    expect(await people(STRANGER)).toEqual([]);
    encrypted('2026-10-25', Date.now() + 3_600_000);
    expect(await lookUp(ALICE, STRANGER)).toBe(404);
    expect(await lookUp(STRANGER, ALICE)).toBe(404);

    // A removed member who held a leaf in the project: its owner and
    // members can still check that member's signatures on the history, but
    // the removed member can no longer read theirs.
    srv.db
      .prepare(
        `INSERT INTO e2ee_project_leaves
           (project_id, user_id, device_id, leaf_key, certification, created_at)
         VALUES ('proj_shared', ?, 'device', ?, ?, '2026-10-24')`
      )
      .run(STRANGER, 'k'.repeat(87), 'c'.repeat(98));
    expect(await lookUp(ALICE, STRANGER)).toBe(200);
    expect(await lookUp(BOB, STRANGER)).toBe(200);
    expect(await lookUp(STRANGER, ALICE)).toBe(404);
    expect(await lookUp(STRANGER, BOB)).toBe(404);
    // Once Bob leaves too, the project's history is no longer his to check.
    removeMember(BOB);
    expect(await lookUp(BOB, STRANGER)).toBe(404);
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

    // Another browser of Alice's with no pin (enrolled with only a passkey
    // or the recovery key) starts from the signed list the server shows,
    // which could be an older one: Bob is only seen there (ADR-024).
    const elsewhere: ContactsContext = {
      ...alice.contacts,
      pins: memoryContactPins()
    };
    const fresh = await loadContacts(elsewhere, alice.account);
    expect(fresh.listConfirmed).toBe(false);
    expect(fresh.list?.contacts.get(BOB)?.status).toBe('verified');
    expect(fresh.contacts.find((c) => c.userId === BOB)?.standing).toBe('seen');
    const elsewhereBob = await inspectContact(elsewhere, fresh, BOB);
    expect(elsewhereBob.status).toBe('seen');
    expect(verifiedEncryptionKey(elsewhereBob)).toBeNull();

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
    const oldAnswer = await (
      await srv.call('GET', path, { user: ALICE })
    ).text();
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
    expect((await alice.pins.readContact(ALICE, BOB))?.identityKeyHash).toBe(
      toHex(await publicKeyHash(bob.account.list.identityKey))
    );
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
    await expect(loadContacts(lostRace, alice.account)).rejects.toMatchObject({
      code: 'fork'
    });
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
 * ADR-024, verified pins: a device approved by another device receives the
 * newest contacts head inside the authenticated approval exchange, so it
 * cannot be handed an older list; a device enrolled with only a passkey or
 * the recovery key treats every pin as seen until another of the user's
 * devices confirms the head, or the user re-verifies the contact.
 */
describe('contacts heads in device approval', () => {
  /**
   * Alice verified Bob and then stopped trusting him: an older list (entry
   * 0 alone) would revive the verification.
   */
  async function aliceUntrustedBob() {
    const srv = serverWith();
    const alice = await person(srv, ALICE);
    await person(srv, BOB);
    share(srv);
    let book = await loadContacts(alice.contacts, alice.account);
    expect(book.listConfirmed).toBe(true);
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
    return { srv, alice };
  }

  /** Alice verified Bob; he stays verified. */
  async function aliceVerifiedBob() {
    const srv = serverWith();
    const alice = await person(srv, ALICE);
    await person(srv, BOB);
    share(srv);
    const book = await loadContacts(alice.contacts, alice.account);
    await verifyContact(
      alice.contacts,
      alice.account,
      book,
      await inspectContact(alice.contacts, book, BOB),
      alice.recovery.secret
    );
    return { srv, alice };
  }

  /** The server's contacts answers, cut to the first `keep` entries. */
  function olderContacts(srv: Server, user: string, keep: number) {
    const real = fetcher(srv, user);
    return async (path: string, init: RequestInit = {}) => {
      const response = await real(path, init);
      if (path !== '/api/e2ee/contacts' || (init.method ?? 'GET') !== 'GET') {
        return response;
      }
      const body = await json<E2eeContactsResponse>(response);
      return new Response(
        JSON.stringify({ ...body, entries: body.entries.slice(0, keep) }),
        { status: response.status, headers: response.headers }
      );
    };
  }

  /** A second browser of `user`, with its own device keys and pins. */
  function browser(
    srv: Server,
    user: string,
    contactsFetch = fetcher(srv, user)
  ) {
    const pins = memoryContactPins();
    const keys: E2eeContext = { ...keysFor(srv, user), contactPins: pins };
    const contacts: ContactsContext = {
      keys,
      api: createContactsApi(contactsFetch),
      pins
    };
    return { keys, pins, contacts };
  }

  /** `approver` approves a fresh `phone` by the scan form, read-only. */
  async function approve(
    approver: Person,
    phone: E2eeContext,
    approverKeys: E2eeContext = approver.keys
  ): Promise<void> {
    const request = await requestApproval(phone, null, 'Phone');
    if (request.step !== 'waiting') throw new Error('Expected a request');
    await approveDevice(
      approverKeys,
      ready(await loadEncryption(approver.keys)),
      await approver.keys.api.getApproval(request.approval.id),
      { kind: 'scan', code: request.scanCode },
      null
    );
    expect((await advanceApprovalAsNewDevice(phone)).step).toBe('done');
  }

  it('pins the approver’s contacts head, so an older signed list is refused', async () => {
    const { srv, alice } = await aliceUntrustedBob();
    // The server shows the freshly approved phone only entry 0, where Bob
    // is still verified: validly signed, but older than the approver's.
    const phone = browser(srv, ALICE, olderContacts(srv, ALICE, 1));
    await approve(alice, phone.keys);
    expect(await phone.pins.readList(ALICE)).toMatchObject({
      sequence: 1,
      confirmed: true
    });
    const account = ready(await loadEncryption(phone.keys));
    expect(account.deviceStatus).toBe('approved');
    await expect(loadContacts(phone.contacts, account)).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof ContactsError && error.code === 'fork'
    );
    // Nothing moved: the honest list is still accepted, confirmed.
    const honest: ContactsContext = {
      ...phone.contacts,
      api: createContactsApi(fetcher(srv, ALICE))
    };
    const book = await loadContacts(honest, account);
    expect(book.listConfirmed).toBe(true);
    expect(book.contacts.find((c) => c.userId === BOB)?.standing).toBe(
      'untrusted'
    );
  });

  it('shows contacts verified elsewhere as seen on a recovery-key device until another device confirms', async () => {
    const { srv, alice } = await aliceVerifiedBob();
    const phone = browser(srv, ALICE);
    const fresh = await loadEncryption(phone.keys);
    const account = ready(
      await enrollWithRecoveryKey(
        phone.keys,
        ready(fresh),
        alice.recovery.secret,
        'Phone'
      )
    );
    expect(account.deviceStatus).toBe('certified');
    let book = await loadContacts(phone.contacts, account);
    expect(book.listConfirmed).toBe(false);
    expect(book.list?.contacts.get(BOB)?.status).toBe('verified');
    expect(book.contacts.find((c) => c.userId === BOB)?.standing).toBe('seen');
    const seenBob = await inspectContact(phone.contacts, book, BOB);
    expect(seenBob.status).toBe('seen');
    expect(verifiedEncryptionKey(seenBob)).toBeNull();

    // Another device confirms the head: the certified phone asks the
    // laptop through the approval exchange, which needs no recovery key.
    const request = await requestApproval(phone.keys, account, 'Phone');
    if (request.step !== 'waiting') throw new Error('Expected a request');
    await approveDevice(
      alice.keys,
      ready(await loadEncryption(alice.keys)),
      await alice.keys.api.getApproval(request.approval.id),
      { kind: 'scan', code: request.scanCode },
      null
    );
    expect((await advanceApprovalAsNewDevice(phone.keys)).step).toBe('done');
    const after = ready(await loadEncryption(phone.keys));
    expect(after.deviceStatus).toBe('certified');
    book = await loadContacts(phone.contacts, after);
    expect(book.listConfirmed).toBe(true);
    expect(book.contacts.find((c) => c.userId === BOB)?.standing).toBe(
      'verified'
    );
    const verifiedBob = await inspectContact(phone.contacts, book, BOB);
    expect(verifiedEncryptionKey(verifiedBob)).toEqual(
      verifiedBob.list!.head.encryptionKey
    );
  });

  it('reports a same-sequence contacts conflict without completing approval (#936 review)', async () => {
    const { srv, alice } = await aliceVerifiedBob();
    const phone = browser(srv, ALICE);
    const account = ready(
      await enrollWithRecoveryKey(
        phone.keys,
        ready(await loadEncryption(phone.keys)),
        alice.recovery.secret,
        'Phone'
      )
    );
    // The phone has seen a different chain at the same sequence as the
    // laptop's head. Confirming must expose that conflict and keep the pin.
    const head = (await alice.pins.readList(ALICE))!;
    const fork = { ...head, entryHash: 'e'.repeat(64), confirmed: false };
    expect(await phone.pins.advanceList(ALICE, fork)).toBe(true);
    const request = await requestApproval(phone.keys, account, 'Phone');
    if (request.step !== 'waiting') throw new Error('Expected a request');
    await approveDevice(
      alice.keys,
      ready(await loadEncryption(alice.keys)),
      await alice.keys.api.getApproval(request.approval.id),
      { kind: 'scan', code: request.scanCode },
      null
    );
    const cancel = vi.spyOn(phone.keys.api, 'cancelApproval');
    await expect(
      advanceApprovalAsNewDevice(phone.keys).then((result) => result.step)
    ).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof EncryptionFlowError &&
        error.code === 'grant-invalid' &&
        error.message.includes('conflicting contacts lists')
    );
    expect(await phone.pins.readList(ALICE)).toEqual(fork);
    expect((await phone.keys.store.loadDevice(ALICE))?.approval?.id).toBe(
      request.approval.id
    );
    expect(cancel).not.toHaveBeenCalled();
    expect((await phone.keys.api.getApproval(request.approval.id)).state).toBe(
      'completed'
    );
    // Retrying cannot silently turn the conflict into success.
    await expect(
      advanceApprovalAsNewDevice(phone.keys).then((result) => result.step)
    ).rejects.toMatchObject({
      code: 'grant-invalid'
    });
  });

  it('never rolls the pin back to an older approval head (#936 review)', async () => {
    // The laptop's pin stays at entry 0 (Bob verified): it never reloads.
    const { srv, alice } = await aliceVerifiedBob();
    const phone = browser(srv, ALICE);
    const account = ready(
      await enrollWithRecoveryKey(
        phone.keys,
        ready(await loadEncryption(phone.keys)),
        alice.recovery.secret,
        'Phone'
      )
    );
    // The unconfirmed phone signs an untrust at entry 1.
    let book = await loadContacts(phone.contacts, account);
    book = await untrustContact(
      phone.contacts,
      account,
      book,
      BOB,
      alice.recovery.secret
    );
    expect(book.list?.pin.sequence).toBe(1);
    expect(book.listConfirmed).toBe(false);

    // It asks the stale laptop to confirm: the grant names entry 0.
    const request = await requestApproval(phone.keys, account, 'Phone');
    if (request.step !== 'waiting') throw new Error('Expected a request');
    await approveDevice(
      alice.keys,
      ready(await loadEncryption(alice.keys)),
      await alice.keys.api.getApproval(request.approval.id),
      { kind: 'scan', code: request.scanCode },
      null
    );
    expect((await advanceApprovalAsNewDevice(phone.keys)).step).toBe('done');
    const pinned = await phone.pins.readList(ALICE);
    expect(pinned).toMatchObject({ sequence: 1, confirmed: false });
    expect(pinned?.pendingApproval).toMatchObject({
      sequence: 0,
      confirmed: true
    });

    // A server serving only through entry 0 would revive Bob: refused.
    const after = ready(await loadEncryption(phone.keys));
    const older: ContactsContext = {
      ...phone.contacts,
      api: createContactsApi(olderContacts(srv, ALICE, 1))
    };
    await expect(loadContacts(older, after)).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof ContactsError && error.code === 'fork'
    );
    expect(await phone.pins.readList(ALICE)).toMatchObject({ sequence: 1 });
    // The honest list holds the laptop's entry 0 under entry 1: confirmed,
    // and Bob stays untrusted.
    book = await loadContacts(phone.contacts, after);
    expect(book.listConfirmed).toBe(true);
    expect(await phone.pins.readList(ALICE)).toEqual({
      identityKeyHash: pinned!.identityKeyHash,
      sequence: 1,
      entryHash: pinned!.entryHash,
      confirmed: true
    });
    expect(book.contacts.find((c) => c.userId === BOB)?.standing).toBe(
      'untrusted'
    );
  });

  it('keeps a confirmed pin when an unconfirmed approver on a longer fork confirms (#936 review)', async () => {
    type Row = Record<string, string | number>;
    const entriesOf = (srv: Server): Row[] =>
      srv.db
        .prepare(
          'SELECT * FROM e2ee_contact_entries WHERE user_id = ? ORDER BY sequence'
        )
        .all(ALICE) as Row[];
    const serve = (srv: Server, rows: Row[]) => {
      srv.db
        .prepare('DELETE FROM e2ee_contact_entries WHERE user_id = ?')
        .run(ALICE);
      for (const row of rows) {
        const columns = Object.keys(row);
        srv.db
          .prepare(
            `INSERT INTO e2ee_contact_entries (${columns.join(', ')})
             VALUES (${columns.map(() => '?').join(', ')})`
          )
          .run(...columns.map((column) => row[column]!));
      }
    };
    // The laptop, confirmed since setup, verified Bob (0) and untrusted
    // him (1): its pin is confirmed at entry 1.
    const { srv, alice } = await aliceUntrustedBob();
    const honest = entriesOf(srv);
    expect(await alice.pins.readList(ALICE)).toMatchObject({
      sequence: 1,
      confirmed: true
    });

    // A recovery-key phone is shown a fork: entry 0, then its own entries
    // 1' (Bob untrusted) and 2' (Bob verified again).
    serve(srv, honest.slice(0, 1));
    const phone = browser(srv, ALICE);
    const phoneAccount = ready(
      await enrollWithRecoveryKey(
        phone.keys,
        ready(await loadEncryption(phone.keys)),
        alice.recovery.secret,
        'Phone'
      )
    );
    let forkBook = await loadContacts(phone.contacts, phoneAccount);
    forkBook = await untrustContact(
      phone.contacts,
      phoneAccount,
      forkBook,
      BOB,
      alice.recovery.secret
    );
    forkBook = await verifyContact(
      phone.contacts,
      phoneAccount,
      forkBook,
      await inspectContact(phone.contacts, forkBook, BOB),
      alice.recovery.secret
    );
    expect(forkBook.list?.pin.sequence).toBe(2);
    expect(forkBook.listConfirmed).toBe(false);
    const fork = entriesOf(srv);
    expect(fork[1]!.entry_hash).not.toBe(honest[1]!.entry_hash);
    serve(srv, honest);

    // The laptop asks the phone to confirm: the grant names entry 2'.
    const laptopAccount = ready(await loadEncryption(alice.keys));
    const request = await requestApproval(alice.keys, laptopAccount, 'Laptop');
    if (request.step !== 'waiting') throw new Error('Expected a request');
    await approveDevice(
      phone.keys,
      ready(await loadEncryption(phone.keys)),
      await phone.keys.api.getApproval(request.approval.id),
      { kind: 'scan', code: request.scanCode },
      null
    );
    expect((await advanceApprovalAsNewDevice(alice.keys)).step).toBe('done');
    // The laptop's pin did not move to the fork.
    expect(await alice.pins.readList(ALICE)).toMatchObject({
      sequence: 1,
      entryHash: honest[1]!.entry_hash,
      confirmed: true,
      pendingApproval: {
        sequence: 2,
        entryHash: fork[2]!.entry_hash,
        confirmed: false
      }
    });

    // The server now serves the fork, hiding the untrust: refused.
    serve(srv, fork);
    const after = ready(await loadEncryption(alice.keys));
    await expect(loadContacts(alice.contacts, after)).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof ContactsError && error.code === 'fork'
    );
    // The original chain is still accepted, confirmed, Bob untrusted.
    serve(srv, honest);
    const book = await loadContacts(alice.contacts, after);
    expect(book.listConfirmed).toBe(true);
    expect(book.list?.pin.sequence).toBe(1);
    expect(book.contacts.find((c) => c.userId === BOB)?.standing).toBe(
      'untrusted'
    );
    expect(await alice.pins.readList(ALICE)).toMatchObject({
      sequence: 1,
      confirmed: true
    });
  });

  it('refuses a list whose entry differs from an older approval head', async () => {
    const { srv, alice } = await aliceVerifiedBob();
    const phone = browser(srv, ALICE);
    const account = ready(
      await enrollWithRecoveryKey(
        phone.keys,
        ready(await loadEncryption(phone.keys)),
        alice.recovery.secret,
        'Phone'
      )
    );
    const book = await loadContacts(phone.contacts, account);
    await untrustContact(
      phone.contacts,
      account,
      book,
      BOB,
      alice.recovery.secret
    );
    // An approver on a fork vouches for a different entry 0.
    const stored = (await phone.pins.readList(ALICE))!;
    expect(
      await phone.pins.advanceList(
        ALICE,
        {
          identityKeyHash: stored.identityKeyHash,
          sequence: 0,
          entryHash: 'e'.repeat(64),
          confirmed: true
        },
        { fromApproval: true }
      )
    ).toBe(true);
    await expect(loadContacts(phone.contacts, account)).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof ContactsError && error.code === 'fork'
    );
    expect((await phone.pins.readList(ALICE))?.confirmed).toBe(false);
  });

  it('counts a contact verified again on an unconfirmed device', async () => {
    const { srv, alice } = await aliceVerifiedBob();
    const phone = browser(srv, ALICE);
    const account = ready(
      await enrollWithRecoveryKey(
        phone.keys,
        ready(await loadEncryption(phone.keys)),
        alice.recovery.secret,
        'Phone'
      )
    );
    let book = await loadContacts(phone.contacts, account);
    const seenBob = await inspectContact(phone.contacts, book, BOB);
    expect(seenBob.status).toBe('seen');
    // The user compares codes with Bob again here.
    book = await verifyContact(
      phone.contacts,
      account,
      book,
      seenBob,
      alice.recovery.secret
    );
    expect(book.listConfirmed).toBe(false);
    expect(book.contacts.find((c) => c.userId === BOB)?.standing).toBe(
      'verified'
    );
    expect((await inspectContact(phone.contacts, book, BOB)).status).toBe(
      'verified'
    );
  });

  it('still approves with an older build’s version 1 grant, leaving contacts unconfirmed', async () => {
    const { srv, alice } = await aliceVerifiedBob();
    const phone = browser(srv, ALICE);
    // The laptop runs an older build: its grant has no contacts head.
    const complete = alice.keys.api.completeApproval;
    const olderBuild: E2eeContext = {
      ...alice.keys,
      api: {
        ...alice.keys.api,
        completeApproval: async (id, body) => {
          const decoded = decodeDeviceApprovalGrant(
            fromBase64Url(body.grant.statement)
          );
          expect(decoded.contacts).toMatchObject({ confirmed: true });
          const { contacts: _dropped, ...v1 } = decoded;
          const device = (await alice.keys.store.loadDevice(ALICE))!;
          const grant = await signDeviceApprovalGrant(
            device.signing.privateKey,
            v1
          );
          expect(grant.statement[3]).toBe(1);
          return complete(id, {
            ...body,
            grant: {
              statement: toBase64Url(grant.statement),
              signature: toBase64Url(grant.signature)
            }
          });
        }
      }
    };
    await approve(alice, phone.keys, olderBuild);
    expect(await phone.pins.readList(ALICE)).toBeNull();
    const account = ready(await loadEncryption(phone.keys));
    expect([account.deviceStatus, account.unlocked]).toEqual([
      'approved',
      true
    ]);
    const book = await loadContacts(phone.contacts, account);
    expect(book.listConfirmed).toBe(false);
    expect(book.contacts.find((c) => c.userId === BOB)?.standing).toBe('seen');
  });
});

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
