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
  signProjectEnvelope,
  toBase64Url,
  unwrapKey,
  wrapKey
} from '@openzcad/crypto';
import { handleE2eeRequest } from '../apps/web/worker/e2ee';
import type { E2eeInvitationHost } from '../apps/web/worker/e2eeInvitations';
import {
  admitDevelopmentE2eeWrite,
  releaseDevelopmentE2eeWrite
} from '../apps/web/worker/e2eeWriteAuthorization';
import { createE2eeInvitationsApi } from '@openzcad/shared';
import {
  InvitationError,
  acceptEncryptedInvitation,
  acceptedInvitations,
  addInvitedMember,
  completeReadyInvitations,
  inviteToEncryptedProject,
  joinWelcomedProjects,
  projectInvitations,
  publishInvitationKeyPackages,
  sentInvitations,
  syncInvitations,
  type InvitationContext,
  type InvitationPerson
} from '../apps/web/src/lib/e2ee/invitations';
import { memoryInvitationStore } from '../apps/web/src/lib/e2ee/invitationStore';
import {
  commitProjectGroup,
  joinProjectByWelcome,
  joinProjectGroup,
  postOwnEpochKeys,
  projectKeyForEpoch,
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
      inspect: async (userId): Promise<InvitationPerson | null> => {
        const account = ACCOUNTS().find((a) => a.userId === userId);
        if (!account) return null;
        return {
          userId,
          email: EMAILS[userId] ?? null,
          status: w.verified.get(d.account.userId)?.has(userId)
            ? 'verified'
            : 'seen',
          list: account.list
        };
      }
    }
  };
}

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

/** The owner's encrypted project, an empty Commit in (history to verify). */
async function ownersProject(w: World) {
  const laptop = emailDevice(w, owner, 'owner_laptop', { members: [other] });
  const { document } = await createEncrypted(laptop);
  const projectId = document.projectId;
  await commitProjectGroup(laptop.groups, projectId);
  return { laptop, projectId, document };
}

/** Invited, accepted, the owner verified by the invitee: ready to publish. */
async function invited(w: World, role: 'editor' | 'viewer' = 'editor') {
  const project = await ownersProject(w);
  const ownerCtx = invitationsOf(w, project.laptop);
  const invitation = await inviteToEncryptedProject(
    ownerCtx,
    project.projectId,
    INVITEE_EMAIL,
    role
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
      await invited(w);
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

    // Verified: the owner's sync claims, checks and adds both devices.
    verify(w, OWNER, OTHER);
    const sync = await syncInvitations(ownerCtx);
    expect(sync.errors).toEqual([]);
    expect(sync.added).toEqual([invitation.invitationId]);
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
    // posts its account's wraps of the joined epoch.
    expect(await joinWelcomedProjects(inviteeCtx)).toEqual([projectId]);
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
      (error: unknown) => error instanceof ProjectGroupError && error.code === 'archive-invalid'
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
