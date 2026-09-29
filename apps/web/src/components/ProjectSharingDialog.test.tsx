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
import { ProjectSharingDialog } from './ProjectSharingDialog';

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
          createdAt: 1_700_000_000,
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

    await screen.findByText('member@example.com');
    await user.type(screen.getByLabelText('Email'), 'new@example.com');
    await user.click(screen.getByRole('button', { name: 'Invite' }));

    expect(await screen.findByText('Working…')).toBeVisible();
    expect(
      screen.getByRole('dialog', { name: 'Project sharing' })
    ).toHaveAttribute('aria-busy', 'true');
  });

  it('labels every live session belonging to the signed-in user', () => {
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

    // Two sessions of one account are one person, so one row.
    expect(screen.getAllByText('test-user (you)')).toHaveLength(1);
    expect(screen.getByText('alex')).toBeVisible();
    expect(screen.queryByText('alex (you)')).not.toBeInTheDocument();
    expect(screen.getByText('Viewer')).toBeVisible();
    expect(screen.getByText('idle')).toBeVisible();
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
    expect(await screen.findByText('member@example.com')).toBeVisible();
    expect(screen.getByText('pending@example.com')).toBeVisible();
    expect(screen.getByText('Invited · editor · expired')).toBeVisible();
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
    expect(screen.queryByText('one-time-token')).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /copy invitation/i })
    ).not.toBeInTheDocument();
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
