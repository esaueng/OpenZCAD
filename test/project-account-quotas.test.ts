import { describe, expect, it, vi } from 'vitest';
import { D1R2PersistenceService } from '@openzcad/cloudflare-adapters';
import { createProjectDocument } from '@openzcad/document-core';
import {
  InMemoryPersistenceService,
  ProjectQuotaError
} from '@openzcad/persistence';
import {
  MAX_ACCOUNT_PROJECTS,
  MAX_ACCOUNT_PROJECT_STORAGE_BYTES,
  toUserId
} from '@openzcad/shared';

const owner = toUserId('quota_owner');

describe('project quota preflight', () => {
  it('caps in-memory fresh, adopted, and copied projects by owner', async () => {
    const service = new InMemoryPersistenceService();
    const first = await service.createProject(owner, { name: 'First' });
    for (let index = 1; index < MAX_ACCOUNT_PROJECTS; index += 1) {
      await service.createProject(owner, { name: `Project ${index}` });
    }
    await expect(
      service.createProject(owner, { name: 'Overflow' })
    ).rejects.toMatchObject({
      kind: 'count',
      limit: MAX_ACCOUNT_PROJECTS
    });
    await expect(
      service.duplicateProject(owner, {
        projectId: first.document.projectId
      })
    ).rejects.toBeInstanceOf(ProjectQuotaError);
    await service.deleteProject(owner, first.document.projectId);
    await expect(
      service.createProject(owner, { name: 'After deletion' })
    ).resolves.toHaveProperty('project');
    await expect(
      service.createProject(toUserId('another_owner'), { name: 'Independent' })
    ).resolves.toHaveProperty('project');
  });

  it('refuses a full D1 account before creating an R2 object', async () => {
    const put = vi.fn();
    const prepare = vi.fn((query: string) => ({
      bind: () => ({
        first: async () =>
          query.includes('AS project_count')
            ? { project_count: MAX_ACCOUNT_PROJECTS }
            : null
      })
    }));
    const service = new D1R2PersistenceService({
      DB: { prepare } as unknown as D1Database,
      PROJECT_STORAGE: {
        put,
        get: vi.fn(),
        delete: vi.fn()
      } as unknown as R2Bucket
    });
    await expect(
      service.createProject(owner, { name: 'Full' })
    ).rejects.toMatchObject({
      kind: 'count',
      limit: MAX_ACCOUNT_PROJECTS
    });
    expect(put).not.toHaveBeenCalled();
  });

  it('refuses a full R2 account before uploading a document', async () => {
    const put = vi.fn();
    const prepare = vi.fn((query: string) => ({
      bind: () => ({
        first: async () =>
          query.includes('AS project_count')
            ? { project_count: 0 }
            : query.includes('AS object_bytes')
              ? {
                  object_bytes: MAX_ACCOUNT_PROJECT_STORAGE_BYTES,
                  asset_bytes: 0
                }
              : null
      })
    }));
    const service = new D1R2PersistenceService({
      DB: { prepare } as unknown as D1Database,
      PROJECT_STORAGE: {
        put,
        get: vi.fn(),
        delete: vi.fn()
      } as unknown as R2Bucket
    });
    await expect(
      service.createProject(owner, { name: 'Full' })
    ).rejects.toMatchObject({
      kind: 'storage',
      limit: MAX_ACCOUNT_PROJECT_STORAGE_BYTES
    });
    expect(put).not.toHaveBeenCalled();
  });

  it('maps atomic D1 fallback save refusals to typed quota errors', async () => {
    const document = createProjectDocument('Legacy', owner);
    const prepare = vi.fn((query: string) => {
      const statement = {
        bind: () => statement,
        first: async () =>
          query.includes('user_id AS owner_user_id')
            ? { owner_user_id: owner }
            : null,
        run: async () => {
          throw new Error('project_account_document_quota');
        }
      };
      return statement;
    });
    const service = new D1R2PersistenceService({
      DB: {
        prepare,
        batch: async () => {
          throw new Error('project_account_document_quota');
        }
      } as unknown as D1Database
    });
    await expect(
      service.saveDocument(owner, {
        projectId: document.projectId,
        expectedVersion: document.version,
        document
      })
    ).rejects.toMatchObject({
      kind: 'storage',
      limit: MAX_ACCOUNT_PROJECT_STORAGE_BYTES
    });
    await expect(
      service.saveRevision(owner, {
        projectId: document.projectId,
        expectedVersion: document.version,
        reason: 'Manual save',
        document
      })
    ).rejects.toMatchObject({
      kind: 'storage',
      limit: MAX_ACCOUNT_PROJECT_STORAGE_BYTES
    });
  });

  it.each([
    ['project_account_count_quota', 'count', MAX_ACCOUNT_PROJECTS],
    [
      'project_account_storage_quota',
      'storage',
      MAX_ACCOUNT_PROJECT_STORAGE_BYTES
    ]
  ] as const)(
    'reconciles a raced %s after R2 upload',
    async (label, kind, limit) => {
      const put = vi.fn(async () => undefined);
      const remove = vi.fn(async () => undefined);
      const prepare = vi.fn((query: string) => {
        const statement = {
          bind: () => statement,
          first: async () =>
            query.includes('AS project_count')
              ? { project_count: 0 }
              : query.includes('AS object_bytes')
                ? { object_bytes: 0, asset_bytes: 0 }
                : query.includes('AS current_document_object_id')
                  ? {
                      current_document_object_id: null,
                      current_document_version: null,
                      object_state: null,
                      project_references: 0,
                      revision_references: 0
                    }
                  : null,
          run: async () => ({ meta: { changes: 0 } })
        };
        return statement;
      });
      const service = new D1R2PersistenceService({
        DB: {
          prepare,
          batch: async () => {
            throw new Error(label);
          }
        } as unknown as D1Database,
        PROJECT_STORAGE: {
          put,
          get: vi.fn(),
          delete: remove
        } as unknown as R2Bucket
      });
      await expect(
        service.createProject(owner, { name: 'Raced' })
      ).rejects.toMatchObject({
        kind,
        limit
      });
      expect(put).toHaveBeenCalledOnce();
      expect(remove).toHaveBeenCalledOnce();
    }
  );
});
