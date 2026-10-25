/**
 * A co-member's revoked device that no signed revocation cutoff names the
 * project for (ADR-024 Phase 5, slice 5-7, closing slice 5-2's gap; roadmap
 * L11). Before, such a device made every member's MLS directory refuse
 * (`revocation-cutoff-missing`), so a shared project stopped for everyone
 * once a member who had ever removed a device joined it. Now, in a shared
 * project, the device gets `UNSIGNED_SHARED_CUTOFF` in every member's
 * directory: the project stays usable and only that account's External
 * Commits by rejoin PSK are refused. A solo project keeps slice 4-10's rule.
 *
 * Two accounts' Node devices run the real invitation flow (slice 5-3b),
 * `projectGroups.ts` and `encryptedProjectStore.ts` with the in-process MLS
 * engine against the real Worker routes over SQLite. The invitee revoked an
 * old device before it was invited, which is the common case: cutoff
 * statements name only projects that existed at the removal.
 */
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { handleE2eeRequest } from '../apps/web/worker/e2ee';
import type { E2eeInvitationHost } from '../apps/web/worker/e2eeInvitations';
import {
  admitDevelopmentE2eeWrite,
  releaseDevelopmentE2eeWrite
} from '../apps/web/worker/e2eeWriteAuthorization';
import { createE2eeInvitationsApi } from '@openzcad/shared';
import {
  acceptEncryptedInvitation,
  inviteToEncryptedProject,
  joinWelcomedProjects,
  publishInvitationKeyPackages,
  syncInvitations,
  type InvitationContext,
  type InvitationPerson
} from '../apps/web/src/lib/e2ee/invitations';
import { memoryInvitationStore } from '../apps/web/src/lib/e2ee/invitationStore';
import {
  commitProjectGroup,
  joinProjectGroup
} from '../apps/web/src/lib/e2ee/projectGroups';
import { MlsDirectoryError } from '../apps/web/src/lib/e2ee/mls/directory';
import { forgetAllProjectKeys } from '../apps/web/src/lib/e2ee/unlockedProjectKeys';
import {
  OTHER,
  OWNER,
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

const OWNER_EMAIL = 'owner@example.com';
const INVITEE_EMAIL = 'invitee@example.com';
const EMAILS: Record<string, string> = {
  [OWNER]: OWNER_EMAIL,
  [OTHER]: INVITEE_EMAIL
};

let owner: Account;
let other: Account;

beforeAll(async () => {
  owner = await makeAccount(OWNER, ['owner_laptop', 'owner_desktop']);
  other = await makeAccount(OTHER, [
    'other_laptop',
    'other_desktop',
    'other_tablet',
    'other_old'
  ]);
});

afterEach(() => {
  forgetAllProjectKeys();
});

interface World {
  srv: Server;
  mail: { token: string }[];
}

function world(): World {
  const srv = newServer([owner, other], undefined, {
    PROJECT_INVITATION_EMAIL_FROM: 'invites@example.test',
    PUBLIC_APP_ORIGIN: 'https://openzcad.example/'
  });
  for (const [userId, email] of Object.entries(EMAILS)) {
    srv.db
      .prepare('UPDATE users SET email = ? WHERE id = ?')
      .run(email, userId);
  }
  return { srv, mail: [] };
}

function host(w: World, userId: string): E2eeInvitationHost {
  return {
    email: EMAILS[userId] ?? null,
    inviterLabel: EMAILS[userId] ?? userId,
    sharingEnabled: true,
    emailConfigured: true,
    sendInvitationEmail: async (details) => {
      w.mail.push({ token: details.token });
    }
  };
}

/** A device whose e2ee calls carry the account's email, as invitations need. */
function emailDevice(
  w: World,
  account: Account,
  deviceId: string,
  options: DeviceOptions = {}
): Device {
  return withEmailSession(w, device(w.srv, account, deviceId, options));
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

/** Both accounts have compared codes (slice 5-1) before anything is added. */
function invitationsOf(d: Device): InvitationContext {
  return {
    groups: d.groups,
    api: createE2eeInvitationsApi((path, init) => d.fetcher(path, init)),
    store: memoryInvitationStore(),
    email: EMAILS[d.account.userId] ?? null,
    people: {
      inspect: async (userId): Promise<InvitationPerson | null> => {
        const account = [owner, other].find((a) => a.userId === userId);
        return account
          ? {
              userId,
              email: EMAILS[userId] ?? null,
              status: 'verified',
              list: account.list
            }
          : null;
      }
    }
  };
}

const groupEpoch = (srv: Server, projectId: string) =>
  rows<{ epoch: number }>(
    srv,
    'SELECT epoch FROM e2ee_project_groups WHERE project_id = ?',
    projectId
  )[0]!.epoch;

const isPolicy = (code: string) => (error: unknown) =>
  error instanceof Error &&
  error.name === 'MlsError' &&
  ((error as { reasons?: { code: string }[] }).reasons ?? []).some(
    (reason) => reason.code === code
  );

describe('a co-member’s revoked device without a signed cutoff (slice 5-7)', () => {
  it('keeps a shared project usable for everyone and refuses only that account’s rejoins by PSK', async () => {
    const w = world();
    // The invitee's own solo project, from before its old device was
    // removed by a removal that stored no cutoff statement.
    const otherLaptop = emailDevice(w, other, 'other_laptop', {
      members: [owner]
    });
    const solo = (await createEncrypted(otherLaptop, 'Solo')).document
      .projectId;
    await other.revoke(w.srv.db, 'other_old');

    // The owner's project, the invitation, accepted and published by two of
    // the invitee's devices, and the owner's Add.
    const laptop = emailDevice(w, owner, 'owner_laptop', { members: [other] });
    const { document } = await createEncrypted(laptop, 'Bracket');
    const projectId = document.projectId;
    await commitProjectGroup(laptop.groups, projectId);
    const ownerCtx = invitationsOf(laptop);
    const invitation = await inviteToEncryptedProject(
      ownerCtx,
      projectId,
      INVITEE_EMAIL,
      'editor'
    );
    const inviteeCtx = invitationsOf(otherLaptop);
    await acceptEncryptedInvitation(inviteeCtx, w.mail.at(-1)!.token);
    const otherDesktop = emailDevice(w, other, 'other_desktop', {
      members: [owner]
    });
    expect(await publishInvitationKeyPackages(inviteeCtx)).toEqual([
      invitation.invitationId
    ]);
    expect(
      await publishInvitationKeyPackages(invitationsOf(otherDesktop))
    ).toEqual([invitation.invitationId]);
    const sync = await syncInvitations(ownerCtx);
    expect(sync.errors).toEqual([]);
    expect(sync.added).toEqual([invitation.invitationId]);

    // The invitee's devices join by their Welcomes: their own directory
    // names the old device, which no statement covers for this project.
    expect(await joinWelcomedProjects(inviteeCtx)).toEqual([projectId]);
    const opened = await otherLaptop.store.loadProject(projectId);
    expect(opened.name).toBe('Bracket');
    forgetAllProjectKeys();
    expect((await otherDesktop.store.loadProject(projectId)).name).toBe(
      'Bracket'
    );
    await otherLaptop.store.saveProjectDocument({
      projectId,
      expectedVersion: opened.version,
      document: edited(opened, 'Member edit')
    });

    // The owner's reloaded and fresh browsers build the directory, read
    // the member's version and commit on; the member follows.
    forgetAllProjectKeys();
    const reloaded = withEmailSession(
      w,
      reload(w.srv, laptop, { members: [other] })
    );
    expect((await reloaded.store.loadProject(projectId)).name).toBe(
      'Member edit'
    );
    forgetAllProjectKeys();
    const ownerDesktop = emailDevice(w, owner, 'owner_desktop', {
      members: [other]
    });
    expect((await ownerDesktop.store.loadProject(projectId)).name).toBe(
      'Member edit'
    );
    // The old device holds no leaf and nothing names a later key epoch for
    // it, so the owner writes too.
    const read = await reloaded.store.loadProject(projectId);
    await reloaded.store.saveProjectDocument({
      projectId,
      expectedVersion: read.version,
      document: edited(read, 'Owner edit')
    });
    expect((await otherDesktop.store.loadProject(projectId)).name).toBe(
      'Owner edit'
    );
    const before = groupEpoch(w.srv, projectId);
    await commitProjectGroup(reloaded.groups, projectId);
    expect(groupEpoch(w.srv, projectId)).toBe(before + 1);
    await joinProjectGroup(otherDesktop.groups, projectId);

    // The invitee's tablet published no KeyPackage. Its External Commit by
    // rejoin PSK is refused by its own browser, so nothing reaches the
    // server: the old device might know any PSK of this project so far.
    forgetAllProjectKeys();
    const tablet = emailDevice(w, other, 'other_tablet', { members: [owner] });
    const epoch = groupEpoch(w.srv, projectId);
    await expect(joinProjectGroup(tablet.groups, projectId)).rejects.toSatisfy(
      isPolicy('rejoin-psk-before-revocation')
    );
    expect(groupEpoch(w.srv, projectId)).toBe(epoch);

    // The invitee's solo project (no other account's leaf, so no co-member
    // lists) keeps slice 4-10's rule: without a cutoff the directory
    // refuses rather than guess.
    await expect(
      commitProjectGroup(reload(w.srv, otherLaptop).groups, solo)
    ).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof MlsDirectoryError &&
        error.code === 'revocation-cutoff-missing'
    );
  });
});
