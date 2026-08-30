import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { createProjectDocument } from '@openzcad/document-core';
import {
  toUserId,
  type AcceptProjectInvitationResponse,
  type CreateProjectInvitationResponse,
  type ProjectDocument,
  type ProjectMemberRole,
  type ProjectSharingResponse,
  type UserId
} from '@openzcad/shared';
import type { ConflictResolutionHandlers } from '../lib/conflictRecovery';
import type { ProjectSharingClient } from '../lib/projectSharing';
import type { ProjectShareLinkClient } from '../lib/projectShareClient';
import { ProjectSharingDialog } from './ProjectSharingDialog';

const owner = toUserId('user_sharing_owner');
const member = toUserId('user_sharing_member');

function version(document: ProjectDocument, value: number): ProjectDocument {
  return { ...structuredClone(document), version: value };
}

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
      const index = links.findIndex(
        (link) => link.shareLinkId === shareLinkId
      );
      if (index >= 0) {
        links.splice(index, 1);
      }
    }),
    fetchSharedProject: vi.fn(async () => null)
  };
}

function recoveryHandlers(calls: string[] = []): ConflictResolutionHandlers {
  return {
    writeRecoveryCopy: vi.fn(async () => {
      calls.push('recovery');
    }),
    useRemoteVersion: vi.fn(async () => {
      calls.push('room');
    }),
    keepMyVersion: vi.fn(async () => {
      calls.push('mine');
    }),
    saveLocalAsCopy: vi.fn(async () => {
      calls.push('copy');
    })
  };
}

describe('ProjectSharingDialog', () => {
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

    expect(screen.getAllByText('test-user (you)')).toHaveLength(2);
    expect(screen.getByText('alex')).toBeVisible();
    expect(screen.queryByText('alex (you)')).not.toBeInTheDocument();
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
    expect(screen.getByText(/Your role:/)).toHaveTextContent('owner');
    expect(await screen.findByText('member@example.com')).toBeVisible();
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
    await user.click(screen.getByRole('button', { name: 'Send invite' }));

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
        onClose={vi.fn()}
      />
    );

    expect(await screen.findByText('No active share links.')).toBeVisible();
    expect(
      screen.getByText(
        'Anyone with the link can open this model, adjust its parameters and export — without an account.'
      )
    ).toBeVisible();

    await user.click(screen.getByRole('button', { name: 'Create link' }));
    await waitFor(() =>
      expect(links.createProjectShareLink).toHaveBeenCalledWith(
        base.projectId,
        'tweak'
      )
    );
    const url = screen.getByLabelText('Share link');
    expect(url).toHaveValue(`${location.origin}/#share=${'a'.repeat(43)}`);
    await user.click(screen.getByRole('button', { name: 'Copy' }));
    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith(
        `${location.origin}/#share=${'a'.repeat(43)}`
      )
    );
    expect(screen.getByRole('button', { name: 'Copied' })).toBeVisible();
    expect(screen.getByText('Anyone with the link')).toBeVisible();

    await user.click(
      screen.getByRole('button', { name: /Revoke share link created/ })
    );
    await waitFor(() =>
      expect(links.revokeProjectShareLink).toHaveBeenCalledWith(
        base.projectId,
        'share_1'
      )
    );
    expect(await screen.findByText('No active share links.')).toBeVisible();
    expect(screen.queryByLabelText('Share link')).not.toBeInTheDocument();
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

  it('keeps viewer recovery actions safe and never offers lease acquisition', async () => {
    const base = createProjectDocument('Viewer conflict', owner);
    const conflict = {
      projectId: base.projectId,
      localDocument: version(base, 2),
      remoteDocument: version(base, 3),
      expectedRemoteVersion: 3,
      source: 'room' as const
    };
    const calls: string[] = [];
    const handlers = recoveryHandlers(calls);
    const sharingClient = client();
    const user = userEvent.setup();
    render(
      <ProjectSharingDialog
        projectId={base.projectId}
        role="viewer"
        collaborationStatus="conflict"
        lease={null}
        conflict={conflict}
        conflictHandlers={handlers}
        client={sharingClient}
        onClose={vi.fn()}
      />
    );

    expect(
      screen.getByRole('button', { name: 'Keep my version' })
    ).toBeDisabled();
    expect(
      screen.queryByRole('button', { name: /lease/i })
    ).not.toBeInTheDocument();
    expect(sharingClient.getProjectSharing).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Use room version' }));
    await waitFor(() => expect(calls).toEqual(['recovery', 'room']));
  });

  it('enables Keep my version only for an active editor lease', async () => {
    const base = createProjectDocument('Editor conflict', owner);
    const conflict = {
      projectId: base.projectId,
      localDocument: version(base, 5),
      remoteDocument: version(base, 6),
      expectedRemoteVersion: 6,
      source: 'room' as const
    };
    const calls: string[] = [];
    const handlers = recoveryHandlers(calls);
    const user = userEvent.setup();
    render(
      <ProjectSharingDialog
        projectId={base.projectId}
        role="editor"
        collaborationStatus="conflict"
        lease={{
          projectId: base.projectId,
          leaseId: 'lease_editor',
          clientId: 'client_editor',
          userId: member,
          expiresAt: Date.now() + 30_000
        }}
        conflict={conflict}
        conflictHandlers={handlers}
        client={client()}
        onClose={vi.fn()}
      />
    );

    const keepMine = screen.getByRole('button', { name: 'Keep my version' });
    expect(keepMine).toBeEnabled();
    await user.click(keepMine);
    await waitFor(() => expect(calls).toEqual(['recovery', 'mine']));
    expect(handlers.keepMyVersion).toHaveBeenCalledWith({
      document: conflict.localDocument,
      expectedRemoteVersion: 6,
      leaseId: 'lease_editor'
    });
  });

  it('keeps Keep my version lease-gated by default when no flag is passed', () => {
    const base = createProjectDocument('Default enforcement', owner);
    render(
      <ProjectSharingDialog
        projectId={base.projectId}
        role="editor"
        collaborationStatus="conflict"
        lease={null}
        conflict={{
          projectId: base.projectId,
          localDocument: version(base, 2),
          remoteDocument: version(base, 3),
          expectedRemoteVersion: 3,
          source: 'room' as const
        }}
        conflictHandlers={recoveryHandlers()}
        client={client()}
        onClose={vi.fn()}
      />
    );

    expect(
      screen.getByRole('button', { name: 'Keep my version' })
    ).toBeDisabled();
    expect(screen.getByText(/active edit lease/)).toBeInTheDocument();
  });

  it('lets an editor keep their version without a lease when leases are not enforced', async () => {
    const base = createProjectDocument('Unenforced leases', owner);
    const conflict = {
      projectId: base.projectId,
      localDocument: version(base, 5),
      remoteDocument: version(base, 6),
      expectedRemoteVersion: 6,
      source: 'room' as const
    };
    const calls: string[] = [];
    const handlers = recoveryHandlers(calls);
    const user = userEvent.setup();
    render(
      <ProjectSharingDialog
        projectId={base.projectId}
        role="editor"
        collaborationStatus="conflict"
        lease={null}
        conflict={conflict}
        conflictHandlers={handlers}
        client={client()}
        editLeasesEnforced={false}
        onClose={vi.fn()}
      />
    );

    const keepMine = screen.getByRole('button', { name: 'Keep my version' });
    expect(keepMine).toBeEnabled();
    await user.click(keepMine);
    await waitFor(() => expect(calls).toEqual(['recovery', 'mine']));
    expect(handlers.keepMyVersion).toHaveBeenCalledWith({
      document: conflict.localDocument,
      expectedRemoteVersion: 6
    });
  });
});
