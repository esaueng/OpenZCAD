import { describe, expect, it, vi } from 'vitest';
import { D1R2PersistenceService } from '@openzcad/cloudflare-adapters';
import { ProjectNotFoundError } from '@openzcad/persistence';
import { createProjectDocument } from '@openzcad/document-core';
import { toUserId, type UserId } from '@openzcad/shared';

type ResolvedRole = 'owner' | 'editor' | 'viewer';

interface MockStatement {
  sql: string;
  bindings: unknown[];
  bind(...values: unknown[]): MockStatement;
  first<T>(): Promise<T | null>;
}

function createAuthorizationDb(options?: { batchChanges?: number }): {
  db: D1Database;
  prepared: MockStatement[];
  batched: MockStatement[];
} {
  const owner = toUserId('user_d1_owner');
  const roles = new Map<UserId, ResolvedRole>([
    [owner, 'owner'],
    [toUserId('user_d1_editor'), 'editor'],
    [toUserId('user_d1_viewer'), 'viewer']
  ]);
  const prepared: MockStatement[] = [];
  const batched: MockStatement[] = [];

  const prepare = vi.fn((sql: string): MockStatement => {
    const makeStatement = (bindings: unknown[]): MockStatement => ({
      sql,
      bindings,
      bind: (...values: unknown[]) => makeStatement(values),
      first: async <T>() => {
        if (sql.includes('AS resolved_role')) {
          const userId = bindings[0] as UserId;
          const role = roles.get(userId) ?? null;
          return (
            role
              ? { owner_user_id: owner, resolved_role: role }
              : { owner_user_id: owner, resolved_role: null }
          ) as T;
        }
        return null;
      }
    });
    const statement = makeStatement([]);
    prepared.push(statement);
    return statement;
  });
  const batch = vi.fn(async (statements: MockStatement[]) => {
    batched.push(...statements);
    return statements.map(() => ({
      success: true,
      meta: { changes: options?.batchChanges ?? 1 },
      results: []
    }));
  });

  return {
    db: { prepare, batch } as unknown as D1Database,
    prepared,
    batched
  };
}

describe('project authorization', () => {
  it('resolves D1 owner, editor, and viewer roles and hides unrelated users', async () => {
    const { db } = createAuthorizationDb();
    const service = new D1R2PersistenceService({
      DB: db,
      PROJECT_SHARING_ENABLED: 'true'
    });
    const projectId = 'project_d1_shared';
    const owner = toUserId('user_d1_owner');
    const editor = toUserId('user_d1_editor');
    const viewer = toUserId('user_d1_viewer');
    const unrelated = toUserId('user_d1_unrelated');

    await expect(
      service.requireProjectOwner(owner, projectId)
    ).resolves.toEqual({ projectId, ownerUserId: owner, role: 'owner' });
    await expect(
      service.requireProjectEdit(editor, projectId)
    ).resolves.toEqual({ projectId, ownerUserId: owner, role: 'editor' });
    await expect(
      service.requireProjectRead(viewer, projectId)
    ).resolves.toEqual({ projectId, ownerUserId: owner, role: 'viewer' });
    await expect(service.requireProjectEdit(viewer, projectId)).rejects.toThrow(
      ProjectNotFoundError
    );
    await expect(
      service.requireProjectOwner(editor, projectId)
    ).rejects.toThrow(ProjectNotFoundError);
    await expect(
      service.requireProjectRead(unrelated, projectId)
    ).rejects.toThrow(ProjectNotFoundError);
  });

  it('attributes an editor revision while keeping the owner-bound update guard', async () => {
    const { db, batched } = createAuthorizationDb();
    const service = new D1R2PersistenceService({
      DB: db,
      PROJECT_SHARING_ENABLED: 'true'
    });
    const owner = toUserId('user_d1_owner');
    const editor = toUserId('user_d1_editor');
    const document = createProjectDocument('D1 shared', owner);

    const saved = await service.saveRevision(editor, {
      projectId: document.projectId,
      reason: 'Editor-authored revision',
      expectedVersion: document.version,
      document: { ...document, name: 'Edited without transfer' }
    });

    expect(saved.ownerUserId).toBe(owner);
    const update = batched.find((statement) =>
      statement.sql.startsWith('UPDATE projects')
    );
    const revision = batched.find((statement) =>
      statement.sql.startsWith('INSERT OR REPLACE INTO revisions')
    );
    expect(update?.bindings[5]).toBe(owner);
    expect(revision?.bindings.at(-1)).toBe(editor);
    expect(revision?.sql).toContain('author_user_id');
  });

  it('rejects an editor-authored document that changes the owner', async () => {
    const { db, batched } = createAuthorizationDb();
    const service = new D1R2PersistenceService({
      DB: db,
      PROJECT_SHARING_ENABLED: 'true'
    });
    const owner = toUserId('user_d1_owner');
    const editor = toUserId('user_d1_editor');
    const document = createProjectDocument('D1 owned', owner);

    await expect(
      service.saveRevision(editor, {
        projectId: document.projectId,
        reason: 'Takeover',
        expectedVersion: document.version,
        document: { ...document, ownerUserId: editor }
      })
    ).rejects.toThrow(ProjectNotFoundError);
    expect(batched).toHaveLength(0);
  });
});
