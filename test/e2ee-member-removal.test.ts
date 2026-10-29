/**
 * Member removal and leaving in end-to-end encrypted projects (ADR-024
 * Phase 5, slice 5-5; roadmap L11; migration 0039): Node devices of three
 * accounts run the real client modules (`projectGroups.ts`,
 * `memberships.ts`, `encryptedProjectStore.ts`) with the in-process MLS
 * engine against the real Worker over SQLite. Members are seeded through
 * MLS as in the slice 5-2 tests (`support/e2ee-members.ts`).
 */
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { fromBase64Url, toBase64Url, toHex } from '@openzcad/crypto';
import { isE2eeMlsProposalStorageReady } from '@openzcad/cloudflare-adapters';
import { proposalErasureStatements } from '../apps/web/worker/e2eeProposals';
import { ownProjectRole } from '../apps/web/src/lib/e2ee/memberships';
import {
  ProjectGroupApiError,
  ProjectGroupError,
  catchUpProjectGroup,
  changeMemberRole,
  commitPendingDepartures,
  commitProjectGroup,
  dedupeSecretForProject,
  epochRoles,
  joinProjectGroup,
  leaveProject,
  projectKeyForEpoch,
  removeMember,
  type MembersRemoved,
  type ProjectGroupContext
} from '../apps/web/src/lib/e2ee/projectGroups';
import { forgetAllProjectKeys } from '../apps/web/src/lib/e2ee/unlockedProjectKeys';
import { sqliteD1 } from './support/sqlite-d1';
import {
  OTHER,
  OWNER,
  device,
  edited,
  makeAccount,
  rows,
  type Account,
  type Device,
  type Server
} from './support/e2ee-documents';
import {
  addMember,
  forgeVersion,
  head,
  memberRow,
  ownerRef,
  refusedWith,
  serverKeyEpoch,
  sharedProject
} from './support/e2ee-members';

const THIRD = 'user_third';
const NOW = '2026-10-24T00:00:00.000Z';

let owner: Account;
let other: Account;
let third: Account;

beforeAll(async () => {
  owner = await makeAccount(OWNER, ['owner_laptop', 'owner_desktop']);
  other = await makeAccount(OTHER, ['other_laptop', 'other_desktop']);
  third = await makeAccount(THIRD, ['third_laptop']);
});

afterEach(() => {
  forgetAllProjectKeys();
});

const accounts = () => [owner, other, third];

const mirrored = (srv: Server, projectId: string) =>
  rows<{ user_id: string; role: string }>(
    srv,
    `SELECT user_id, role FROM project_members WHERE project_id = ?
     ORDER BY user_id`,
    projectId
  );

const wrapsOf = (srv: Server, projectId: string, userId: string) =>
  rows<{ n: number }>(
    srv,
    `SELECT COUNT(*) AS n FROM e2ee_project_keys
     WHERE project_id = ? AND user_id = ?`,
    projectId,
    userId
  )[0]!.n;

function consentRow(srv: Server, projectId: string, userId: string) {
  srv.db
    .prepare(
      `INSERT INTO e2ee_assistant_consents
         (user_id, project_id, allowed, copy_version, route, record,
          record_mac, sequence, updated_at)
       VALUES (?, ?, 1, 1, 'r', 'x', ?, 1, ?)`
    )
    .run(userId, projectId, 'A'.repeat(43), NOW);
}

const consentsOf = (srv: Server, projectId: string) =>
  rows<{ user_id: string }>(
    srv,
    `SELECT user_id FROM e2ee_assistant_consents WHERE project_id = ?
     ORDER BY user_id`,
    projectId
  ).map((row) => row.user_id);

const proposals = (srv: Server, projectId: string) =>
  rows<{
    key_epoch: number;
    sender_user_id: string | null;
    outcome: string | null;
    settled_key_epoch: number | null;
  }>(
    srv,
    `SELECT key_epoch, sender_user_id, outcome, settled_key_epoch
     FROM e2ee_mls_proposals WHERE project_id = ? ORDER BY created_at`,
    projectId
  );

/** Collects what a device's `onMembersRemoved` hears. */
function listen(d: Device): MembersRemoved[] {
  const heard: MembersRemoved[] = [];
  (
    d.groups as { onMembersRemoved?: (r: MembersRemoved) => void }
  ).onMembersRemoved = (removal) => heard.push(removal);
  return heard;
}

const dedupeHex = async (ctx: ProjectGroupContext, projectId: string) =>
  toHex((await dedupeSecretForProject(ctx, projectId)).secret);

const isCommitPost = (path: string, init: RequestInit) =>
  init.method === 'POST' && path.endsWith('/mls/commits');

async function apiRefusal(
  promise: Promise<unknown>,
  status: number,
  code: string
) {
  await expect(promise).rejects.toSatisfy(
    (error: unknown) =>
      error instanceof ProjectGroupApiError &&
      error.status === status &&
      error.code === code
  );
}

/**
 * OTHER an editor with both its devices in the group, THIRD a viewer: the
 * cast of the leaving cases.
 */
async function threeMembers(db?: DatabaseSync) {
  const shared = await sharedProject(accounts(), owner, other, 'editor', db);
  const { srv, laptop, projectId } = shared;
  const viewer = await addMember(
    srv,
    laptop,
    projectId,
    third,
    'viewer',
    'third_laptop',
    [owner, other]
  );
  // Its laptop posts its wraps of the epochs since, which the desktop's
  // rejoin needs.
  await catchUpProjectGroup(shared.member.groups, projectId);
  const otherDesktop = device(srv, other, 'other_desktop', {
    members: [owner, third]
  });
  await joinProjectGroup(otherDesktop.groups, projectId);
  await catchUpProjectGroup(laptop.groups, projectId);
  return { ...shared, viewer, otherDesktop };
}

/** The leaves the owner's session holds, by user. */
async function leavesByUser(d: Device, projectId: string) {
  const status = await d.sessions.status(ownerRef(projectId));
  const counts: Record<string, number> = {};
  for (const member of status.members) {
    counts[member.userId] = (counts[member.userId] ?? 0) + 1;
  }
  return counts;
}

describe('the owner removes a member (slice 5-5)', { timeout: 60_000 }, () => {
  it.each([2, 4])(
    'never reports removal success after two staggered SelfRemoves (round budget %s)',
    async (attempts) => {
      const { srv, laptop, member, otherDesktop, projectId } =
        await threeMembers();
      const before = serverKeyEpoch(srv, projectId);
      const depart = async (d: Device) => {
        await catchUpProjectGroup(d.groups, projectId);
        const { leaves } = await laptop.groups.api.leaves(projectId);
        const message = await d.sessions.proposeSelfRemove(
          { userId: OTHER, deviceId: d.deviceId!, projectId },
          {
            lists: accounts().map((a) => a.list),
            certifications: leaves.map((leaf) => ({
              userId: leaf.userId,
              deviceId: leaf.deviceId,
              leafKey: fromBase64Url(leaf.leafKey),
              certification: fromBase64Url(leaf.certification)
            }))
          }
        );
        await d.groups.api.propose!(projectId, {
          epoch: serverKeyEpoch(srv, projectId),
          deviceId: d.deviceId!,
          kind: 'self-remove',
          message: toBase64Url(message)
        });
      };
      await depart(member);
      let staggered = false;
      laptop.before = async (path, init) => {
        if (
          !staggered &&
          init.method === 'GET' &&
          path.endsWith('/mls/group-info') &&
          serverKeyEpoch(srv, projectId) === before + 1
        ) {
          staggered = true;
          // A hostile server restores access to stage a second still-valid
          // leaf's SelfRemove in the next epoch, before the owner's drop.
          memberRow(srv, projectId, OTHER, 'editor');
          await depart(otherDesktop);
        }
      };
      const removal = removeMember(
        { ...laptop.groups, attempts },
        projectId,
        OTHER
      );
      if (attempts === 2) {
        await expect(removal).rejects.toMatchObject({ code: 'epoch-lost' });
      } else {
        const state = await removal;
        expect(state.keyEpoch).toBe(before + 3);
        expect(
          (
            await epochRoles(laptop.groups, projectId, state.keyEpoch)
          ).users.some((u) => u.userId === OTHER)
        ).toBe(false);
        expect(mirrored(srv, projectId).some((m) => m.user_id === OTHER)).toBe(
          false
        );
      }
      expect(staggered).toBe(true);
    }
  );
  it('drops the identity, its row, wraps and consent in the Commit, replaces the dedupe secret, and shuts the member out of later keys and writes', async () => {
    const { srv, laptop, member, projectId } = await sharedProject(
      accounts(),
      owner,
      other,
      'editor'
    );
    const heard = listen(laptop);
    const opened = await member.store.loadProject(projectId);
    await member.store.saveProjectDocument({
      projectId,
      expectedVersion: opened.version,
      document: edited(opened, 'Before removal')
    });
    consentRow(srv, projectId, OTHER);
    consentRow(srv, projectId, OWNER);
    const oldKeys = await member.sessions.epochMaterial({
      userId: OTHER,
      deviceId: 'other_laptop',
      projectId
    });
    expect(wrapsOf(srv, projectId, OTHER)).toBeGreaterThan(0);
    const secretBefore = await dedupeHex(laptop.groups, projectId);

    const state = await removeMember(laptop.groups, projectId, OTHER);

    // The Worker mirrored it in the Commit's own batch.
    expect(mirrored(srv, projectId)).toEqual([]);
    expect(wrapsOf(srv, projectId, OTHER)).toBe(0);
    expect(wrapsOf(srv, projectId, OWNER)).toBeGreaterThan(0);
    expect(consentsOf(srv, projectId)).toEqual([OWNER]);
    expect(
      rows<{ event_type: string; previous_role: string }>(
        srv,
        `SELECT event_type, previous_role FROM project_access_events
         WHERE project_id = ? AND subject_user_id = ?
           AND event_type = 'member-removed'`,
        projectId,
        OTHER
      )
    ).toEqual([{ event_type: 'member-removed', previous_role: 'editor' }]);
    // The new epoch's roles no longer list the member, and no leaf of it
    // is left; the dedupe secret is a new one (decision M5).
    const roles = await epochRoles(laptop.groups, projectId, state.keyEpoch);
    expect(roles.users.map((u) => u.userId)).toEqual([OWNER]);
    expect(await leavesByUser(laptop, projectId)).toEqual({ [OWNER]: 1 });
    expect(await dedupeHex(laptop.groups, projectId)).not.toBe(secretBefore);
    // The reissue hook heard it (slice 5-10 offers new share links).
    expect(heard).toEqual([
      { projectId, keyEpoch: state.keyEpoch, userIds: [OTHER] }
    ]);

    // The removed member cannot read on, nor open the new epoch's keys.
    expect(await ownProjectRole(member.groups, projectId)).toBe(null);
    await expect(
      projectKeyForEpoch(member.groups, projectId, state.keyEpoch)
    ).rejects.toThrow();
    // Even served the Commits by a server that lies about its membership,
    // its own engine sees it was removed and holds no key of the new epoch.
    memberRow(srv, projectId, OTHER, 'editor');
    await expect(
      catchUpProjectGroup(member.groups, projectId)
    ).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof ProjectGroupError && error.code === 'no-session'
    );
    // Nor can it write: its browser cannot rejoin (the roles no longer
    // list it), and an honest Worker refuses what it forces.
    await expect(
      member.store.saveProjectDocument({
        projectId,
        expectedVersion: opened.version + 1,
        document: edited(edited(opened), 'After removal')
      })
    ).rejects.toThrow();
    srv.db
      .prepare(
        'DELETE FROM project_members WHERE project_id = ? AND user_id = ?'
      )
      .run(projectId, OTHER);
    await refusedWith(
      forgeVersion(srv, member, projectId, opened, oldKeys),
      404,
      'PROJECT_NOT_FOUND'
    );
    expect(head(srv, projectId).signer_user_id).toBe(OTHER);
    // The owner writes on in the new epoch.
    const read = await laptop.store.loadProject(projectId);
    await laptop.store.saveProjectDocument({
      projectId,
      expectedVersion: read.version,
      document: edited(read, 'After removal')
    });
    expect(head(srv, projectId)).toMatchObject({
      signer_user_id: OWNER,
      key_epoch: state.keyEpoch
    });
  });

  it('commits a departure of the member first, then drops it', async () => {
    const { srv, laptop, member, projectId } = await sharedProject(
      accounts(),
      owner,
      other,
      'editor'
    );
    // The member's proposal is stored (and its access dropped)...
    await leaveProject(member.groups, projectId);
    // ...and the owner's removal commits it before the drop: mls-rs refuses
    // one Commit removing a leaf both ways.
    const before = serverKeyEpoch(srv, projectId);
    const state = await removeMember(laptop.groups, projectId, OTHER);
    expect(state.keyEpoch).toBe(before + 2);
    expect(proposals(srv, projectId)).toEqual([
      {
        key_epoch: before,
        sender_user_id: OTHER,
        outcome: 'committed',
        settled_key_epoch: before + 1
      }
    ]);
    const roles = await epochRoles(laptop.groups, projectId, state.keyEpoch);
    expect(roles.users.map((u) => u.userId)).toEqual([OWNER]);
  });

  it('refuses a removal from anyone but the owner, and the owner’s own', async () => {
    const { srv, laptop, member, projectId } = await sharedProject(
      accounts(),
      owner,
      other,
      'editor'
    );
    for (const promise of [
      removeMember(member.groups, projectId, OWNER),
      removeMember(laptop.groups, projectId, OWNER)
    ]) {
      await expect(promise).rejects.toSatisfy(
        (error: unknown) =>
          error instanceof ProjectGroupError &&
          error.code === 'membership-refused'
      );
    }
    // A drop the member states is refused by the Worker as well.
    member.before = async (path, init) => {
      if (!isCommitPost(path, init)) return;
      const body = JSON.parse(init.body as string) as Record<string, unknown>;
      body.dropUsers = [OWNER];
      init.body = JSON.stringify(body);
    };
    await apiRefusal(
      commitProjectGroup(member.groups, projectId),
      403,
      'E2EE_PROJECT_OWNER_ONLY'
    );
    member.before = undefined;
    expect(mirrored(srv, projectId)).toEqual([
      { user_id: OTHER, role: 'editor' }
    ]);
  });
});

describe('a member leaves (slice 5-5)', { timeout: 60_000 }, () => {
  it('loses access at the proposal; a viewer commits the departure with a new dedupe secret; the owner then drops the identity', async () => {
    const { srv, laptop, member, viewer, projectId } = await threeMembers();
    consentRow(srv, projectId, OTHER);
    const heardByViewer = listen(viewer);
    const heardByOwner = listen(laptop);
    expect(await leavesByUser(laptop, projectId)).toMatchObject({ [OTHER]: 2 });

    await leaveProject(member.groups, projectId);

    // Decision M4: its access went with the stored proposal.
    const proposedAt = serverKeyEpoch(srv, projectId);
    expect(mirrored(srv, projectId)).toEqual([
      { user_id: THIRD, role: 'viewer' }
    ]);
    expect(wrapsOf(srv, projectId, OTHER)).toBe(0);
    expect(consentsOf(srv, projectId)).toEqual([]);
    expect(proposals(srv, projectId)).toEqual([
      {
        key_epoch: proposedAt,
        sender_user_id: OTHER,
        outcome: null,
        settled_key_epoch: null
      }
    ]);
    expect(
      JSON.parse(
        rows<{ metadata_json: string }>(
          srv,
          `SELECT metadata_json FROM project_access_events
           WHERE project_id = ? AND subject_user_id = ?
             AND event_type = 'member-removed'`,
          projectId,
          OTHER
        )[0]!.metadata_json
      )
    ).toMatchObject({ left: true });
    expect(
      (
        await srv.call(
          'GET',
          `/api/e2ee/projects/${projectId}/mls/group-info`,
          {
            user: OTHER
          }
        )
      ).status
    ).toBe(404);
    expect(await ownProjectRole(member.groups, projectId)).toBe(null);
    // Its other device's leaf went first, by its own Commit.
    await catchUpProjectGroup(laptop.groups, projectId);
    expect(await leavesByUser(laptop, projectId)).toMatchObject({ [OTHER]: 1 });

    // The viewer commits the departure (reading its role does).
    const secretBefore = await dedupeHex(viewer.groups, projectId);
    expect(await ownProjectRole(viewer.groups, projectId)).toBe('viewer');
    expect(serverKeyEpoch(srv, projectId)).toBe(proposedAt + 1);
    expect(proposals(srv, projectId)[0]).toMatchObject({
      outcome: 'committed',
      settled_key_epoch: proposedAt + 1
    });
    expect(await dedupeHex(viewer.groups, projectId)).not.toBe(secretBefore);
    expect(heardByViewer).toEqual([
      { projectId, keyEpoch: proposedAt + 1, userIds: [OTHER] }
    ]);

    // The owner's next write drops the identity the departure left listed.
    await catchUpProjectGroup(laptop.groups, projectId);
    expect(heardByOwner).toEqual([
      { projectId, keyEpoch: proposedAt + 1, userIds: [OTHER] }
    ]);
    expect(
      (await epochRoles(laptop.groups, projectId, proposedAt + 1)).users.map(
        (u) => u.userId
      )
    ).toContain(OTHER);
    const read = await laptop.store.loadProject(projectId);
    await laptop.store.saveProjectDocument({
      projectId,
      expectedVersion: read.version,
      document: edited(read, 'After the departure')
    });
    const now = serverKeyEpoch(srv, projectId);
    expect(now).toBe(proposedAt + 2);
    expect(
      (await epochRoles(laptop.groups, projectId, now)).users.map(
        (u) => u.userId
      )
    ).toEqual([OWNER, THIRD]);
    expect(head(srv, projectId)).toMatchObject({
      signer_user_id: OWNER,
      key_epoch: now
    });
  });

  it('has writers commit a pending departure before their next write', async () => {
    const { srv, laptop, member, viewer, projectId } = await threeMembers();
    await changeMemberRole(laptop.groups, projectId, THIRD, 'editor');
    await leaveProject(member.groups, projectId);
    const proposedAt = serverKeyEpoch(srv, projectId);
    const read = await viewer.store.loadProject(projectId);
    await viewer.store.saveProjectDocument({
      projectId,
      expectedVersion: read.version,
      document: edited(read, 'Third writes')
    });
    expect(proposals(srv, projectId)[0]).toMatchObject({
      outcome: 'committed',
      settled_key_epoch: proposedAt + 1
    });
    expect(head(srv, projectId)).toMatchObject({
      signer_user_id: THIRD,
      key_epoch: proposedAt + 1
    });
  });

  it('refuses the owner’s leaving, a Commit that leaves a departure out and a rejoin while one is pending, and does not let a bad proposal hold the group', async () => {
    const { srv, laptop, member, projectId } = await threeMembers();
    await expect(leaveProject(laptop.groups, projectId)).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof ProjectGroupError &&
        error.code === 'membership-refused'
    );
    // Hold back the member's proposal to replay it.
    let held: Record<string, unknown> | null = null;
    member.before = async (path, init) => {
      if (init.method === 'POST' && path.endsWith('/mls/proposals')) {
        held = JSON.parse(init.body as string) as Record<string, unknown>;
        throw new Error('held back');
      }
    };
    await expect(leaveProject(member.groups, projectId)).rejects.toThrow(
      'held back'
    );
    member.before = undefined;
    const proposal = held! as { message: string; epoch: number };
    const post = (user: string, deviceId: string, message = proposal.message) =>
      srv.call('POST', `/api/e2ee/projects/${projectId}/mls/proposals`, {
        user,
        body: { epoch: proposal.epoch, deviceId, kind: 'self-remove', message }
      });
    // The owner cannot leave, by any message.
    const asOwner = await post(OWNER, 'owner_laptop');
    expect(asOwner.status).toBe(409);
    expect(await asOwner.json()).toMatchObject({
      code: 'E2EE_OWNER_CANNOT_LEAVE'
    });
    // Anything but a member's SelfRemove of this group is refused.
    const garbage = await post(OTHER, 'other_laptop', 'AAAAAAAAAAAA');
    expect(garbage.status).toBe(400);
    expect(proposals(srv, projectId)).toEqual([]);

    // Stored, with a forged signature beside it (a member's bad proposal).
    expect((await post(OTHER, 'other_laptop')).status).toBe(201);
    const keyEpoch = serverKeyEpoch(srv, projectId);
    const tampered = Buffer.from(proposal.message, 'base64url');
    tampered.writeUInt8(
      tampered.readUInt8(tampered.length - 1) ^ 0xff,
      tampered.length - 1
    );
    const tamperedText = tampered.toString('base64url');
    srv.db
      .prepare(
        `INSERT INTO e2ee_mls_proposals
           (project_id, key_epoch, proposal_hash, kind, sender_user_id,
            sender_device_id, message, created_at)
         VALUES (?, ?, ?, 'self-remove', ?, 'third_laptop', ?, ?)`
      )
      .run(
        projectId,
        keyEpoch,
        toHex(
          new Uint8Array(
            await crypto.subtle.digest('SHA-256', new Uint8Array(tampered))
          )
        ),
        THIRD,
        tamperedText,
        NOW
      );

    // A Commit that leaves them out is refused.
    laptop.before = async (path, init) => {
      if (!isCommitPost(path, init)) return;
      const body = JSON.parse(init.body as string) as Record<string, unknown>;
      delete body.proposals;
      delete body.rejectedProposals;
      init.body = JSON.stringify(body);
    };
    await apiRefusal(
      commitProjectGroup(laptop.groups, projectId),
      409,
      'E2EE_PROPOSALS_PENDING'
    );
    laptop.before = undefined;
    // A rejoin, which cannot carry them, is refused until they are settled.
    const desktop = device(srv, owner, 'owner_desktop', {
      members: [other, third]
    });
    await apiRefusal(
      joinProjectGroup(desktop.groups, projectId),
      409,
      'E2EE_DEPARTURE_PENDING'
    );
    expect(serverKeyEpoch(srv, projectId)).toBe(keyEpoch);

    // The owner's next Commit applies the real one and rejects the bad one.
    await commitPendingDepartures(laptop.groups, projectId);
    expect(
      rows<{ sender_user_id: string; outcome: string }>(
        srv,
        `SELECT sender_user_id, outcome FROM e2ee_mls_proposals
         WHERE project_id = ? ORDER BY sender_user_id`,
        projectId
      )
    ).toEqual([
      { sender_user_id: OTHER, outcome: 'committed' },
      { sender_user_id: THIRD, outcome: 'rejected' }
    ]);
    expect(await leavesByUser(laptop, projectId)).toMatchObject({
      [THIRD]: 1
    });
    expect((await leavesByUser(laptop, projectId))[OTHER]).toBeUndefined();
    // Now the rejoin goes through.
    await joinProjectGroup(desktop.groups, projectId);
  });
});

describe('storage of proposals (migration 0039)', { timeout: 60_000 }, () => {
  /** Every migration but 0039, as a database not yet updated holds them. */
  function withoutProposals(): DatabaseSync {
    const dir = new URL('../apps/web/migrations/', import.meta.url);
    const db = new DatabaseSync(':memory:');
    for (const file of readdirSync(dir)
      .filter((name) => name.endsWith('.sql') && !name.startsWith('0039_'))
      .sort()) {
      db.exec(readFileSync(new URL(file, dir), 'utf8'));
    }
    return db;
  }

  it('keeps removals, role changes and writes working without it; only leaving waits for it', async () => {
    const db = withoutProposals();
    expect(await isE2eeMlsProposalStorageReady(sqliteD1(db))).toBe(false);
    const { srv, laptop, member, viewer, projectId } = await threeMembers(db);
    const listed = await srv.call(
      'GET',
      `/api/e2ee/projects/${projectId}/mls/proposals`,
      { user: THIRD }
    );
    expect(await listed.json()).toMatchObject({
      available: false,
      proposals: [],
      departed: []
    });
    await apiRefusal(
      leaveProject(member.groups, projectId),
      503,
      'E2EE_UNAVAILABLE'
    );
    expect(mirrored(srv, projectId)).toHaveLength(2);
    await changeMemberRole(laptop.groups, projectId, THIRD, 'editor');
    const read = await viewer.store.loadProject(projectId);
    await viewer.store.saveProjectDocument({
      projectId,
      expectedVersion: read.version,
      document: edited(read, 'Third writes')
    });
    const state = await removeMember(laptop.groups, projectId, OTHER);
    expect(mirrored(srv, projectId)).toEqual([
      { user_id: THIRD, role: 'editor' }
    ]);
    expect(wrapsOf(srv, projectId, OTHER)).toBe(0);
    expect(head(srv, projectId).signer_user_id).toBe(THIRD);
    expect(
      (await epochRoles(laptop.groups, projectId, state.keyEpoch)).users.map(
        (u) => u.userId
      )
    ).toEqual([OWNER, THIRD]);
    expect(
      await proposalErasureStatements(srv.env.DB as D1Database, OTHER, 'all')
    ).toEqual([]);
    expect((await srv.call('POST', '/api/projects/purge')).status).toBe(200);
  });

  it('clears a sender on account erasure and goes with the project', async () => {
    const { srv, member, projectId } = await sharedProject(
      accounts(),
      owner,
      other,
      'editor'
    );
    await leaveProject(member.groups, projectId);
    const db = srv.env.DB as D1Database;
    expect(await proposalErasureStatements(db, OTHER, 'profile')).toEqual([]);
    await db.batch(await proposalErasureStatements(db, OTHER, 'all'));
    expect(proposals(srv, projectId)).toEqual([
      expect.objectContaining({ sender_user_id: null, outcome: null })
    ]);
    // Deleting the owner's projects purges the project's proposals.
    expect(
      (
        await srv.call('POST', '/api/account/delete-data', {
          user: OWNER,
          body: { scope: 'projects', confirmation: 'DELETE CLOUD PROJECTS' }
        })
      ).status
    ).toBe(200);
    expect(proposals(srv, projectId)).toEqual([]);
  });
});
