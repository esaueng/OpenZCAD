import { describe, expect, it, vi } from 'vitest';
import { D1R2PersistenceService } from '@openzcad/cloudflare-adapters';
import { ProjectNotFoundError } from '@openzcad/persistence';
import { createProjectDocument } from '@openzcad/document-core';
import {
  toArtifactId,
  toUploadSessionId,
  toUserId,
  type UserId
} from '@openzcad/shared';

type ResolvedRole = 'owner' | 'editor' | 'viewer';

interface MockStatement {
  sql: string;
  bindings: unknown[];
  bind(...values: unknown[]): MockStatement;
  first<T>(): Promise<T | null>;
  run(): Promise<{ meta: { changes: number } }>;
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
      },
      run: async () => ({ meta: { changes: options?.batchChanges ?? 1 } })
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
    const { db, prepared } = createAuthorizationDb();
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
    expect(
      prepared.find((statement) => statement.sql.includes('AS resolved_role'))
        ?.sql
    ).toContain("WHEN p.status = 'deleted' THEN NULL");
  });

  it.each(['document', 'revision'] as const)(
    'refuses an editor %s save when trash wins after authorization',
    async (kind) => {
      const owner = toUserId('user_race_owner');
      const editor = toUserId('user_race_editor');
      const document = createProjectDocument('Trash race', owner);
      let trashed = false;
      let releaseCommit!: () => void;
      let commitReached!: () => void;
      const atCommit = new Promise<void>((resolve) => {
        commitReached = resolve;
      });
      const mayCommit = new Promise<void>((resolve) => {
        releaseCommit = resolve;
      });
      const updates: MockStatement[] = [];
      const prepare = (sql: string): MockStatement => {
        const makeStatement = (bindings: unknown[]): MockStatement => ({
          sql,
          bindings,
          bind: (...values) => makeStatement(values),
          first: async <T>() => {
            if (sql.includes('AS resolved_role')) {
              return {
                owner_user_id: owner,
                resolved_role: trashed ? null : 'editor'
              } as T;
            }
            return { document_version: document.version } as T;
          },
          run: async () => {
            if (sql.startsWith('UPDATE projects')) {
              const statement = makeStatement(bindings);
              updates.push(statement);
              commitReached();
              await mayCommit;
              return { meta: { changes: trashed ? 0 : 1 } };
            }
            return { meta: { changes: 1 } };
          }
        });
        return makeStatement([]);
      };
      const batch = async (statements: MockStatement[]) => {
        updates.push(statements[0]!);
        commitReached();
        await mayCommit;
        return statements.map((_, index) => ({
          meta: { changes: index === 0 && trashed ? 0 : 1 }
        }));
      };
      const service = new D1R2PersistenceService({
        DB: { prepare, batch } as unknown as D1Database,
        PROJECT_SHARING_ENABLED: 'true'
      });

      const save =
        kind === 'document'
          ? service.saveDocument(editor, {
              projectId: document.projectId,
              expectedVersion: document.version,
              document
            })
          : service.saveRevision(editor, {
              projectId: document.projectId,
              expectedVersion: document.version,
              reason: 'Late editor save',
              document
            });
      await atCommit;
      trashed = true;
      releaseCommit();

      await expect(save).rejects.toThrow(ProjectNotFoundError);
      expect(updates).toHaveLength(1);
      expect(updates[0]?.sql).toContain(
        "AND (user_id = ? OR status != 'deleted')"
      );
      expect(updates[0]?.bindings.at(-1)).toBe(editor);
    }
  );

  it('does not return a project trashed after the initial D1 read check', async () => {
    const owner = toUserId('user_read_race_owner');
    const member = toUserId('user_read_race_member');
    const document = createProjectDocument('Read race', owner);
    let trashed = false;
    let finalReadReached!: () => void;
    let releaseRead!: () => void;
    const atFinalRead = new Promise<void>((resolve) => {
      finalReadReached = resolve;
    });
    const mayRead = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
    const prepare = (sql: string) => ({
      bind: (...bindings: unknown[]) => ({
        first: async () => {
          if (sql.includes('AS resolved_role')) {
            return { owner_user_id: owner, resolved_role: 'viewer' };
          }
          expect(sql).toContain("status != 'deleted'");
          expect(bindings).toEqual([document.projectId, member]);
          finalReadReached();
          await mayRead;
          return trashed
            ? null
            : { document_json: JSON.stringify(document), document_object_id: null };
        }
      })
    });
    const service = new D1R2PersistenceService({
      DB: { prepare } as unknown as D1Database,
      PROJECT_SHARING_ENABLED: 'true'
    });

    const load = service.loadProject(member, document.projectId);
    await atFinalRead;
    trashed = true;
    releaseRead();
    await expect(load).resolves.toBeNull();
  });

  it('does not finalize an editor artifact after the owner trashes the project', async () => {
    const owner = toUserId('user_artifact_race_owner');
    const editor = toUserId('user_artifact_race_editor');
    const projectId = createProjectDocument('Artifact race', owner).projectId;
    const artifactId = toArtifactId('artifact_trash_race');
    const uploadSessionId = toUploadSessionId('upload_trash_race');
    let trashed = false;
    let commitReached!: () => void;
    let releaseCommit!: () => void;
    const atCommit = new Promise<void>((resolve) => {
      commitReached = resolve;
    });
    const mayCommit = new Promise<void>((resolve) => {
      releaseCommit = resolve;
    });
    let insertSql = '';
    let insertBindings: unknown[] = [];
    const prepare = (sql: string) => ({
      bind: (...bindings: unknown[]) => ({
        sql,
        bindings,
        first: async () => {
          if (sql.includes('AS resolved_role')) {
            return {
              owner_user_id: owner,
              resolved_role: trashed ? null : 'editor'
            };
          }
          if (sql.includes('FROM upload_sessions WHERE id = ?')) {
            return {
              id: uploadSessionId,
              artifact_id: artifactId,
              project_id: projectId,
              object_key: 'artifact/trash-race',
              file_name: 'part.step',
              content_type: 'model/step',
              kind: 'step-export',
              metadata_json: '{}',
              expires_at: new Date(Date.now() + 60_000).toISOString(),
              owner_user_id: owner,
              reserved_bytes: 1,
              reservation_state: 'completed',
              multipart_upload_id: 'r2_upload_trash_race',
              single_part: 0,
              upload_protocol_version: 1,
              completion_started_at: null
            };
          }
          return null;
        }
      })
    });
    const batch = async (statements: Array<{ sql: string; bindings: unknown[] }>) => {
      const insert = statements.find((statement) =>
        statement.sql.includes('INSERT INTO artifacts')
      );
      insertSql = insert?.sql ?? '';
      insertBindings = insert?.bindings ?? [];
      commitReached();
      await mayCommit;
      return statements.map((statement) => ({
        meta: {
          changes:
            statement === insert && trashed && insertSql.includes("status != 'deleted'")
              ? 0
              : 1
        }
      }));
    };
    const service = new D1R2PersistenceService({
      DB: { prepare, batch } as unknown as D1Database,
      ARTIFACTS: {
        head: async () => ({ size: 1 })
      } as unknown as R2Bucket,
      PROJECT_SHARING_ENABLED: 'true'
    });

    const finalize = service.finalizeArtifact(editor, {
      projectId,
      uploadSessionId,
      artifactId
    });
    await atCommit;
    trashed = true;
    releaseCommit();

    await expect(finalize).rejects.toThrow(ProjectNotFoundError);
    expect(insertSql).toContain("status != 'deleted'");
    expect(insertBindings.at(-1)).toBe(editor);
  });

  it.each(['document', 'revision'] as const)(
    'does not commit an R2 editor %s after the owner trashes the project',
    async (kind) => {
      const owner = toUserId('user_r2_race_owner');
      const editor = toUserId('user_r2_race_editor');
      const document = createProjectDocument('R2 trash race', owner);
      let trashed = false;
      let commitReached!: () => void;
      let releaseCommit!: () => void;
      const atCommit = new Promise<void>((resolve) => {
        commitReached = resolve;
      });
      const mayCommit = new Promise<void>((resolve) => {
        releaseCommit = resolve;
      });
      let updateSql = '';
      let updateBindings: unknown[] = [];
      const bucket = {
        put: vi.fn(async () => undefined),
        get: vi.fn(async () => null),
        delete: vi.fn(async () => undefined)
      };
      const prepare = (sql: string) => ({
        bind: (...bindings: unknown[]) => ({
          sql,
          bindings,
          first: async () => {
            if (sql.includes('AS resolved_role')) {
              return {
                owner_user_id: owner,
                resolved_role: trashed ? null : 'editor'
              };
            }
            if (sql.includes('AS current_document_object_id')) {
              return {
                current_document_object_id: 'previous_object',
                current_document_version: document.version,
                object_state: 'pending',
                project_references: 0,
                revision_references: 0
              };
            }
            if (sql.includes('SELECT document_version FROM projects')) {
              return { document_version: document.version };
            }
            return null;
          },
          run: async () => ({ meta: { changes: 1 } }),
          all: async () => ({ results: [] })
        })
      });
      const batch = async (statements: Array<{ sql: string; bindings: unknown[] }>) => {
        updateSql = statements[1]?.sql ?? '';
        updateBindings = statements[1]?.bindings ?? [];
        commitReached();
        await mayCommit;
        return statements.map((_, index) => ({
          meta: {
            changes:
              index === 1 && trashed && updateSql.includes("status != 'deleted'")
                ? 0
                : 1
          }
        }));
      };
      const service = new D1R2PersistenceService({
        DB: { prepare, batch } as unknown as D1Database,
        PROJECT_STORAGE: bucket as unknown as R2Bucket,
        PROJECT_SHARING_ENABLED: 'true'
      });

      const save =
        kind === 'document'
          ? service.saveDocument(editor, {
              projectId: document.projectId,
              expectedVersion: document.version,
              document
            })
          : service.saveRevision(editor, {
              projectId: document.projectId,
              expectedVersion: document.version,
              reason: 'Late R2 revision',
              document
            });
      await atCommit;
      trashed = true;
      releaseCommit();

      await expect(save).rejects.toThrow(ProjectNotFoundError);
      expect(updateSql).toContain("AND (user_id = ? OR status != 'deleted')");
      expect(updateBindings.at(-1)).toBe(editor);
      expect(bucket.put).toHaveBeenCalled();
      expect(bucket.delete).toHaveBeenCalled();
    }
  );

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
    // The owner binds the UPDATE's user_id predicate: an editor's save must
    // stay scoped to the owner's row rather than to the editor's.
    expect(update?.bindings[6]).toBe(owner);
    expect(revision?.bindings.at(-1)).toBe(editor);
    expect(revision?.sql).toContain('author_user_id');
  });

  it('blocks editor REST persistence writes when edit leases are enforced', async () => {
    const { db, batched } = createAuthorizationDb();
    const service = new D1R2PersistenceService({
      DB: db,
      PROJECT_SHARING_ENABLED: 'true',
      PROJECT_EDIT_LEASES_ENFORCED: 'true'
    });
    const owner = toUserId('user_d1_owner');
    const editor = toUserId('user_d1_editor');
    const document = createProjectDocument('D1 lease protected', owner);

    await expect(
      service.saveRevision(editor, {
        projectId: document.projectId,
        reason: 'Bypass revision',
        expectedVersion: document.version,
        document: { ...document, name: 'Bypassed revision' }
      })
    ).rejects.toThrow(ProjectNotFoundError);

    await expect(
      service.saveDocument(editor, {
        projectId: document.projectId,
        expectedVersion: document.version,
        document: { ...document, name: 'Bypassed document' }
      })
    ).rejects.toThrow(ProjectNotFoundError);

    expect(batched).toHaveLength(0);
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
