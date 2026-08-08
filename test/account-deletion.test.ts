import { describe, expect, it, vi } from 'vitest';
import type { PersistenceService } from '@openzcad/persistence';
import {
  toProjectId,
  toUserId,
  type AuthSession,
  type ProjectId
} from '@openzcad/shared';
import type { AccountDeletionError } from '../apps/web/worker/accountDeletion';
import {
  accountDeletionPreview,
  deleteAccountData
} from '../apps/web/worker/accountDeletion';

interface PreparedCall {
  query: string;
  params: unknown[];
}

function database(
  projectPasses: ProjectId[][] = [[]],
  fence: { changes: number; existingScope?: string } = { changes: 1 }
) {
  const calls: PreparedCall[] = [];
  const batches: PreparedCall[][] = [];
  let projectPass = 0;
  const prepare = vi.fn((query: string) => {
    const call = { query, params: [] as unknown[] };
    calls.push(call);
    const statement = {
      query,
      bind(...params: unknown[]) {
        call.params = params;
        return statement;
      },
      async first() {
        if (query.includes("name LIKE 'block_erasing_%'")) {
          return { table_ready: 1, trigger_count: 25 };
        }
        if (query.includes("pragma_table_info('projects')")) {
          return {
            project_columns: 3,
            revision_pointer: 1,
            document_objects_table: 1,
            storage_assets_table: 1,
            document_objects_index: 1,
            storage_assets_index: 1,
            pointer_indexes: 2
          };
        }
        if (query.includes('collaborator_count')) {
          return { collaborator_count: 2 };
        }
        if (query.includes('SELECT scope FROM account_erasure_requests')) {
          return fence.existingScope ? { scope: fence.existingScope } : null;
        }
        return null;
      },
      async all() {
        if (query.includes('SELECT id FROM projects WHERE user_id')) {
          const ids = projectPasses[projectPass++] ?? [];
          return { results: ids.map((id) => ({ id })) };
        }
        return { results: [] };
      },
      async run() {
        return {
          meta: {
            changes: query.includes('INSERT INTO account_erasure_requests')
              ? fence.changes
              : 1
          }
        };
      }
    };
    return statement;
  });
  const db = {
    prepare,
    async batch(statements: Array<{ query?: string }>) {
      batches.push(
        statements.map(
          (statement) =>
            calls.find((candidate) => candidate.query === statement.query) ?? {
              query: statement.query ?? '',
              params: []
            }
        )
      );
      return [];
    }
  } as unknown as D1Database;
  return { db, calls, batches };
}

function persistence(projectIds: ProjectId[] = []) {
  return {
    getStorageUsage: vi.fn(async () => ({
      projectCount: 3,
      documentBytes: 1_024,
      revisionBytes: 2_048,
      revisionCount: 4,
      documentLimitBytes: 24 * 1024 * 1024,
      maxRevisionsPerProject: 50
    })),
    deleteOwnedProjects: vi.fn(async () => projectIds)
  } as unknown as PersistenceService;
}

const projectBucket = {
  put: vi.fn(),
  get: vi.fn(),
  delete: vi.fn()
} as unknown as R2Bucket;

const projectRooms = {
  getByName: vi.fn(() => ({
    fetch: vi.fn(async () => new Response(null, { status: 204 }))
  }))
} as never;

const session: AuthSession = {
  userId: toUserId('user_delete'),
  displayName: 'person',
  email: 'Person@Example.com',
  mode: 'email-code'
};

describe('account cloud-data deletion', () => {
  it('returns server-owned impact counts and normalized email confirmation', async () => {
    const { db } = database();
    await expect(
      accountDeletionPreview(
        session,
        'all',
        {
          DB: db,
          PROJECT_STORAGE: projectBucket,
          PROJECT_ROOM: projectRooms
        },
        persistence()
      )
    ).resolves.toEqual({
      confirmationKind: 'email',
      confirmationText: 'person@example.com',
      projectCount: 3,
      documentBytes: 1_024,
      revisionBytes: 2_048,
      revisionCount: 4,
      collaboratorCount: 2
    });
  });

  it('refuses a mismatched confirmation before installing a fence', async () => {
    const { db, calls } = database();
    await expect(
      deleteAccountData(
        session,
        { scope: 'all', confirmation: 'wrong@example.com' },
        {
          DB: db,
          PROJECT_STORAGE: projectBucket,
          PROJECT_ROOM: projectRooms
        },
        persistence()
      )
    ).rejects.toMatchObject({
      code: 'ACCOUNT_DELETION_CONFIRMATION_MISMATCH',
      status: 400
    } satisfies Partial<AccountDeletionError>);
    expect(
      calls.some(({ query }) =>
        query.includes('INSERT INTO account_erasure_requests')
      )
    ).toBe(false);
  });

  it('refuses project erasure before installing a fence when R2 is unavailable', async () => {
    const { db, calls } = database();
    await expect(
      deleteAccountData(
        session,
        { scope: 'projects', confirmation: 'person@example.com' },
        { DB: db, PROJECT_ROOM: projectRooms },
        persistence()
      )
    ).rejects.toMatchObject({
      code: 'PROJECT_ERASURE_UNAVAILABLE',
      status: 503
    } satisfies Partial<AccountDeletionError>);
    expect(
      calls.some(({ query }) =>
        query.includes('INSERT INTO account_erasure_requests')
      )
    ).toBe(false);
  });

  it('refuses project erasure when collaboration storage cannot be reached', async () => {
    const { db, calls } = database();
    await expect(
      deleteAccountData(
        session,
        { scope: 'projects', confirmation: 'person@example.com' },
        { DB: db, PROJECT_STORAGE: projectBucket },
        persistence()
      )
    ).rejects.toMatchObject({
      code: 'PROJECT_ERASURE_UNAVAILABLE',
      status: 503
    } satisfies Partial<AccountDeletionError>);
    expect(
      calls.some(({ query }) =>
        query.includes('INSERT INTO account_erasure_requests')
      )
    ).toBe(false);
  });

  it('erases rooms before deleting only projects owned by the account', async () => {
    const projectId = toProjectId('project_owned');
    const { db, calls } = database([[projectId], []]);
    const store = persistence([projectId]);
    const roomFetch = vi.fn(
      async (_request: Request) => new Response(null, { status: 204 })
    );

    const result = await deleteAccountData(
      session,
      { scope: 'projects', confirmation: 'person@example.com' },
      {
        DB: db,
        PROJECT_STORAGE: projectBucket,
        PROJECT_ROOM: {
          getByName: vi.fn(() => ({ fetch: roomFetch }))
        } as never
      },
      store
    );

    expect(result).toEqual({
      ok: true,
      scope: 'projects',
      deletedProjectIds: [projectId],
      signedOut: false
    });
    expect(roomFetch).toHaveBeenCalledOnce();
    expect(
      roomFetch.mock.calls[0]?.[0].headers.get(
        'x-openzcad-internal-project-erasure'
      )
    ).toBe('v1');
    expect(store.deleteOwnedProjects).toHaveBeenCalledWith(session.userId);
    expect(calls.at(-1)?.query).toContain(
      'DELETE FROM account_erasure_requests'
    );
  });

  it('keeps the fence retryable when collaboration storage cannot be erased', async () => {
    const projectId = toProjectId('project_retry');
    const { db, calls } = database([[projectId]]);
    const store = persistence([projectId]);

    await expect(
      deleteAccountData(
        session,
        { scope: 'projects', confirmation: 'person@example.com' },
        {
          DB: db,
          PROJECT_STORAGE: projectBucket,
          PROJECT_ROOM: {
            getByName: vi.fn(() => ({
              fetch: vi.fn(async () => new Response(null, { status: 503 }))
            }))
          } as never
        },
        store
      )
    ).rejects.toThrow(/Project room erasure failed/);

    expect(store.deleteOwnedProjects).not.toHaveBeenCalled();
    expect(
      calls.filter(({ query }) =>
        query.includes('DELETE FROM account_erasure_requests')
      )
    ).toHaveLength(0);
  });

  it('resumes an existing fence for the same deletion scope', async () => {
    const { db } = database([[], []], {
      changes: 0,
      existingScope: 'projects'
    });
    await expect(
      deleteAccountData(
        session,
        { scope: 'projects', confirmation: 'person@example.com' },
        {
          DB: db,
          PROJECT_STORAGE: projectBucket,
          PROJECT_ROOM: projectRooms
        },
        persistence()
      )
    ).resolves.toMatchObject({ ok: true, scope: 'projects' });
  });

  it('deletes profile and authentication rows while retaining owned projects', async () => {
    const { db, batches } = database();
    const result = await deleteAccountData(
      session,
      { scope: 'profile', confirmation: ' PERSON@example.com ' },
      { DB: db, AUTH_OTP_PEPPER: 'test-pepper' },
      persistence()
    );

    expect(result.signedOut).toBe(true);
    const queries = batches
      .flat()
      .map(({ query }) => query)
      .join('\n');
    expect(queries).toContain('DELETE FROM auth_sessions');
    expect(queries).toContain('DELETE FROM desktop_refresh_tokens');
    expect(queries).toContain('DELETE FROM user_settings');
    expect(queries).toContain('UPDATE users SET email = NULL');
    expect(queries).not.toContain('DELETE FROM users WHERE id');
  });
});
