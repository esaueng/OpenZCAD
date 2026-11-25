/**
 * Pending invitations don't lapse (L11 plan of 2026-11-25, §3.4): before a
 * statement nobody accepted expires, the owner's certified device signs a
 * fresh seven-day statement for the same invitation, and the Worker
 * replaces the stored one (`PUT /api/e2ee/projects/:id/invitations/:id`)
 * only for an open, unaccepted invitation and a statement naming exactly
 * what the stored one names. The real client modules run against the real
 * Worker over SQLite.
 */
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  MAX_PROJECT_INVITATION_CHAIN_MS,
  MAX_PROJECT_INVITATION_LIFETIME_MS,
  accountKeyCommitment,
  decodeProjectInvitation,
  invitationChainIssuedAt,
  toHex,
  fromBase64Url,
  invitationEmailHash,
  publicKeyHash,
  signProjectInvitation,
  toBase64Url,
  type ProjectInvitation
} from '@openzcad/crypto';
import {
  createE2eeInvitationsApi,
  type E2eeInvitationRecord,
  type E2eeInvitationsApi
} from '@openzcad/shared';
import { handleE2eeRequest } from '../apps/web/worker/e2ee';
import type { E2eeInvitationHost } from '../apps/web/worker/e2eeInvitations';
import {
  admitDevelopmentE2eeWrite,
  releaseDevelopmentE2eeWrite
} from '../apps/web/worker/e2eeWriteAuthorization';
import {
  acceptEncryptedInvitation,
  acceptedInvitations,
  addInvitedMember,
  declineInvitation,
  publishInvitationKeyPackages,
  inviteToEncryptedProject,
  type InvitationContext
} from '../apps/web/src/lib/e2ee/invitations';
import { memoryInvitationStore } from '../apps/web/src/lib/e2ee/invitationStore';
import {
  cancelInvitation,
  memoryInvitationTombstones,
  sealedInvitationTombstones,
  type InvitationTombstones
} from '../apps/web/src/lib/e2ee/invitationTombstones';
import {
  INVITATION_RENEWAL_WINDOW_MS,
  renewPendingInvitations
} from '../apps/web/src/lib/e2ee/invitationRenewal';
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

const THIRD = 'user_third';
const EMAILS: Record<string, string> = {
  [OWNER]: 'owner@example.com',
  [OTHER]: 'invitee@example.com',
  [THIRD]: 'third@example.com'
};
const DAY = 86_400_000;

let owner: Account;
let other: Account;
let third: Account;

beforeAll(async () => {
  owner = await makeAccount(OWNER, ['owner_laptop', 'owner_desktop']);
  other = await makeAccount(OTHER, ['other_laptop']);
  third = await makeAccount(THIRD, ['third_laptop']);
});

afterEach(() => {
  forgetAllProjectKeys();
});

interface World {
  srv: Server;
  mail: { to: string; token: string }[];
}

function world(db?: ReturnType<typeof databaseBefore>): World {
  const srv = newServer([owner, other, third], db, {
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

/** A device whose calls reach the Worker as a session with an email. */
function emailDevice(w: World, account: Account, deviceId: string): Device {
  const d = device(w.srv, account, deviceId, {
    members: [owner, other].filter((a) => a !== account)
  });
  d.fetcher = async (path: string, init: RequestInit = {}) => {
    const session = { userId: account.userId };
    const db = w.srv.env.DB as D1Database;
    await admitDevelopmentE2eeWrite(db, session);
    const email = EMAILS[account.userId] ?? null;
    const host: E2eeInvitationHost = {
      email,
      inviterLabel: email ?? account.userId,
      sharingEnabled: true,
      emailConfigured: true,
      sendInvitationEmail: async (details) => {
        w.mail.push({ to: details.recipientEmail, token: details.token });
      }
    };
    try {
      return await handleE2eeRequest(
        new Request(`https://example.com${path}`, init),
        w.srv.env,
        session,
        true,
        true,
        host
      );
    } finally {
      await releaseDevelopmentE2eeWrite(session);
    }
  };
  return d;
}

function contextOf(
  d: Device,
  options: {
    now?: () => number;
    api?: E2eeInvitationsApi;
    tombstones?: InvitationTombstones;
  } = {}
): InvitationContext {
  return {
    groups: d.groups,
    tombstones: options.tombstones ?? memoryInvitationTombstones(),
    api:
      options.api ??
      createE2eeInvitationsApi((path, init) => d.fetcher(path, init)),
    store: memoryInvitationStore(),
    email: EMAILS[d.account.userId] ?? null,
    ...(options.now ? { now: options.now } : {}),
    people: {
      inspect: async (userId) => {
        const account = [owner, other, third].find((a) => a.userId === userId);
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

/**
 * The owner's project and an email-only invitation of the invitee, signed
 * `age` ago (so it has seven days minus `age` left), not accepted yet.
 */
async function pending(w: World, age = 0) {
  const laptop = emailDevice(w, owner, 'owner_laptop');
  const { document } = await createEncrypted(laptop);
  const projectId = document.projectId;
  const signedAt = Date.now() - age;
  const invitation = await inviteToEncryptedProject(
    contextOf(laptop, { now: () => signedAt }),
    projectId,
    EMAILS[OTHER]!,
    'viewer'
  );
  return {
    laptop,
    projectId,
    invitation,
    token: w.mail.at(-1)!.token,
    ownerCtx: contextOf(laptop)
  };
}

const stored = (srv: Server, invitationId: string) =>
  rows<{ statement: string; expires_at: number; signer_device_id: string }>(
    srv,
    'SELECT statement, expires_at, signer_device_id FROM e2ee_invitations WHERE invitation_id = ?',
    invitationId
  )[0]!;

describe('renewing pending invitations', () => {
  it('re-signs a statement close to lapsing, and the emailed link still opens it', async () => {
    const w = world();
    const { invitation, token, ownerCtx, projectId } = await pending(
      w,
      2 * DAY
    );
    const { invitations: listed } = await ownerCtx.api.pending();
    expect(listed.map((entry) => entry.invitationId)).toEqual([
      invitation.invitationId
    ]);
    const before = stored(w.srv, invitation.invitationId);
    const desktop = contextOf(emailDevice(w, owner, 'owner_desktop'));
    const renewed = await renewPendingInvitations(desktop);
    expect(renewed).toEqual({ renewed: [invitation.invitationId], failed: [] });
    const after = stored(w.srv, invitation.invitationId);
    expect(after.expires_at).toBeGreaterThan(before.expires_at);
    // Another owner device signs it: the same invitation otherwise.
    expect(after.signer_device_id).toBe('owner_desktop');
    const was = decodeProjectInvitation(fromBase64Url(before.statement));
    const now = decodeProjectInvitation(fromBase64Url(after.statement));
    expect(now.expiresAt - now.issuedAt).toBe(
      MAX_PROJECT_INVITATION_LIFETIME_MS
    );
    expect(now.expiresAt).toBe(after.expires_at);
    expect({
      ...now,
      issuedAt: 0,
      expiresAt: 0,
      chainIssuedAt: 0,
      signerDeviceId: '',
      signerKeyHash: null
    }).toEqual({
      ...was,
      issuedAt: 0,
      expiresAt: 0,
      chainIssuedAt: 0,
      signerDeviceId: '',
      signerKeyHash: null
    });
    // The first statement (version 2) was a chain of one: the renewal
    // names its issuance as where the chain began.
    expect(was.chainIssuedAt).toBeUndefined();
    expect(now.chainIssuedAt).toBe(was.issuedAt);
    // The invitee opens the very link the first email carried; the
    // statement they accept is the renewed one, and it verifies.
    const invitee = emailDevice(w, other, 'other_laptop');
    const inviteeCtx = contextOf(invitee);
    const accepted = await acceptEncryptedInvitation(inviteeCtx, token);
    expect(accepted.linked).toBe(true);
    expect(accepted.invitation.statement).toBe(after.statement);
    expect(await acceptedInvitations(inviteeCtx)).toMatchObject([
      { record: { invitationId: invitation.invitationId, projectId } }
    ]);
    expect(
      (await acceptedInvitations(inviteeCtx)).map((entry) => entry.state)
    ).not.toContain('invalid');
    // Accepted: never renewed again (the acceptance signs that statement).
    expect((await ownerCtx.api.pending()).invitations).toEqual([]);
    expect(await renewPendingInvitations(ownerCtx)).toEqual({
      renewed: [],
      failed: []
    });
  });

  it('renews only once the window is reached, about a day after signing', async () => {
    // The window is six of the seven days: a statement a day old is due.
    const due =
      MAX_PROJECT_INVITATION_LIFETIME_MS - INVITATION_RENEWAL_WINDOW_MS;
    expect(due).toBe(DAY);
    const early = world();
    const notYet = await pending(early, due - 60_000);
    const before = stored(early.srv, notYet.invitation.invitationId);
    expect(await renewPendingInvitations(notYet.ownerCtx)).toEqual({
      renewed: [],
      failed: []
    });
    expect(stored(early.srv, notYet.invitation.invitationId)).toEqual(before);
    const late = world();
    const now = await pending(late, due + 60_000);
    expect(await renewPendingInvitations(now.ownerCtx)).toEqual({
      renewed: [now.invitation.invitationId],
      failed: []
    });
  });

  it('stops the chain once the owner cancels the invitation', async () => {
    const w = world();
    const { invitation, ownerCtx, projectId } = await pending(w, 3 * DAY);
    await declineInvitation(ownerCtx, projectId, invitation.invitationId);
    expect((await ownerCtx.api.pending()).invitations).toEqual([]);
    expect(await renewPendingInvitations(ownerCtx)).toEqual({
      renewed: [],
      failed: []
    });
    // Asked directly, the Worker refuses to renew it.
    const response = await renewRequest(w, invitation, {});
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      code: 'E2EE_INVITATION_UNAVAILABLE'
    });
  });

  it('signs nothing the server lists that this account’s devices did not sign', async () => {
    const w = world();
    const { invitation, laptop } = await pending(w, 3 * DAY);
    const real = createE2eeInvitationsApi((path, init) =>
      laptop.fetcher(path, init)
    );
    // The server lists a statement in the owner's name signed by another
    // account's device.
    const forged = await signed(invitation, {}, third, 'third_laptop');
    let renewCalls = 0;
    const api: E2eeInvitationsApi = {
      ...real,
      pending: async () => ({
        invitations: [{ ...invitation, statement: forged.statement }]
      }),
      renew: async (...args) => {
        renewCalls += 1;
        return real.renew(...args);
      }
    };
    const result = await renewPendingInvitations(contextOf(laptop, { api }));
    expect(result.renewed).toEqual([]);
    expect(result.failed).toHaveLength(1);
    expect(renewCalls).toBe(0);
  });
});

/** A statement like `record`'s, changed by `overrides`, signed by `by`. */
async function signed(
  record: E2eeInvitationRecord,
  overrides: Partial<ProjectInvitation>,
  by: Account = owner,
  deviceId = 'owner_laptop'
) {
  const base = decodeProjectInvitation(fromBase64Url(record.statement));
  const issuedAt = Date.now();
  const value: ProjectInvitation = {
    ...base,
    issuedAt,
    expiresAt: issuedAt + MAX_PROJECT_INVITATION_LIFETIME_MS,
    chainIssuedAt: invitationChainIssuedAt(base),
    signerDeviceId: deviceId,
    signerKeyHash: await publicKeyHash(
      by.list.head.devices.find((d) => d.deviceId === deviceId)!.signingKey
    ),
    ...overrides
  };
  const pair = await signProjectInvitation(
    by.devices.get(deviceId)!.signing.privateKey,
    value
  );
  return {
    statement: toBase64Url(pair.statement),
    signature: toBase64Url(pair.signature)
  };
}

/**
 * A renewal of `record` changed by `overrides`, signed by `by`'s device,
 * sent by `as` (the owner by default) under `path`.
 */
async function renewRequest(
  w: World,
  record: E2eeInvitationRecord,
  overrides: Partial<ProjectInvitation>,
  options: {
    by?: Account;
    deviceId?: string;
    as?: [Account, string];
    path?: string;
  } = {}
) {
  const body = await signed(record, overrides, options.by, options.deviceId);
  const [account, deviceId] = options.as ?? [owner, 'owner_laptop'];
  return emailDevice(w, account, deviceId).fetcher(
    options.path ??
      `/api/e2ee/projects/${record.projectId}/invitations/${record.invitationId}`,
    {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body)
    }
  );
}

describe('the renewal route', () => {
  it('replaces only a statement naming everything the stored one names', async () => {
    const w = world();
    const { invitation } = await pending(w, 3 * DAY);
    const before = stored(w.srv, invitation.invitationId);
    const refusals: [Partial<ProjectInvitation>, string][] = [
      [{ role: 'editor' }, 'E2EE_INVITATION_INVALID'],
      [
        {
          inviteeEmailHash: await invitationEmailHash(EMAILS[THIRD]!)
        },
        'E2EE_INVITATION_INVALID'
      ],
      [
        { linkTokenHash: new Uint8Array(32).fill(7) },
        'E2EE_INVITATION_INVALID'
      ],
      // A chain that claims to begin anew.
      [{ chainIssuedAt: Date.now() - 60_000 }, 'E2EE_INVITATION_INVALID'],
      [
        { inviteeIdentityKeyHash: new Uint8Array(32).fill(3) },
        'E2EE_INVITATION_INVALID'
      ],
      // No longer than the stored one.
      [
        {
          issuedAt: before.expires_at - MAX_PROJECT_INVITATION_LIFETIME_MS,
          expiresAt: before.expires_at
        },
        'E2EE_INVITATION_INVALID'
      ],
      // Not valid yet.
      [
        {
          issuedAt: Date.now() + DAY,
          expiresAt: Date.now() + DAY + MAX_PROJECT_INVITATION_LIFETIME_MS
        },
        'E2EE_INVITATION_EXPIRED'
      ]
    ];
    for (const [overrides, code] of refusals) {
      const response = await renewRequest(w, invitation, overrides);
      const body = (await response.json()) as { code?: string };
      expect({ status: response.status, code: body.code }).toEqual({
        status: 400,
        code
      });
    }
    // Signed by another account's device in the owner's name.
    const foreign = await renewRequest(
      w,
      invitation,
      {},
      {
        by: third,
        deviceId: 'third_laptop'
      }
    );
    expect(foreign.status).toBe(403);
    expect(await foreign.json()).toMatchObject({
      code: 'E2EE_DEVICE_NOT_CERTIFIED'
    });
    // Someone else cannot renew the owner's invitation.
    const stranger = await renewRequest(
      w,
      invitation,
      {},
      {
        as: [other, 'other_laptop']
      }
    );
    expect(stranger.status).toBe(404);
    expect(await stranger.json()).toMatchObject({ code: 'PROJECT_NOT_FOUND' });
    // Under another project's path.
    const elsewhere = await renewRequest(
      w,
      invitation,
      {},
      {
        path: `/api/e2ee/projects/proj_elsewhere/invitations/${invitation.invitationId}`
      }
    );
    expect(elsewhere.status).toBe(404);
    expect(await elsewhere.json()).toMatchObject({ code: 'PROJECT_NOT_FOUND' });
    expect(stored(w.srv, invitation.invitationId)).toEqual(before);
    // The well-formed renewal lands.
    const ok = await renewRequest(w, invitation, {});
    expect(ok.status).toBe(200);
    expect(stored(w.srv, invitation.invitationId).expires_at).toBeGreaterThan(
      before.expires_at
    );
  });

  it('never changes an accepted invitation’s statement', async () => {
    const w = world();
    const { invitation, token } = await pending(w, 3 * DAY);
    await acceptEncryptedInvitation(
      contextOf(emailDevice(w, other, 'other_laptop')),
      token
    );
    const before = stored(w.srv, invitation.invitationId);
    const response = await renewRequest(w, invitation, {});
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      code: 'E2EE_INVITATION_UNAVAILABLE'
    });
    expect(stored(w.srv, invitation.invitationId)).toEqual(before);
  });
});

describe('without migration 0068', () => {
  it('lists pending invitations but answers a renewal 503, changing nothing', async () => {
    const w = world(databaseBefore(68, { authority: true }));
    const { invitation, ownerCtx } = await pending(w, 3 * DAY);
    expect(
      (await ownerCtx.api.pending()).invitations.map((i) => i.invitationId)
    ).toEqual([invitation.invitationId]);
    const before = stored(w.srv, invitation.invitationId);
    const response = await renewRequest(w, invitation, {});
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: 'E2EE_UNAVAILABLE' });
    // The page's pass drops a 503 like this one (`invitationPass.ts`).
    const result = await renewPendingInvitations(ownerCtx);
    expect(result.renewed).toEqual([]);
    expect(result.failed).toMatchObject([
      { invitationId: invitation.invitationId, error: { status: 503 } }
    ]);
    expect(stored(w.srv, invitation.invitationId)).toEqual(before);
  });
});

describe('the owner’s own record of what it cancelled', () => {
  it('renews nothing it cancelled, even while the server lists it as pending', async () => {
    const w = world();
    const { invitation, laptop } = await pending(w, 3 * DAY);
    // The server ignored the cancellation: it still lists the invitation.
    const tombstones = memoryInvitationTombstones([invitation.invitationId]);
    const ctx = contextOf(laptop, { tombstones });
    expect(
      (await ctx.api.pending()).invitations.map((i) => i.invitationId)
    ).toEqual([invitation.invitationId]);
    const before = stored(w.srv, invitation.invitationId);
    expect(await renewPendingInvitations(ctx)).toEqual({
      renewed: [],
      failed: []
    });
    expect(stored(w.srv, invitation.invitationId)).toEqual(before);
  });

  it('renews nothing while that record cannot be read', async () => {
    const w = world();
    const { invitation, laptop } = await pending(w, 3 * DAY);
    const tombstones = memoryInvitationTombstones();
    tombstones.failing = true;
    const before = stored(w.srv, invitation.invitationId);
    await expect(
      renewPendingInvitations(contextOf(laptop, { tombstones }))
    ).rejects.toThrow(/cannot be read/);
    expect(stored(w.srv, invitation.invitationId)).toEqual(before);
  });

  it('adds nobody by an invitation it cancelled, whatever the server says', async () => {
    const w = world();
    const { invitation, token, laptop } = await pending(w, 3 * DAY);
    await acceptEncryptedInvitation(
      contextOf(emailDevice(w, other, 'other_laptop')),
      token
    );
    const tombstones = memoryInvitationTombstones([invitation.invitationId]);
    const ctx = contextOf(laptop, { tombstones });
    const [record] = (await ctx.api.sent()).invitations;
    expect(record?.invitationId).toBe(invitation.invitationId);
    await expect(addInvitedMember(ctx, record!)).rejects.toMatchObject({
      code: 'invitation-cancelled'
    });
    // Unreadable, it adds nobody either.
    tombstones.failing = true;
    await expect(addInvitedMember(ctx, record!)).rejects.toThrow(
      /cannot be read/
    );
  });

  it('cancels into the sealed record first, then revokes', async () => {
    const w = world();
    const { invitation, ownerCtx, projectId } = await pending(w, 3 * DAY);
    const tombstones = memoryInvitationTombstones();
    const ctx = { ...ownerCtx, tombstones };
    await cancelInvitation(ctx, projectId, invitation.invitationId);
    expect([...(await tombstones.cancelled())]).toEqual([
      invitation.invitationId
    ]);
    expect((await ctx.api.pending()).invitations).toEqual([]);
    // A record it cannot write revokes nothing.
    const next = await inviteToEncryptedProject(
      ownerCtx,
      projectId,
      EMAILS[THIRD]!,
      'viewer'
    );
    tombstones.failing = true;
    await expect(
      cancelInvitation(ctx, projectId, next.invitationId)
    ).rejects.toThrow(/cannot be read/);
    expect(
      (await ctx.api.pending()).invitations.map((i) => i.invitationId)
    ).toEqual([next.invitationId]);
  });

  it('keeps it sealed in the account record, refusing an older or a withheld copy', async () => {
    const w = world();
    const laptop = emailDevice(w, owner, 'owner_laptop');
    const api = createE2eeInvitationsApi((path, init) =>
      laptop.fetcher(path, init)
    );
    const commitment = toHex(await accountKeyCommitment(owner.accountKey));
    const pinsOf = () => {
      let pin = 0;
      return {
        read: () => pin,
        write: (sequence: number) => {
          pin = Math.max(pin, sequence);
        }
      };
    };
    const tombstonesOn = (pins = pinsOf()) =>
      sealedInvitationTombstones({
        userId: OWNER,
        api,
        local: memoryInvitationStore(),
        pins,
        currentKey: () => owner.accountKey.slice(),
        keyFor: async (key) =>
          toHex(key) === commitment ? owner.accountKey.slice() : null
      });
    const tombstoneRow = () =>
      rows<{ record: string; sequence: number }>(
        w.srv,
        'SELECT record, sequence FROM e2ee_invitation_tombstones WHERE user_id = ?',
        OWNER
      )[0]!;
    const desktop = tombstonesOn();
    // Nothing stored yet: nothing cancelled.
    expect([...(await desktop.cancelled())]).toEqual([]);
    await desktop.cancel('inv_one');
    const first = tombstoneRow();
    // Two devices write at once: both cancellations land.
    const phone = tombstonesOn();
    await Promise.all([phone.cancel('inv_two'), desktop.cancel('inv_three')]);
    const all = ['inv_one', 'inv_three', 'inv_two'];
    expect([...(await tombstonesOn().cancelled())].sort()).toEqual(all);
    expect([...(await desktop.cancelled())].sort()).toEqual(all);
    // The server never sees an id.
    expect(tombstoneRow().record).not.toContain('inv_');
    // Rolled back to the first record: refused where a newer one was seen.
    w.srv.db
      .prepare(
        'UPDATE e2ee_invitation_tombstones SET sequence = ?, record = ? WHERE user_id = ?'
      )
      .run(first.sequence, first.record, OWNER);
    await expect(desktop.cancelled()).rejects.toThrow(/older record/);
    // Withheld altogether: refused too.
    w.srv.db
      .prepare('DELETE FROM e2ee_invitation_tombstones WHERE user_id = ?')
      .run(OWNER);
    await expect(desktop.cancelled()).rejects.toThrow(/no longer holds/);
  });
});

describe('the renewal chain’s bound', () => {
  it('ends 30 days after the first statement, however often it is renewed', async () => {
    const w = world();
    const { invitation, ownerCtx } = await pending(w, 0);
    const start = decodeProjectInvitation(
      fromBase64Url(invitation.statement)
    ).issuedAt;
    // The owner's and the Worker's clocks both jump to just before each
    // statement lapses.
    const realNow = Date.now.bind(Date);
    let offset = 0;
    Date.now = () => realNow() + offset;
    const ctx = { ...ownerCtx, now: () => Date.now() };
    try {
      let expiry = stored(w.srv, invitation.invitationId).expires_at;
      for (let round = 0; round < 10; round++) {
        offset = expiry - 60 * 60 * 1000 - realNow();
        const result = await renewPendingInvitations(ctx);
        if (!result.renewed.length) break;
        const after = stored(w.srv, invitation.invitationId);
        const statement = decodeProjectInvitation(
          fromBase64Url(after.statement)
        );
        expect(statement.chainIssuedAt).toBe(start);
        expect(statement.expiresAt - statement.issuedAt).toBeLessThanOrEqual(
          MAX_PROJECT_INVITATION_LIFETIME_MS
        );
        expect(after.expires_at).toBeGreaterThan(expiry);
        expiry = after.expires_at;
      }
      expect(expiry).toBe(start + MAX_PROJECT_INVITATION_CHAIN_MS);
      // At the bound, nothing is renewed again.
      offset = expiry - 60 * 60 * 1000 - realNow();
      expect((await renewPendingInvitations(ctx)).renewed).toEqual([]);
    } finally {
      Date.now = realNow;
    }
  });

  it('refuses a statement past the bound when accepting and when adding', async () => {
    const w = world();
    const { invitation, token, laptop, ownerCtx } = await pending(w, 3 * DAY);
    await renewPendingInvitations(ownerCtx);
    const renewed = stored(w.srv, invitation.invitationId);
    // The server stretches the renewed statement past its chain's bound.
    const bytes = fromBase64Url(renewed.statement);
    const value = decodeProjectInvitation(bytes);
    expect(value.chainIssuedAt).toBeDefined();
    const expiresAt =
      4 +
      (1 + value.projectId.length) +
      (1 + value.invitationId.length) +
      (1 + value.inviterUserId.length) +
      32 +
      1 +
      8;
    const stretched = new Uint8Array(bytes);
    new DataView(stretched.buffer).setBigUint64(
      expiresAt,
      BigInt(value.chainIssuedAt! + MAX_PROJECT_INVITATION_CHAIN_MS + 1)
    );
    const forged = { statement: toBase64Url(stretched) };
    // The invitee's browser refuses to accept it…
    const invitee = emailDevice(w, other, 'other_laptop');
    const real = createE2eeInvitationsApi((path, init) =>
      invitee.fetcher(path, init)
    );
    const inviteeCtx = contextOf(invitee, {
      api: {
        ...real,
        accept: async (request) => {
          const answer = await real.accept(request);
          return { invitation: { ...answer.invitation, ...forged } };
        }
      }
    });
    await expect(
      acceptEncryptedInvitation(inviteeCtx, token)
    ).rejects.toMatchObject({ code: 'statement-invalid' });
    // …and the owner's browser to add anyone by it.
    const [record] = (await ownerCtx.api.sent()).invitations;
    expect(record?.invitationId).toBe(invitation.invitationId);
    await expect(
      addInvitedMember(contextOf(laptop), { ...record!, ...forged })
    ).rejects.toMatchObject({ code: 'statement-invalid' });
  });
});

describe('cancellations this device knows of', () => {
  /** Sealed tombstones of the owner on `api`, with this device's copy. */
  const ownerTombstones = async (
    api: Pick<E2eeInvitationsApi, 'tombstones' | 'saveTombstones'>
  ) => {
    const commitment = toHex(await accountKeyCommitment(owner.accountKey));
    return sealedInvitationTombstones({
      userId: OWNER,
      api,
      local: memoryInvitationStore(),
      pins: (() => {
        let pin = 0;
        return {
          read: () => pin,
          write: (sequence: number) => {
            pin = Math.max(pin, sequence);
          }
        };
      })(),
      currentKey: () => owner.accountKey.slice(),
      keyFor: async (key) =>
        toHex(key) === commitment ? owner.accountKey.slice() : null
    });
  };

  it('outlast a same-sequence record of another device the server serves instead', async () => {
    const w = world();
    const { invitation, token, laptop } = await pending(w, 3 * DAY);
    const api = createE2eeInvitationsApi((path, init) =>
      laptop.fetcher(path, init)
    );
    // Device A cancels X (the server keeps it pending: it ignored the
    // revocation).
    const deviceA = await ownerTombstones(api);
    await deviceA.cancel(invitation.invitationId);
    const ownRecord = rows<{ sequence: number }>(
      w.srv,
      'SELECT sequence FROM e2ee_invitation_tombstones WHERE user_id = ?',
      OWNER
    )[0]!;
    // Device B sealed from the same revision, so at the same sequence; the
    // server acknowledged both and now serves A only B's record.
    const sealedByB = { record: '' };
    const deviceB = await ownerTombstones({
      tombstones: async () => ({
        revision: 0,
        sequence: 0,
        record: null,
        updatedAt: null
      }),
      saveTombstones: async (request) => {
        sealedByB.record = request.record;
        return {
          revision: 1,
          sequence: 1,
          record: request.record,
          updatedAt: null
        };
      }
    });
    await deviceB.cancel('inv_other_device');
    expect(ownRecord.sequence).toBe(1);
    w.srv.db
      .prepare(
        'UPDATE e2ee_invitation_tombstones SET record = ? WHERE user_id = ?'
      )
      .run(sealedByB.record, OWNER);
    // A still knows of X, and of what B's record names.
    expect([...(await deviceA.cancelled())].sort()).toEqual(
      [invitation.invitationId, 'inv_other_device'].sort()
    );
    // It renews nothing of X…
    const ctx = contextOf(laptop, { tombstones: deviceA });
    const before = stored(w.srv, invitation.invitationId);
    expect(await renewPendingInvitations(ctx)).toEqual({
      renewed: [],
      failed: []
    });
    expect(stored(w.srv, invitation.invitationId)).toEqual(before);
    // …and adds nobody by it.
    await acceptEncryptedInvitation(
      contextOf(emailDevice(w, other, 'other_laptop')),
      token
    );
    const [record] = (await ctx.api.sent()).invitations;
    await expect(addInvitedMember(ctx, record!)).rejects.toMatchObject({
      code: 'invitation-cancelled'
    });
    // Its next write seals both again.
    await deviceA.cancel('inv_later');
    const fresh = await ownerTombstones(api);
    expect([...(await fresh.cancelled())].sort()).toEqual(
      [invitation.invitationId, 'inv_later', 'inv_other_device'].sort()
    );
  });

  it('stop an Add already in flight, at its Commit', async () => {
    const w = world();
    const { invitation, token, laptop } = await pending(w, 3 * DAY);
    const invitee = emailDevice(w, other, 'other_laptop');
    const inviteeCtx = contextOf(invitee);
    await acceptEncryptedInvitation(inviteeCtx, token);
    expect(await publishInvitationKeyPackages(inviteeCtx)).toEqual([
      invitation.invitationId
    ]);
    // Cancelled once the Add has passed its first check and claimed the
    // KeyPackages: the check before the Commit sees it.
    let reads = 0;
    const tombstones: InvitationTombstones = {
      cancelled: async () => {
        reads += 1;
        return new Set(reads > 2 ? [invitation.invitationId] : []);
      },
      cancel: async () => undefined
    };
    const ctx = contextOf(laptop, { tombstones });
    const [record] = (await ctx.api.sent()).invitations;
    await expect(
      addInvitedMember(ctx, record!, {
        confirmedIdentity: toHex(other.list.identityKeyHash)
      })
    ).rejects.toMatchObject({ code: 'invitation-cancelled' });
    // Read up front, before the claim, and again before the Commit.
    expect(reads).toBe(3);
    // The KeyPackages were claimed, and nobody was added.
    expect(
      rows<{ claimed_at: string | null }>(
        w.srv,
        'SELECT claimed_at FROM e2ee_key_packages WHERE invitation_id = ?',
        invitation.invitationId
      ).every((row) => row.claimed_at !== null)
    ).toBe(true);
    expect(
      rows(
        w.srv,
        'SELECT 1 FROM project_members WHERE project_id = ? AND user_id = ?',
        record!.projectId,
        OTHER
      )
    ).toEqual([]);
  });

  it('count a lost revocation answer as done once the tombstone is there', async () => {
    const w = world();
    const { invitation, ownerCtx, projectId } = await pending(w, 3 * DAY);
    const tombstones = memoryInvitationTombstones();
    const ctx = { ...ownerCtx, tombstones };
    // The first revocation landed, but its answer was lost.
    await ctx.api.revoke(projectId, invitation.invitationId);
    await tombstones.cancel(invitation.invitationId);
    // The retry completes rather than reporting a failure.
    await expect(
      cancelInvitation(ctx, projectId, invitation.invitationId)
    ).resolves.toBeUndefined();
    // An invitation that does not exist is still refused.
    await expect(
      cancelInvitation(ctx, projectId, 'inv_unknown')
    ).rejects.toMatchObject({ code: 'INVITATION_NOT_FOUND' });
  });
});
