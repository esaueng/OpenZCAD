/**
 * Invitations to end-to-end encrypted projects, KeyPackages and Welcomes
 * (ADR-024 Phase 5, slice 5-3a; roadmap L11; migration 0038), over the real
 * Worker and SQLite. The owner's device signs real invitation statements;
 * its MLS engine (in process) builds the Commits the Add form rides on. The
 * Worker does not read MLS messages, so the KeyPackage bytes and leaves an
 * invitee publishes here are shaped like the real ones without being them:
 * the browser half (slice 5-3b) brings real ones.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  invitationEmailHash,
  publicKeyHash,
  signProjectInvitation,
  toBase64Url,
  toHex,
  type ProjectInvitation
} from '@openzcad/crypto';
import {
  D1R2PersistenceService,
  isE2eeInvitationStorageReady
} from '@openzcad/cloudflare-adapters';
import {
  createProjectDocument,
  withoutDerivedProjection
} from '@openzcad/document-core';
import { createE2eeInvitationsApi } from '@openzcad/shared';
import { handleE2eeRequest } from '../apps/web/worker/e2ee';
import {
  invitationErasureStatements,
  type E2eeInvitationHost
} from '../apps/web/worker/e2eeInvitations';
import {
  admitDevelopmentE2eeWrite,
  releaseDevelopmentE2eeWrite
} from '../apps/web/worker/e2eeWriteAuthorization';
import { hashProjectInvitationToken } from '../apps/web/worker/sharing';
import type { CommitRequest } from '@openzcad/mls';
import { commitProjectGroup } from '../apps/web/src/lib/e2ee/projectGroups';
import { forgetAllProjectKeys } from '../apps/web/src/lib/e2ee/unlockedProjectKeys';
import {
  OTHER,
  OWNER,
  createEncrypted,
  databaseBefore,
  device,
  makeAccount,
  newServer,
  rows,
  type Account,
  type Device,
  type Server
} from './support/e2ee-documents';
import { sqliteD1 } from './support/sqlite-d1';

const THIRD = 'user_third';
const INVITEE_EMAIL = 'invitee@example.com';
const THIRD_EMAIL = 'third@example.com';
const DAY = 86_400_000;

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
  vi.useRealTimers();
});

interface Mailbox {
  sent: { to: string; subject: string; text: string; html: string }[];
}

function server(
  db?: ReturnType<typeof databaseBefore>,
  extraEnv: Record<string, unknown> = {}
) {
  const mailbox: Mailbox = { sent: [] };
  const srv = newServer([owner, other, third], db, {
    EMAIL: {
      send: vi.fn(async (message: Mailbox['sent'][number]) => {
        mailbox.sent.push(message);
      })
    },
    PROJECT_INVITATION_EMAIL_FROM: 'invites@example.test',
    PUBLIC_APP_ORIGIN: 'https://openzcad.example/',
    PROJECT_EDIT_LEASES_ENFORCED: 'true',
    ...extraEnv
  });
  return { srv, mailbox };
}

async function json<T = Record<string, unknown>>(response: Response) {
  return (await response.json()) as T;
}

/** An encrypted project of the owner, named so its name is recognisable. */
async function encryptedProject(srv: Server) {
  const laptop = device(srv, owner, 'owner_laptop', { members: [other] });
  const { document } = await createEncrypted(laptop);
  srv.db
    .prepare('UPDATE projects SET name = ? WHERE id = ?')
    .run('Secret bracket', document.projectId);
  return { laptop, projectId: document.projectId };
}

async function statement(
  projectId: string,
  overrides: Partial<ProjectInvitation> = {},
  signerId = 'owner_laptop',
  signingAccount: Account = owner
) {
  const signer = signingAccount.devices.get(signerId)!;
  const now = Date.now();
  const value: ProjectInvitation = {
    projectId,
    invitationId: `inv_${crypto.randomUUID()}`,
    inviterUserId: OWNER,
    inviteeEmailHash: await invitationEmailHash(INVITEE_EMAIL),
    role: 'editor',
    issuedAt: now,
    expiresAt: now + 3 * DAY,
    signerDeviceId: signerId,
    signerKeyHash: await publicKeyHash(
      signingAccount.list.head.devices.find((d) => d.deviceId === signerId)!
        .signingKey
    ),
    ...overrides
  };
  const signed = await signProjectInvitation(signer.signing.privateKey, value);
  return {
    value,
    body: {
      email: INVITEE_EMAIL,
      statement: toBase64Url(signed.statement),
      signature: toBase64Url(signed.signature)
    }
  };
}

const invitationsPath = (projectId: string) =>
  `/api/e2ee/projects/${projectId}/invitations`;

async function invite(
  srv: Server,
  projectId: string,
  overrides: Partial<ProjectInvitation> = {}
) {
  const { value, body } = await statement(projectId, overrides);
  const response = await srv.call('POST', invitationsPath(projectId), { body });
  return { value, response };
}

function tokenOf(mailbox: Mailbox): string {
  const text = mailbox.sent.at(-1)!.text;
  const match = /#encrypted-invite=([A-Za-z0-9_-]+)/.exec(text);
  if (!match) throw new Error(`No encrypted invitation link in: ${text}`);
  return match[1]!;
}

/**
 * A request as an email-bearing session would make it: the Worker index
 * hands `handleE2eeRequest` the session's email through the invitation
 * host; development auth has none, so this calls the handler with one.
 */
async function asSession(
  srv: Server,
  user: string,
  email: string | null,
  method: string,
  path: string,
  body?: unknown
): Promise<Response> {
  const session = { userId: user };
  const db = srv.env.DB as D1Database;
  await admitDevelopmentE2eeWrite(db, session);
  const host: E2eeInvitationHost = {
    email,
    inviterLabel: email ?? user,
    sharingEnabled: true,
    emailConfigured: true,
    sendInvitationEmail: async () => undefined
  };
  try {
    return await handleE2eeRequest(
      new Request(`https://example.com${path}`, {
        method,
        headers: { 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) })
      }),
      srv.env,
      session,
      true,
      true,
      host
    );
  } finally {
    await releaseDevelopmentE2eeWrite(session);
  }
}

const accept = (
  srv: Server,
  token: string,
  user = OTHER,
  email = INVITEE_EMAIL
) =>
  asSession(srv, user, email, 'POST', '/api/e2ee/invitations/accept', {
    token
  });

/** Shaped like a P-256 leaf key and a version-2 certification. */
function leaf(seed: number) {
  const key = new Uint8Array(65).fill(seed);
  key[0] = 0x04;
  const certification = new Uint8Array(73).fill(seed);
  certification[0] = 2;
  return {
    leafKey: toBase64Url(key),
    certification: toBase64Url(certification)
  };
}

function keyPackageBytes(seed: number) {
  return Uint8Array.from({ length: 300 }, (_, i) => (i * 7 + seed) % 256);
}

async function hashHex(bytes: Uint8Array) {
  return toHex(
    new Uint8Array(
      await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>)
    )
  );
}

function publish(
  srv: Server,
  projectId: string,
  invitationId: string,
  deviceId: string,
  seed: number,
  user = OTHER
) {
  return srv.call('POST', `/api/e2ee/projects/${projectId}/key-packages`, {
    user,
    body: {
      invitationId,
      deviceId,
      keyPackage: toBase64Url(keyPackageBytes(seed)),
      leaf: leaf(seed)
    }
  });
}

const claim = (
  srv: Server,
  projectId: string,
  invitationId: string,
  user = OWNER
) =>
  srv.call('POST', `/api/e2ee/projects/${projectId}/key-packages/claim`, {
    user,
    body: { invitationId }
  });

/**
 * A real Commit body from the owner's device (its MLS message, GroupInfo,
 * wraps and key archive for the next epoch), held back before it reaches
 * the Worker so a test can send it with or without an Add.
 */
async function heldCommit(
  d: Device,
  projectId: string,
  /** A setRoles Commit stands in for an Add's; `{}` is an ordinary one. */
  request: CommitRequest = { setRoles: [{ userId: OTHER, role: 'editor' }] }
): Promise<Record<string, unknown>> {
  let held: Record<string, unknown> | null = null;
  d.before = async (path, init) => {
    if (init.method === 'POST' && path.endsWith('/mls/commits')) {
      held = JSON.parse(init.body as string) as Record<string, unknown>;
      throw new Error('held back');
    }
  };
  await commitProjectGroup(d.groups, projectId, request).catch(() => undefined);
  d.before = undefined;
  if (!held) throw new Error('No Commit was sent');
  // An Add states its invitee through `add`, not as a role change of a
  // member (slice 5-4).
  delete (held as Record<string, unknown>).roles;
  return held;
}

const commit = (
  srv: Server,
  projectId: string,
  body: Record<string, unknown>,
  user = OWNER
) =>
  srv.call('POST', `/api/e2ee/projects/${projectId}/mls/commits`, {
    user,
    body
  });

const groupEpoch = (srv: Server, projectId: string) =>
  rows<{ epoch: number }>(
    srv,
    'SELECT epoch FROM e2ee_project_groups WHERE project_id = ?',
    projectId
  )[0]!.epoch;

/** Invited, accepted, two devices published and claimed: ready to Add. */
async function readyToAdd() {
  const { srv, mailbox } = server();
  const { laptop, projectId } = await encryptedProject(srv);
  const { value, response } = await invite(srv, projectId);
  expect(response.status).toBe(201);
  expect((await accept(srv, tokenOf(mailbox))).status).toBe(200);
  for (const [deviceId, seed] of [
    ['other_laptop', 1],
    ['other_desktop', 2]
  ] as const) {
    expect(
      (await publish(srv, projectId, value.invitationId, deviceId, seed)).status
    ).toBe(201);
  }
  const claimed = await json<{
    keyPackages: { userId: string; deviceId: string; keyPackageHash: string }[];
  }>(await claim(srv, projectId, value.invitationId));
  const add = {
    invitationId: value.invitationId,
    keyPackages: claimed.keyPackages.map(
      ({ userId, deviceId, keyPackageHash }) => ({
        userId,
        deviceId,
        keyPackageHash
      })
    ),
    welcome: toBase64Url(new Uint8Array(500).fill(9))
  };
  return { srv, mailbox, laptop, projectId, invitation: value, add };
}

describe('encrypted invitations (slice 5-3a)', () => {
  it('stores an owner-signed invitation and emails the sender, not the project', async () => {
    const { srv, mailbox } = server();
    const { projectId } = await encryptedProject(srv);
    const { value, response } = await invite(srv, projectId, {
      role: 'viewer'
    });
    expect(response.status).toBe(201);
    const { invitation } = await json<{ invitation: Record<string, unknown> }>(
      response
    );
    expect(invitation).toMatchObject({
      invitationId: value.invitationId,
      projectId,
      inviterUserId: OWNER,
      role: 'viewer',
      emailHash: toHex(await invitationEmailHash(INVITEE_EMAIL)),
      acceptedByUserId: null,
      completedAt: null
    });
    // The token goes only to the invitee; the address is not stored.
    expect(invitation).not.toHaveProperty('token');
    expect(
      JSON.stringify(srv.db.prepare('SELECT * FROM e2ee_invitations').all())
    ).not.toContain(INVITEE_EMAIL);
    const [mail] = mailbox.sent;
    expect(mail!.to).toBe(INVITEE_EMAIL);
    for (const part of [mail!.subject, mail!.text, mail!.html]) {
      expect(part).not.toContain('Secret bracket');
      expect(part).not.toContain(projectId);
      expect(part).toContain('Beta developer');
    }
    expect(mail!.text).toContain('as a viewer');
    expect(mail!.text).toMatch(
      /https:\/\/openzcad\.example\/#encrypted-invite=[A-Za-z0-9_-]{43}/
    );
    // The stored token hash is the emailed token's.
    expect(
      rows<{ token_hash: string }>(
        srv,
        'SELECT token_hash FROM e2ee_invitations WHERE invitation_id = ?',
        value.invitationId
      )[0]!.token_hash
    ).toBe(await hashProjectInvitationToken(tokenOf(mailbox)));
    // The shared client lists it for the owner.
    const api = createE2eeInvitationsApi((path, init) =>
      srv.call(init?.method ?? 'GET', path, {})
    );
    expect((await api.list(projectId)).invitations).toHaveLength(1);
    // One active invitation per email.
    const again = await invite(srv, projectId);
    expect(again.response.status).toBe(409);
    expect(await json(again.response)).toMatchObject({
      code: 'INVITATION_EXISTS'
    });
  });

  it('refuses a forged, misdirected, uncertified or expired statement', async () => {
    const { srv, mailbox } = server();
    const { projectId } = await encryptedProject(srv);
    const refused = async (body: unknown, status: number, code: string) => {
      const response = await srv.call('POST', invitationsPath(projectId), {
        body
      });
      expect(response.status).toBe(status);
      expect(await json(response)).toMatchObject({ code });
    };
    const good = await statement(projectId);
    // Another device's signature over the owner's statement.
    const forged = await statement(projectId, {}, 'owner_desktop');
    await refused(
      { ...good.body, signature: forged.body.signature },
      400,
      'E2EE_INVITATION_INVALID'
    );
    // A different email than the statement hashed.
    await refused(
      { ...good.body, email: 'someone@example.com' },
      400,
      'E2EE_INVITATION_INVALID'
    );
    // Signed by another account's device, naming the owner.
    await refused(
      (await statement(projectId, {}, 'third_laptop', third)).body,
      403,
      'E2EE_DEVICE_NOT_CERTIFIED'
    );
    // For another project.
    await refused(
      (await statement('proj_other')).body,
      400,
      'E2EE_INVITATION_INVALID'
    );
    // Expired (issued 8 days ago for 7 days), and issued in the future.
    const now = Date.now();
    await refused(
      (
        await statement(projectId, {
          issuedAt: now - 8 * DAY,
          expiresAt: now - DAY
        })
      ).body,
      400,
      'E2EE_INVITATION_EXPIRED'
    );
    await refused(
      (
        await statement(projectId, {
          issuedAt: now + DAY,
          expiresAt: now + 2 * DAY
        })
      ).body,
      400,
      'E2EE_INVITATION_EXPIRED'
    );
    // Garbage bytes.
    await refused(
      { ...good.body, statement: toBase64Url(new Uint8Array(40).fill(1)) },
      400,
      'E2EE_INVITATION_INVALID'
    );
    // A member cannot invite; nobody else learns the project exists.
    expect(
      (
        await srv.call('POST', invitationsPath(projectId), {
          user: THIRD,
          body: good.body
        })
      ).status
    ).toBe(404);
    expect(mailbox.sent).toHaveLength(0);
    expect(rows(srv, 'SELECT * FROM e2ee_invitations')).toHaveLength(0);
    // The good one still goes through.
    expect(
      (await srv.call('POST', invitationsPath(projectId), { body: good.body }))
        .status
    ).toBe(201);
  });

  it('binds the accepting account by its email, and the plaintext route refuses the token', async () => {
    const { srv, mailbox } = server();
    const { projectId } = await encryptedProject(srv);
    const { value } = await invite(srv, projectId);
    const token = tokenOf(mailbox);
    // Another account's email, no email, and the owner itself.
    expect((await accept(srv, token, THIRD, THIRD_EMAIL)).status).toBe(404);
    expect(
      (
        await asSession(
          srv,
          OTHER,
          null,
          'POST',
          '/api/e2ee/invitations/accept',
          {
            token
          }
        )
      ).status
    ).toBe(400);
    expect((await accept(srv, token, OWNER)).status).toBe(404);
    // The plaintext accept never knew this token.
    const plaintext = new D1R2PersistenceService({
      DB: srv.env.DB,
      PROJECT_SHARING_ENABLED: 'true'
    } as never);
    await expect(
      plaintext.acceptProjectInvitation(
        OTHER as never,
        INVITEE_EMAIL,
        await hashProjectInvitationToken(token),
        Math.floor(Date.now() / 1000)
      )
    ).rejects.toMatchObject({ code: 'INVITATION_NOT_FOUND' });
    // The invitee, by the email the statement hashed (in any case).
    const accepted = await accept(srv, token, OTHER, ' Invitee@Example.com ');
    expect(accepted.status).toBe(200);
    expect(await json(accepted)).toMatchObject({
      invitation: { invitationId: value.invitationId, acceptedByUserId: OTHER }
    });
    // Again by the same account: the same answer; by another: refused.
    expect((await accept(srv, token)).status).toBe(200);
    expect((await accept(srv, token, THIRD, INVITEE_EMAIL)).status).toBe(404);
    // Acceptance alone makes no member.
    expect(
      rows(srv, 'SELECT * FROM project_members WHERE project_id = ?', projectId)
    ).toHaveLength(0);
    // It relates the two for device-list lookups (M2).
    expect(
      (await srv.call('GET', `/api/e2ee/users/${OTHER}/device-list`)).status
    ).toBe(200);
    expect(
      (
        await srv.call('GET', `/api/e2ee/users/${OWNER}/device-list`, {
          user: OTHER
        })
      ).status
    ).toBe(200);
    expect(
      (
        await srv.call('GET', `/api/e2ee/users/${OWNER}/device-list`, {
          user: THIRD
        })
      ).status
    ).toBe(404);
    // The invitee lists it until an Add completes it.
    const mine = await json<{ invitations: { invitationId: string }[] }>(
      await srv.call('GET', '/api/e2ee/invitations', { user: OTHER })
    );
    expect(mine.invitations.map((i) => i.invitationId)).toEqual([
      value.invitationId
    ]);
  });

  it('publishes one KeyPackage per device and hands each out once', async () => {
    const { srv, mailbox } = server();
    const { projectId } = await encryptedProject(srv);
    const { value } = await invite(srv, projectId);
    // Before acceptance nobody may publish for it.
    expect(
      (await publish(srv, projectId, value.invitationId, 'other_laptop', 1))
        .status
    ).toBe(404);
    await accept(srv, tokenOf(mailbox));
    // Only a device the invitee's list certifies.
    expect(
      (await publish(srv, projectId, value.invitationId, 'stolen_phone', 1))
        .status
    ).toBe(403);
    // Not another account.
    expect(
      (
        await publish(
          srv,
          projectId,
          value.invitationId,
          'third_laptop',
          1,
          THIRD
        )
      ).status
    ).toBe(404);
    expect(
      (await publish(srv, projectId, value.invitationId, 'other_laptop', 1))
        .status
    ).toBe(201);
    // Republishing an unclaimed one replaces it.
    expect(
      (await publish(srv, projectId, value.invitationId, 'other_laptop', 3))
        .status
    ).toBe(201);
    // Only the owner claims; the invitee is no member yet and learns nothing.
    expect(
      (await claim(srv, projectId, value.invitationId, OTHER)).status
    ).toBe(404);
    const first = await claim(srv, projectId, value.invitationId);
    expect(first.status).toBe(200);
    const claimed = await json<{
      keyPackages: {
        deviceId: string;
        keyPackageHash: string;
        claimedAt: string;
      }[];
    }>(first);
    expect(claimed.keyPackages).toHaveLength(1);
    expect(claimed.keyPackages[0]).toMatchObject({
      deviceId: 'other_laptop',
      keyPackageHash: await hashHex(keyPackageBytes(3))
    });
    expect(claimed.keyPackages[0]!.claimedAt).toBeTruthy();
    // Claimed twice: refused, and nothing is handed out again.
    const second = await claim(srv, projectId, value.invitationId);
    expect(second.status).toBe(409);
    expect(await json(second)).toMatchObject({
      code: 'E2EE_KEY_PACKAGE_UNAVAILABLE'
    });
    // The same KeyPackage again is refused; a new one is claimable.
    const same = await publish(
      srv,
      projectId,
      value.invitationId,
      'other_laptop',
      3
    );
    expect(same.status).toBe(409);
    expect(await json(same)).toMatchObject({
      code: 'E2EE_KEY_PACKAGE_CLAIMED'
    });
    // The database refuses a second claim of one KeyPackage outright.
    expect(() =>
      srv.db
        .prepare(
          `UPDATE e2ee_key_packages SET claimed_by_user_id = ?, claimed_at = ?
           WHERE project_id = ?`
        )
        .run(THIRD, new Date().toISOString(), projectId)
    ).toThrow(/E2EE_KEY_PACKAGE_CLAIMED/);
    expect(
      (await publish(srv, projectId, value.invitationId, 'other_laptop', 4))
        .status
    ).toBe(201);
    expect((await claim(srv, projectId, value.invitationId)).status).toBe(200);
  });

  it('adds the claimed devices in the Commit batch and mirrors the member', async () => {
    const { srv, laptop, projectId, invitation, add } = await readyToAdd();
    const body = await heldCommit(laptop, projectId);
    const epoch = body.epoch as number;
    const response = await commit(srv, projectId, { ...body, add });
    expect(response.status).toBe(200);
    expect(groupEpoch(srv, projectId)).toBe(epoch + 1);
    expect(
      rows(
        srv,
        `SELECT user_id, role, added_by_user_id FROM project_members
         WHERE project_id = ?`,
        projectId
      )
    ).toEqual([{ user_id: OTHER, role: 'editor', added_by_user_id: OWNER }]);
    // Each added device's leaf is registered, from its KeyPackage.
    expect(
      rows(
        srv,
        `SELECT device_id, leaf_key FROM e2ee_project_leaves
         WHERE project_id = ? AND user_id = ? ORDER BY device_id`,
        projectId,
        OTHER
      )
    ).toEqual([
      { device_id: 'other_desktop', leaf_key: leaf(2).leafKey },
      { device_id: 'other_laptop', leaf_key: leaf(1).leafKey }
    ]);
    expect(
      rows(
        srv,
        `SELECT device_id, consumed_epoch FROM e2ee_key_packages
         WHERE project_id = ? ORDER BY device_id`,
        projectId
      )
    ).toEqual([
      { device_id: 'other_desktop', consumed_epoch: epoch },
      { device_id: 'other_laptop', consumed_epoch: epoch }
    ]);
    expect(
      rows(
        srv,
        `SELECT completed_epoch FROM e2ee_invitations WHERE invitation_id = ?`,
        invitation.invitationId
      )
    ).toEqual([{ completed_epoch: epoch }]);
    expect(
      rows<{ event_type: string; next_role: string; subject_user_id: string }>(
        srv,
        `SELECT event_type, next_role, subject_user_id FROM project_access_events
         WHERE project_id = ?`,
        projectId
      )
    ).toEqual([
      {
        event_type: 'invitation-accepted',
        next_role: 'editor',
        subject_user_id: OTHER
      }
    ]);
    // Each added device reads its Welcome; another device of the member
    // has none, and a stranger reads nothing.
    for (const deviceId of ['other_laptop', 'other_desktop']) {
      const welcome = await srv.call(
        'GET',
        `/api/e2ee/projects/${projectId}/welcome?deviceId=${deviceId}`,
        { user: OTHER }
      );
      expect(welcome.status).toBe(200);
      expect(await json(welcome)).toMatchObject({
        welcome: {
          epoch,
          welcome: add.welcome,
          keyPackageHash: add.keyPackages.find((k) => k.deviceId === deviceId)!
            .keyPackageHash
        }
      });
    }
    expect(
      (
        await srv.call(
          'GET',
          `/api/e2ee/projects/${projectId}/welcome?deviceId=other_phone`,
          { user: OTHER }
        )
      ).status
    ).toBe(404);
    expect(
      (
        await srv.call(
          'GET',
          `/api/e2ee/projects/${projectId}/welcome?deviceId=other_laptop`,
          { user: THIRD }
        )
      ).status
    ).toBe(404);
    // The member reads the group now; the invitation is finished.
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
    ).toBe(200);
    expect(
      await json(
        await srv.call('GET', '/api/e2ee/invitations', { user: OTHER })
      )
    ).toEqual({ invitations: [] });
    // The consumed KeyPackages cannot be published over or claimed.
    expect(
      (
        await publish(
          srv,
          projectId,
          invitation.invitationId,
          'other_laptop',
          8
        )
      ).status
    ).toBe(409);
  });

  it('refuses a Commit whose membership change does not match the claimed KeyPackages', async () => {
    const { srv, laptop, projectId, add } = await readyToAdd();
    const body = await heldCommit(laptop, projectId);
    const epoch = groupEpoch(srv, projectId);
    const refused = async (
      changed: Record<string, unknown>,
      status: number,
      code: string,
      user = OWNER
    ) => {
      const response = await commit(
        srv,
        projectId,
        { ...body, ...changed },
        user
      );
      expect(response.status).toBe(status);
      expect(await json(response)).toMatchObject({ code });
    };
    // One claimed device left out.
    await refused(
      { add: { ...add, keyPackages: add.keyPackages.slice(0, 1) } },
      409,
      'E2EE_ADD_MISMATCH'
    );
    // A KeyPackage the owner never claimed (another hash).
    await refused(
      {
        add: {
          ...add,
          keyPackages: add.keyPackages.map((k, i) =>
            i === 0 ? { ...k, keyPackageHash: 'ab'.repeat(32) } : k
          )
        }
      },
      409,
      'E2EE_ADD_MISMATCH'
    );
    // A device the invitee never published for.
    await refused(
      {
        add: {
          ...add,
          keyPackages: [
            ...add.keyPackages,
            {
              userId: OTHER,
              deviceId: 'other_phone',
              keyPackageHash: 'cd'.repeat(32)
            }
          ]
        }
      },
      409,
      'E2EE_ADD_MISMATCH'
    );
    // Someone else's account named for a claimed device.
    await refused(
      {
        add: {
          ...add,
          keyPackages: add.keyPackages.map((k, i) =>
            i === 0 ? { ...k, userId: THIRD } : k
          )
        }
      },
      409,
      'E2EE_ADD_MISMATCH'
    );
    // As an external Commit, and without a Welcome.
    await refused({ add, kind: 'external' }, 400, 'E2EE_REQUEST_INVALID');
    await refused(
      { add: { ...add, welcome: undefined } },
      400,
      'E2EE_REQUEST_INVALID'
    );
    // Nothing moved.
    expect(groupEpoch(srv, projectId)).toBe(epoch);
    expect(
      rows(srv, 'SELECT * FROM project_members WHERE project_id = ?', projectId)
    ).toHaveLength(0);
    expect(
      rows(srv, 'SELECT * FROM e2ee_key_packages WHERE consumed_at IS NOT NULL')
    ).toHaveLength(0);
    expect(rows(srv, 'SELECT * FROM e2ee_welcomes')).toHaveLength(0);
    // The matching Add still lands on the same epoch.
    const matching = await commit(srv, projectId, { ...body, add });
    expect(matching.status).toBe(200);
  });

  it('lands nothing when the claim changes between the check and the batch', async () => {
    const { srv, laptop, projectId, add } = await readyToAdd();
    const body = await heldCommit(laptop, projectId);
    const epoch = groupEpoch(srv, projectId);
    const real = srv.env.DB as D1Database;
    let raced = false;
    // The invitee republishes one device right before the Commit's batch.
    srv.env.DB = new Proxy(real, {
      get(target, property) {
        if (property === 'batch') {
          return async (statements: D1PreparedStatement[]) => {
            if (!raced && statements.length > 5) {
              raced = true;
              srv.db
                .prepare(
                  `UPDATE e2ee_key_packages SET key_package_hash = ?,
                     claimed_at = NULL, claimed_by_user_id = NULL
                   WHERE device_id = 'other_desktop'`
                )
                .run('ee'.repeat(32));
            }
            return target.batch(statements);
          };
        }
        const value = Reflect.get(target, property) as unknown;
        return typeof value === 'function'
          ? (value as (...args: unknown[]) => unknown).bind(target)
          : value;
      }
    });
    const response = await commit(srv, projectId, { ...body, add });
    srv.env.DB = real;
    expect(raced).toBe(true);
    expect(response.status).toBe(409);
    expect(await json(response)).toMatchObject({ code: 'E2EE_ADD_MISMATCH' });
    expect(groupEpoch(srv, projectId)).toBe(epoch);
    expect(
      rows(
        srv,
        'SELECT * FROM e2ee_mls_commits WHERE project_id = ? AND epoch = ?',
        projectId,
        epoch
      )
    ).toHaveLength(0);
    expect(
      rows(srv, 'SELECT * FROM e2ee_key_packages WHERE consumed_at IS NOT NULL')
    ).toHaveLength(0);
    expect(rows(srv, 'SELECT * FROM project_members')).toHaveLength(0);
    expect(rows(srv, 'SELECT * FROM e2ee_welcomes')).toHaveLength(0);
  });

  it('only the owner adds, and only for a live invitation', async () => {
    const { srv, mailbox, projectId, add, invitation } = await readyToAdd();
    // A member (made by hand) cannot state an Add.
    srv.db
      .prepare(
        `INSERT INTO project_members
           (project_id, user_id, role, added_by_user_id, created_at, updated_at)
         VALUES (?, ?, 'editor', ?, 1, 1)`
      )
      .run(projectId, THIRD, OWNER);
    const response = await commit(
      srv,
      projectId,
      {
        epoch: groupEpoch(srv, projectId),
        kind: 'commit',
        deviceId: 'third_laptop',
        message: 'AAAA',
        groupInfo: 'AAAA',
        wraps: [],
        archive: {},
        add
      },
      THIRD
    );
    // The wraps are refused before the Add is considered, or the Add is.
    expect([400, 403]).toContain(response.status);
    // A revoked invitation drops its KeyPackages and cannot be added.
    const revoked = await srv.call(
      'DELETE',
      `${invitationsPath(projectId)}/${invitation.invitationId}`
    );
    expect(revoked.status).toBe(200);
    expect(rows(srv, 'SELECT * FROM e2ee_key_packages')).toHaveLength(0);
    expect((await accept(srv, tokenOf(mailbox))).status).toBe(404);
    expect((await claim(srv, projectId, invitation.invitationId)).status).toBe(
      409
    );
  });

  it('erases the invitee’s side and purges with the project', async () => {
    const { srv, laptop, projectId, add } = await readyToAdd();
    expect(
      (
        await commit(srv, projectId, {
          ...(await heldCommit(laptop, projectId)),
          add
        })
      ).status
    ).toBe(200);
    const db = srv.env.DB as D1Database;
    await db.batch(await invitationErasureStatements(db, OTHER, INVITEE_EMAIL));
    for (const table of [
      'e2ee_welcomes',
      'e2ee_key_packages',
      'e2ee_invitations'
    ]) {
      expect(rows(srv, `SELECT * FROM ${table}`)).toHaveLength(0);
    }
    // Project purge names the tables once they exist (and only then).
    expect(await isE2eeInvitationStorageReady(db)).toBe(true);
  });
});

describe('the plaintext route’s recipient rules', () => {
  // Slice 5-4: the edit-lease rule keeps plaintext editors in the
  // lease-checked room; an encrypted project's editors write only on top of
  // the head they read, and its room is the owner's until slice 5-6.
  it('sends an editor invitation while edit leases are not enforced', async () => {
    const { srv, mailbox } = server(undefined, {
      PROJECT_EDIT_LEASES_ENFORCED: 'false'
    });
    const { projectId } = await encryptedProject(srv);
    const editor = await invite(srv, projectId);
    expect(editor.response.status).toBe(201);
    expect(editor.value.role).toBe('editor');
    expect(mailbox.sent).toHaveLength(1);
  });
});

describe('without migration 0038', () => {
  it('keeps ordinary invitations and Commits working, and refuses the encrypted routes', async () => {
    const { srv, mailbox } = server(databaseBefore(38));
    expect(
      rows(
        srv,
        `SELECT name FROM sqlite_master WHERE name = 'e2ee_invitations'`
      )
    ).toHaveLength(0);
    // A plaintext project, invited to and accepted as before.
    const service = new D1R2PersistenceService({
      DB: srv.env.DB,
      PROJECT_SHARING_ENABLED: 'true'
    } as never);
    const plain = await service.createProject(OWNER as never, {
      name: 'Plain bracket',
      initialDocument: withoutDerivedProjection(
        createProjectDocument('Plain bracket', OWNER as never)
      )
    });
    const created = await srv.call(
      'POST',
      `/api/projects/${plain.document.projectId}/invitations`,
      { body: { email: INVITEE_EMAIL, role: 'viewer' } }
    );
    expect(created.status).toBe(201);
    const { token } = await json<{ token: string }>(created);
    expect(mailbox.sent.at(-1)!.text).toContain('Plain bracket');
    expect(mailbox.sent.at(-1)!.text).toContain('#invite=');
    await expect(
      service.acceptProjectInvitation(
        OTHER as never,
        INVITEE_EMAIL,
        await hashProjectInvitationToken(token),
        Math.floor(Date.now() / 1000)
      )
    ).resolves.toMatchObject({ role: 'viewer' });
    // The encrypted invitation routes answer 503.
    const { laptop, projectId } = await encryptedProject(srv);
    const { response } = await invite(srv, projectId);
    expect(response.status).toBe(503);
    // A Commit without an Add lands; one with an Add answers 503.
    const body = await heldCommit(laptop, projectId, {});
    const withAdd = await commit(srv, projectId, {
      ...body,
      add: { invitationId: 'inv_x', keyPackages: [], welcome: 'AAAA' }
    });
    expect(withAdd.status).toBe(503);
    expect((await commit(srv, projectId, body)).status).toBe(200);
    // Contacts lookups and the probe do not need it.
    expect(
      (await srv.call('GET', `/api/e2ee/users/${OTHER}/device-list`)).status
    ).toBe(200);
    const db = srv.env.DB as D1Database;
    expect(await invitationErasureStatements(db, OTHER, INVITEE_EMAIL)).toEqual(
      []
    );
    expect(
      await isE2eeInvitationStorageReady(sqliteD1(databaseBefore(38)))
    ).toBe(false);
  });
});
