/**
 * Co-members' device lists in production wiring (ADR-024 Phase 5): slice
 * 5-1's contacts module supplies slice 5-2's `ProjectGroupContext.members`
 * (`memberLists.ts`), so a shared project's directory gets each co-member's
 * list through `GET /api/e2ee/users/:id/device-list`, checked against this
 * browser's pins. Node devices of two accounts run the real client modules
 * with the in-process MLS engine against the real Worker over SQLite.
 */
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { toHex } from '@openzcad/crypto';
import type { E2eeContext } from '../apps/web/src/lib/e2ee/accountKeys';
import { memoryContactPins } from '../apps/web/src/lib/e2ee/contactPins';
import {
  ContactsError,
  createContactsApi,
  type ContactView
} from '../apps/web/src/lib/e2ee/contacts';
import { EncryptedProjectIntegrityError } from '../apps/web/src/lib/e2ee/encryptedProjectStore';
import { contactMemberLists } from '../apps/web/src/lib/e2ee/memberLists';
import {
  catchUpProjectGroup,
  commitProjectGroup,
  joinProjectGroup,
  postOwnEpochKeys
} from '../apps/web/src/lib/e2ee/projectGroups';
import { forgetAllProjectKeys } from '../apps/web/src/lib/e2ee/unlockedProjectKeys';
import { rememberExpectedProjectOwner } from '../apps/web/src/lib/e2ee/projectAuthority';
import {
  OTHER,
  OWNER,
  createEncrypted,
  device,
  edited,
  makeAccount,
  newServer,
  type Account,
  type Device,
  type Server
} from './support/e2ee-documents';

let owner: Account;
let other: Account;

beforeAll(async () => {
  owner = await makeAccount(OWNER, ['owner_laptop', 'owner_desktop']);
  other = await makeAccount(OTHER, ['other_laptop']);
});

afterEach(() => {
  forgetAllProjectKeys();
});

/** The owner's encrypted project, with OTHER an editor who saved an edit. */
async function sharedWithEdit() {
  const srv = newServer([owner, other]);
  const laptop = device(srv, owner, 'owner_laptop', { members: [other] });
  const { document } = await createEncrypted(laptop);
  const projectId = document.projectId;
  srv.db
    .prepare(
      `INSERT INTO project_members
         (project_id, user_id, role, added_by_user_id, created_at, updated_at)
       VALUES (?, ?, 'editor', ?, 1, 1)`
    )
    .run(projectId, OTHER, OWNER);
  await commitProjectGroup(laptop.groups, projectId, {
    setRoles: [{ userId: OTHER, role: 'editor' }]
  });
  // The Welcome's stand-in (slice 5-3): epoch 1's keys, handed over.
  const member = device(srv, other, 'other_laptop', { members: [owner] });
  await rememberExpectedProjectOwner(member.groups, projectId, owner.list);
  await postOwnEpochKeys(
    member.groups,
    projectId,
    1,
    await laptop.sessions.epochMaterial({
      userId: OWNER,
      deviceId: 'owner_laptop',
      projectId
    })
  );
  forgetAllProjectKeys();
  await joinProjectGroup(member.groups, projectId);
  const opened = await member.store.loadProject(projectId);
  await member.store.saveProjectDocument({
    projectId,
    expectedVersion: opened.version,
    document: edited(opened, 'Member edit')
  });
  // Processing the member's External Commit, the owner posts its own wraps
  // of that epoch, which its other browsers read through.
  await catchUpProjectGroup(laptop.groups, projectId);
  forgetAllProjectKeys();
  return { srv, projectId };
}

/**
 * A fresh owner browser whose co-member lists come from the contacts
 * module, as `encryptedProjects.ts` wires them, and the requests it made.
 */
function contactsBrowser(srv: Server, pins = memoryContactPins()) {
  const d: Device = device(srv, owner, 'owner_desktop');
  const requests: string[] = [];
  const inspected: ContactView[][] = [];
  d.before = async (path) => {
    requests.push(path);
  };
  Object.assign(d.groups, {
    members: contactMemberLists({
      contacts: {
        keys: { userId: OWNER } as E2eeContext,
        api: createContactsApi((path, init) => d.fetcher(path, init)),
        pins
      },
      account: { userId: OWNER, generation: 1, list: owner.list },
      leaves: (projectId) => d.groups.api.leaves(projectId),
      onInspected: (_projectId, views) => inspected.push([...views])
    })
  });
  return { d, pins, requests, inspected };
}

describe('co-members’ device lists from contacts (5-1 into 5-2)', () => {
  it('reads a member’s version with their seen list and pins its head', async () => {
    const { srv, projectId } = await sharedWithEdit();
    const { d, pins, requests, inspected } = contactsBrowser(srv);

    const read = await d.store.loadProject(projectId);
    expect(read.name).toBe('Member edit');
    expect(requests).toContain(`/api/e2ee/users/${OTHER}/device-list`);
    // Unverified: the user never compared OTHER's code, so the list is a
    // seen input. MLS authority still checked OTHER's leaf certification
    // and editing role.
    expect(inspected.at(-1)?.map((view) => [view.userId, view.status])).toEqual(
      [[OTHER, 'seen']]
    );
    expect(await pins.readContact(OWNER, OTHER)).toMatchObject({
      identityKeyHash: toHex(other.list.identityKeyHash),
      sequence: other.list.pin.sequence,
      entryHash: toHex(other.list.headHash),
      keyChanged: false
    });
  });

  it('refuses a co-member list behind the head this browser pinned', async () => {
    const { srv, projectId } = await sharedWithEdit();
    const pins = memoryContactPins();
    // This browser once accepted a newer head for OTHER's identity than the
    // server now shows: a rollback or fork.
    await pins.advanceContact(
      OWNER,
      {
        contactUserId: OTHER,
        identityKeyHash: toHex(other.list.identityKeyHash),
        sequence: other.list.pin.sequence + 3,
        entryHash: 'ab'.repeat(32),
        keyChanged: false,
        seenAt: 1
      },
      { replaceIdentity: true }
    );
    const { d } = contactsBrowser(srv, pins);
    await expect(d.store.loadProject(projectId)).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof ContactsError && error.code === 'fork'
    );
  });

  it('still verifies a removed member’s versions, whose leaf stays in the project', async () => {
    const { srv, projectId } = await sharedWithEdit();
    srv.db
      .prepare(
        'DELETE FROM project_members WHERE project_id = ? AND user_id = ?'
      )
      .run(projectId, OTHER);
    const { d } = contactsBrowser(srv);
    expect((await d.store.loadProject(projectId)).name).toBe('Member edit');
  });

  it('gives no list for someone the server will not look up, refusing their versions', async () => {
    const { srv, projectId } = await sharedWithEdit();
    const { d, inspected } = contactsBrowser(srv);
    // The server will not relate the two accounts (M2): the device-list
    // lookup answers 404, and OTHER's version is refused visibly.
    const real = d.fetcher;
    d.fetcher = async (path, init) =>
      path.endsWith(`/users/${OTHER}/device-list`)
        ? new Response(
            JSON.stringify({
              error: 'Not found.',
              code: 'E2EE_CONTACT_NOT_FOUND'
            }),
            { status: 404, headers: { 'content-type': 'application/json' } }
          )
        : real(path, init);
    await expect(d.store.loadProject(projectId)).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof EncryptedProjectIntegrityError &&
        /not signed by a member/.test(error.message)
    );
    expect(inspected.at(-1)).toEqual([]);
  });

  it('asks nothing of the contacts routes for a solo project', async () => {
    const srv = newServer([owner, other]);
    const laptop = device(srv, owner, 'owner_laptop');
    const { document } = await createEncrypted(laptop);
    forgetAllProjectKeys();
    const { d, requests } = contactsBrowser(srv);
    expect((await d.store.loadProject(document.projectId)).name).toBe(
      'Bracket'
    );
    expect(
      requests.filter(
        (path) =>
          path.startsWith('/api/e2ee/contacts') ||
          path.startsWith('/api/e2ee/users/')
      )
    ).toEqual([]);
  });
});
