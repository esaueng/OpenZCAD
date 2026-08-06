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
});
