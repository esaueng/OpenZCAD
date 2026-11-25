import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * One pass of the invitation runner (`invitationPass.ts`): how its steps'
 * failures read to the runner. A locked device is quiet, routes closed
 * for the account close the runner, and a database without renewals yet
 * closes only renewing.
 */

const encryptedInvitations = vi.fn<() => Promise<unknown>>();
const syncInvitations = vi.fn<(...args: unknown[]) => Promise<unknown>>();
const renewPendingInvitations =
  vi.fn<(...args: unknown[]) => Promise<unknown>>();

vi.mock('./accountKeys', () => ({ loadEncryption: vi.fn() }));
vi.mock('./e2eeApi', () => ({ createE2eeApi: () => ({}) }));
vi.mock('./keychainDeviceKeys', () => ({ deviceKeyStore: () => ({}) }));
vi.mock('./encryptedProjects', () => ({
  encryptedInvitations: () => encryptedInvitations()
}));
vi.mock('./invitations', () => ({
  syncInvitations: (...args: unknown[]) => syncInvitations(...args)
}));
vi.mock('./invitationRenewal', () => ({
  renewPendingInvitations: (...args: unknown[]) =>
    renewPendingInvitations(...args)
}));

const { runInvitationPass } = await import('./invitationPass');

const ctx = { groups: { account: { userId: 'user_1' } } };
const synced = (errors: unknown[] = []) => ({
  incoming: [],
  outgoing: [],
  joined: ['proj_1'],
  added: [],
  completed: [],
  failed: [],
  errors
});
const status = (code: number) =>
  Object.assign(new Error(`HTTP ${code}`), { status: code });

beforeEach(() => {
  encryptedInvitations.mockReset();
  encryptedInvitations.mockResolvedValue(ctx);
  syncInvitations.mockReset();
  syncInvitations.mockResolvedValue(synced());
  renewPendingInvitations.mockReset();
  renewPendingInvitations.mockResolvedValue({ renewed: ['inv_1'], failed: [] });
});

describe('an invitation pass', () => {
  it('syncs, and renews only when asked', async () => {
    expect(await runInvitationPass('user_1', { renew: false })).toMatchObject({
      kind: 'ran',
      joined: ['proj_1'],
      renewed: [],
      errors: []
    });
    expect(renewPendingInvitations).not.toHaveBeenCalled();
    expect(await runInvitationPass('user_1', { renew: true })).toMatchObject({
      kind: 'ran',
      renewed: ['inv_1']
    });
    expect(renewPendingInvitations).toHaveBeenCalledWith(ctx);
  });

  it('is ineligible while the keys are locked, or for another account', async () => {
    encryptedInvitations.mockRejectedValueOnce(
      Object.assign(new Error('locked'), { code: 'E2EE_KEYS_LOCKED' })
    );
    expect(await runInvitationPass('user_1', { renew: true })).toEqual({
      kind: 'ineligible'
    });
    expect(await runInvitationPass('user_2', { renew: true })).toEqual({
      kind: 'ineligible'
    });
    expect(syncInvitations).toHaveBeenCalledTimes(0);
  });

  it('closes when the routes are closed for the account', async () => {
    syncInvitations.mockResolvedValue(synced([status(501), status(503)]));
    expect(await runInvitationPass('user_1', { renew: true })).toEqual({
      kind: 'closed'
    });
    expect(renewPendingInvitations).not.toHaveBeenCalled();
  });

  it('drops a renewal the database cannot take yet, and keeps other failures', async () => {
    const other = status(500);
    renewPendingInvitations.mockResolvedValue({
      renewed: [],
      failed: [
        { invitationId: 'inv_1', error: status(503) },
        { invitationId: 'inv_2', error: other }
      ]
    });
    expect(await runInvitationPass('user_1', { renew: true })).toMatchObject({
      kind: 'ran',
      errors: [other]
    });
  });
});
