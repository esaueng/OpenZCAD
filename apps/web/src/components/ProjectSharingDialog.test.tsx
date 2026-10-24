import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { createProjectDocument } from '@openzcad/document-core';
import {
  toUserId,
  type AcceptProjectInvitationResponse,
  type CreateProjectInvitationResponse,
  type ProjectMemberRole,
  type ProjectSharingResponse,
  type UserId
} from '@openzcad/shared';
import type { ProjectSharingClient } from '../lib/projectSharing';
import type { ProjectShareLinkClient } from '../lib/projectShareClient';
import { setPersonalInfoVisible } from './PersonalInfoToggle';
import {
  ProjectSharingDialog,
  type EncryptedSharingClient
} from './ProjectSharingDialog';
import type { OwnerInvitation } from '../lib/e2ee/invitations';

const owner = toUserId('user_sharing_owner');
const member = toUserId('user_sharing_member');

function client(): ProjectSharingClient {
  return {
    getProjectSharing: vi.fn(
      async (projectId: string): Promise<ProjectSharingResponse> => ({
        projectId,
        ownerUserId: owner,
        members: [
          {
            userId: member,
            email: 'member@example.com',
            role: 'viewer',
            createdAt: 1,
            updatedAt: 1
          }
        ],
        invitations: [
          {
            invitationId: 'invite_pending',
            projectId,
            email: 'pending@example.com',
            role: 'editor',
            createdAt: 1,
            expiresAt: 2
          }
        ]
      })
    ),
    createInvitation: vi.fn(
      async (
        projectId: string,
        email: string,
        role: ProjectMemberRole
      ): Promise<CreateProjectInvitationResponse> => ({
        invitation: {
          invitationId: 'invite_new',
          projectId,
          email,
          role,
          createdAt: 1,
          expiresAt: 2
        },
        token: 'one-time-token'
      })
    ),
    revokeInvitation: vi.fn(async () => undefined),
    updateMemberRole: vi.fn(
      async (
        _projectId: string,
        userId: UserId,
        role: ProjectMemberRole
      ): Promise<{ userId: UserId; role: ProjectMemberRole }> => ({
        userId,
        role
      })
    ),
    removeMember: vi.fn(async () => undefined),
    acceptInvitation: vi.fn(
      async (): Promise<AcceptProjectInvitationResponse> => ({
        projectId: 'project',
        role: 'viewer'
      })
    )
  };
}

function shareLinkClient(): ProjectShareLinkClient {
  const links: Array<{
    shareLinkId: string;
    projectId: string;
    mode: 'tweak' | 'view';
    createdAt: number;
    revokedAt: null;
  }> = [];
  return {
    createProjectShareLink: vi.fn(
      async (projectId: string, mode: 'tweak' | 'view') => {
        const shareLink = {
          shareLinkId: `share_${links.length + 1}`,
          projectId,
          mode,
          createdAt: Math.floor(Date.now() / 1000),
          revokedAt: null
        };
        links.push(shareLink);
        return { shareLink, token: 'a'.repeat(43) };
      }
    ),
    listProjectShareLinks: vi.fn(async () => [...links]),
    revokeProjectShareLink: vi.fn(async (_projectId, shareLinkId: string) => {
      const index = links.findIndex((link) => link.shareLinkId === shareLinkId);
      if (index >= 0) {
        links.splice(index, 1);
      }
    }),
    fetchSharedProject: vi.fn(async () => null)
  };
}

describe('ProjectSharingDialog', () => {
  it('hydrates owner data without flashing the action status row', async () => {
    const sharingClient = client();
    vi.mocked(sharingClient.getProjectSharing).mockImplementation(
      () => new Promise<ProjectSharingResponse>(() => undefined)
    );
    const base = createProjectDocument('Quiet hydration', owner);
    render(
      <ProjectSharingDialog
        projectId={base.projectId}
        role="owner"
        collaborationStatus="live"
        lease={null}
        client={sharingClient}
        shareLinkClient={shareLinkClient()}
        onClose={vi.fn()}
      />
    );

    await waitFor(() =>
      expect(sharingClient.getProjectSharing).toHaveBeenCalledWith(
        base.projectId
      )
    );
    expect(screen.queryByText('Working…')).not.toBeInTheDocument();
    expect(
      screen.getByRole('dialog', { name: 'Project sharing' })
    ).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByRole('button', { name: 'Invite' })).toBeDisabled();
  });

  it('shows progress for an explicit sharing action', async () => {
    const sharingClient = client();
    vi.mocked(sharingClient.createInvitation).mockImplementation(
      () => new Promise<CreateProjectInvitationResponse>(() => undefined)
    );
    const base = createProjectDocument('Action progress', owner);
    const user = userEvent.setup();
    render(
      <ProjectSharingDialog
        projectId={base.projectId}
        role="owner"
        collaborationStatus="live"
        lease={null}
        client={sharingClient}
        shareLinkClient={shareLinkClient()}
        onClose={vi.fn()}
      />
    );

    await screen.findByText('Collaborator 1');
    await user.type(screen.getByLabelText('Email'), 'new@example.com');
    await user.click(screen.getByRole('button', { name: 'Invite' }));

    expect(await screen.findByText('Working…')).toBeVisible();
    expect(
      screen.getByRole('dialog', { name: 'Project sharing' })
    ).toHaveAttribute('aria-busy', 'true');
  });

  it('hides live names and initials until Settings reveals them, while identifying your sessions', () => {
    const base = createProjectDocument('Shared sessions', owner);
    render(
      <ProjectSharingDialog
        projectId={base.projectId}
        role="viewer"
        collaborationStatus="live"
        lease={null}
        currentUserId={owner}
        liveMembers={[
          {
            clientId: 'client_owner_one',
            userId: owner,
            displayName: 'test-user',
            status: 'active'
          },
          {
            clientId: 'client_owner_two',
            userId: owner,
            displayName: 'test-user',
            status: 'active'
          },
          {
            clientId: 'client_member',
            userId: member,
            displayName: 'alex',
            status: 'idle'
          }
        ]}
        client={client()}
        onClose={vi.fn()}
      />
    );

    expect(screen.getByText('You')).toBeVisible();
    // Numbered among the others: the self row used to make alex number 2.
    expect(screen.getByText('Collaborator 1')).toBeVisible();
    expect(screen.queryByText('Collaborator 2')).not.toBeInTheDocument();
    expect(screen.queryByText('alex')).not.toBeInTheDocument();
    expect(screen.getAllByText('?')).toHaveLength(2);
    // Settings owns the only switch; the dialog just follows it.
    expect(
      screen.queryByRole('button', { name: /personal info/i })
    ).not.toBeInTheDocument();
    act(() => setPersonalInfoVisible(true));
    // Two sessions of one account are one person, so one row.
    expect(screen.getAllByText('test-user (you)')).toHaveLength(1);
    expect(screen.getByText('alex')).toBeVisible();
    expect(screen.queryByText('alex (you)')).not.toBeInTheDocument();
    expect(screen.getByText('Viewer')).toBeVisible();
    expect(screen.getByText('Idle')).toBeVisible();
    act(() => setPersonalInfoVisible(false));
    expect(screen.queryByText('alex')).not.toBeInTheDocument();
  });

  it('exposes an accessible owner dialog and typed invitation/member controls', async () => {
    const sharingClient = client();
    const base = createProjectDocument('Shared', owner);
    const user = userEvent.setup();
    render(
      <ProjectSharingDialog
        projectId={base.projectId}
        role="owner"
        collaborationStatus="live"
        lease={null}
        client={sharingClient}
        shareLinkClient={shareLinkClient()}
        onClose={vi.fn()}
      />
    );

    expect(
      screen.getByRole('dialog', { name: 'Project sharing' })
    ).toHaveAttribute('aria-modal', 'true');
    expect(screen.getByRole('contentinfo')).toHaveTextContent(
      'Live · only you · edit lease not held'
    );
    expect(await screen.findByText('Collaborator 1')).toBeVisible();
    const dialog = screen.getByRole('dialog');
    expect(dialog.innerHTML).not.toContain('member@example.com');
    expect(dialog.innerHTML).not.toContain('pending@example.com');
    expect(screen.getByLabelText('Role for Collaborator 1')).toHaveValue(
      'viewer'
    );
    act(() => setPersonalInfoVisible(true));
    expect(await screen.findByText('member@example.com')).toBeVisible();
    expect(screen.getByText('pending@example.com')).toBeVisible();
    expect(screen.getByText('Invited · Editor · expired')).toBeVisible();
    expect(screen.getByLabelText('Role for member@example.com')).toHaveValue(
      'viewer'
    );
    expect(
      screen.getByRole('button', {
        name: 'Revoke invitation for pending@example.com'
      })
    ).toBeEnabled();

    await user.type(screen.getByLabelText('Email'), 'new@example.com');
    await user.selectOptions(
      screen.getByLabelText('Role', { selector: 'select' }),
      'editor'
    );
    await user.click(screen.getByRole('button', { name: 'Invite' }));

    await waitFor(() =>
      expect(sharingClient.createInvitation).toHaveBeenCalledWith(
        base.projectId,
        'new@example.com',
        'editor'
      )
    );
    expect(
      screen.getByText('Invitation sent to new@example.com.')
    ).toBeVisible();
    act(() => setPersonalInfoVisible(false));
    expect(screen.getByText('Invitation sent.')).toBeVisible();
    expect(dialog.innerHTML).not.toContain('new@example.com');
    expect(dialog.innerHTML).not.toContain('member@example.com');
    expect(dialog.innerHTML).not.toContain('pending@example.com');
    expect(screen.queryByText('one-time-token')).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /copy invitation/i })
    ).not.toBeInTheDocument();
  });

  it('shows an active invitation as time remaining when expiry is in seconds', async () => {
    const sharingClient = client();
    const nowSeconds = Math.floor(Date.now() / 1000);
    vi.mocked(sharingClient.getProjectSharing).mockImplementation(
      async (projectId) => ({
        projectId,
        ownerUserId: owner,
        members: [],
        invitations: [
          {
            invitationId: 'invite_future',
            projectId,
            email: 'future@example.com',
            role: 'editor',
            createdAt: nowSeconds,
            expiresAt: nowSeconds + 3 * 86_400
          }
        ]
      })
    );
    const base = createProjectDocument('Active invitation', owner);

    render(
      <ProjectSharingDialog
        projectId={base.projectId}
        role="owner"
        collaborationStatus="live"
        lease={null}
        client={sharingClient}
        shareLinkClient={shareLinkClient()}
        onClose={vi.fn()}
      />
    );

    // Personal info starts hidden, so the row carries its redacted label.
    const invitation = await screen.findByText('Invitation 1');
    // Rounded up: a fresh 3-day invitation read "2d".
    expect(invitation.closest('li')).toHaveTextContent('Invited · Editor · 3d');
  });

  it('returns focus inside the dialog once an action settles', async () => {
    const sharingClient = client();
    let failRoleChange!: (error: Error) => void;
    vi.mocked(sharingClient.updateMemberRole).mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          failRoleChange = reject;
        })
    );
    const base = createProjectDocument('Focus after actions', owner);
    const user = userEvent.setup();
    render(
      <ProjectSharingDialog
        projectId={base.projectId}
        role="owner"
        collaborationStatus="live"
        lease={null}
        client={sharingClient}
        shareLinkClient={shareLinkClient()}
        onClose={vi.fn()}
      />
    );
    const dialog = screen.getByRole('dialog', { name: 'Project sharing' });

    // The revoked invitation's row, and the button in it, are gone.
    const revoke = await screen.findByRole('button', {
      name: 'Revoke invitation for Invitation 1'
    });
    vi.mocked(sharingClient.getProjectSharing).mockImplementation(
      async (projectId) => ({
        projectId,
        ownerUserId: owner,
        members: [
          {
            userId: member,
            email: 'member@example.com',
            role: 'viewer',
            createdAt: 1,
            updatedAt: 1
          }
        ],
        invitations: []
      })
    );
    await user.click(revoke);
    await waitFor(() => expect(revoke).not.toBeInTheDocument());
    await waitFor(() => expect(dialog).toHaveFocus());

    // A failed action keeps its control, which gets focus back with the
    // error. Chrome drops focus from a control once it is disabled; happy-dom
    // keeps it there, so the drop is made by hand.
    const roleSelect = screen.getByLabelText<HTMLSelectElement>(
      'Role for Collaborator 1'
    );
    await user.selectOptions(roleSelect, 'editor');
    expect(roleSelect).toBeDisabled();
    act(() => {
      roleSelect.disabled = false;
      roleSelect.blur();
      roleSelect.disabled = true;
    });
    expect(document.activeElement).toBe(document.body);
    await act(async () =>
      failRoleChange(new Error('The role could not be changed.'))
    );
    expect(screen.getByText('The role could not be changed.')).toBeVisible();
    expect(roleSelect).toHaveFocus();
  });

  it('closes on Escape once focus has fallen out of it', async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(
      <ProjectSharingDialog
        projectId="project"
        role="viewer"
        collaborationStatus="live"
        lease={null}
        client={client()}
        onClose={onClose}
      />
    );
    (document.activeElement as HTMLElement | null)?.blur();
    expect(document.activeElement).toBe(document.body);
    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('mints a share link shown once, copies it, and revokes active links', async () => {
    const base = createProjectDocument('Share links', owner);
    const links = shareLinkClient();
    const beforeCreate = vi.fn(async () => undefined);
    const writeText = vi.fn(async () => undefined);
    vi.spyOn(navigator.clipboard, 'writeText').mockImplementation(writeText);
    const user = userEvent.setup();
    render(
      <ProjectSharingDialog
        projectId={base.projectId}
        role="owner"
        collaborationStatus="live"
        lease={null}
        client={client()}
        shareLinkClient={links}
        onBeforeCreateShareLink={beforeCreate}
        onClose={vi.fn()}
      />
    );

    expect(
      await screen.findByRole('button', { name: 'Create link' })
    ).toBeEnabled();
    expect(screen.getByText('Anyone with the link')).toBeVisible();
    expect(
      screen.getByText(
        'Links expire 30 days after creation. Create a new link to share again.'
      )
    ).toBeVisible();
    expect(
      screen.getByText(
        'Opens in Tweak: parameters and export, no account needed.'
      )
    ).toBeVisible();
    expect(
      screen.queryByRole('button', { name: /Revoke share link/ })
    ).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Create link' }));
    await waitFor(() =>
      expect(links.createProjectShareLink).toHaveBeenCalledWith(
        base.projectId,
        'tweak'
      )
    );
    expect(beforeCreate).toHaveBeenCalledOnce();
    const url = screen.getByLabelText('Share link');
    expect(url).toHaveValue(`${location.origin}/#share=${'a'.repeat(43)}`);
    await user.click(screen.getByRole('button', { name: 'Copy' }));
    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith(
        `${location.origin}/#share=${'a'.repeat(43)}`
      )
    );
    expect(screen.getByRole('button', { name: 'Copied' })).toBeVisible();
    expect(screen.getByText('Shown once — copy it now.')).toBeVisible();
    expect(screen.getByText(/^Link created /)).toBeVisible();
    expect(screen.getByText(/^Link created /)).toHaveTextContent(
      'Expires in 30d'
    );
    expect(screen.getByText(/^Link created /).closest('li')).toHaveTextContent(
      /Tweak/
    );

    await user.click(
      screen.getByRole('button', { name: /Revoke share link created/ })
    );
    await waitFor(() =>
      expect(links.revokeProjectShareLink).toHaveBeenCalledWith(
        base.projectId,
        'share_1'
      )
    );
    await waitFor(() =>
      expect(
        screen.queryByRole('button', { name: /Revoke share link/ })
      ).not.toBeInTheDocument()
    );
    expect(screen.queryByLabelText('Share link')).not.toBeInTheDocument();
  });

  it('labels an expired link and keeps it revocable', async () => {
    const base = createProjectDocument('Expired share link', owner);
    const links = shareLinkClient();
    vi.mocked(links.listProjectShareLinks).mockResolvedValue([
      {
        shareLinkId: 'share_old',
        projectId: base.projectId,
        mode: 'view',
        createdAt: 1,
        revokedAt: null
      }
    ]);
    const user = userEvent.setup();
    render(
      <ProjectSharingDialog
        projectId={base.projectId}
        role="owner"
        collaborationStatus="live"
        lease={null}
        client={client()}
        shareLinkClient={links}
        onClose={vi.fn()}
      />
    );
    expect(await screen.findByText(/^Link created /)).toHaveTextContent(
      'Expired'
    );
    await user.click(
      screen.getByRole('button', { name: /Revoke share link created/ })
    );
    expect(links.revokeProjectShareLink).toHaveBeenCalledWith(
      base.projectId,
      'share_old'
    );
  });

  it('blocks a new link while a STEP source exists only on this device', async () => {
    const base = createProjectDocument('Local source', owner);
    const links = shareLinkClient();
    render(
      <ProjectSharingDialog
        projectId={base.projectId}
        role="owner"
        collaborationStatus="live"
        lease={null}
        localImportSourceNames={['synthetic.step']}
        client={client()}
        shareLinkClient={links}
        onClose={vi.fn()}
      />
    );
    expect(
      await screen.findByText(/Save the source files for synthetic.step/)
    ).toBeVisible();
    expect(screen.getByRole('button', { name: 'Create link' })).toBeDisabled();
    expect(links.createProjectShareLink).not.toHaveBeenCalled();
  });

  it('does not issue a link if the account copy cannot be brought current', async () => {
    const base = createProjectDocument('Unsynced', owner);
    const links = shareLinkClient();
    const user = userEvent.setup();
    render(
      <ProjectSharingDialog
        projectId={base.projectId}
        role="owner"
        collaborationStatus="live"
        lease={null}
        client={client()}
        shareLinkClient={links}
        onBeforeCreateShareLink={async () => {
          throw new Error('Save this project before creating a link.');
        }}
        onClose={vi.fn()}
      />
    );
    await user.click(
      await screen.findByRole('button', { name: 'Create link' })
    );
    expect(
      await screen.findByText('Save this project before creating a link.')
    ).toBeVisible();
    expect(links.createProjectShareLink).not.toHaveBeenCalled();
  });

  it('keeps editor assignment unavailable when lease enforcement is off', async () => {
    const base = createProjectDocument('Viewer-only rollout', owner);
    render(
      <ProjectSharingDialog
        projectId={base.projectId}
        role="owner"
        collaborationStatus="live"
        lease={null}
        editorInvitationsEnabled={false}
        client={client()}
        shareLinkClient={shareLinkClient()}
        onClose={vi.fn()}
      />
    );

    expect(screen.getByLabelText('Role', { selector: 'select' })).toHaveValue(
      'viewer'
    );
    expect(screen.getByRole('option', { name: 'Editor' })).toBeDisabled();
  });
});

it('offers account storage for a local import instead of an ownership error', async () => {
  const api = client();
  const save = vi.fn();
  render(
    <ProjectSharingDialog
      projectId="local-import"
      role={null}
      collaborationStatus="offline"
      lease={null}
      localProject
      client={api}
      onSaveToAccount={save}
      onClose={() => {}}
    />
  );
  expect(
    screen.queryByText(
      'Only the project owner can manage members and invitations.'
    )
  ).not.toBeInTheDocument();
  expect(api.getProjectSharing).not.toHaveBeenCalled();
  await userEvent.click(
    screen.getByRole('button', { name: 'Save to my account' })
  );
  expect(save).toHaveBeenCalledTimes(1);
});

it('hangs from the top bar sharing chip and follows it on resize', async () => {
  const chip = document.createElement('button');
  chip.className = 'collaboration-state';
  document.body.append(chip);
  let right = 1000;
  vi.spyOn(chip, 'getBoundingClientRect').mockImplementation(
    () => ({ right, width: 80 }) as DOMRect
  );
  const width = window.innerWidth;
  try {
    render(
      <ProjectSharingDialog
        projectId="anchored"
        role="owner"
        collaborationStatus="live"
        lease={null}
        client={client()}
        shareLinkClient={shareLinkClient()}
        onClose={vi.fn()}
      />
    );
    const backdrop = screen.getByRole('dialog', { name: 'Project sharing' })
      .parentElement as HTMLElement;
    expect(backdrop.style.getPropertyValue('--sharing-anchor-right')).toBe(
      `${width - 1000}px`
    );
    expect(backdrop.style.getPropertyValue('--sharing-anchor-centre')).toBe(
      '40px'
    );

    right = width - 5;
    act(() => {
      window.dispatchEvent(new Event('resize'));
    });
    // Never closer to the viewport edge than the modal gutter.
    expect(backdrop.style.getPropertyValue('--sharing-anchor-right')).toBe(
      '12px'
    );
  } finally {
    chip.remove();
  }
});

it('names the self row from the account when no session is live', async () => {
  const base = createProjectDocument('Named self', owner);
  const { rerender } = render(
    <ProjectSharingDialog
      projectId={base.projectId}
      role="owner"
      collaborationStatus="offline"
      lease={null}
      currentUserId={owner}
      currentUserName="peter"
      client={client()}
      shareLinkClient={shareLinkClient()}
      onClose={vi.fn()}
    />
  );
  expect(screen.getByText('You')).toBeVisible();
  expect(screen.queryByText('peter (you)')).not.toBeInTheDocument();
  act(() => setPersonalInfoVisible(true));
  expect(await screen.findByText('peter (you)')).toBeVisible();
  expect(screen.getByText('Owner')).toBeVisible();

  rerender(
    <ProjectSharingDialog
      projectId={base.projectId}
      role="owner"
      collaborationStatus="offline"
      lease={null}
      currentUserId={owner}
      client={client()}
      shareLinkClient={shareLinkClient()}
      onClose={vi.fn()}
    />
  );
  expect(screen.getByText('You')).toBeVisible();
  expect(screen.queryByText(/\(you\)/)).not.toBeInTheDocument();
});

it('distinguishes an unresolved account role from a non-owner role', () => {
  render(
    <ProjectSharingDialog
      projectId="account-project"
      role={null}
      collaborationStatus="connecting"
      lease={null}
      onClose={() => {}}
    />
  );
  expect(
    screen.getByText(
      'Connecting to project sharing. Your cloud access has not been confirmed yet.'
    )
  ).toBeInTheDocument();
  expect(
    screen.queryByText(
      'Only the project owner can manage members and invitations.'
    )
  ).not.toBeInTheDocument();
});

it('shows an account save failure inside the local project dialog and allows retry', async () => {
  const save = vi
    .fn()
    .mockRejectedValueOnce(new Error('Account storage is unavailable'))
    .mockResolvedValue(undefined);
  render(
    <ProjectSharingDialog
      projectId="local-import"
      role={null}
      collaborationStatus="offline"
      lease={null}
      localProject
      onSaveToAccount={save}
      onClose={() => {}}
    />
  );
  await userEvent.click(
    screen.getByRole('button', { name: 'Save to my account' })
  );
  expect(await screen.findByRole('alert')).toHaveTextContent(
    'Account storage is unavailable'
  );
  await userEvent.click(
    screen.getByRole('button', { name: 'Save to my account' })
  );
  await waitFor(() =>
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  );
  expect(save).toHaveBeenCalledTimes(2);
});

describe('ProjectSharingDialog for an encrypted project (slice 5-3b)', () => {
  const invitee = toUserId('user_encrypted_invitee');

  function encryptedRecord(
    invitationId: string,
    overrides: Partial<OwnerInvitation['record']> = {}
  ): OwnerInvitation['record'] {
    return {
      invitationId,
      projectId: 'proj_encrypted',
      inviterUserId: owner,
      role: 'editor',
      emailHash: 'ab'.repeat(32),
      statement: 'AA',
      signature: 'AA',
      signerDeviceId: 'dev_owner',
      createdAt: '2026-10-24T00:00:00.000Z',
      expiresAt: Date.now() + 3 * 86_400_000,
      acceptedByUserId: null,
      acceptedAt: null,
      completedAt: null,
      completedEpoch: null,
      revokedAt: null,
      ...overrides
    };
  }

  function encryptedClient(
    invitations: OwnerInvitation[]
  ): EncryptedSharingClient {
    return {
      list: vi.fn(async () => invitations),
      invite: vi.fn(async () => undefined),
      revoke: vi.fn(async () => undefined),
      changeRole: vi.fn(async () => undefined)
    };
  }

  it('lists invitations by where they stand, verifies, revokes and invites through MLS', async () => {
    setPersonalInfoVisible(true);
    const sharingClient = client();
    const encrypted = encryptedClient([
      {
        record: encryptedRecord('inv_keys', { acceptedByUserId: invitee }),
        state: 'waiting-for-keys',
        email: 'keys@example.com'
      },
      {
        record: encryptedRecord('inv_verify', {
          acceptedByUserId: invitee,
          role: 'viewer'
        }),
        state: 'waiting-for-verification',
        email: 'verify@example.com'
      },
      {
        record: encryptedRecord('inv_done', {
          acceptedByUserId: member,
          completedAt: '2026-10-24T01:00:00.000Z'
        }),
        state: 'completed',
        email: 'member@example.com'
      }
    ]);
    const onVerifyContact = vi.fn();
    const links = shareLinkClient();
    const user = userEvent.setup();
    render(
      <ProjectSharingDialog
        projectId="proj_encrypted"
        role="owner"
        collaborationStatus="live"
        lease={null}
        client={sharingClient}
        shareLinkClient={links}
        encrypted
        encryptedClient={encrypted}
        editorInvitationsEnabled={false}
        onVerifyContact={onVerifyContact}
        onClose={vi.fn()}
      />
    );
    expect(await screen.findByText('keys@example.com')).toBeVisible();
    expect(
      screen.getByText(/^Waiting for keys · Editor · \d+d$/)
    ).toBeVisible();
    expect(
      screen.getByText(/^Waiting for you to verify · Viewer · \d+d$/)
    ).toBeVisible();
    // Completed ones are members now, not pending rows.
    expect(screen.queryByText(/^Added/)).not.toBeInTheDocument();
    // No share links yet (slice 5-10); what the metadata route lists is
    // still shown.
    expect(
      screen.queryByRole('button', { name: 'Create link' })
    ).not.toBeInTheDocument();
    expect(screen.queryByText('pending@example.com')).toBeVisible();
    expect(sharingClient.getProjectSharing).toHaveBeenCalled();
    expect(links.listProjectShareLinks).not.toHaveBeenCalled();

    // Roles change by the owner's MLS Commit (slice 5-4), never through the
    // plaintext route, and editors need no edit-lease rollout.
    const roleSelect = screen.getByRole('combobox', {
      name: 'Role for member@example.com'
    });
    expect(roleSelect).toHaveValue('viewer');
    await user.selectOptions(roleSelect, 'editor');
    await waitFor(() =>
      expect(encrypted.changeRole).toHaveBeenCalledWith(
        'proj_encrypted',
        member,
        'editor'
      )
    );
    expect(sharingClient.updateMemberRole).not.toHaveBeenCalled();
    for (const option of screen.getAllByRole('option', { name: 'Editor' })) {
      expect(option).not.toBeDisabled();
    }

    await user.click(
      screen.getByRole('button', { name: 'Verify verify@example.com' })
    );
    expect(onVerifyContact).toHaveBeenCalledWith(invitee);
    // Only an invitation waiting for verification offers it.
    expect(
      screen.queryByRole('button', { name: 'Verify keys@example.com' })
    ).not.toBeInTheDocument();

    await user.click(
      screen.getByRole('button', {
        name: 'Revoke invitation for keys@example.com'
      })
    );
    await waitFor(() =>
      expect(encrypted.revoke).toHaveBeenCalledWith(
        'proj_encrypted',
        'inv_keys'
      )
    );

    await user.type(screen.getByLabelText('Email'), 'New@Example.com');
    await user.click(screen.getByRole('button', { name: 'Invite' }));
    await waitFor(() =>
      expect(encrypted.invite).toHaveBeenCalledWith(
        'proj_encrypted',
        'New@Example.com',
        'viewer'
      )
    );
    expect(sharingClient.createInvitation).not.toHaveBeenCalled();
    expect(
      await screen.findByText('Invitation sent to new@example.com.')
    ).toBeVisible();
    setPersonalInfoVisible(false);
  });

  it('leaves plaintext sharing exactly as it was', async () => {
    const sharingClient = client();
    const encrypted = encryptedClient([]);
    const links = shareLinkClient();
    render(
      <ProjectSharingDialog
        projectId="proj_plain"
        role="owner"
        collaborationStatus="live"
        lease={null}
        client={sharingClient}
        shareLinkClient={links}
        encryptedClient={encrypted}
        onClose={vi.fn()}
      />
    );
    expect(
      await screen.findByRole('button', { name: 'Create link' })
    ).toBeVisible();
    await waitFor(() => expect(links.listProjectShareLinks).toHaveBeenCalled());
    expect(encrypted.list).not.toHaveBeenCalled();
    expect(
      await screen.findByRole('combobox', { name: /Role for/ })
    ).toBeVisible();
  });
});
