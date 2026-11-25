import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within
} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import {
  createProjectDocument,
  frozenShareDocument
} from '@openzcad/document-core';
import {
  toUserId,
  type ProjectDocument,
  type AcceptProjectInvitationResponse,
  type CreateProjectInvitationResponse,
  type ProjectMemberRole,
  type ProjectSharingResponse,
  type UserId
} from '@openzcad/shared';
import type { ProjectSharingClient } from '../lib/projectSharing';
import type { ProjectShareLinkClient } from '../lib/projectShareClient';
import { setPersonalInfoVisible } from './PersonalInfo';
import {
  ProjectSharingDialog,
  type EncryptedSharingClient
} from './ProjectSharingDialog';
import type { OwnerInvitation } from '../lib/e2ee/invitations';
import type { EncryptedShareLinkClient } from './EncryptedShareLinks';
import {
  reportHeadVerified,
  reportKeysLocked,
  resetEncryptionStatus
} from '../lib/e2ee/encryptionStatus';

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
    label: string | null;
    history?: false;
    frozenAt?: number;
  }> = [];
  return {
    createProjectShareLink: vi.fn(
      async (
        projectId: string,
        mode: 'tweak' | 'view',
        label?: string | null,
        _comments?: boolean,
        frozenDocument?: ProjectDocument
      ) => {
        const createdAt = Math.floor(Date.now() / 1000);
        const shareLink = {
          shareLinkId: `share_${links.length + 1}`,
          projectId,
          mode,
          createdAt,
          revokedAt: null,
          label: label ?? null,
          ...(frozenDocument
            ? { history: false as const, frozenAt: createdAt }
            : {})
        };
        links.push(shareLink);
        return { shareLink, token: 'a'.repeat(43) };
      }
    ),
    updateProjectShareLinkSnapshot: vi.fn(
      async (_projectId: string, shareLinkId: string) => {
        const link = links.find((entry) => entry.shareLinkId === shareLinkId);
        if (!link) throw new Error('Project share link not found.');
        link.frozenAt = Math.floor(Date.now() / 1000);
        return { ...link };
      }
    ),
    listProjectShareLinks: vi.fn(async () =>
      links.map((link) => ({ ...link }))
    ),
    renameProjectShareLink: vi.fn(
      async (_projectId, shareLinkId: string, label: string | null) => {
        const link = links.find((entry) => entry.shareLinkId === shareLinkId);
        if (!link) {
          throw new Error('Project share link not found.');
        }
        link.label = label;
        return { ...link };
      }
    ),
    revokeProjectShareLink: vi.fn(async (_projectId, shareLinkId: string) => {
      const index = links.findIndex((link) => link.shareLinkId === shareLinkId);
      if (index >= 0) {
        links.splice(index, 1);
      }
    }),
    fetchSharedProject: vi.fn(async () => null)
  };
}

/** The owner's Links tab, where share links are made and listed. */
async function openLinks(
  user: { click(element: Element): Promise<void> } = userEvent
) {
  await user.click(await screen.findByRole('tab', { name: /^Links/ }));
}

/**
 * Opens a new link's options (L11: Create link alone makes a view-only link
 * at once).
 */
async function openLinkOptions(
  user: { click(element: Element): Promise<void> } = userEvent
) {
  await user.click(await screen.findByRole('button', { name: 'Options…' }));
}

/** Opens a link's card, which holds its name, settings and actions. */
async function openCard(
  name: string | RegExp,
  user: { click(element: Element): Promise<void> } = userEvent
) {
  await user.click(
    await screen.findByRole('button', { name, expanded: false })
  );
}

describe('ProjectSharingDialog', () => {
  it('shows the room refusal and offers a connection retry without publishing', async () => {
    const retry = vi.fn();
    const base = createProjectDocument('Room retry', owner);
    render(
      <ProjectSharingDialog
        projectId={base.projectId}
        role="owner"
        collaborationStatus="rejected"
        collaborationFailure="The room could not confirm this revision."
        onRetryConnection={retry}
        lease={null}
        client={client()}
        shareLinkClient={shareLinkClient()}
        onClose={vi.fn()}
      />
    );
    expect(
      screen.getByText('The room could not confirm this revision.')
    ).toBeVisible();
    await userEvent.click(
      screen.getByRole('button', { name: 'Retry connection' })
    );
    expect(retry).toHaveBeenCalledOnce();
  });

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
    // Hidden, an avatar is a person glyph with no initial in it.
    const avatars = document.querySelectorAll('.sharing-avatar');
    expect(avatars).toHaveLength(2);
    for (const avatar of avatars) {
      expect(avatar.textContent).toBe('');
      expect(avatar.querySelector('svg')).not.toBeNull();
    }
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

  it('splits people and links into tabs the arrow keys move between', async () => {
    const links = shareLinkClient();
    await links.createProjectShareLink('proj_tabs', 'view');
    const user = userEvent.setup();
    render(
      <ProjectSharingDialog
        projectId="proj_tabs"
        role="owner"
        collaborationStatus="live"
        lease={null}
        client={client()}
        shareLinkClient={links}
        onClose={vi.fn()}
      />
    );
    const people = await screen.findByRole('tab', { name: /^People/ });
    const linksTab = screen.getByRole('tab', { name: /^Links/ });
    expect(people).toHaveAttribute('aria-selected', 'true');
    // The tab says how many links there are once they are listed.
    await waitFor(() => expect(linksTab).toHaveTextContent(/^Links1$/));
    expect(screen.getByRole('tabpanel', { name: /^People/ })).toBeVisible();
    expect(
      screen.queryByRole('region', { name: 'General access' })
    ).not.toBeInTheDocument();

    people.focus();
    await user.keyboard('{ArrowRight}');
    expect(linksTab).toHaveFocus();
    expect(linksTab).toHaveAttribute('aria-selected', 'true');
    expect(
      screen.getByRole('region', { name: 'General access' })
    ).toBeVisible();
    expect(screen.getByRole('button', { name: /^View link · / })).toBeVisible();
    // Create link is one click; its options wait behind Options….
    expect(
      screen.queryByRole('radiogroup', { name: 'Link access' })
    ).not.toBeInTheDocument();
    await openLinkOptions(user);
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.getByRole('button', { name: 'Options…' })).toBeVisible();

    linksTab.focus();
    await user.keyboard('{ArrowLeft}');
    expect(people).toHaveFocus();
    expect(screen.getByRole('tabpanel', { name: /^People/ })).toBeVisible();
  });

  it('shows an encrypted link problem on the People tab it opens on', async () => {
    const encryptedLinks: EncryptedShareLinkClient = {
      list: vi.fn(async () => ({
        links: [
          {
            shareId: 'shr_a',
            mode: 'view' as const,
            url: null,
            status: 'revocation-pending' as const,
            expiresAt: null
          }
        ],
        needsConfirmation: false,
        retired: [],
        problem: 'A revoked link may still open for visitors.'
      })),
      create: vi.fn(),
      revoke: vi.fn(),
      confirm: vi.fn(),
      reissue: vi.fn(),
      subscribeRemovals: vi.fn(() => () => undefined)
    };
    const user = userEvent.setup();
    render(
      <ProjectSharingDialog
        projectId="proj_problem"
        role="owner"
        encrypted
        encryptedClient={{
          list: vi.fn(async () => []),
          invite: vi.fn(),
          revoke: vi.fn(),
          changeRole: vi.fn(),
          remove: vi.fn(),
          leave: vi.fn()
        }}
        encryptedShareLinkClient={encryptedLinks}
        collaborationStatus="live"
        lease={null}
        client={client()}
        shareLinkClient={shareLinkClient()}
        onClose={vi.fn()}
      />
    );
    const people = await screen.findByRole('tabpanel', { name: /^People/ });
    const warning = await within(people).findByRole('alert');
    expect(warning).toHaveTextContent(
      'A revoked link may still open for visitors.'
    );
    expect(
      screen.getByRole('tab', { name: /needs attention/ })
    ).toBeInTheDocument();
    await user.click(
      within(warning).getByRole('button', { name: 'Show links' })
    );
    expect(screen.getByRole('tab', { name: /^Links/ })).toHaveAttribute(
      'aria-selected',
      'true'
    );
  });

  it('keeps a link with its configuration in the field when nothing can copy it', async () => {
    const links = shareLinkClient();
    vi.spyOn(navigator.clipboard, 'writeText').mockRejectedValue(
      new Error('denied')
    );
    const execCommand = vi.fn(() => false);
    Object.defineProperty(document, 'execCommand', {
      configurable: true,
      value: execCommand
    });
    onTestFinished(() => {
      delete (document as { execCommand?: unknown }).execCommand;
    });
    const user = userEvent.setup();
    render(
      <ProjectSharingDialog
        projectId="proj_fallback"
        role="owner"
        collaborationStatus="live"
        lease={null}
        client={client()}
        shareLinkClient={links}
        configurations={[{ id: 'large', name: 'Large' }]}
        onClose={vi.fn()}
      />
    );
    await openLinks(user);
    await user.click(
      await screen.findByRole('button', { name: 'Create link' })
    );
    const url = await screen.findByLabelText('Share link');
    await user.click(
      screen.getByRole('button', {
        name: 'Copy link opening on a configuration'
      })
    );
    await user.click(screen.getByRole('menuitem', { name: 'Large' }));
    await waitFor(() => expect(execCommand).toHaveBeenCalledWith('copy'));
    expect(url).toHaveValue(
      `${location.origin}/#share=${'a'.repeat(43)}&configuration=large`
    );
    expect(screen.getByRole('button', { name: 'Copy' })).toBeVisible();
  });

  it('shows no tabs to someone who is not the owner', async () => {
    render(
      <ProjectSharingDialog
        projectId="proj_member"
        role="viewer"
        collaborationStatus="live"
        lease={null}
        client={client()}
        shareLinkClient={shareLinkClient()}
        onClose={vi.fn()}
      />
    );
    expect(
      await screen.findByText(
        'Only the project owner can manage members and invitations.'
      )
    ).toBeVisible();
    expect(screen.queryByRole('tablist')).not.toBeInTheDocument();
  });

  it('mints a commenter link when visitors may comment (L08)', async () => {
    const base = createProjectDocument('Commenter links', owner);
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
        onClose={vi.fn()}
      />
    );
    await openLinks(user);
    await openLinkOptions(user);
    const comments = await screen.findByRole('checkbox', {
      name: /Visitors can comment/
    });
    await user.click(comments);
    // The disclosure is read with the control, not only shown beside it.
    expect(comments).toHaveAccessibleDescription(
      /Visitors see every comment and sign theirs with a name\./
    );
    await user.click(screen.getByRole('button', { name: 'Create link' }));
    await waitFor(() =>
      expect(links.createProjectShareLink).toHaveBeenCalledWith(
        base.projectId,
        'tweak',
        null,
        true
      )
    );
  });

  it('mints a view link when the owner picks View', async () => {
    const base = createProjectDocument('View links', owner);
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
        onClose={vi.fn()}
      />
    );
    await openLinks(user);
    await openLinkOptions(user);
    const access = await screen.findByRole('radiogroup', {
      name: 'Link access'
    });
    // A plaintext link's options still default to Tweak.
    expect(within(access).getByRole('radio', { name: 'Tweak' })).toBeChecked();
    await user.click(within(access).getByRole('radio', { name: 'View' }));
    expect(access).toHaveAccessibleDescription(
      'Visitors can look, measure and export.'
    );
    expect(screen.getByText(/Links expire after 30 days\./)).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Create link' }));
    await waitFor(() =>
      expect(links.createProjectShareLink).toHaveBeenCalledWith(
        base.projectId,
        'view'
      )
    );
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

    // People come first; links are one tab away.
    expect(await screen.findByRole('tab', { name: /^People/ })).toHaveAttribute(
      'aria-selected',
      'true'
    );
    await openLinks(user);
    expect(
      await screen.findByRole('button', { name: 'Create link' })
    ).toBeEnabled();
    expect(screen.getByText('Only invited people')).toBeVisible();
    expect(
      screen.queryByRole('button', { name: /Revoke share link/ })
    ).not.toBeInTheDocument();

    // L11: one click makes a view-only link (with history where the model
    // cannot leave it out).
    await user.click(screen.getByRole('button', { name: 'Create link' }));
    await waitFor(() =>
      expect(links.createProjectShareLink).toHaveBeenCalledWith(
        base.projectId,
        'view'
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
    expect(
      screen.getByText('View link · shown once — copy it now.')
    ).toBeVisible();
    expect(screen.getByText('Anyone with a link · 1 active')).toBeVisible();
    expect(
      screen.getByRole('button', { name: /^View link · / })
    ).toHaveAccessibleDescription('View · Expires in 30d');
    // A plaintext link's address is shown once, so its card has no Copy.
    expect(screen.getAllByRole('button', { name: /^Cop/ })).toHaveLength(1);

    await openCard(/^View link · /, user);
    await user.click(
      screen.getByRole('button', { name: /Revoke share link created/ })
    );
    // Revoking asks first, in place, with focus on Keep link (I2).
    expect(links.revokeProjectShareLink).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Keep link' })).toHaveFocus();
    await user.click(screen.getByRole('button', { name: 'Keep link' }));
    expect(links.revokeProjectShareLink).not.toHaveBeenCalled();
    await user.click(
      screen.getByRole('button', { name: /Revoke share link created/ })
    );
    await user.click(screen.getByRole('button', { name: 'Revoke link' }));
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

  it('lets a new link open on a chosen configuration (F06)', async () => {
    const base = createProjectDocument('Share links', owner);
    const links = shareLinkClient();
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
        configurations={[
          { id: 'small', name: 'Small' },
          { id: 'large', name: 'Large' }
        ]}
        onClose={vi.fn()}
      />
    );
    await openLinks(user);
    // The configuration is a choice made when copying, not a link setting.
    expect(
      screen.queryByRole('combobox', { name: 'Opens on' })
    ).not.toBeInTheDocument();
    await user.click(
      await screen.findByRole('button', { name: 'Create link' })
    );
    const plain = `${location.origin}/#share=${'a'.repeat(43)}`;
    const url = await screen.findByLabelText('Share link');
    expect(url).toHaveValue(plain);
    const opensOn = screen.getByRole('button', {
      name: 'Copy link opening on a configuration'
    });
    await user.click(opensOn);
    const menu = screen.getByRole('menu', {
      name: 'Copy a link that opens on'
    });
    expect(
      within(menu).getByRole('menuitem', { name: 'The saved configuration' })
    ).toHaveFocus();
    await user.click(within(menu).getByRole('menuitem', { name: 'Large' }));
    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith(`${plain}&configuration=large`)
    );
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(url).toHaveValue(plain);
    // Copy itself copies the link as saved.
    await user.click(screen.getByRole('button', { name: /^Cop(y|ied)$/ }));
    await waitFor(() => expect(writeText).toHaveBeenLastCalledWith(plain));
    // Escape closes the menu, not the dialog.
    await user.click(opensOn);
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(opensOn).toHaveFocus();
  });

  it('names a new link, renames links in place, and clears a blank name', async () => {
    const base = createProjectDocument('Named links', owner);
    const links = shareLinkClient();
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(
      <ProjectSharingDialog
        projectId={base.projectId}
        projectName="Bracket rev C"
        role="owner"
        collaborationStatus="live"
        lease={null}
        client={client()}
        shareLinkClient={links}
        onClose={onClose}
      />
    );
    expect(
      screen.getByRole('heading', { name: 'Share · Bracket rev C' })
    ).toBeVisible();

    // The new link is named before it is made, in one request.
    await openLinks(user);
    await openLinkOptions(user);
    await user.type(
      await screen.findByRole('textbox', { name: 'Link name' }),
      '  Supplier   review '
    );
    await user.click(screen.getByRole('button', { name: 'Create link' }));
    await waitFor(() =>
      expect(links.createProjectShareLink).toHaveBeenCalledWith(
        base.projectId,
        'tweak',
        'Supplier review'
      )
    );
    expect(await screen.findByText('Supplier review is ready')).toBeVisible();
    expect(links.renameProjectShareLink).not.toHaveBeenCalled();
    const named = await screen.findByRole('button', {
      name: 'Supplier review'
    });
    expect(named).toHaveAccessibleDescription('Tweak · Expires in 30d');

    // Its card holds the name field; Escape discards only the edit.
    await openCard('Supplier review', user);
    const field = screen.getByRole('textbox', { name: 'Link name' });
    expect(field).toHaveValue('Supplier review');
    await user.type(field, ' draft');
    await user.keyboard('{Escape}');
    expect(onClose).not.toHaveBeenCalled();
    expect(field).toHaveValue('Supplier review');
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();

    await user.clear(field);
    await user.type(field, 'Forum post');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(links.renameProjectShareLink).toHaveBeenCalledWith(
        base.projectId,
        'share_1',
        'Forum post'
      )
    );
    expect(
      await screen.findByRole('button', { name: 'Forum post', expanded: true })
    ).toBeVisible();
    expect(
      screen.getByRole('button', { name: 'Revoke share link Forum post' })
    ).toBeInTheDocument();

    // A blank name clears it back to the dated default.
    await user.clear(screen.getByRole('textbox', { name: 'Link name' }));
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(links.renameProjectShareLink).toHaveBeenLastCalledWith(
        base.projectId,
        'share_1',
        null
      )
    );
    expect(
      await screen.findByRole('button', { name: /^Tweak link · / })
    ).toBeVisible();
  });

  it('reports an invalid name without renaming', async () => {
    const base = createProjectDocument('Long link name', owner);
    const links = shareLinkClient();
    await links.createProjectShareLink(base.projectId, 'tweak');
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
    await openLinks(user);
    await openCard(/^Tweak link · /, user);
    // maxLength keeps typed names within the limit; a pasted control
    // character is what the shared normalizer still refuses here.
    const field = screen.getByRole('textbox', { name: 'Link name' });
    fireEvent.change(field, { target: { value: 'bad\u0007name' } });
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'A link name cannot contain control characters.'
    );
    expect(links.renameProjectShareLink).not.toHaveBeenCalled();
  });

  it('confirms removing a member in place and can cancel', async () => {
    setPersonalInfoVisible(true);
    const sharing = client();
    const user = userEvent.setup();
    render(
      <ProjectSharingDialog
        projectId="proj_remove"
        role="owner"
        collaborationStatus="live"
        lease={null}
        client={sharing}
        shareLinkClient={shareLinkClient()}
        onClose={vi.fn()}
      />
    );
    await user.click(
      await screen.findByRole('button', { name: 'Remove member@example.com' })
    );
    const confirm = screen.getByRole('group', {
      name: 'Remove member@example.com'
    });
    expect(confirm).toHaveTextContent(
      'They lose access to this project right away.'
    );
    await user.click(within(confirm).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('group', { name: /^Remove / })).toBeNull();
    expect(sharing.removeMember).not.toHaveBeenCalled();

    await user.click(
      screen.getByRole('button', { name: 'Remove member@example.com' })
    );
    await user.click(
      within(
        screen.getByRole('group', { name: 'Remove member@example.com' })
      ).getByRole('button', { name: 'Remove' })
    );
    await waitFor(() =>
      expect(sharing.removeMember).toHaveBeenCalledWith('proj_remove', member)
    );
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
        revokedAt: null,
        label: null
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
    await openLinks(user);
    expect(
      await screen.findByRole('button', { name: /^View link · / })
    ).toHaveAccessibleDescription('View · Expired');
    await openCard(/^View link · /, user);
    await user.click(
      screen.getByRole('button', { name: /Revoke share link created/ })
    );
    await user.click(screen.getByRole('button', { name: 'Revoke link' }));
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
    await openLinks();
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
    await openLinks(user);
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

  function encryptedShareLinkClient(): EncryptedShareLinkClient {
    return {
      list: vi.fn(async () => ({
        links: [],
        needsConfirmation: false,
        retired: []
      })),
      create: vi.fn(async () => ({
        url: 'https://app.example/#share=x',
        shareId: 'shr_x'
      })),
      revoke: vi.fn(async () => undefined),
      confirm: vi.fn(async () => undefined),
      reissue: vi.fn(async () => undefined),
      subscribeRemovals: vi.fn(() => () => undefined)
    };
  }

  function encryptedClient(
    invitations: OwnerInvitation[]
  ): EncryptedSharingClient {
    return {
      list: vi.fn(async () => invitations),
      invite: vi.fn(async () => undefined),
      revoke: vi.fn(async () => undefined),
      changeRole: vi.fn(async () => undefined),
      remove: vi.fn(async () => undefined),
      leave: vi.fn(async () => undefined)
    };
  }

  it('shows the full verified state code and comparison guidance, hiding it when keys lock', async () => {
    resetEncryptionStatus();
    const code = '01234 56789 01234 56789 01234 56789 01234 56789';
    reportHeadVerified('proj_encrypted', code);
    render(
      <ProjectSharingDialog
        projectId="proj_encrypted"
        role="viewer"
        collaborationStatus="offline"
        lease={null}
        client={client()}
        encrypted
        encryptedClient={encryptedClient([])}
        onClose={vi.fn()}
      />
    );
    // A disclosure behind the header's Encrypted chip, closed by default.
    expect(screen.queryByText(code)).not.toBeInTheDocument();
    const chip = screen.getByRole('button', { name: 'Encrypted' });
    expect(chip).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(chip);
    expect(chip).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText(code)).toBeVisible();
    expect(
      screen.getByText(/compare this code with a collaborator/)
    ).toBeVisible();
    act(() => reportKeysLocked());
    expect(screen.queryByText(code)).not.toBeInTheDocument();
    expect(screen.getByText(/Load and verify the project/)).toBeVisible();
    resetEncryptionStatus();
  });

  it('lists invitations by where they stand, verifies, revokes and invites through MLS', async () => {
    setPersonalInfoVisible(true);
    const sharingClient = client();
    const encrypted = encryptedClient([
      {
        record: encryptedRecord('inv_keys', { acceptedByUserId: invitee }),
        state: 'waiting-for-keys',
        email: 'keys@example.com',
        statement: null,
        acceptor: null
      },
      {
        record: encryptedRecord('inv_verify', {
          acceptedByUserId: invitee,
          role: 'viewer'
        }),
        state: 'needs-acceptance',
        email: 'verify@example.com',
        statement: null,
        acceptor: {
          userId: invitee,
          identityKeyHash: 'dd'.repeat(32),
          code: '77777 88888',
          email: 'verify@example.com',
          verified: false,
          pinned: true
        }
      },
      {
        // Accepted by someone other than the address invited: a badge
        // there would name the wrong person's keys.
        record: encryptedRecord('inv_elsewhere', {
          acceptedByUserId: toUserId('user_carol')
        }),
        state: 'needs-acceptance',
        email: 'bob@example.com',
        statement: null,
        acceptor: {
          userId: 'user_carol',
          identityKeyHash: 'cc'.repeat(32),
          code: '12345 67890',
          email: 'carol@example.com',
          verified: true,
          pinned: true
        }
      },
      {
        record: encryptedRecord('inv_done', {
          acceptedByUserId: member,
          completedAt: '2026-10-24T01:00:00.000Z'
        }),
        state: 'completed',
        email: 'member@example.com',
        statement: null,
        acceptor: null
      }
    ]);
    const onVerifyContact = vi.fn();
    const links = shareLinkClient();
    const encryptedLinks = encryptedShareLinkClient();
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
        encryptedShareLinkClient={encryptedLinks}
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
      screen.getByText(/^Waiting for them to accept again · Viewer · \d+d$/)
    ).toBeVisible();
    // Verification is shown, never waited on: Not verified, with Verify….
    // Only beside the address the acceptor accepted as.
    expect(screen.getByText('Not verified')).toBeVisible();
    expect(screen.queryByText('Verified')).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Verify bob@example.com' })
    ).not.toBeInTheDocument();
    // Completed ones are members now, not pending rows.
    expect(screen.queryByText(/^Added/)).not.toBeInTheDocument();
    // Share links are the encrypted ones (slice 5-10), never the plaintext
    // routes'; what the metadata route lists is still shown.
    // Listed (and kept up) while the People tab is open.
    await waitFor(() =>
      expect(encryptedLinks.list).toHaveBeenCalledWith('proj_encrypted')
    );
    expect(screen.queryByText('pending@example.com')).toBeVisible();
    await openLinks(user);
    expect(
      screen.getByRole('region', { name: 'Encrypted share links' })
    ).toBeVisible();
    expect(screen.getAllByRole('button', { name: 'Create link' })).toHaveLength(
      1
    );
    expect(screen.queryByText('pending@example.com')).not.toBeVisible();
    await user.click(screen.getByRole('tab', { name: /^People/ }));
    expect(sharingClient.getProjectSharing).toHaveBeenCalled();
    expect(links.listProjectShareLinks).not.toHaveBeenCalled();
    expect(links.createProjectShareLink).not.toHaveBeenCalled();

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
    // Removal is the owner's MLS Commit too (slice 5-5), confirmed in place
    // where its consequence is stated; Cancel takes focus, not Remove.
    await user.click(
      screen.getByRole('button', { name: 'Remove member@example.com' })
    );
    const confirm = screen.getByRole('group', {
      name: 'Remove member@example.com'
    });
    expect(confirm).toHaveTextContent(
      /Removing someone keeps them out of every later version/
    );
    await waitFor(() =>
      expect(
        within(confirm).getByRole('button', { name: 'Cancel' })
      ).toHaveFocus()
    );
    expect(encrypted.remove).not.toHaveBeenCalled();
    await user.click(within(confirm).getByRole('button', { name: 'Remove' }));
    await waitFor(() =>
      expect(encrypted.remove).toHaveBeenCalledWith('proj_encrypted', member)
    );
    expect(sharingClient.removeMember).not.toHaveBeenCalled();
    // The owner cannot leave.
    expect(
      screen.queryByRole('button', { name: /Leave project/ })
    ).not.toBeInTheDocument();

    await user.click(
      screen.getByRole('button', { name: 'Verify verify@example.com' })
    );
    expect(onVerifyContact).toHaveBeenCalledWith(invitee);
    // Only an invitation someone accepted names a person to verify.
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

  it('invites by email alone: no contact choice, whoever accepts is added on first use', async () => {
    setPersonalInfoVisible(true);
    const encrypted = encryptedClient([]);
    const user = userEvent.setup();
    render(
      <ProjectSharingDialog
        projectId="proj_encrypted"
        role="owner"
        collaborationStatus="live"
        lease={null}
        client={client()}
        shareLinkClient={shareLinkClient()}
        encrypted
        encryptedClient={encrypted}
        encryptedShareLinkClient={encryptedShareLinkClient()}
        onClose={vi.fn()}
      />
    );
    await user.type(await screen.findByLabelText('Email'), 'Bob@Example.com');
    // One input, one button: the "email only / this contact" choice is gone.
    expect(screen.queryByRole('radiogroup')).not.toBeInTheDocument();
    expect(screen.queryByRole('radio')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Invite' }));
    await waitFor(() =>
      expect(encrypted.invite).toHaveBeenLastCalledWith(
        'proj_encrypted',
        'Bob@Example.com',
        'viewer'
      )
    );
    expect(encrypted.invite).toHaveBeenCalledOnce();
    setPersonalInfoVisible(false);
  });

  it('marks members Verified or Not verified, and never adds someone whose keys changed without Review or Trust new keys', async () => {
    setPersonalInfoVisible(true);
    const changedHash = 'ee'.repeat(32);
    const sharingClient = client();
    vi.mocked(sharingClient.getProjectSharing).mockImplementation(
      async (projectId: string) => ({
        projectId,
        ownerUserId: owner,
        members: [
          {
            userId: member,
            email: 'member@example.com',
            role: 'viewer',
            createdAt: 1,
            updatedAt: 1
          },
          {
            userId: invitee,
            email: 'changed@example.com',
            role: 'editor',
            createdAt: 1,
            updatedAt: 1
          }
        ],
        invitations: []
      })
    );
    const encrypted: EncryptedSharingClient = {
      ...encryptedClient([
        {
          record: encryptedRecord('inv_changed', {
            acceptedByUserId: toUserId('user_dana')
          }),
          state: 'keys-changed',
          email: 'dana@example.com',
          statement: null,
          acceptor: {
            userId: 'user_dana',
            identityKeyHash: 'ab'.repeat(32),
            code: '12121 21212',
            email: 'dana@example.com',
            verified: false,
            pinned: true
          }
        }
      ]),
      confirmAdd: vi.fn(async () => undefined),
      peopleTrust: vi.fn(async (userIds: readonly string[]) =>
        userIds.map((userId) =>
          userId === member
            ? {
                userId,
                verified: true,
                keyChanged: false,
                identityKeyHash: 'aa'.repeat(32)
              }
            : {
                userId,
                verified: false,
                keyChanged: true,
                identityKeyHash: changedHash
              }
        )
      ),
      trustNewKeys: vi.fn(async () => undefined),
      passkeyAvailable: vi.fn(async () => true)
    };
    const onVerifyContact = vi.fn();
    const user = userEvent.setup();
    render(
      <ProjectSharingDialog
        projectId="proj_encrypted"
        role="owner"
        collaborationStatus="live"
        lease={null}
        currentUserId={owner}
        client={sharingClient}
        shareLinkClient={shareLinkClient()}
        encrypted
        encryptedClient={encrypted}
        encryptedShareLinkClient={encryptedShareLinkClient()}
        onVerifyContact={onVerifyContact}
        onClose={vi.fn()}
      />
    );
    expect(await screen.findByText('Verified')).toBeVisible();
    // The owner's own row is never looked up.
    expect(encrypted.peopleTrust).toHaveBeenCalledWith([member, invitee]);
    const changed = await screen.findByRole('group', {
      name: "changed@example.com's encryption keys changed"
    });
    expect(changed).toHaveTextContent(
      'Nothing is shared with them automatically'
    );
    const invitation = screen.getByRole('group', {
      name: "dana@example.com's encryption keys changed"
    });
    // Nothing is added or confirmed in the background.
    expect(encrypted.confirmAdd).not.toHaveBeenCalled();
    expect(encrypted.trustNewKeys).not.toHaveBeenCalled();
    expect(
      within(invitation).queryByRole('button', { name: 'Add' })
    ).not.toBeInTheDocument();
    await user.click(within(changed).getByRole('button', { name: 'Review' }));
    expect(onVerifyContact).toHaveBeenCalledWith(invitee);
    // Trust new keys is signed: one passkey touch (or the recovery key).
    await user.click(
      within(changed).getByRole('button', { name: 'Trust new keys' })
    );
    const signMember = await screen.findByRole('dialog', {
      name: "Trust changed@example.com's new keys"
    });
    expect(encrypted.trustNewKeys).not.toHaveBeenCalled();
    await user.click(
      within(signMember).getByRole('button', { name: 'Confirm with passkey' })
    );
    await waitFor(() =>
      expect(encrypted.trustNewKeys).toHaveBeenCalledWith(
        invitee,
        changedHash,
        'passkey'
      )
    );
    await user.click(
      within(
        screen.getByRole('group', {
          name: "dana@example.com's encryption keys changed"
        })
      ).getByRole('button', { name: 'Trust new keys' })
    );
    await user.click(
      within(
        await screen.findByRole('dialog', {
          name: "Trust dana@example.com's new keys"
        })
      ).getByRole('button', { name: 'Confirm with passkey' })
    );
    await waitFor(() =>
      expect(encrypted.trustNewKeys).toHaveBeenLastCalledWith(
        'user_dana',
        'ab'.repeat(32),
        'passkey'
      )
    );
    expect(encrypted.confirmAdd).not.toHaveBeenCalled();
    setPersonalInfoVisible(false);
  });

  it('confirms someone new to the account with one signature before adding them (ADR-024 amendment 2026-11-25)', async () => {
    setPersonalInfoVisible(true);
    const encrypted: EncryptedSharingClient = {
      ...encryptedClient([
        {
          record: encryptedRecord('inv_alex', {
            acceptedByUserId: invitee,
            role: 'viewer'
          }),
          state: 'confirm-new',
          email: 'alex@example.com',
          statement: {
            projectId: 'proj_encrypted',
            role: 'viewer'
          } as OwnerInvitation['statement'],
          acceptor: {
            userId: invitee,
            identityKeyHash: 'a1'.repeat(32),
            code: '24680 13579',
            email: 'alex@example.com',
            verified: false,
            pinned: false
          }
        }
      ]),
      confirmAdd: vi.fn(async () => undefined),
      passkeyAvailable: vi.fn(async () => true)
    };
    const user = userEvent.setup();
    render(
      <ProjectSharingDialog
        projectId="proj_encrypted"
        projectName="Gearbox"
        role="owner"
        collaborationStatus="live"
        lease={null}
        client={client()}
        shareLinkClient={shareLinkClient()}
        encrypted
        encryptedClient={encrypted}
        encryptedShareLinkClient={encryptedShareLinkClient()}
        onClose={vi.fn()}
      />
    );
    const row = await screen.findByRole('group', {
      name: 'Confirm alex@example.com'
    });
    expect(row).toHaveTextContent('They are new to you');
    // Nothing is signed or added until the owner confirms, with a touch.
    await user.click(within(row).getByRole('button', { name: 'Confirm' }));
    const dialog = await screen.findByRole('dialog', {
      name: 'Confirm alex@example.com'
    });
    expect(encrypted.confirmAdd).not.toHaveBeenCalled();
    await user.click(
      within(dialog).getByRole('button', { name: 'Confirm with passkey' })
    );
    await waitFor(() =>
      expect(encrypted.confirmAdd).toHaveBeenCalledWith(
        'proj_encrypted',
        'inv_alex',
        'a1'.repeat(32),
        'passkey'
      )
    );
    setPersonalInfoVisible(false);
  });

  it('adds someone who accepted only when the owner confirms the contact code, and declines', async () => {
    setPersonalInfoVisible(true);
    const statement = {
      projectId: 'proj_encrypted',
      role: 'viewer'
    } as OwnerInvitation['statement'];
    const acceptor = (code: string, identityKeyHash: string) => ({
      userId: invitee,
      identityKeyHash,
      code,
      email: 'carol@example.com',
      verified: false,
      pinned: true
    });
    const encrypted = {
      ...encryptedClient([
        {
          record: encryptedRecord('inv_new', {
            acceptedByUserId: invitee,
            role: 'viewer'
          }),
          state: 'confirm-add',
          email: 'bob@example.com',
          statement,
          acceptor: acceptor('11111 22222', 'aa'.repeat(32))
        },
        {
          record: encryptedRecord('inv_again', { acceptedByUserId: invitee }),
          state: 'confirm-re-add',
          email: 'again@example.com',
          statement: { ...statement!, role: 'editor' },
          acceptor: acceptor('33333 44444', 'bb'.repeat(32))
        },
        {
          record: encryptedRecord('inv_other', { acceptedByUserId: invitee }),
          state: 'accepted-by-other',
          email: 'dave@example.com',
          statement,
          acceptor: acceptor('55555 66666', 'cc'.repeat(32))
        },
        {
          record: encryptedRecord('inv_older', { acceptedByUserId: invitee }),
          state: 'needs-acceptance',
          email: 'older@example.com',
          statement: null,
          acceptor: null
        }
      ]),
      confirmAdd: vi.fn(async () => undefined)
    };
    const onVerifyContact = vi.fn();
    const user = userEvent.setup();
    render(
      <ProjectSharingDialog
        projectId="proj_encrypted"
        projectName="Gearbox"
        role="owner"
        collaborationStatus="live"
        lease={null}
        client={client()}
        shareLinkClient={shareLinkClient()}
        encrypted
        encryptedClient={encrypted}
        encryptedShareLinkClient={encryptedShareLinkClient()}
        onVerifyContact={onVerifyContact}
        onClose={vi.fn()}
      />
    );
    // Named by the verified acceptor and the signed role, with the code
    // Contacts shows; never the address the invitation was sent to.
    const [first] = await screen.findAllByRole('group', {
      name: 'Confirm carol@example.com'
    });
    expect(first).toHaveTextContent(
      'carol@example.com accepted your invitation to Gearbox as a viewer. Add them?'
    );
    expect(first).toHaveTextContent('11111 22222');
    expect(first).not.toHaveTextContent('bob@example.com');
    const groups = screen.getAllByRole('group', {
      name: 'Confirm carol@example.com'
    });
    expect(groups).toHaveLength(2);
    expect(groups[1]).toHaveTextContent('as an editor');
    expect(groups[1]).toHaveTextContent('You removed them from this project');
    expect(
      screen.getByText(
        /^Accepted by someone you did not invite · Editor · \d+d$/
      )
    ).toBeVisible();
    expect(
      screen.getByText(/^Waiting for them to accept again · Editor · \d+d$/)
    ).toBeVisible();
    // Nothing happens until the owner asks for it.
    expect(encrypted.confirmAdd).not.toHaveBeenCalled();
    await user.click(
      within(groups[0]!).getByRole('button', { name: 'Open contact' })
    );
    expect(onVerifyContact).toHaveBeenCalledWith(invitee);
    await user.click(within(groups[0]!).getByRole('button', { name: 'Add' }));
    await waitFor(() =>
      expect(encrypted.confirmAdd).toHaveBeenCalledWith(
        'proj_encrypted',
        'inv_new',
        'aa'.repeat(32)
      )
    );
    await user.click(
      within(
        screen.getAllByRole('group', { name: 'Confirm carol@example.com' })[1]!
      ).getByRole('button', { name: 'Decline' })
    );
    await waitFor(() =>
      expect(encrypted.revoke).toHaveBeenCalledWith(
        'proj_encrypted',
        'inv_again'
      )
    );
    expect(encrypted.confirmAdd).toHaveBeenCalledTimes(1);
    setPersonalInfoVisible(false);
  });

  it('lets a member leave after saying what that means (slice 5-5)', async () => {
    const sharingClient = client();
    const encrypted = encryptedClient([]);
    const onLeft = vi.fn();
    const user = userEvent.setup();
    render(
      <ProjectSharingDialog
        projectId="proj_encrypted"
        role="viewer"
        collaborationStatus="offline"
        lease={null}
        client={sharingClient}
        encrypted
        encryptedClient={encrypted}
        onLeft={onLeft}
        onClose={vi.fn()}
      />
    );
    // Only the owner manages share links.
    expect(
      screen.queryByRole('region', { name: 'Encrypted share links' })
    ).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Leave project…' }));
    const confirm = screen.getByRole('group', { name: 'Leave this project' });
    expect(confirm).toHaveTextContent(
      'You lose access to this project at once'
    );
    expect(encrypted.leave).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Leave project' }));
    await waitFor(() => expect(onLeft).toHaveBeenCalled());
    expect(encrypted.leave).toHaveBeenCalledWith('proj_encrypted');
    expect(sharingClient.removeMember).not.toHaveBeenCalled();
  });

  it('offers no leaving on a plaintext project', async () => {
    render(
      <ProjectSharingDialog
        projectId="proj_plain"
        role="viewer"
        collaborationStatus="live"
        lease={null}
        client={client()}
        encryptedClient={encryptedClient([])}
        onClose={vi.fn()}
      />
    );
    expect(
      screen.getByText(
        'Only the project owner can manage members and invitations.'
      )
    ).toBeVisible();
    expect(
      screen.queryByRole('button', { name: /Leave project/ })
    ).not.toBeInTheDocument();
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
    await openLinks();
    expect(
      await screen.findByRole('button', { name: 'Create link' })
    ).toBeVisible();
    await waitFor(() => expect(links.listProjectShareLinks).toHaveBeenCalled());
    expect(encrypted.list).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('tab', { name: /^People/ }));
    expect(
      await screen.findByRole('combobox', { name: /Role for/ })
    ).toBeVisible();
  });
});

describe('ProjectSharingDialog links without history (L08)', () => {
  const owner = toUserId('user_owner');
  const frozenOf = (document: ProjectDocument, name = 'Plate') =>
    frozenShareDocument(document, [
      { name, stepText: 'ISO-10303-21;', color: null, opacity: null }
    ]);

  async function open(
    links: ProjectShareLinkClient,
    props: Partial<Parameters<typeof ProjectSharingDialog>[0]> = {}
  ) {
    const base = createProjectDocument('Bracket', owner);
    render(
      <ProjectSharingDialog
        projectId={base.projectId}
        role="owner"
        collaborationStatus="live"
        lease={null}
        client={client()}
        shareLinkClient={links}
        onClose={vi.fn()}
        {...props}
      />
    );
    await openLinks();
    return base;
  }

  it('includes history by default and offers no choice where a model cannot be frozen', async () => {
    const links = shareLinkClient();
    const base = await open(links);
    await openLinkOptions();
    expect(
      screen.queryByRole('checkbox', { name: 'Include history' })
    ).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Create link' }));
    await waitFor(() =>
      expect(links.createProjectShareLink).toHaveBeenCalledWith(
        base.projectId,
        'tweak'
      )
    );
  });

  it('makes a view-only link without history in one click (L11)', async () => {
    const links = shareLinkClient();
    let frozen: ProjectDocument | null = null;
    const onFreezeModel = vi.fn(async () => (frozen = frozenOf(base)));
    const base: ProjectDocument = await open(links, { onFreezeModel });
    await userEvent.click(
      await screen.findByRole('button', { name: 'Create link' })
    );
    await waitFor(() =>
      expect(links.createProjectShareLink).toHaveBeenCalledWith(
        base.projectId,
        'view',
        null,
        false,
        frozen
      )
    );
    expect(onFreezeModel).toHaveBeenCalledWith({ parameters: false });
  });

  it('keeps today’s link when Include history stays ticked', async () => {
    const links = shareLinkClient();
    const onFreezeModel = vi.fn();
    const base = await open(links, { onFreezeModel });
    await openLinkOptions();
    expect(
      await screen.findByRole('checkbox', { name: 'Include history' })
    ).toBeChecked();
    await userEvent.click(screen.getByRole('button', { name: 'Create link' }));
    await waitFor(() =>
      expect(links.createProjectShareLink).toHaveBeenCalledWith(
        base.projectId,
        'tweak'
      )
    );
    expect(onFreezeModel).not.toHaveBeenCalled();
  });

  it('shares only the frozen model, view only, when history is left out', async () => {
    const links = shareLinkClient();
    const user = userEvent.setup();
    let frozen: ProjectDocument | null = null;
    const onBeforeCreateShareLink = vi.fn();
    const base: ProjectDocument = await open(links, {
      onBeforeCreateShareLink,
      // A source file only on this device blocks a link to the project,
      // but a frozen model needs no file from the account.
      localImportSourceNames: ['bracket.step'],
      onFreezeModel: vi.fn(async () => (frozen = frozenOf(base)))
    });
    await openLinkOptions(user);
    const history = await screen.findByRole('checkbox', {
      name: 'Include history'
    });
    expect(screen.getByRole('button', { name: 'Create link' })).toBeDisabled();
    await user.click(history);
    const access = screen.getByRole('radiogroup', { name: 'Link access' });
    expect(within(access).getByRole('radio', { name: 'View' })).toBeChecked();
    expect(history).toHaveAccessibleDescription(
      /finished model only: no features, sketches or parameters/
    );
    await user.click(screen.getByRole('button', { name: 'Create link' }));
    await waitFor(() =>
      expect(links.createProjectShareLink).toHaveBeenCalledWith(
        base.projectId,
        'view',
        null,
        false,
        frozen
      )
    );
    expect(frozen).not.toBeNull();
    // No save is awaited: the model comes from this browser.
    expect(onBeforeCreateShareLink).not.toHaveBeenCalled();
    // The owner's list says so, and its card offers Update.
    expect(await screen.findByText(/View · No history, as of/)).toBeVisible();
    await openCard(/^View link · /, user);
    expect(
      screen.getByRole('button', { name: /^Update .* to the current model$/ })
    ).toBeVisible();
  });

  it('shares the parameters without history when Tweak is chosen', async () => {
    const links = shareLinkClient();
    const user = userEvent.setup();
    const onFreezeModel = vi.fn(async () => frozenOf(base));
    const base: ProjectDocument = await open(links, { onFreezeModel });
    await openLinkOptions(user);
    await user.click(
      await screen.findByRole('checkbox', { name: 'Include history' })
    );
    const access = screen.getByRole('radiogroup', { name: 'Link access' });
    await user.click(within(access).getByRole('radio', { name: 'Tweak' }));
    await user.click(screen.getByRole('button', { name: 'Create link' }));
    await waitFor(() =>
      expect(links.createProjectShareLink).toHaveBeenCalledWith(
        base.projectId,
        'tweak',
        null,
        false,
        expect.anything()
      )
    );
    expect(onFreezeModel).toHaveBeenLastCalledWith({ parameters: true });
    expect(await screen.findByText(/Tweak · No history, as of/)).toBeVisible();
    // Its Update shares the parameters again.
    await openCard(/^Tweak link · /, user);
    await user.click(
      await screen.findByRole('button', {
        name: /^Update .* to the current model$/
      })
    );
    await waitFor(() =>
      expect(links.updateProjectShareLinkSnapshot).toHaveBeenCalled()
    );
    expect(onFreezeModel).toHaveBeenLastCalledWith({ parameters: true });
  });

  it('makes no link when the model cannot be frozen', async () => {
    const links = shareLinkClient();
    const user = userEvent.setup();
    await open(links, {
      onFreezeModel: vi.fn(async () => {
        throw new Error('This model has no solid body to share.');
      })
    });
    await openLinkOptions(user);
    await user.click(
      await screen.findByRole('checkbox', { name: 'Include history' })
    );
    await user.click(screen.getByRole('button', { name: 'Create link' }));
    expect(
      await screen.findByText(/This model has no solid body to share\./)
    ).toBeVisible();
    expect(links.createProjectShareLink).not.toHaveBeenCalled();
  });

  it('Update freezes the current model into the same link', async () => {
    const links = shareLinkClient();
    const user = userEvent.setup();
    const models: ProjectDocument[] = [];
    const base: ProjectDocument = await open(links, {
      onFreezeModel: vi.fn(async () => {
        const next = frozenOf(base, `Plate v${models.length + 1}`);
        models.push(next);
        return next;
      })
    });
    await openLinkOptions(user);
    await user.click(
      await screen.findByRole('checkbox', { name: 'Include history' })
    );
    await user.click(screen.getByRole('button', { name: 'Create link' }));
    await openCard(/^View link · /, user);
    await user.click(
      await screen.findByRole('button', {
        name: /^Update .* to the current model$/
      })
    );
    await waitFor(() =>
      expect(links.updateProjectShareLinkSnapshot).toHaveBeenCalledWith(
        base.projectId,
        'share_1',
        models[1]
      )
    );
    expect(models).toHaveLength(2);
    // One link throughout: Update made no new one.
    expect(links.createProjectShareLink).toHaveBeenCalledTimes(1);
  });

  it('offers no Update on a link that shares its history', async () => {
    const links = shareLinkClient();
    const base = await open(links, { onFreezeModel: vi.fn() });
    await openLinkOptions();
    await userEvent.click(
      await screen.findByRole('button', { name: 'Create link' })
    );
    await waitFor(() =>
      expect(links.createProjectShareLink).toHaveBeenCalledWith(
        base.projectId,
        'tweak'
      )
    );
    await openCard(/^Tweak link · /);
    expect(
      screen.queryByRole('button', { name: /to the current model$/ })
    ).not.toBeInTheDocument();
    expect(screen.queryByText(/No history/)).not.toBeInTheDocument();
  });
});
