import { describe, expect, it, vi } from 'vitest';
import { D1R2PersistenceService } from '@openzcad/cloudflare-adapters';
import {
  InMemoryPersistenceService,
  ProjectSharingError
} from '@openzcad/persistence';
import {
  createInvitation,
  createProjectInvitationToken,
  hashProjectInvitationToken,
  PROJECT_INVITATION_TTL_SECONDS
} from '../apps/web/worker/sharing';
import { toUserId } from '@openzcad/shared';

describe('project sharing invitations', () => {
  it('uses a 256-bit opaque token and persists only its hash', async () => {
    const service = new InMemoryPersistenceService();
    const owner = toUserId('user_invite_owner');
    const project = await service.createProject(owner, { name: 'Invited' });
    const now = 2_000_000_000;

    const created = await createInvitation(
      service,
      owner,
      project.document.projectId,
      { email: '  Member@Example.COM ', role: 'viewer' },
      now
    );

    expect(created.token).toHaveLength(43);
    expect(created.token).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(created.invitation.email).toBe('member@example.com');
    expect(created.invitation.expiresAt - created.invitation.createdAt).toBe(
      PROJECT_INVITATION_TTL_SECONDS
    );
    const sharing = await service.listProjectSharing(
      owner,
      project.document.projectId,
      now
    );
    expect(JSON.stringify(sharing)).not.toContain(created.token);
    expect(JSON.stringify(sharing)).not.toContain(
      await hashProjectInvitationToken(created.token)
    );
  });

  it('accepts once for the exact normalized email and keeps the owner immutable', async () => {
    const service = new InMemoryPersistenceService();
    const owner = toUserId('user_accept_owner');
    const invited = toUserId('user_accept_member');
    const project = await service.createProject(owner, { name: 'Single use' });
    const now = 2_000_000_000;
    const token = createProjectInvitationToken();
    const tokenHash = await hashProjectInvitationToken(token);
    await service.createProjectInvitation(owner, project.document.projectId, {
      invitationId: 'invite_single_use',
      email: 'member@example.com',
      role: 'editor',
      tokenHash,
      createdAt: now,
      expiresAt: now + PROJECT_INVITATION_TTL_SECONDS
    });

    await expect(
      service.acceptProjectInvitation(
        invited,
        'wrong@example.com',
        tokenHash,
        now + 1
      )
    ).rejects.toThrow(ProjectSharingError);
    await expect(
      service.acceptProjectInvitation(
        invited,
        'member@example.com',
        tokenHash,
        now + 1
      )
    ).resolves.toEqual({
      projectId: project.document.projectId,
      role: 'editor'
    });
    await expect(
      service.acceptProjectInvitation(
        invited,
        'member@example.com',
        tokenHash,
        now + 1
      )
    ).rejects.toMatchObject({ code: 'INVITATION_NOT_FOUND' });
    await expect(
      service.requireProjectEdit(invited, project.document.projectId)
    ).resolves.toMatchObject({
      ownerUserId: owner,
      role: 'editor'
    });
    expect(
      (await service.loadProject(owner, project.document.projectId))
        ?.ownerUserId
    ).toBe(owner);
  });

  it('rate-limits invitation creation per owner and project', async () => {
    const service = new InMemoryPersistenceService();
    const owner = toUserId('user_rate_owner');
    const project = await service.createProject(owner, { name: 'Rate limit' });
    const now = 2_000_000_000;
    for (let index = 0; index < 10; index += 1) {
      await service.createProjectInvitation(owner, project.document.projectId, {
        invitationId: `invite_rate_${index}`,
        email: `member-${index}@example.com`,
        role: 'viewer',
        tokenHash: await hashProjectInvitationToken(
          createProjectInvitationToken()
        ),
        createdAt: now + index,
        expiresAt: now + PROJECT_INVITATION_TTL_SECONDS
      });
    }
    await expect(
      service.createProjectInvitation(owner, project.document.projectId, {
        invitationId: 'invite_rate_rejected',
        email: 'rejected@example.com',
        role: 'viewer',
        tokenHash: await hashProjectInvitationToken(
          createProjectInvitationToken()
        ),
        createdAt: now + 10,
        expiresAt: now + PROJECT_INVITATION_TTL_SECONDS
      })
    ).rejects.toMatchObject({ code: 'INVITATION_RATE_LIMIT' });
  });

  it('treats the conditional D1 acceptance update as the single-use decision', async () => {
    const statements: Array<{ query: string; bindings: unknown[] }> = [];
    let batchAttempt = 0;
    const prepare = vi.fn((query: string) => ({
      bind: (...bindings: unknown[]) => {
        const statement = { query, bindings };
        statements.push(statement);
        return {
          ...statement,
          first: async <T>() => {
            if (query.includes('FROM project_invitations i')) {
              return {
                id: 'invite_d1_single',
                project_id: 'project_d1_single',
                role: 'viewer',
                owner_user_id: 'user_d1_owner'
              } as T;
            }
            if (query.includes('COUNT(*) AS count')) {
              return { count: 0 } as T;
            }
            return null;
          }
        };
      }
    }));
    const batch = vi.fn(async () => {
      batchAttempt += 1;
      return [
        { meta: { changes: batchAttempt === 1 ? 1 : 0 } },
        { meta: { changes: batchAttempt === 1 ? 1 : 0 } },
        { meta: { changes: batchAttempt === 1 ? 1 : 0 } }
      ];
    });
    const service = new D1R2PersistenceService({
      DB: { prepare, batch } as unknown as D1Database
    });

    await expect(
      service.acceptProjectInvitation(
        toUserId('user_d1_invited'),
        'member@example.com',
        'hash_d1_single',
        2_000_000_001
      )
    ).resolves.toEqual({ projectId: 'project_d1_single', role: 'viewer' });
    await expect(
      service.acceptProjectInvitation(
        toUserId('user_d1_invited'),
        'member@example.com',
        'hash_d1_single',
        2_000_000_001
      )
    ).rejects.toMatchObject({ code: 'INVITATION_NOT_FOUND' });

    const conditionalUpdate = statements.find((statement) =>
      statement.query.includes('UPDATE project_invitations')
    );
    expect(conditionalUpdate?.query).toContain('accepted_at IS NULL');
    expect(conditionalUpdate?.query).toContain('revoked_at IS NULL');
    expect(conditionalUpdate?.query).toContain('expires_at >= ?');
    expect(batch).toHaveBeenCalledTimes(2);
  });
});
