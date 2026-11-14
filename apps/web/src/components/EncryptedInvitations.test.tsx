import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProjectInvitation } from '@openzcad/crypto';
import type { E2eeInvitationRecord } from '@openzcad/shared';
import type { InviteeInvitation } from '../lib/e2ee/invitations';

/**
 * Settings › Encryption › Invitations: a Join shows the role and project
 * the verified statement names and the inviter by the fingerprint of the
 * contact compared, never the server's listing or email; it confirms
 * exactly the listing shown.
 */

const syncInvitations = vi.fn<(...args: unknown[]) => Promise<unknown>>();
const confirmEncryptedInvitation =
  vi.fn<(...args: unknown[]) => Promise<unknown>>();

vi.mock('../lib/desktopBridge', () => ({
  desktopFetch: async () =>
    Response.json({ enabled: true, projectsEnabled: true })
}));
vi.mock('../lib/e2ee/encryptedProjects', () => ({
  encryptedInvitations: async () => ({})
}));
vi.mock('../lib/e2ee/invitations', () => ({
  syncInvitations: (...args: unknown[]) => syncInvitations(...args),
  confirmEncryptedInvitation: (...args: unknown[]) =>
    confirmEncryptedInvitation(...args)
}));

const { EncryptedInvitations } = await import('./EncryptedInvitations');

const record = {
  invitationId: 'inv_1',
  projectId: 'proj_1',
  inviterUserId: 'user_owner',
  // The server's listing: it says editor.
  role: 'editor'
} as unknown as E2eeInvitationRecord;

const statement = {
  projectId: 'proj_1',
  invitationId: 'inv_1',
  inviterUserId: 'user_owner',
  // The owner signed viewer.
  role: 'viewer'
} as unknown as ProjectInvitation;

function listing(overrides: Partial<InviteeInvitation> = {}) {
  const incoming: InviteeInvitation = {
    record,
    state: 'confirm',
    ownerEmail: 'someone-else@example.com',
    statement,
    statementHash: 'ab'.repeat(32),
    ownerFingerprint: '1234 5678 9012',
    ...overrides
  };
  return {
    incoming: [incoming],
    outgoing: [],
    joined: [],
    added: [],
    errors: []
  };
}

beforeEach(() => {
  syncInvitations.mockReset();
  confirmEncryptedInvitation.mockReset();
});

describe('EncryptedInvitations', () => {
  it('shows a Join from the verified statement and the compared fingerprint', async () => {
    const shown = listing();
    syncInvitations.mockResolvedValue(shown);
    confirmEncryptedInvitation.mockResolvedValue(undefined);
    render(<EncryptedInvitations ready />);
    const join = await screen.findByRole('button', {
      name: 'Join project proj_1 from Your verified contact 1234 5678 9012 as a viewer'
    });
    expect(
      screen.getByText(
        'Your verified contact 1234 5678 9012 invited you as a viewer'
      )
    ).toBeTruthy();
    // Neither the server's role nor its email text labels the Join.
    expect(screen.queryByText(/an editor/)).toBeNull();
    expect(screen.queryByText(/someone-else@example\.com/)).toBeNull();
    fireEvent.click(join);
    await waitFor(() =>
      expect(confirmEncryptedInvitation).toHaveBeenCalledOnce()
    );
    // Exactly the listing reviewed, with its statement hash.
    expect(confirmEncryptedInvitation.mock.calls[0]![1]).toBe(
      shown.incoming[0]
    );
  });

  it('offers no Join for an invitation that does not verify or names no fingerprint', async () => {
    syncInvitations.mockResolvedValue(
      listing({ state: 'invalid', statement: null, statementHash: null })
    );
    const { unmount } = render(<EncryptedInvitations ready />);
    expect(
      await screen.findByText(
        'An invitation from someone-else@example.com that does not verify'
      )
    ).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^Join/ })).toBeNull();
    unmount();

    syncInvitations.mockResolvedValue(listing({ ownerFingerprint: null }));
    render(<EncryptedInvitations ready />);
    await waitFor(() => expect(syncInvitations).toHaveBeenCalledTimes(2));
    await screen.findByText(/invited you as a viewer/);
    expect(screen.queryByRole('button', { name: /^Join/ })).toBeNull();
    expect(confirmEncryptedInvitation).not.toHaveBeenCalled();
  });
});
