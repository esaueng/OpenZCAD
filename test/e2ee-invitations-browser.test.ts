/**
 * Invitations to end-to-end encrypted projects, the browser flow (ADR-024
 * Phase 5, slice 5-3b; roadmap L11): two accounts' Node devices run the
 * real client modules (`invitations.ts`, `projectGroups.ts`,
 * `encryptedProjectStore.ts`) with the in-process MLS engine against the
 * real Worker routes over SQLite (migrations through 0038). Who is a
 * verified contact (slice 5-1's mutual comparison, covered by its own
 * tests and by Playwright) is the one input given here directly.
 */
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  EnvelopeKey,
  decodeKeyArchiveBody,
  decryptProjectEnvelope,
  encodeKeyArchiveBody,
  encryptProjectEnvelope,
  epochBinding,
  fromBase64Url,
  invitationStatementHash,
  signProjectEnvelope,
  toBase64Url,
  toHex,
  unwrapKey,
  wrapKey
} from '@openzcad/crypto';
import type { AccountView } from '../apps/web/src/lib/e2ee/accountKeys';
import { ownVerificationCode } from '../apps/web/src/lib/e2ee/contacts';
import { handleE2eeRequest } from '../apps/web/worker/e2ee';
import type { E2eeInvitationHost } from '../apps/web/worker/e2eeInvitations';
import {
  admitDevelopmentE2eeWrite,
  releaseDevelopmentE2eeWrite
} from '../apps/web/worker/e2eeWriteAuthorization';
import {
  createE2eeInvitationsApi,
  type E2eeInvitationRecord
} from '@openzcad/shared';
import {
  InvitationError,
  acceptEncryptedInvitation,
  acceptedInvitations,
  addInvitedMember,
  completeReadyInvitations,
  confirmEncryptedInvitation,
  contactCodeOf,
  declineInvitation,
  invitationRemovalChecks,
  inviteToEncryptedProject,
  joinWelcomedProjects,
  projectInvitations,
  publishInvitationKeyPackages,
  recordRemovedMembers,
  sentInvitations,
  signInvitationStatement,
  syncInvitations,
  type InvitationContext,
  type InvitationPerson
} from '../apps/web/src/lib/e2ee/invitations';
import {
  memoryInvitationStore,
  type InvitationStore
} from '../apps/web/src/lib/e2ee/invitationStore';
import {
  catchUpProjectGroup,
  commitProjectGroup,
  joinProjectByWelcome,
  joinProjectGroup,
  postOwnEpochKeys,
  projectKeyForEpoch,
  removeMember,
  ProjectGroupError
} from '../apps/web/src/lib/e2ee/projectGroups';
import { EncryptedProjectIntegrityError } from '../apps/web/src/lib/e2ee/encryptedProjectStore';
import { forgetAllProjectKeys } from '../apps/web/src/lib/e2ee/unlockedProjectKeys';
import { rememberExpectedProjectOwner } from '../apps/web/src/lib/e2ee/projectAuthority';
import {
  OTHER,
  OWNER,
  count,
  createEncrypted,
  device,
  edited,
  makeAccount,
  newServer,
  reload,
  rows,
  type Account,
  type Device,
  type DeviceOptions,
  type Server
} from './support/e2ee-documents';

const THIRD = 'user_third';
const OWNER_EMAIL = 'owner@example.com';
const INVITEE_EMAIL = 'invitee@example.com';
const THIRD_EMAIL = 'third@example.com';

let owner: Account;
let other: Account;
let third: Account;

beforeAll(async () => {
  owner = await makeAccount(OWNER, ['owner_laptop', 'owner_desktop']);
  other = await makeAccount(OTHER, [
    'other_laptop',
    'other_desktop',
    'other_tablet'
  ]);
  third = await makeAccount(THIRD, ['third_laptop']);
});

afterEach(() => {
  forgetAllProjectKeys();
});

const EMAILS: Record<string, string> = {
  [OWNER]: OWNER_EMAIL,
  [OTHER]: INVITEE_EMAIL,
  [THIRD]: THIRD_EMAIL
};

interface World {
  srv: Server;
  mail: { to: string; token: string; text: string }[];
  /** Who each account has verified (slice 5-1's signed contacts list). */
  verified: Map<string, Set<string>>;
}

function world(): World {
  const srv = newServer([owner, other, third], undefined, {
    PROJECT_INVITATION_EMAIL_FROM: 'invites@example.test',
    PUBLIC_APP_ORIGIN: 'https://openzcad.example/'
  });
  for (const [userId, email] of Object.entries(EMAILS)) {
    srv.db
      .prepare('UPDATE users SET email = ? WHERE id = ?')
      .run(email, userId);
  }
  return { srv, mail: [], verified: new Map() };
}

function host(w: World, userId: string): E2eeInvitationHost {
  return {
    email: EMAILS[userId] ?? null,
    inviterLabel: EMAILS[userId] ?? userId,
    sharingEnabled: true,
    emailConfigured: true,
    sendInvitationEmail: async (details) => {
      w.mail.push({
        to: details.recipientEmail,
        token: details.token,
        text: JSON.stringify(details)
      });
    }
  };
}

/**
 * A device whose e2ee calls reach `handleE2eeRequest` as a session with
 * the account's email (development sign-in has none), so the invitation
 * routes can bind an acceptance.
 */
function emailDevice(
  w: World,
  account: Account,
  deviceId: string | null,
  options: DeviceOptions = {}
): Device {
  const d = device(w.srv, account, deviceId, options);
  return withEmailSession(w, d);
}

function withEmailSession(w: World, d: Device): Device {
  d.fetcher = async (path: string, init: RequestInit = {}) => {
    await d.before?.(path, init);
    const session = { userId: d.account.userId };
    const db = w.srv.env.DB as D1Database;
    await admitDevelopmentE2eeWrite(db, session);
    try {
      const response = await handleE2eeRequest(
        new Request(`https://example.com${path}`, init),
        w.srv.env,
        session,
        true,
        true,
        host(w, d.account.userId)
      );
      return d.answer ? d.answer(path, init, response) : response;
    } finally {
      await releaseDevelopmentE2eeWrite(session);
    }
  };
  return d;
}

const ACCOUNTS = () => [owner, other, third];

/** The invitations context of a device, with its account's contacts. */
function invitationsOf(
  w: World,
  d: Device,
  store = memoryInvitationStore()
): InvitationContext {
  return {
    groups: d.groups,
    api: createE2eeInvitationsApi((path, init) => d.fetcher(path, init)),
    store,
    email: EMAILS[d.account.userId] ?? null,
    people: {
      inspect: async (userId) => personOf(w, d.account.userId, userId),
      // The contacts Contacts lists under an address (the server's word):
      // only ever offered to the owner, never bound by itself.
      verifiedContacts: async (email) =>
        Object.entries(EMAILS)
          .filter(([, address]) => address === email.trim().toLowerCase())
          .map(([userId]) => personOf(w, d.account.userId, userId))
          .filter((person): person is InvitationPerson =>
            Boolean(person?.status === 'verified')
          )
    }
  };
}

function personOf(
  w: World,
  by: string,
  userId: string
): InvitationPerson | null {
  const account = ACCOUNTS().find((a) => a.userId === userId);
  if (!account) return null;
  return {
    userId,
    email: EMAILS[userId] ?? null,
    status: w.verified.get(by)?.has(userId) ? 'verified' : 'seen',
    list: account.list
  };
}

/** The owner's explicit confirmation of the invitee's identity. */
const otherIdentity = () => toHex(other.list.identityKeyHash);

/**
 * The owner's explicit pick of a verified contact when inviting, by the
 * identity its contact code showed: the statement then names them.
 */
const pick = (account: Account) => ({
  contact: {
    userId: account.userId,
    identityKeyHash: toHex(account.list.identityKeyHash)
  }
});

function verify(w: World, by: string, whom: string) {
  const set = w.verified.get(by) ?? new Set<string>();
  set.add(whom);
  w.verified.set(by, set);
}

const memberRole = (srv: Server, projectId: string, userId: string) =>
  rows<{ role: string }>(
    srv,
    'SELECT role FROM project_members WHERE project_id = ? AND user_id = ?',
    projectId,
    userId
  )[0]?.role ?? null;

const groupEpoch = (srv: Server, projectId: string) =>
  rows<{ epoch: number }>(
    srv,
    'SELECT epoch FROM e2ee_project_groups WHERE project_id = ?',
    projectId
  )[0]!.epoch;

/**
 * The owner's encrypted project, an empty Commit in (history to verify),
 * made by a laptop that marks its removal history in `store`, as the page
 * does: it created the group, so it saw every removal.
 */
async function ownersProject(w: World) {
  const laptop = emailDevice(w, owner, 'owner_laptop', { members: [other] });
  const store = memoryInvitationStore();
  Object.assign(laptop.groups, {
    removalChecks: invitationRemovalChecks(store, OWNER)
  });
  const { document } = await createEncrypted(laptop);
  const projectId = document.projectId;
  await commitProjectGroup(laptop.groups, projectId);
  return { laptop, projectId, document, store };
}

/**
 * Invited and accepted. By default the owner verified the invitee first
 * and picked them as that contact, so the statement names their identity
 * and the sweep adds them; with `bind: false` it names none, and the owner
 * confirms whoever accepted.
 */
async function invited(
  w: World,
  role: 'editor' | 'viewer' = 'editor',
  { bind = true }: { bind?: boolean } = {}
) {
  const project = await ownersProject(w);
  const ownerCtx = invitationsOf(w, project.laptop, project.store);
  if (bind) verify(w, OWNER, OTHER);
  const invitation = await inviteToEncryptedProject(
    ownerCtx,
    project.projectId,
    INVITEE_EMAIL,
    role,
    bind ? pick(other) : {}
  );
  const laptop = emailDevice(w, other, 'other_laptop', { members: [owner] });
  const inviteeCtx = invitationsOf(w, laptop);
  await acceptEncryptedInvitation(inviteeCtx, w.mail.at(-1)!.token);
  return { ...project, ownerCtx, invitation, invitee: laptop, inviteeCtx };
}

describe('the invitation flow in the browser (slice 5-3b)', () => {
  it('invites, verifies both ways and adds an invitee whose devices join by Welcome or rejoin', async () => {
    const w = world();
    const { laptop, projectId, ownerCtx, invitation, invitee, inviteeCtx } =
      await invited(w, 'editor', { bind: false });
    // The email names the sender, never the project; the address stays in
    // the owner's browser, the server keeps its hash.
    expect(w.mail).toHaveLength(1);
    expect(w.mail[0]!.to).toBe(INVITEE_EMAIL);
    expect(w.mail[0]!.text).not.toContain(projectId);
    expect(
      JSON.stringify(w.srv.db.prepare('SELECT * FROM e2ee_invitations').all())
    ).not.toContain(INVITEE_EMAIL);
    expect(await projectInvitations(ownerCtx, projectId)).toMatchObject([
      { state: 'waiting-for-keys', email: INVITEE_EMAIL }
    ]);

    // The invitee compares codes with the owner before publishing anything.
    expect(await acceptedInvitations(inviteeCtx)).toMatchObject([
      { state: 'verify-owner', ownerEmail: OWNER_EMAIL }
    ]);
    expect(await publishInvitationKeyPackages(inviteeCtx)).toEqual([]);
    verify(w, OTHER, OWNER);
    const [ready] = await acceptedInvitations(inviteeCtx);
    expect(ready).toMatchObject({ state: 'ready' });
    expect(ready!.record.groupEpoch).toBe(1);
    // Each online device publishes its own KeyPackage (M3); the tablet is
    // offline and will rejoin.
    const desktop = emailDevice(w, other, 'other_desktop', {
      members: [owner]
    });
    const desktopCtx = invitationsOf(w, desktop);
    expect(await publishInvitationKeyPackages(inviteeCtx)).toEqual([
      invitation.invitationId
    ]);
    expect(await publishInvitationKeyPackages(desktopCtx)).toEqual([
      invitation.invitationId
    ]);
    expect(await acceptedInvitations(inviteeCtx)).toMatchObject([
      { state: 'waiting-for-owner' }
    ]);

    // The owner's next session: waiting for the owner to verify.
    const outgoing = await sentInvitations(ownerCtx);
    expect(outgoing).toMatchObject([
      {
        state: 'waiting-for-verification',
        record: { keyPackages: 2, claimedKeyPackages: 0 }
      }
    ]);
    // An unverified invitee is never added, and nothing is claimed.
    await expect(
      addInvitedMember(ownerCtx, outgoing[0]!.record)
    ).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof InvitationError && error.code === 'not-verified'
    );
    expect(
      rows<{ claimed_at: string | null }>(
        w.srv,
        'SELECT claimed_at FROM e2ee_key_packages WHERE project_id = ?',
        projectId
      )
    ).toEqual([{ claimed_at: null }, { claimed_at: null }]);
    expect(await completeReadyInvitations(ownerCtx, outgoing)).toMatchObject({
      added: []
    });
    expect(groupEpoch(w.srv, projectId)).toBe(1);

    // Verified. The invitation went out before, so it names no identity:
    // whoever the server delivered the link to, the owner confirms the
    // contact who accepted, by the code Contacts shows for them.
    verify(w, OWNER, OTHER);
    const sync = await syncInvitations(ownerCtx);
    expect(sync.errors).toEqual([]);
    expect(sync.added).toEqual([]);
    expect(sync.outgoing).toMatchObject([
      {
        state: 'confirm-add',
        statement: { role: 'editor', projectId },
        acceptor: {
          userId: OTHER,
          identityKeyHash: otherIdentity(),
          code: (await ownVerificationCode({ list: other.list } as AccountView))
            .code
        }
      }
    ]);
    await expect(
      addInvitedMember(ownerCtx, sync.outgoing[0]!.record)
    ).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof InvitationError && error.code === 'needs-confirmation'
    );
    expect(groupEpoch(w.srv, projectId)).toBe(1);
    // The owner's confirmation claims, checks and adds both devices.
    await addInvitedMember(ownerCtx, sync.outgoing[0]!.record, {
      confirmedIdentity: otherIdentity()
    });
    expect(groupEpoch(w.srv, projectId)).toBe(2);
    expect(memberRole(w.srv, projectId, OTHER)).toBe('editor');
    expect(
      rows<{ device_id: string; epoch: number }>(
        w.srv,
        `SELECT device_id, epoch FROM e2ee_welcomes WHERE project_id = ?
         ORDER BY device_id`,
        projectId
      )
    ).toEqual([
      { device_id: 'other_desktop', epoch: 1 },
      { device_id: 'other_laptop', epoch: 1 }
    ]);
    expect((await sentInvitations(ownerCtx)).length).toBe(0);
    // The owner's own wraps of the new epoch travelled with the Add.
    expect(
      rows<{ purpose: string }>(
        w.srv,
        `SELECT purpose FROM e2ee_project_keys
         WHERE project_id = ? AND user_id = ? AND key_epoch = 2
         ORDER BY purpose`,
        projectId,
        OWNER
      ).map((row) => row.purpose)
    ).toEqual(['project-key', 'rejoin-psk']);

    // The laptop joins by its Welcome, verifying the whole history, and
    // posts its account's wraps of the joined epoch. A read of the project
    // (the shelf's) joins at the same moment as the invitation sync: one
    // join opens the Welcome and the other shares its outcome, rather than
    // opening it again over the provisional join in progress.
    const [joinedBySync, joinedByRead] = await Promise.all([
      joinWelcomedProjects(inviteeCtx),
      joinProjectByWelcome(invitee.groups, projectId)
    ]);
    expect(joinedBySync).toEqual([projectId]);
    expect(joinedByRead).toMatchObject({ epoch: 2 });
    expect(
      rows<{ purpose: string }>(
        w.srv,
        `SELECT purpose FROM e2ee_project_keys
         WHERE project_id = ? AND user_id = ? AND key_epoch = 2
         ORDER BY purpose`,
        projectId,
        OTHER
      ).map((row) => row.purpose)
    ).toEqual(['project-key', 'rejoin-psk']);
    forgetAllProjectKeys();
    const opened = await invitee.store.loadProject(projectId);
    expect(opened.name).toBe('Bracket');
    // The shelf: the owner's project info decrypts for the member.
    expect((await invitee.store.info.read(projectId)).body?.name).toBe(
      'Bracket'
    );

    // The desktop joins by its own Welcome the first time it reads.
    forgetAllProjectKeys();
    expect((await desktop.store.loadProject(projectId)).name).toBe('Bracket');
    expect(
      await desktop.sessions.status({
        userId: OTHER,
        deviceId: 'other_desktop',
        projectId
      })
    ).toMatchObject({ inGroup: true });

    // The tablet published nothing: it rejoins by External Commit with the
    // account-wrapped rejoin PSK, and writes as an editor.
    forgetAllProjectKeys();
    const tablet = emailDevice(w, other, 'other_tablet', { members: [owner] });
    const read = await tablet.store.loadProject(projectId);
    await tablet.store.saveProjectDocument({
      projectId,
      expectedVersion: read.version,
      document: edited(read, 'Tablet edit')
    });
    expect(groupEpoch(w.srv, projectId)).toBe(3);

    // The owner's laptop, reloaded, reads the tablet's version written in
    // an epoch none of the owner's devices processed yet: it catches up.
    forgetAllProjectKeys();
    const reloaded = withEmailSession(
      w,
      reload(w.srv, laptop, { members: [other] })
    );
    expect((await reloaded.store.loadProject(projectId)).name).toBe(
      'Tablet edit'
    );
    // And a fresh browser of the owner reads it through those wraps.
    forgetAllProjectKeys();
    const ownerDesktop = emailDevice(w, owner, 'owner_desktop', {
      members: [other]
    });
    expect((await ownerDesktop.store.loadProject(projectId)).name).toBe(
      'Tablet edit'
    );
  });

  it('adds a viewer who reads but whose browser never writes', async () => {
    const w = world();
    const { projectId, ownerCtx, invitee, inviteeCtx } = await invited(
      w,
      'viewer'
    );
    verify(w, OTHER, OWNER);
    verify(w, OWNER, OTHER);
    await publishInvitationKeyPackages(inviteeCtx);
    expect((await syncInvitations(ownerCtx)).added).toHaveLength(1);
    expect(memberRole(w.srv, projectId, OTHER)).toBe('viewer');
    const opened = await invitee.store.loadProject(projectId);
    await expect(
      invitee.store.saveProjectDocument({
        projectId,
        expectedVersion: opened.version,
        document: edited(opened, 'Viewer edit')
      })
    ).rejects.toMatchObject({ code: 'E2EE_PROJECT_READ_ONLY' });
  });

  it('refuses a Welcome whose history was omitted, and joins once it is whole (#817)', async () => {
    const w = world();
    const { projectId, ownerCtx, invitee, inviteeCtx } = await invited(w);
    verify(w, OTHER, OWNER);
    verify(w, OWNER, OTHER);
    await publishInvitationKeyPackages(inviteeCtx);
    expect((await syncInvitations(ownerCtx)).added).toHaveLength(1);
    const ref = { userId: OTHER, deviceId: 'other_laptop', projectId };

    // The server leaves out epoch 1's key archive: its record is missing.
    invitee.answer = async (path, _init, response) => {
      if (!path.includes('/keys/archives')) return response;
      const body = (await response.json()) as {
        archives: { keyEpoch: number }[];
      };
      return new Response(
        JSON.stringify({
          ...body,
          archives: body.archives.filter((archive) => archive.keyEpoch !== 1)
        }),
        { status: response.status, headers: response.headers }
      );
    };
    await expect(
      joinProjectByWelcome(invitee.groups, projectId)
    ).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof ProjectGroupError && error.code === 'archive-invalid'
    );
    expect(await invitee.sessions.status(ref)).toMatchObject({
      inGroup: false,
      pendingJoin: false,
      pendingArchive: false
    });
    expect(
      rows(
        w.srv,
        'SELECT 1 FROM e2ee_project_keys WHERE project_id = ? AND user_id = ?',
        projectId,
        OTHER
      )
    ).toEqual([]);

    // The same Welcome joins with the whole history.
    invitee.answer = undefined;
    expect(await joinWelcomedProjects(inviteeCtx)).toEqual([projectId]);
    expect(await invitee.sessions.status(ref)).toMatchObject({
      inGroup: true,
      epoch: 2
    });
  });

  it('refuses a Welcome from an inviter whose archive omits the Add from the history (#817)', async () => {
    const w = world();
    const { laptop, projectId, ownerCtx, invitee, inviteeCtx } =
      await invited(w);
    verify(w, OTHER, OWNER);
    verify(w, OWNER, OTHER);
    await publishInvitationKeyPackages(inviteeCtx);
    expect((await syncInvitations(ownerCtx)).added).toHaveLength(1);

    // A hostile inviter re-signs the joined epoch's archive with its own
    // device, carrying epoch 1's record where the Add's belongs: every
    // signature, key and binding holds, only the history is short.
    const archive = (epoch: number) =>
      rows<{
        envelope: string;
        wrapped_version_key: string;
      }>(
        w.srv,
        `SELECT envelope, wrapped_version_key FROM e2ee_key_archives
         WHERE project_id = ? AND key_epoch = ?`,
        projectId,
        epoch
      )[0]!;
    const open = async (epoch: number) => {
      const key = await projectKeyForEpoch(laptop.groups, projectId, epoch);
      const stored = archive(epoch);
      const versionKey = await unwrapKey(
        key,
        fromBase64Url(stored.wrapped_version_key),
        {
          purpose: 'version-key',
          projectId,
          keyEpoch: epoch,
          kind: 'key-archive',
          versionId: `key-archive:${epoch}`
        }
      );
      const { header, plaintext } = await decryptProjectEnvelope(
        versionKey,
        fromBase64Url(stored.envelope),
        { expect: { projectId, kind: 'key-archive', keyEpoch: epoch } }
      );
      return { key, header, body: decodeKeyArchiveBody(plaintext, header) };
    };
    const first = await open(1);
    const joined = await open(2);
    const body = { ...joined.body, epochRecord: first.body.epochRecord };
    const versionKey = EnvelopeKey.generate();
    const envelope = await encryptProjectEnvelope(
      versionKey,
      {
        kind: 'key-archive',
        projectId,
        documentVersion: 2,
        previousVersionHash: null,
        epochBindingHash: await epochBinding(
          projectId,
          2,
          body.epochAuthenticator
        ),
        schemaVersion: 1,
        keyEpoch: 2
      },
      encodeKeyArchiveBody(body, { kind: 'key-archive', keyEpoch: 2 })
    );
    const signer = owner.devices.get('owner_laptop')!;
    w.srv.db
      .prepare(
        `UPDATE e2ee_key_archives
         SET envelope = ?, wrapped_version_key = ?, signature = ?
         WHERE project_id = ? AND key_epoch = 2`
      )
      .run(
        toBase64Url(envelope),
        toBase64Url(
          await wrapKey(joined.key, versionKey.bytes, {
            purpose: 'version-key',
            projectId,
            keyEpoch: 2,
            kind: 'key-archive',
            versionId: 'key-archive:2'
          })
        ),
        toBase64Url(
          await signProjectEnvelope(signer.signing.privateKey, envelope)
        ),
        projectId
      );

    await expect(
      joinProjectByWelcome(invitee.groups, projectId)
    ).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof ProjectGroupError && error.code === 'archive-invalid'
    );
    expect(
      await invitee.sessions.status({
        userId: OTHER,
        deviceId: 'other_laptop',
        projectId
      })
    ).toMatchObject({ inGroup: false, pendingJoin: false });
    expect(await joinWelcomedProjects(inviteeCtx)).toEqual([]);
    expect(count(w.srv, 'e2ee_project_keys', projectId)).toBe(
      // The owner's own: epochs 0, 1 and 2, each a project key and a PSK.
      6
    );
  });

  it('refuses a KeyPackage whose leaf is not the invitee’s, adding nothing', async () => {
    const w = world();
    const { projectId, ownerCtx, invitation, inviteeCtx, invitee } =
      await invited(w);
    verify(w, OTHER, OWNER);
    verify(w, OWNER, OTHER);
    await publishInvitationKeyPackages(inviteeCtx);
    // The server swaps the claimed KeyPackage's leaf for another device's.
    const swapped = emailDevice(w, other, 'other_desktop', {
      members: [owner]
    });
    const desktopCtx = invitationsOf(w, swapped);
    await publishInvitationKeyPackages(desktopCtx);
    const desktopLeaf = rows<{ leaf_key: string; certification: string }>(
      w.srv,
      `SELECT leaf_key, certification FROM e2ee_key_packages
       WHERE device_id = 'other_desktop'`
    )[0]!;
    w.srv.db
      .prepare(
        `UPDATE e2ee_key_packages SET leaf_key = ?, certification = ?
         WHERE device_id = 'other_laptop'`
      )
      .run(desktopLeaf.leaf_key, desktopLeaf.certification);
    const [pending] = await projectInvitations(ownerCtx, projectId);
    await expect(addInvitedMember(ownerCtx, pending!.record)).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof InvitationError && error.code === 'key-package-invalid'
    );
    expect(groupEpoch(w.srv, projectId)).toBe(1);
    expect(memberRole(w.srv, projectId, OTHER)).toBeNull();
    expect(invitation.invitationId).toBe(pending!.record.invitationId);
    // The refused claim is not kept: the invitee publishes anew.
    expect(
      await ownerCtx.store.claim(OWNER, invitation.invitationId)
    ).toBeNull();
    expect(await projectInvitations(ownerCtx, projectId)).toMatchObject([
      { state: 'waiting-for-keys' }
    ]);
    expect(invitee.deviceId).toBe('other_laptop');
  });

  it('completes only invitations this owner signed, from a claim it kept across a reload', async () => {
    const w = world();
    const { projectId, laptop, ownerCtx, inviteeCtx } = await invited(w);
    verify(w, OTHER, OWNER);
    verify(w, OWNER, OTHER);
    await publishInvitationKeyPackages(inviteeCtx);
    // The first Add attempt is lost before the Worker sees it, after the
    // claim: the claim is kept, and the reloaded browser adds from it.
    laptop.before = async (path, init) => {
      if (init.method === 'POST' && path.endsWith('/mls/commits')) {
        throw new Error('offline');
      }
    };
    const [pending] = await projectInvitations(ownerCtx, projectId);
    await expect(addInvitedMember(ownerCtx, pending!.record)).rejects.toThrow(
      'offline'
    );
    laptop.before = undefined;
    const claimed = await ownerCtx.store.claim(
      OWNER,
      pending!.record.invitationId
    );
    expect(claimed?.keyPackages).toHaveLength(1);
    const [again] = await projectInvitations(ownerCtx, projectId);
    expect(again).toMatchObject({
      state: 'ready',
      record: { keyPackages: 0, claimedKeyPackages: 1 }
    });
    const reloaded = withEmailSession(
      w,
      reload(w.srv, laptop, { members: [other] })
    );
    const reloadedCtx = {
      ...invitationsOf(w, reloaded),
      store: ownerCtx.store
    };
    await addInvitedMember(reloadedCtx, again!.record);
    expect(memberRole(w.srv, projectId, OTHER)).toBe('editor');
    expect(
      await ownerCtx.store.claim(OWNER, pending!.record.invitationId)
    ).toBeNull();

    // Someone else's invitation is not this account's to complete.
    const thirdDevice = emailDevice(w, third, 'third_laptop');
    await expect(
      addInvitedMember(invitationsOf(w, thirdDevice), pending!.record)
    ).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof InvitationError && error.code === 'statement-invalid'
    );
  });
});

describe('the invitee’s signed acceptance', () => {
  const unclaimed = (w: World, projectId: string) =>
    rows<{ claimed_at: string | null }>(
      w.srv,
      'SELECT claimed_at FROM e2ee_key_packages WHERE project_id = ?',
      projectId
    ).every((row) => row.claimed_at === null);

  const refusedWith = (code: string) => (error: unknown) =>
    error instanceof InvitationError && error.code === code;

  /** Accepted, verified both ways, KeyPackage and acceptance published. */
  async function published(w: World) {
    const setup = await invited(w);
    verify(w, OTHER, OWNER);
    verify(w, OWNER, OTHER);
    expect(await publishInvitationKeyPackages(setup.inviteeCtx)).toEqual([
      setup.invitation.invitationId
    ]);
    const stored = rows<{
      acceptance_statement: string | null;
      acceptance_signature: string | null;
    }>(
      w.srv,
      `SELECT acceptance_statement, acceptance_signature FROM e2ee_invitations
       WHERE invitation_id = ?`,
      setup.invitation.invitationId
    )[0]!;
    expect(stored.acceptance_statement).toBeTruthy();
    return { ...setup, stored };
  }

  const setAcceptance = (
    w: World,
    invitationId: string,
    statement: string | null,
    signature: string | null
  ) =>
    w.srv.db
      .prepare(
        `UPDATE e2ee_invitations SET acceptance_statement = ?,
           acceptance_signature = ? WHERE invitation_id = ?`
      )
      .run(statement, signature, invitationId);

  it('adds nobody whose acceptance is missing, and takes one an older app never signed', async () => {
    const w = world();
    const setup = await published(w);
    const { projectId, ownerCtx, invitation } = setup;
    // As an older app version left it: a KeyPackage, no acceptance, and no
    // record on the device that the person accepted it there.
    setAcceptance(w, invitation.invitationId, null, null);
    const older = memoryInvitationStore();
    for (const entry of await setup.inviteeCtx.store.published(OTHER)) {
      await older.markPublished(OTHER, entry);
    }
    const inviteeCtx: InvitationContext = { ...setup.inviteeCtx, store: older };
    const outgoing = await sentInvitations(ownerCtx);
    expect(outgoing).toMatchObject([{ state: 'needs-acceptance' }]);
    expect(await completeReadyInvitations(ownerCtx, outgoing)).toMatchObject({
      added: []
    });
    await expect(
      addInvitedMember(ownerCtx, outgoing[0]!.record)
    ).rejects.toSatisfy(refusedWith('acceptance-missing'));
    expect(unclaimed(w, projectId)).toBe(true);
    expect(groupEpoch(w.srv, projectId)).toBe(1);

    // The invitee's next session signs nothing in the background: they
    // confirm the invitation in the app first (inviter and role shown).
    const [listed] = await acceptedInvitations(inviteeCtx);
    expect(listed).toMatchObject({
      state: 'confirm',
      ownerEmail: OWNER_EMAIL,
      ownerCode: await contactCodeOf(owner.list),
      statement: { role: 'editor', projectId }
    });
    expect(await publishInvitationKeyPackages(inviteeCtx)).toEqual([]);
    expect((await syncInvitations(inviteeCtx)).errors).toEqual([]);
    expect(
      rows<{ acceptance_statement: string | null }>(
        w.srv,
        'SELECT acceptance_statement FROM e2ee_invitations WHERE invitation_id = ?',
        invitation.invitationId
      )
    ).toEqual([{ acceptance_statement: null }]);
    await confirmEncryptedInvitation(inviteeCtx, listed!);
    expect(await acceptedInvitations(inviteeCtx)).toMatchObject([
      { state: 'ready' }
    ]);
    // It signs then, without a second KeyPackage.
    const before = rows<{ key_package_hash: string }>(
      w.srv,
      'SELECT key_package_hash FROM e2ee_key_packages WHERE project_id = ?',
      projectId
    );
    expect(await publishInvitationKeyPackages(inviteeCtx)).toEqual([
      invitation.invitationId
    ]);
    expect(
      rows<{ key_package_hash: string }>(
        w.srv,
        'SELECT key_package_hash FROM e2ee_key_packages WHERE project_id = ?',
        projectId
      )
    ).toEqual(before);
    expect(await acceptedInvitations(inviteeCtx)).toMatchObject([
      { state: 'waiting-for-owner' }
    ]);
    const sync = await syncInvitations(ownerCtx);
    expect(sync.errors).toEqual([]);
    expect(sync.added).toEqual([invitation.invitationId]);
    expect(memberRole(w.srv, projectId, OTHER)).toBe('editor');
  });

  it('adds nobody from a forged acceptance or one the server moved to another account', async () => {
    const w = world();
    const { projectId, laptop, ownerCtx, invitation, stored } =
      await published(w);
    // A signature that is not the invitee device's.
    const forged = fromBase64Url(stored.acceptance_signature!);
    forged[forged.length - 1]! ^= 1;
    setAcceptance(
      w,
      invitation.invitationId,
      stored.acceptance_statement,
      toBase64Url(forged)
    );
    let [pending] = await sentInvitations(ownerCtx);
    expect(pending).toMatchObject({ state: 'needs-acceptance' });
    await expect(addInvitedMember(ownerCtx, pending!.record)).rejects.toSatisfy(
      refusedWith('acceptance-invalid')
    );

    // The server names another verified contact as the one who accepted,
    // with the invitee's genuine acceptance and KeyPackage.
    setAcceptance(
      w,
      invitation.invitationId,
      stored.acceptance_statement,
      stored.acceptance_signature
    );
    verify(w, OWNER, THIRD);
    laptop.answer = async (path, _init, response) => {
      if (!/\/invitations(\/sent)?$/.test(path)) return response;
      const body = (await response.json()) as {
        invitations: E2eeInvitationRecord[];
      };
      return Response.json(
        {
          invitations: body.invitations.map((record) => ({
            ...record,
            acceptedByUserId: THIRD
          }))
        },
        { status: response.status }
      );
    };
    const listed = await projectInvitations(ownerCtx, projectId);
    expect(listed).toMatchObject([
      { state: 'needs-acceptance', email: INVITEE_EMAIL }
    ]);
    expect(await completeReadyInvitations(ownerCtx, listed)).toMatchObject({
      added: []
    });
    [pending] = listed;
    await expect(addInvitedMember(ownerCtx, pending!.record)).rejects.toSatisfy(
      refusedWith('acceptance-invalid')
    );
    expect(unclaimed(w, projectId)).toBe(true);
    expect(groupEpoch(w.srv, projectId)).toBe(1);
    expect(memberRole(w.srv, projectId, THIRD)).toBeNull();
  });

  it('refuses an acceptance the Worker cannot verify', async () => {
    const w = world();
    const { projectId, invitation, inviteeCtx, stored } = await published(w);
    const forged = fromBase64Url(stored.acceptance_signature!);
    forged[forged.length - 1]! ^= 1;
    await expect(
      inviteeCtx.api.publishAcceptance(projectId, invitation.invitationId, {
        statement: stored.acceptance_statement!,
        signature: toBase64Url(forged)
      })
    ).rejects.toMatchObject({ status: 400 });
    // Nobody else posts an acceptance for this invitation.
    const thirdCtx = invitationsOf(w, emailDevice(w, third, 'third_laptop'));
    await expect(
      thirdCtx.api.publishAcceptance(projectId, invitation.invitationId, {
        statement: stored.acceptance_statement!,
        signature: stored.acceptance_signature!
      })
    ).rejects.toMatchObject({ status: 404 });
  });

  it('never adds back someone removed from the project without the owner’s confirmation', async () => {
    const w = world();
    const { projectId, laptop, ownerCtx, inviteeCtx } = await published(w);
    expect((await syncInvitations(ownerCtx)).added).toHaveLength(1);
    expect(await joinWelcomedProjects(inviteeCtx)).toEqual([projectId]);
    // The owner removes them; the page records it (`onMembersRemoved`).
    await removeMember(laptop.groups, projectId, OTHER);
    await ownerCtx.store.rememberRemoved(OWNER, {
      projectId,
      userId: OTHER,
      removedAt: Date.now()
    });
    expect(memberRole(w.srv, projectId, OTHER)).toBeNull();

    // An invitation to the same address, accepted and published again.
    const again = await inviteToEncryptedProject(
      ownerCtx,
      projectId,
      INVITEE_EMAIL,
      'viewer',
      pick(other)
    );
    const fresh = emailDevice(w, other, 'other_desktop', { members: [owner] });
    const freshCtx = invitationsOf(w, fresh);
    await acceptEncryptedInvitation(freshCtx, w.mail.at(-1)!.token);
    expect(await publishInvitationKeyPackages(freshCtx)).toEqual([
      again.invitationId
    ]);
    const sync = await syncInvitations(ownerCtx);
    expect(sync.added).toEqual([]);
    expect(sync.outgoing).toMatchObject([{ state: 'confirm-re-add' }]);
    await expect(
      addInvitedMember(ownerCtx, sync.outgoing[0]!.record)
    ).rejects.toSatisfy(refusedWith('removed-member'));
    expect(memberRole(w.srv, projectId, OTHER)).toBeNull();

    // The owner confirms: added back, and no longer remembered as removed.
    await addInvitedMember(ownerCtx, sync.outgoing[0]!.record, {
      confirmedIdentity: otherIdentity()
    });
    expect(memberRole(w.srv, projectId, OTHER)).toBe('viewer');
    expect(await ownerCtx.store.removedMembers(OWNER)).toEqual([]);
  });

  const acceptanceOf = (w: World, invitationId: string) =>
    rows<{ acceptance_statement: string | null }>(
      w.srv,
      'SELECT acceptance_statement FROM e2ee_invitations WHERE invitation_id = ?',
      invitationId
    )[0]!.acceptance_statement;

  const keyPackageCount = (w: World, projectId: string) =>
    rows<{ device_id: string }>(
      w.srv,
      'SELECT device_id FROM e2ee_key_packages WHERE project_id = ?',
      projectId
    ).length;

  it('signs nothing for an invitation the server lists for another account, whatever email it reports', async () => {
    const w = world();
    // The owner invites the invitee, who accepts by link.
    const { projectId, ownerCtx, invitation } = await invited(w);
    // The server lists that invitation to the third account as accepted
    // by it, and reports the invitee's address as its signed-in email.
    verify(w, THIRD, OWNER);
    verify(w, OWNER, THIRD);
    const carol = emailDevice(w, third, 'third_laptop', { members: [owner] });
    const record = (await projectInvitations(ownerCtx, projectId))[0]!.record;
    const posted: string[] = [];
    carol.before = async (path, init) => {
      if (init.method === 'POST') posted.push(path);
    };
    carol.answer = async (path, _init, response) =>
      path === '/api/e2ee/invitations'
        ? Response.json({
            invitations: [{ ...record, acceptedByUserId: THIRD }]
          })
        : response;
    const carolCtx: InvitationContext = {
      ...invitationsOf(w, carol),
      email: INVITEE_EMAIL
    };
    const [listed] = await acceptedInvitations(carolCtx);
    expect(listed).toMatchObject({
      state: 'confirm',
      record: { invitationId: invitation.invitationId }
    });
    // The background sweep signs and publishes nothing for it.
    const sync = await syncInvitations(carolCtx);
    expect(sync.errors).toEqual([]);
    expect(await publishInvitationKeyPackages(carolCtx)).toEqual([]);
    expect(posted).toEqual([]);
    expect(acceptanceOf(w, invitation.invitationId)).toBeNull();
    expect(keyPackageCount(w, projectId)).toBe(0);
    // So the owner adds nobody.
    expect((await syncInvitations(ownerCtx)).added).toEqual([]);
    expect(memberRole(w.srv, projectId, THIRD)).toBeNull();
    expect(groupEpoch(w.srv, projectId)).toBe(1);
  });

  it('signs only an invitation accepted on the device; the account’s other devices then publish', async () => {
    const w = world();
    const { projectId, invitation, inviteeCtx } = await invited(w);
    verify(w, OTHER, OWNER);
    // A second device of the invitee, which never opened the link, signs
    // nothing in the background.
    const desktop = emailDevice(w, other, 'other_desktop', {
      members: [owner]
    });
    const desktopCtx = invitationsOf(w, desktop);
    expect(await acceptedInvitations(desktopCtx)).toMatchObject([
      { state: 'confirm' }
    ]);
    expect((await syncInvitations(desktopCtx)).errors).toEqual([]);
    expect(acceptanceOf(w, invitation.invitationId)).toBeNull();
    expect(keyPackageCount(w, projectId)).toBe(0);
    // The device that opened the link signs; the other then publishes its
    // KeyPackage under that acceptance without signing one of its own.
    expect(await publishInvitationKeyPackages(inviteeCtx)).toEqual([
      invitation.invitationId
    ]);
    const signed = acceptanceOf(w, invitation.invitationId);
    expect(signed).toBeTruthy();
    expect(await acceptedInvitations(desktopCtx)).toMatchObject([
      { state: 'ready' }
    ]);
    expect(await publishInvitationKeyPackages(desktopCtx)).toEqual([
      invitation.invitationId
    ]);
    expect(acceptanceOf(w, invitation.invitationId)).toBe(signed);
    expect(keyPackageCount(w, projectId)).toBe(2);
  });

  /**
   * The owner's laptop records the removals its Commits make or process,
   * as the page does (`onMembersRemoved`, awaited).
   */
  function recordingOwner(
    w: World,
    laptop: Device,
    store: InvitationStore
  ): InvitationContext {
    return {
      ...invitationsOf(w, laptop, store),
      groups: {
        ...laptop.groups,
        onMembersRemoved: (removal) =>
          recordRemovedMembers(store, OWNER, removal),
        removalChecks: invitationRemovalChecks(store, OWNER)
      }
    };
  }

  /**
   * The invitee added and removed by the owner's desktop, which the
   * laptop has not processed; then invited again from the laptop, accepted
   * and published from a fresh device of the invitee.
   */
  async function removedElsewhere(w: World, removeNow: boolean) {
    const setup = await published(w);
    const { projectId, laptop } = setup;
    expect((await syncInvitations(setup.ownerCtx)).added).toHaveLength(1);
    const ownerDesktop = emailDevice(w, owner, 'owner_desktop', {
      members: [other]
    });
    await joinProjectGroup(ownerDesktop.groups, projectId);
    const removeFromDesktop = () =>
      removeMember(ownerDesktop.groups, projectId, OTHER);
    if (removeNow) await removeFromDesktop();
    const ownerCtx = recordingOwner(w, laptop, setup.ownerCtx.store);
    const again = await inviteToEncryptedProject(
      ownerCtx,
      projectId,
      INVITEE_EMAIL,
      'viewer',
      pick(other)
    );
    const fresh = emailDevice(w, other, 'other_tablet', { members: [owner] });
    const freshCtx = invitationsOf(w, fresh);
    await acceptEncryptedInvitation(freshCtx, w.mail.at(-1)!.token);
    expect(await publishInvitationKeyPackages(freshCtx)).toEqual([
      again.invitationId
    ]);
    return { ...setup, ownerCtx, again, removeFromDesktop };
  }

  it('stops an Add whose catch-up processes another device’s removal of the invitee', async () => {
    const w = world();
    const { projectId, ownerCtx } = await removedElsewhere(w, true);
    expect(memberRole(w.srv, projectId, OTHER)).toBeNull();
    const epoch = groupEpoch(w.srv, projectId);
    // The laptop has not processed the removal: the invitation lists as
    // ready, but the Add's catch-up finds the removal and stops.
    const outgoing = await sentInvitations(ownerCtx);
    expect(outgoing).toMatchObject([{ state: 'ready' }]);
    await expect(
      addInvitedMember(ownerCtx, outgoing[0]!.record)
    ).rejects.toSatisfy(refusedWith('removed-member'));
    expect(memberRole(w.srv, projectId, OTHER)).toBeNull();
    expect(groupEpoch(w.srv, projectId)).toBe(epoch);
    expect(await ownerCtx.store.removedMembers(OWNER)).toMatchObject([
      { projectId, userId: OTHER }
    ]);
    expect(await sentInvitations(ownerCtx)).toMatchObject([
      { state: 'confirm-re-add' }
    ]);
  });

  it('stops an Add rebuilt after another device’s removal of the invitee took its epoch', async () => {
    const w = world();
    const { projectId, laptop, ownerCtx, removeFromDesktop } =
      await removedElsewhere(w, false);
    const outgoing = await sentInvitations(ownerCtx);
    expect(outgoing).toMatchObject([{ state: 'ready' }]);
    // Just as the laptop sends its Add, the desktop's removal lands first.
    let raced = false;
    laptop.before = async (path, init) => {
      if (
        raced ||
        init.method !== 'POST' ||
        !path.endsWith('/mls/commits') ||
        typeof init.body !== 'string' ||
        !init.body.includes('"add"')
      ) {
        return;
      }
      raced = true;
      await removeFromDesktop();
    };
    await expect(
      addInvitedMember(ownerCtx, outgoing[0]!.record)
    ).rejects.toSatisfy(refusedWith('removed-member'));
    laptop.before = undefined;
    expect(raced).toBe(true);
    expect(memberRole(w.srv, projectId, OTHER)).toBeNull();
    expect(
      rows<{ device_id: string }>(
        w.srv,
        `SELECT device_id FROM e2ee_welcomes WHERE project_id = ?
         AND device_id = 'other_tablet'`,
        projectId
      )
    ).toEqual([]);
  });

  it('adds nobody automatically once a removal could not be written down', async () => {
    const w = world();
    const setup = await published(w);
    const { projectId, laptop, inviteeCtx } = setup;
    expect((await syncInvitations(setup.ownerCtx)).added).toHaveLength(1);
    expect(await joinWelcomedProjects(inviteeCtx)).toEqual([projectId]);
    // The removal's record fails to write.
    const failing: InvitationStore = {
      ...setup.ownerCtx.store,
      rememberRemoved: () => Promise.reject(new Error('quota exceeded'))
    };
    const ownerCtx = recordingOwner(w, laptop, failing);
    await removeMember(ownerCtx.groups, projectId, OTHER);
    expect(memberRole(w.srv, projectId, OTHER)).toBeNull();
    // Reads say nobody was removed, but this page does not trust them.
    expect(await failing.removedMembers(OWNER)).toEqual([]);

    const again = await inviteToEncryptedProject(
      ownerCtx,
      projectId,
      INVITEE_EMAIL,
      'viewer',
      pick(other)
    );
    const fresh = emailDevice(w, other, 'other_desktop', { members: [owner] });
    const freshCtx = invitationsOf(w, fresh);
    await acceptEncryptedInvitation(freshCtx, w.mail.at(-1)!.token);
    expect(await publishInvitationKeyPackages(freshCtx)).toEqual([
      again.invitationId
    ]);
    const sync = await syncInvitations(ownerCtx);
    expect(sync.added).toEqual([]);
    expect(sync.outgoing).toMatchObject([{ state: 'confirm-add' }]);
    await expect(
      addInvitedMember(ownerCtx, sync.outgoing[0]!.record)
    ).rejects.toSatisfy(refusedWith('needs-confirmation'));
    expect(memberRole(w.srv, projectId, OTHER)).toBeNull();
    // The owner's explicit confirmation still adds them.
    await addInvitedMember(ownerCtx, sync.outgoing[0]!.record, {
      confirmedIdentity: otherIdentity()
    });
    expect(memberRole(w.srv, projectId, OTHER)).toBe('viewer');
  });

  /**
   * Two tabs of the owner's browser: one IndexedDB store behind both, but
   * each tab its own module state (a store object of its own, so the
   * per-page latch does not carry over) and the same device's MLS session.
   */
  function tabOf(
    w: World,
    laptop: Device,
    shared: InvitationStore
  ): InvitationContext {
    return recordingOwner(w, laptop, { ...shared });
  }

  it('blocks an automatic re-add in another tab while a removal there is unrecorded', async () => {
    const w = world();
    const setup = await removedElsewhere(w, true);
    const { projectId, laptop } = setup;
    const shared = setup.ownerCtx.store;
    // Tab A processes the desktop's removal, advancing the shared session,
    // and fails to record it.
    const tabA = recordingOwner(w, laptop, {
      ...shared,
      rememberRemoved: () => Promise.reject(new Error('quota exceeded'))
    });
    const epoch = groupEpoch(w.srv, projectId);
    await catchUpProjectGroup(tabA.groups, projectId);
    expect(await shared.removedMembers(OWNER)).toEqual([]);
    // The Commit's check stays open (and the failed record opened one).
    const open = await shared.removalChecks(OWNER);
    expect(open.length).toBeGreaterThan(0);
    expect(open.every((check) => check.projectId === projectId)).toBe(true);
    // Tab B reads the advanced session: nothing to replay, no record of
    // the removal, but the open check stops it adding them back.
    const tabB = tabOf(w, laptop, shared);
    const sync = await syncInvitations(tabB);
    expect(sync.added).toEqual([]);
    expect(sync.outgoing).toMatchObject([{ state: 'confirm-add' }]);
    await expect(
      addInvitedMember(tabB, sync.outgoing[0]!.record)
    ).rejects.toSatisfy(refusedWith('needs-confirmation'));
    expect(memberRole(w.srv, projectId, OTHER)).toBeNull();
    expect(groupEpoch(w.srv, projectId)).toBe(epoch);
    // The owner's explicit confirmation still adds them.
    await addInvitedMember(tabB, sync.outgoing[0]!.record, {
      confirmedIdentity: otherIdentity()
    });
    expect(memberRole(w.srv, projectId, OTHER)).toBe('viewer');
  });

  it('closes a removal check once the removal is recorded', async () => {
    const w = world();
    const setup = await removedElsewhere(w, true);
    const { projectId } = setup;
    await catchUpProjectGroup(setup.ownerCtx.groups, projectId);
    expect(await setup.ownerCtx.store.removalChecks(OWNER)).toEqual([]);
    expect(await setup.ownerCtx.store.removedMembers(OWNER)).toMatchObject([
      { projectId, userId: OTHER }
    ]);
    // Another tab sees the record, not an open check, and still asks.
    const tabB = tabOf(w, setup.laptop, setup.ownerCtx.store);
    expect(await sentInvitations(tabB)).toMatchObject([
      { state: 'confirm-re-add' }
    ]);
  });

  it('processes no Commit in a tab that cannot mark the removal check, and adds nobody there', async () => {
    const w = world();
    const setup = await removedElsewhere(w, true);
    const { projectId, laptop } = setup;
    const shared = setup.ownerCtx.store;
    const broken: InvitationStore = {
      ...shared,
      beginRemovalCheck: () => Promise.reject(new Error('quota exceeded'))
    };
    const tab = recordingOwner(w, laptop, broken);
    const ref = { userId: OWNER, deviceId: 'owner_laptop', projectId };
    const before = (await laptop.groups.sessions.status(ref)).epoch;
    await expect(catchUpProjectGroup(tab.groups, projectId)).rejects.toThrow(
      /could not note a change/
    );
    expect((await laptop.groups.sessions.status(ref)).epoch).toBe(before);
    expect(await shared.removalChecks(OWNER)).toEqual([]);
    // That tab stays latched: it adds nobody automatically.
    const sync = await syncInvitations(tab);
    expect(sync.added).toEqual([]);
    expect(sync.outgoing).toMatchObject([{ state: 'confirm-add' }]);
    expect(memberRole(w.srv, projectId, OTHER)).toBeNull();
  });
});

describe('the emailed link, bound into the owner-signed statement', () => {
  /** The owner's project and an invitation of the invitee, not accepted. */
  async function sent(w: World, role: 'editor' | 'viewer' = 'editor') {
    const project = await ownersProject(w);
    const ownerCtx = invitationsOf(w, project.laptop, project.store);
    const invitation = await inviteToEncryptedProject(
      ownerCtx,
      project.projectId,
      INVITEE_EMAIL,
      role
    );
    return { ...project, ownerCtx, invitation, token: w.mail.at(-1)!.token };
  }

  it('records the link only when the statement names the token opened', async () => {
    const w = world();
    const { projectId, invitation, token } = await sent(w);
    const laptop = emailDevice(w, other, 'other_laptop', { members: [owner] });
    const inviteeCtx = invitationsOf(w, laptop);
    const accepted = await acceptEncryptedInvitation(inviteeCtx, token);
    expect(accepted).toMatchObject({
      linked: true,
      invitation: { invitationId: invitation.invitationId }
    });
    expect(await inviteeCtx.store.intents(OTHER)).toMatchObject([
      { invitationId: invitation.invitationId, projectId, source: 'link' }
    ]);
  });

  it('refuses a link the server answers with another invitation, recording and signing nothing', async () => {
    const w = world();
    // The owner invites the invitee; the server keeps that link's answer.
    const { projectId, ownerCtx, invitation } = await sent(w);
    // It also invites the third account, whose link the server answers
    // with the invitee's invitation, reporting the invitee's email.
    await inviteToEncryptedProject(ownerCtx, projectId, THIRD_EMAIL, 'viewer');
    const carolToken = w.mail.at(-1)!.token;
    const bobs = (await projectInvitations(ownerCtx, projectId)).find(
      (entry) => entry.record.invitationId === invitation.invitationId
    )!.record;
    verify(w, THIRD, OWNER);
    verify(w, OWNER, THIRD);
    const carol = emailDevice(w, third, 'third_laptop', { members: [owner] });
    const substituted = { ...bobs, acceptedByUserId: THIRD };
    carol.answer = async (path, _init, response) =>
      path === '/api/e2ee/invitations/accept'
        ? Response.json({ invitation: substituted })
        : path === '/api/e2ee/invitations'
          ? Response.json({ invitations: [substituted] })
          : response;
    const carolCtx: InvitationContext = {
      ...invitationsOf(w, carol),
      email: INVITEE_EMAIL
    };
    await expect(
      acceptEncryptedInvitation(carolCtx, carolToken)
    ).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof InvitationError &&
        error.code === 'statement-invalid' &&
        /another invitation/.test(error.message)
    );
    expect(await carolCtx.store.intents(THIRD)).toEqual([]);
    // Nothing is signed or published for it in the background.
    expect(await acceptedInvitations(carolCtx)).toMatchObject([
      { state: 'confirm' }
    ]);
    expect(await publishInvitationKeyPackages(carolCtx)).toEqual([]);
    expect(
      rows<{ acceptance_statement: string | null }>(
        w.srv,
        'SELECT acceptance_statement FROM e2ee_invitations WHERE invitation_id = ?',
        invitation.invitationId
      )
    ).toEqual([{ acceptance_statement: null }]);
    expect((await syncInvitations(ownerCtx)).added).toEqual([]);
    expect(memberRole(w.srv, projectId, THIRD)).toBeNull();
  });

  it('joins a version 1 invitation only on a confirmation that shows the verified role', async () => {
    const w = world();
    const { projectId, laptop: ownerLaptop, store } = await ownersProject(w);
    const ownerCtx = invitationsOf(w, ownerLaptop, store);
    // An older app: a statement with no link token, posted without one.
    const signed = await signInvitationStatement(
      ownerCtx,
      projectId,
      INVITEE_EMAIL,
      'viewer'
    );
    expect(fromBase64Url(signed.statement)[3]).toBe(1);
    await ownerCtx.api.create(projectId, {
      email: INVITEE_EMAIL,
      statement: signed.statement,
      signature: signed.signature
    });
    const laptop = emailDevice(w, other, 'other_laptop', { members: [owner] });
    const inviteeCtx = invitationsOf(w, laptop);
    expect(
      await acceptEncryptedInvitation(inviteeCtx, w.mail.at(-1)!.token)
    ).toMatchObject({ linked: false });
    expect(await inviteeCtx.store.intents(OTHER)).toEqual([]);
    verify(w, OTHER, OWNER);
    verify(w, OWNER, OTHER);
    // Listed for confirmation, with the signed role and the owner's
    // fingerprint; nothing is signed before it.
    const [listed] = await acceptedInvitations(inviteeCtx);
    expect(listed).toMatchObject({
      state: 'confirm',
      statement: { role: 'viewer', projectId },
      ownerCode: await contactCodeOf(owner.list)
    });
    expect(await publishInvitationKeyPackages(inviteeCtx)).toEqual([]);
    await confirmEncryptedInvitation(inviteeCtx, listed!);
    expect(await inviteeCtx.store.intents(OTHER)).toMatchObject([
      { statementHash: listed!.statementHash, source: 'confirmed' }
    ]);
    expect(await publishInvitationKeyPackages(inviteeCtx)).toEqual([
      signed.invitationId
    ]);
    // It names no identity: the owner confirms the contact who accepted.
    const sync = await syncInvitations(ownerCtx);
    expect(sync.errors).toEqual([]);
    expect(sync.added).toEqual([]);
    expect(sync.outgoing).toMatchObject([{ state: 'confirm-add' }]);
    await addInvitedMember(ownerCtx, sync.outgoing[0]!.record, {
      confirmedIdentity: otherIdentity()
    });
    expect(memberRole(w.srv, projectId, OTHER)).toBe('viewer');
  });

  it('refuses an invitation whose listed role conflicts with its statement', async () => {
    const w = world();
    const { projectId, invitation, token } = await sent(w, 'viewer');
    const laptop = emailDevice(w, other, 'other_laptop', { members: [owner] });
    const inviteeCtx = invitationsOf(w, laptop);
    // The server answers the link and lists the invitation as editor.
    laptop.answer = async (path, _init, response) => {
      if (
        path !== '/api/e2ee/invitations/accept' &&
        path !== '/api/e2ee/invitations'
      ) {
        return response;
      }
      const body = (await response.json()) as {
        invitation?: E2eeInvitationRecord;
        invitations?: E2eeInvitationRecord[];
      };
      return Response.json(
        body.invitation
          ? { invitation: { ...body.invitation, role: 'editor' } }
          : {
              invitations: body.invitations!.map((record) => ({
                ...record,
                role: 'editor'
              }))
            },
        { status: response.status }
      );
    };
    await expect(
      acceptEncryptedInvitation(inviteeCtx, token)
    ).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof InvitationError && error.code === 'statement-invalid'
    );
    expect(await inviteeCtx.store.intents(OTHER)).toEqual([]);
    verify(w, OTHER, OWNER);
    const [listed] = await acceptedInvitations(inviteeCtx);
    expect(listed).toMatchObject({
      state: 'invalid',
      statement: null,
      statementHash: null,
      record: { invitationId: invitation.invitationId, role: 'editor' }
    });
    await expect(
      confirmEncryptedInvitation(inviteeCtx, listed!)
    ).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof InvitationError && error.code === 'statement-invalid'
    );
    expect(await publishInvitationKeyPackages(inviteeCtx)).toEqual([]);
    expect(
      rows<{ n: number }>(
        w.srv,
        'SELECT COUNT(*) AS n FROM e2ee_key_packages WHERE project_id = ?',
        projectId
      )
    ).toEqual([{ n: 0 }]);
  });
});

describe('the owner’s confirmation: the server delivers the email', () => {
  const refusedWith = (code: string) => (error: unknown) =>
    error instanceof InvitationError && error.code === code;

  /** What Contacts shows for an account: its identity with its head. */
  const contactsCode = async (account: Account) =>
    (await ownVerificationCode({ list: account.list } as AccountView)).code;

  /**
   * Bob's invitation, whose real link the server delivers to Carol: it
   * binds her account, tells her browser her session email is Bob's and
   * answers the link with Bob's genuine statement. Carol and the owner are
   * verified contacts, so her browser signs and publishes.
   */
  async function misdelivered(w: World, { bindBob }: { bindBob: boolean }) {
    const project = await ownersProject(w);
    const ownerCtx = invitationsOf(w, project.laptop, project.store);
    verify(w, OWNER, THIRD);
    verify(w, THIRD, OWNER);
    if (bindBob) verify(w, OWNER, OTHER);
    const invitation = await inviteToEncryptedProject(
      ownerCtx,
      project.projectId,
      INVITEE_EMAIL,
      'editor',
      bindBob ? pick(other) : {}
    );
    const token = w.mail.at(-1)!.token;
    w.srv.db
      .prepare(
        `UPDATE e2ee_invitations SET accepted_by_user_id = ?, accepted_at = ?
         WHERE invitation_id = ?`
      )
      .run(THIRD, new Date().toISOString(), invitation.invitationId);
    const [bobs] = (await projectInvitations(ownerCtx, project.projectId)).map(
      (entry) => entry.record
    );
    const carol = emailDevice(w, third, 'third_laptop', { members: [owner] });
    carol.answer = async (path, _init, response) =>
      path === '/api/e2ee/invitations/accept'
        ? Response.json({ invitation: bobs })
        : response;
    const carolCtx: InvitationContext = {
      ...invitationsOf(w, carol),
      email: INVITEE_EMAIL
    };
    expect(await acceptEncryptedInvitation(carolCtx, token)).toMatchObject({
      linked: true
    });
    expect(await publishInvitationKeyPackages(carolCtx)).toEqual([
      invitation.invitationId
    ]);
    return { ...project, ownerCtx, invitation, carolCtx };
  }

  it('never adds the wrong recipient of an email-only invitation without the owner, who can decline', async () => {
    const w = world();
    const { projectId, ownerCtx, invitation } = await misdelivered(w, {
      bindBob: false
    });
    expect(fromBase64Url(invitation.statement)[3]).toBe(2);
    const sync = await syncInvitations(ownerCtx);
    expect(sync.errors).toEqual([]);
    expect(sync.added).toEqual([]);
    // The confirmation names who really accepted, from their verified
    // keys: Carol's contact code, not the address the owner typed.
    expect(sync.outgoing).toMatchObject([
      {
        state: 'confirm-add',
        email: INVITEE_EMAIL,
        acceptor: {
          userId: THIRD,
          identityKeyHash: toHex(third.list.identityKeyHash),
          code: await contactsCode(third),
          email: THIRD_EMAIL
        }
      }
    ]);
    await expect(
      addInvitedMember(ownerCtx, sync.outgoing[0]!.record)
    ).rejects.toSatisfy(refusedWith('needs-confirmation'));
    // A confirmation of someone else (the code the owner expected) adds
    // nobody either.
    await expect(
      addInvitedMember(ownerCtx, sync.outgoing[0]!.record, {
        confirmedIdentity: otherIdentity()
      })
    ).rejects.toSatisfy(refusedWith('acceptance-invalid'));
    expect(memberRole(w.srv, projectId, THIRD)).toBeNull();
    expect(groupEpoch(w.srv, projectId)).toBe(1);

    // Declining closes the invitation and drops its KeyPackages.
    await declineInvitation(ownerCtx, projectId, invitation.invitationId);
    expect(await projectInvitations(ownerCtx, projectId)).toMatchObject([
      { state: 'revoked' }
    ]);
    expect(
      rows<{ n: number }>(
        w.srv,
        'SELECT COUNT(*) AS n FROM e2ee_key_packages WHERE project_id = ?',
        projectId
      )
    ).toEqual([{ n: 0 }]);
    expect(
      await ownerCtx.store.claim(OWNER, invitation.invitationId)
    ).toBeNull();
    expect((await syncInvitations(ownerCtx)).added).toEqual([]);
    expect(memberRole(w.srv, projectId, THIRD)).toBeNull();
  });

  it('adds automatically only the contact a bound invitation names', async () => {
    const w = world();
    const { projectId, ownerCtx, invitation } = await misdelivered(w, {
      bindBob: true
    });
    // Version 3: the statement names Bob's identity key.
    expect(fromBase64Url(invitation.statement)[3]).toBe(3);
    const sync = await syncInvitations(ownerCtx);
    expect(sync.added).toEqual([]);
    expect(sync.outgoing).toMatchObject([
      { state: 'accepted-by-other', acceptor: { userId: THIRD } }
    ]);
    // Not even the owner's confirmation of Carol adds her to Bob's.
    await expect(
      addInvitedMember(ownerCtx, sync.outgoing[0]!.record, {
        confirmedIdentity: toHex(third.list.identityKeyHash)
      })
    ).rejects.toSatisfy(refusedWith('acceptance-invalid'));
    expect(memberRole(w.srv, projectId, THIRD)).toBeNull();
    expect(groupEpoch(w.srv, projectId)).toBe(1);
  });

  it('adds the bound contact automatically, and only where this browser saw every removal', async () => {
    const w = world();
    const { projectId, laptop, ownerCtx, invitation, inviteeCtx } =
      await invited(w);
    expect(fromBase64Url(invitation.statement)[3]).toBe(3);
    verify(w, OTHER, OWNER);
    await publishInvitationKeyPackages(inviteeCtx);
    // A fresh device of the owner rejoins from the history: it has no
    // record of removals before it, even if its browser once had a mark.
    const desktop = emailDevice(w, owner, 'owner_desktop', {
      members: [other]
    });
    const desktopStore = memoryInvitationStore();
    await desktopStore.establishRemovalHistory(OWNER, {
      projectId,
      since: 0
    });
    Object.assign(desktop.groups, {
      removalChecks: invitationRemovalChecks(desktopStore, OWNER)
    });
    await joinProjectGroup(desktop.groups, projectId);
    expect(await desktopStore.removalHistory(OWNER)).toEqual([]);
    const desktopCtx = invitationsOf(w, desktop, desktopStore);
    const fresh = await syncInvitations(desktopCtx);
    expect(fresh.added).toEqual([]);
    expect(fresh.outgoing).toMatchObject([{ state: 'confirm-add' }]);
    await expect(
      addInvitedMember(desktopCtx, fresh.outgoing[0]!.record)
    ).rejects.toSatisfy(refusedWith('needs-confirmation'));
    expect(memberRole(w.srv, projectId, OTHER)).toBeNull();
    // The laptop made the group: it adds the contact the statement names.
    expect(await ownerCtx.store.removalHistory(OWNER)).toMatchObject([
      { projectId }
    ]);
    const sync = await syncInvitations(ownerCtx);
    expect(sync.errors).toEqual([]);
    expect(sync.added).toEqual([invitation.invitationId]);
    expect(memberRole(w.srv, projectId, OTHER)).toBe('editor');
    expect(laptop.deviceId).toBe('owner_laptop');
  });

  it('counts a link intent only for a statement that names its token, so an older one needs Join', async () => {
    const w = world();
    const project = await ownersProject(w);
    const ownerCtx = invitationsOf(w, project.laptop, project.store);
    const invitation = await inviteToEncryptedProject(
      ownerCtx,
      project.projectId,
      INVITEE_EMAIL,
      'editor'
    );
    const laptop = emailDevice(w, other, 'other_laptop', { members: [owner] });
    const inviteeCtx = invitationsOf(w, laptop);
    await acceptEncryptedInvitation(inviteeCtx, w.mail.at(-1)!.token);
    const [kept] = await inviteeCtx.store.intents(OTHER);
    expect(kept).toMatchObject({ source: 'link' });
    expect(kept!.linkTokenHash).toMatch(/^[0-9a-f]{64}$/);
    // An older version kept the link intent without its token.
    const { linkTokenHash: _dropped, ...legacy } = kept!;
    await inviteeCtx.store.rememberIntent(OTHER, legacy);
    // And a version 1 invitation, to another project, with a retained
    // link intent.
    const second = (await createEncrypted(project.laptop, 'Second')).document
      .projectId;
    const v1 = await signInvitationStatement(
      ownerCtx,
      second,
      INVITEE_EMAIL,
      'viewer'
    );
    await ownerCtx.api.create(second, {
      email: INVITEE_EMAIL,
      statement: v1.statement,
      signature: v1.signature
    });
    await acceptEncryptedInvitation(inviteeCtx, w.mail.at(-1)!.token);
    await inviteeCtx.store.rememberIntent(OTHER, {
      ...legacy,
      projectId: second,
      invitationId: v1.invitationId,
      statementHash: toHex(
        await invitationStatementHash(fromBase64Url(v1.statement))
      )
    });
    verify(w, OTHER, OWNER);
    const listed = await acceptedInvitations(inviteeCtx);
    expect(listed.map((entry) => entry.state)).toEqual(['confirm', 'confirm']);
    expect(await publishInvitationKeyPackages(inviteeCtx)).toEqual([]);
    // A listing that a caller kept as ready is refused at publication too.
    expect(
      await publishInvitationKeyPackages(
        inviteeCtx,
        listed.map((entry) => ({ ...entry, state: 'ready' as const }))
      )
    ).toEqual([]);
    expect(
      rows<{ n: number }>(
        w.srv,
        `SELECT COUNT(*) AS n FROM e2ee_invitations
         WHERE acceptance_statement IS NOT NULL`
      )
    ).toEqual([{ n: 0 }]);
    // The explicit Join still signs.
    await confirmEncryptedInvitation(
      inviteeCtx,
      listed.find(
        (entry) => entry.record.invitationId === invitation.invitationId
      )!
    );
    expect(await publishInvitationKeyPackages(inviteeCtx)).toEqual([
      invitation.invitationId
    ]);
  });

  it('names the inviter and the invitee by the code Contacts shows', async () => {
    const w = world();
    const { inviteeCtx } = await invited(w);
    verify(w, OTHER, OWNER);
    const [listed] = await acceptedInvitations(inviteeCtx);
    expect(listed!.ownerCode).toBe(await contactsCode(owner));
    expect(await contactCodeOf(other.list)).toBe(await contactsCode(other));
  });
});

describe('the slice 5-2 gap: a member’s External-Commit epoch', () => {
  /**
   * 5-2's fixture: OTHER listed by the owner's Commit, its device joining
   * by External Commit with keys handed over in process, then writing in
   * the epoch its External Commit made.
   */
  async function memberWroteInItsOwnEpoch() {
    const srv = newServer([owner, other, third]);
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
    forgetAllProjectKeys();
    return { srv, laptop, projectId };
  }

  it('lets the owner’s reloaded browser read it by catching up first', async () => {
    const { srv, laptop, projectId } = await memberWroteInItsOwnEpoch();
    // Before the fix: "signed by someone without an editing role in its
    // epoch", since no wrap of epoch 2 existed for the owner and the
    // session was never asked.
    const reloaded = reload(srv, laptop, { members: [other] });
    expect((await reloaded.store.loadProject(projectId)).name).toBe(
      'Member edit'
    );
    expect(
      await reloaded.sessions.status({
        userId: OWNER,
        deviceId: 'owner_laptop',
        projectId
      })
    ).toMatchObject({ epoch: 2 });
    // Catching up posted the owner's wraps of epoch 2: a fresh browser of
    // the owner reads it too.
    forgetAllProjectKeys();
    const desktop = device(srv, owner, 'owner_desktop', { members: [other] });
    expect((await desktop.store.loadProject(projectId)).name).toBe(
      'Member edit'
    );
  });

  it('says a browser with no state of its own lacks the epoch’s key, not that the author lacked a role', async () => {
    const { srv, projectId } = await memberWroteInItsOwnEpoch();
    const desktop = device(srv, owner, 'owner_desktop', { members: [other] });
    const error = await desktop.store.loadProject(projectId).then(
      () => null,
      (caught: unknown) => caught
    );
    expect(error).toBeInstanceOf(ProjectGroupError);
    expect(error).toMatchObject({ code: 'key-missing' });
    expect(error).not.toBeInstanceOf(EncryptedProjectIntegrityError);
  });
});

describe('the owner’s and invitee’s lists on the Worker (slice 5-3b)', () => {
  it('counts KeyPackages for the owner only and reports the group epoch to the invitee', async () => {
    const w = world();
    const { projectId, ownerCtx, inviteeCtx, invitation } = await invited(w);
    const [accepted] = (await inviteeCtx.api.accepted()).invitations;
    expect(accepted).toMatchObject({ groupEpoch: 1 });
    expect(accepted).not.toHaveProperty('keyPackages');
    const [listed] = (await ownerCtx.api.list(projectId)).invitations;
    expect(listed).toMatchObject({ keyPackages: 0, claimedKeyPackages: 0 });
    expect(listed).not.toHaveProperty('groupEpoch');
    expect((await ownerCtx.api.sent()).invitations).toMatchObject([
      { invitationId: invitation.invitationId }
    ]);
    // Another account's sent list does not include it.
    const thirdDevice = emailDevice(w, third, 'third_laptop');
    expect(
      (await invitationsOf(w, thirdDevice).api.sent()).invitations
    ).toEqual([]);
  });
});
