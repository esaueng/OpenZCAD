import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProjectInvitation } from '@openzcad/crypto';
import type { E2eeInvitationRecord } from '@openzcad/shared';
import type {
  InviteeInvitation,
  OwnerInvitation
} from '../lib/e2ee/invitations';

/**
 * Settings › Encryption › Invitations: a Join shows the role and project
 * the verified statement names and the inviter by the contact code
 * Contacts shows, never the server's listing or email; it confirms
 * exactly the listing shown. An owner confirms (or declines) the contact
 * who accepted an invitation by the same code.
 */

const syncInvitations = vi.fn<(...args: unknown[]) => Promise<unknown>>();
const confirmEncryptedInvitation =
  vi.fn<(...args: unknown[]) => Promise<unknown>>();
const addInvitedMember = vi.fn<(...args: unknown[]) => Promise<unknown>>();
const declineInvitation = vi.fn<(...args: unknown[]) => Promise<unknown>>();
const requestContactVerification = vi.fn<(userId: string) => void>();

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
    confirmEncryptedInvitation(...args),
  addInvitedMember: (...args: unknown[]) => addInvitedMember(...args),
  declineInvitation: (...args: unknown[]) => declineInvitation(...args)
}));
vi.mock('../lib/e2ee/contactFocus', () => ({
  notifyContactsChanged: () => undefined,
  subscribeContactsChanged: () => () => undefined,
  requestContactVerification: (userId: string) =>
    requestContactVerification(userId)
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
    ownerCode: '12345 67890 12345',
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
  addInvitedMember.mockReset();
  declineInvitation.mockReset();
  requestContactVerification.mockReset();
});

describe('EncryptedInvitations', () => {
  it('shows a Join from the verified statement and the code Contacts shows', async () => {
    const shown = listing();
    syncInvitations.mockResolvedValue(shown);
    confirmEncryptedInvitation.mockResolvedValue(undefined);
    render(<EncryptedInvitations ready />);
    const join = await screen.findByRole('button', {
      name: 'Join project proj_1 as a viewer'
    });
    expect(
      screen.getByText(
        'Your verified contact invited you to project proj_1 as a viewer'
      )
    ).toBeTruthy();
    // The owner's contact code, as Contacts shows it, and a way there.
    expect(screen.getByLabelText('Their contact code').textContent).toBe(
      '12345 67890 12345'
    );
    fireEvent.click(screen.getByRole('button', { name: 'Open contact' }));
    expect(requestContactVerification).toHaveBeenCalledWith('user_owner');
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

  it('offers no Join for an invitation that does not verify or has no contact code', async () => {
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

    syncInvitations.mockResolvedValue(listing({ ownerCode: null }));
    render(<EncryptedInvitations ready />);
    await waitFor(() => expect(syncInvitations).toHaveBeenCalledTimes(2));
    await screen.findByText(/invited you as a viewer/);
    expect(screen.queryByRole('button', { name: /^Join/ })).toBeNull();
    expect(confirmEncryptedInvitation).not.toHaveBeenCalled();
  });

  it('asks the owner to confirm the contact who accepted, by their code, and declines cleanly', async () => {
    const outgoing: OwnerInvitation = {
      record: {
        ...record,
        inviterUserId: 'user_me',
        acceptedByUserId: 'user_carol'
      },
      state: 'confirm-add',
      // The address the owner sent it to: never the confirmation's label.
      email: 'bob@example.com',
      statement,
      acceptor: {
        userId: 'user_carol',
        identityKeyHash: 'cd'.repeat(32),
        code: '99999 88888 77777',
        email: 'carol@example.com'
      }
    };
    syncInvitations.mockResolvedValue({
      incoming: [],
      outgoing: [outgoing],
      joined: [],
      added: [],
      errors: []
    });
    addInvitedMember.mockResolvedValue(undefined);
    declineInvitation.mockResolvedValue(undefined);
    const { unmount } = render(<EncryptedInvitations ready />);
    expect(
      await screen.findByText(
        'carol@example.com accepted your invitation to project proj_1 as a viewer. Add them?'
      )
    ).toBeTruthy();
    expect(screen.getByLabelText('Their contact code').textContent).toBe(
      '99999 88888 77777'
    );
    expect(addInvitedMember).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Open contact' }));
    expect(requestContactVerification).toHaveBeenCalledWith('user_carol');
    fireEvent.click(
      screen.getByRole('button', { name: 'Add carol@example.com' })
    );
    await waitFor(() => expect(addInvitedMember).toHaveBeenCalledOnce());
    // Exactly the identity shown.
    expect(addInvitedMember.mock.calls[0]![1]).toBe(outgoing.record);
    expect(addInvitedMember.mock.calls[0]![2]).toEqual({
      confirmedIdentity: 'cd'.repeat(32)
    });
    unmount();

    render(<EncryptedInvitations ready />);
    fireEvent.click(
      await screen.findByRole('button', { name: 'Decline carol@example.com' })
    );
    await waitFor(() =>
      expect(declineInvitation).toHaveBeenCalledWith({}, 'proj_1', 'inv_1')
    );
    expect(addInvitedMember).toHaveBeenCalledOnce();
  });
});
