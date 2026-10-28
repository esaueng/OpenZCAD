/**
 * Role changes in end-to-end encrypted projects (ADR-024 Phase 5, slice
 * 5-4; roadmap L11): Node devices of three accounts run the real client
 * modules (`projectGroups.ts`, `memberships.ts`, `encryptedProjectStore.ts`)
 * with the in-process MLS engine against the real Worker over SQLite.
 * Members are seeded through MLS as in the slice 5-2 tests
 * (`support/e2ee-members.ts`).
 */
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { sqliteD1 } from './support/sqlite-d1';
import { ownProjectRole } from '../apps/web/src/lib/e2ee/memberships';
import {
  ProjectGroupError,
  catchUpProjectGroup,
  changeMemberRole,
  commitProjectGroup
} from '../apps/web/src/lib/e2ee/projectGroups';
import { ProjectGroupApiError } from '../apps/web/src/lib/e2ee/projectGroups';
import { forgetAllProjectKeys } from '../apps/web/src/lib/e2ee/unlockedProjectKeys';
import {
  OTHER,
  OWNER,
  createEncrypted,
  newServer,
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
  integrityRefusal,
  memberRow,
  ownerRef,
  refusedWith,
  serverKeyEpoch,
  sharedProject
} from './support/e2ee-members';

const THIRD = 'user_third';

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

const isCommitPost = (path: string, init: RequestInit) =>
  init.method === 'POST' && path.endsWith('/mls/commits');

/** Rewrites the body of every Commit `d` sends. */
function rewriteCommits(
  d: Device,
  rewrite: (body: Record<string, unknown>) => void
) {
  d.before = async (path, init) => {
    if (!isCommitPost(path, init)) return;
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    rewrite(body);
    init.body = JSON.stringify(body);
  };
}

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

async function membershipRefusal(promise: Promise<unknown>) {
  await expect(promise).rejects.toSatisfy(
    (error: unknown) =>
      error instanceof ProjectGroupError && error.code === 'membership-refused'
  );
}

// Several MLS Commits and fresh browsers per case.
describe('role changes (slice 5-4)', { timeout: 30_000 }, () => {
  it.each([false, true])(
    'handles 16 role changes plus 16 drops within D1 binds, preserving a stale-member fence (%s)',
    async (race) => {
      const members = await Promise.all(
        Array.from({ length: 32 }, (_, i) =>
          makeAccount(`user_bind_${String(i).padStart(2, '0')}`, [
            `bind_device_${i}`
          ])
        )
      );
      const srv = newServer([owner, ...members]);
      const laptop = device(srv, owner, 'owner_laptop', { members });
      const {
        document: { projectId }
      } = await createEncrypted(laptop);
      for (const member of members)
        memberRow(srv, projectId, member.userId, 'editor');
      for (const batch of [members.slice(0, 16), members.slice(16)]) {
        await commitProjectGroup(laptop.groups, projectId, {
          setRoles: batch.map((m) => ({ userId: m.userId, role: 'editor' }))
        });
      }
      if (race) {
        let moved = false;
        srv.env.DB = sqliteD1(srv.db, {
          onStatement(sql) {
            if (!moved && /^\s*INSERT INTO e2ee_mls_commits/.test(sql)) {
              moved = true;
              srv.db
                .prepare(
                  'UPDATE project_members SET role = ? WHERE project_id = ? AND user_id = ?'
                )
                .run('viewer', projectId, members[0]!.userId);
            }
          }
        });
      }
      const work = commitProjectGroup(laptop.groups, projectId, {
        setRoles: members
          .slice(0, 16)
          .map((m) => ({ userId: m.userId, role: 'viewer' })),
        dropUsers: members.slice(16).map((m) => m.userId)
      });
      if (race) {
        await expect(work).rejects.toBeInstanceOf(ProjectGroupApiError);
        expect(serverKeyEpoch(srv, projectId)).toBe(2);
        expect(mirrored(srv, projectId)).toHaveLength(32);
      } else {
        expect((await work).keyEpoch).toBe(3);
        expect(mirrored(srv, projectId)).toEqual(
          members
            .slice(0, 16)
            .map((m) => ({ user_id: m.userId, role: 'viewer' }))
        );
      }
    }
  );
  it('demotes an editor: the mirror moves with the Commit, its earlier versions verify, and its browser and the Worker refuse its next write', async () => {
    const { srv, laptop, member, projectId } = await sharedProject(
      accounts(),
      owner,
      other,
      'editor'
    );
    const opened = await member.store.loadProject(projectId);
    await member.store.saveProjectDocument({
      projectId,
      expectedVersion: opened.version,
      document: edited(opened, 'Editor edit')
    });
    const written = head(srv, projectId);
    expect(written.signer_user_id).toBe(OTHER);
    expect(await ownProjectRole(member.groups, projectId)).toBe('editor');

    const before = serverKeyEpoch(srv, projectId);
    const state = await changeMemberRole(
      laptop.groups,
      projectId,
      OTHER,
      'viewer'
    );
    expect(state.keyEpoch).toBe(before + 1);
    // The Worker mirrored the role in the Commit's own batch, with an event.
    expect(mirrored(srv, projectId)).toEqual([
      { user_id: OTHER, role: 'viewer' }
    ]);
    expect(
      rows<{ event_type: string; previous_role: string; next_role: string }>(
        srv,
        `SELECT event_type, previous_role, next_role FROM project_access_events
         WHERE project_id = ? AND event_type = 'member-role-changed'
           AND next_role = 'viewer'`,
        projectId
      )
    ).toEqual([
      {
        event_type: 'member-role-changed',
        previous_role: 'editor',
        next_role: 'viewer'
      }
    ]);
    // Asking again changes nothing: the role already holds.
    await changeMemberRole(laptop.groups, projectId, OTHER, 'viewer');
    expect(serverKeyEpoch(srv, projectId)).toBe(before + 1);
    // The member's browser reads its new role from the MLS roles.
    expect(await ownProjectRole(member.groups, projectId)).toBe('viewer');

    // A fresh owner browser still verifies the editor's earlier version,
    // by the roles of its own epoch.
    const read = await device(srv, owner, 'owner_desktop', {
      members: [other, third]
    }).store.loadProject(projectId);
    expect(read.name).toBe('Editor edit');

    // The demoted member's browser does not send its next write.
    const sent: string[] = [];
    member.before = async (path, init) => {
      if (init.method === 'PUT') sent.push(path);
    };
    await refusedWith(
      member.store.saveProjectDocument({
        projectId,
        expectedVersion: read.version,
        document: edited(read, 'After demotion')
      }),
      403,
      'E2EE_PROJECT_READ_ONLY'
    );
    expect(sent).toEqual([]);
    member.before = undefined;

    // One forced past its browser (keys of the new epoch, leaked) is
    // refused by the Worker, which mirrors the member as a viewer.
    const keys = await laptop.sessions.epochMaterial(ownerRef(projectId));
    await refusedWith(
      forgeVersion(srv, member, projectId, read, keys),
      403,
      'E2EE_PROJECT_READ_ONLY'
    );
    expect(head(srv, projectId).document_version).toBe(
      written.document_version
    );
    // A server that kept the editor row lets it in; every browser refuses
    // it, since the roles of its epoch list the author as a viewer.
    memberRow(srv, projectId, OTHER, 'editor');
    await forgeVersion(srv, member, projectId, read, keys);
    forgetAllProjectKeys();
    await integrityRefusal(
      device(srv, owner, 'owner_desktop', {
        members: [other, third]
      }).store.loadProject(projectId),
      'authority'
    );
  });

  it('refuses a role change from anyone but the owner, and one a Commit does not state', async () => {
    const { srv, laptop, member, projectId } = await sharedProject(
      accounts(),
      owner,
      other,
      'editor'
    );
    await addMember(srv, laptop, projectId, third, 'viewer', 'third_laptop', [
      owner,
      other
    ]);
    const epoch = serverKeyEpoch(srv, projectId);

    // The editor's own browser refuses to build it, and so does its MLS
    // policy for a client that skips that check.
    await membershipRefusal(
      changeMemberRole(member.groups, projectId, THIRD, 'editor')
    );
    await expect(
      commitProjectGroup(member.groups, projectId, {
        setRoles: [{ userId: THIRD, role: 'editor' }]
      })
    ).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof Error &&
        (error as { reasons?: { code: string }[] }).reasons?.some(
          (reason) => reason.code === 'role-forbidden'
        ) === true
    );
    // The Worker refuses a role change a member states.
    rewriteCommits(member, (body) => {
      body.roles = [{ userId: THIRD, role: 'editor' }];
    });
    await apiRefusal(
      commitProjectGroup(member.groups, projectId),
      403,
      'E2EE_PROJECT_OWNER_ONLY'
    );
    member.before = undefined;

    // The owner's role change, sent without stating it, is refused...
    rewriteCommits(laptop, (body) => {
      delete body.roles;
    });
    await apiRefusal(
      changeMemberRole(laptop.groups, projectId, THIRD, 'editor'),
      409,
      'E2EE_ROLES_MISMATCH'
    );
    // ...and so is a stated change the Commit does not make.
    rewriteCommits(laptop, (body) => {
      body.roles = [{ userId: OTHER, role: 'viewer' }];
    });
    await apiRefusal(
      commitProjectGroup(laptop.groups, projectId),
      409,
      'E2EE_ROLES_MISMATCH'
    );
    laptop.before = undefined;
    expect(serverKeyEpoch(srv, projectId)).toBe(epoch);
    expect(mirrored(srv, projectId)).toEqual([
      { user_id: OTHER, role: 'editor' },
      { user_id: THIRD, role: 'viewer' }
    ]);

    // Nothing of that is resent: the next honest change lands, and every
    // member follows it.
    await changeMemberRole(laptop.groups, projectId, THIRD, 'editor');
    expect(mirrored(srv, projectId)).toEqual([
      { user_id: OTHER, role: 'editor' },
      { user_id: THIRD, role: 'editor' }
    ]);
    await catchUpProjectGroup(member.groups, projectId);
    expect(await ownProjectRole(member.groups, projectId)).toBe('editor');
  });

  it('refuses an ownership transfer', async () => {
    const { srv, laptop, projectId } = await sharedProject(
      accounts(),
      owner,
      other,
      'editor'
    );
    const epoch = serverKeyEpoch(srv, projectId);
    await membershipRefusal(
      changeMemberRole(laptop.groups, projectId, OTHER, 'owner' as never)
    );
    await membershipRefusal(
      changeMemberRole(laptop.groups, projectId, OWNER, 'viewer')
    );
    // The MLS policy lets an owner hand the role over; the Worker does not,
    // whether the Commit states it or not.
    const transfer = {
      setRoles: [
        { userId: OTHER, role: 'owner' as const },
        { userId: OWNER, role: 'editor' as const }
      ]
    };
    await apiRefusal(
      commitProjectGroup(laptop.groups, projectId, transfer),
      409,
      'E2EE_OWNERSHIP_TRANSFER_UNAVAILABLE'
    );
    rewriteCommits(laptop, (body) => {
      delete body.roles;
    });
    await apiRefusal(
      commitProjectGroup(laptop.groups, projectId, transfer),
      409,
      'E2EE_OWNERSHIP_TRANSFER_UNAVAILABLE'
    );
    laptop.before = undefined;
    expect(serverKeyEpoch(srv, projectId)).toBe(epoch);
    expect(await ownProjectRole(laptop.groups, projectId)).toBe('owner');
  });

  it('reads this account’s role from the MLS roles, never the server’s mirror', async () => {
    const { srv, member, projectId } = await sharedProject(
      accounts(),
      owner,
      other,
      'viewer'
    );
    memberRow(srv, projectId, OTHER, 'editor');
    expect(await ownProjectRole(member.groups, projectId)).toBe('viewer');
    // A device without a leaf (decision D4) reads it from the key archive.
    const reader = device(srv, other, null, { members: [owner, third] });
    expect(await ownProjectRole(reader.groups, projectId)).toBe('viewer');
  });

  it('discards a role change a crash left pending instead of resending it bare', async () => {
    const { srv, laptop, projectId } = await sharedProject(
      accounts(),
      owner,
      other,
      'editor'
    );
    const epoch = serverKeyEpoch(srv, projectId);
    laptop.before = async (path, init) => {
      if (isCommitPost(path, init)) throw new TypeError('connection reset');
    };
    await expect(
      changeMemberRole(laptop.groups, projectId, OTHER, 'viewer')
    ).rejects.toThrow('connection reset');
    laptop.before = undefined;
    expect(await laptop.sessions.pendingCommit(ownerRef(projectId))).not.toBe(
      null
    );
    // The next catch-up drops it: resent without its statement, the Worker
    // would refuse it, and the device would be stuck behind it.
    await catchUpProjectGroup(laptop.groups, projectId);
    expect(await laptop.sessions.pendingCommit(ownerRef(projectId))).toBe(null);
    expect(serverKeyEpoch(srv, projectId)).toBe(epoch);
    expect(mirrored(srv, projectId)).toEqual([
      { user_id: OTHER, role: 'editor' }
    ]);
    await changeMemberRole(laptop.groups, projectId, OTHER, 'viewer');
    expect(mirrored(srv, projectId)).toEqual([
      { user_id: OTHER, role: 'viewer' }
    ]);
  });
});
