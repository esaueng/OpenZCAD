import { describe, expect, it, vi } from 'vitest';
import { toUserId } from '@openzcad/shared';
import {
  createProjectSharingClient,
  ProjectSharingApiError
} from './projectSharing';

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}

describe('project sharing client', () => {
  it('calls every shipped sharing route with encoded identifiers and typed bodies', async () => {
    const userId = toUserId('user/member');
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({
          projectId: 'project/one',
          ownerUserId: toUserId('owner'),
          members: [],
          invitations: []
        })
      )
      .mockResolvedValueOnce(
        jsonResponse(
          {
            invitation: {
              invitationId: 'invite_1',
              projectId: 'project/one',
              email: 'person@example.com',
              role: 'editor',
              createdAt: 1,
              expiresAt: 2
            },
            token: 'secret'
          },
          201
        )
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(jsonResponse({ userId, role: 'viewer' }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(
        jsonResponse({ projectId: 'project/one', role: 'viewer' })
      );
    const client = createProjectSharingClient(fetcher);

    await client.getProjectSharing('project/one');
    await client.createInvitation(
      'project/one',
      ' person@example.com ',
      'editor'
    );
    await client.revokeInvitation('project/one', 'invite/1');
    await client.updateMemberRole('project/one', userId, 'viewer');
    await client.removeMember('project/one', userId);
    await client.acceptInvitation(' token_value ');

    expect(fetcher.mock.calls.map(([url]) => url)).toEqual([
      '/api/projects/project%2Fone/sharing',
      '/api/projects/project%2Fone/invitations',
      '/api/projects/project%2Fone/invitations/invite%2F1',
      '/api/projects/project%2Fone/members/user%2Fmember',
      '/api/projects/project%2Fone/members/user%2Fmember',
      '/api/project-invitations/accept'
    ]);
    expect(fetcher.mock.calls[1]![1]).toMatchObject({
      method: 'POST',
      credentials: 'same-origin',
      body: JSON.stringify({ email: 'person@example.com', role: 'editor' })
    });
    expect(fetcher.mock.calls[3]![1]).toMatchObject({
      method: 'PATCH',
      body: JSON.stringify({ role: 'viewer' })
    });
    expect(fetcher.mock.calls[5]![1]).toMatchObject({
      method: 'POST',
      body: JSON.stringify({ token: 'token_value' })
    });
  });

  it('surfaces the server sharing code and message', async () => {
    const client = createProjectSharingClient(
      vi.fn<typeof fetch>().mockResolvedValue(
        jsonResponse(
          {
            code: 'EDIT_LEASE_REQUIRED',
            error: 'Editor access is disabled.'
          },
          409
        )
      )
    );

    await expect(client.getProjectSharing('project')).rejects.toEqual(
      new ProjectSharingApiError(
        409,
        'EDIT_LEASE_REQUIRED',
        'Editor access is disabled.'
      )
    );
  });
});
