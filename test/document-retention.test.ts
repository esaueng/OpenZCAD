import { describe, expect, it } from 'vitest';
import { InMemoryPersistenceService } from '@openzcad/persistence';
import { createProjectDocument } from '@openzcad/document-core';
import {
  MAX_PERSISTED_DOCUMENT_BYTES,
  MAX_PROJECT_REVISIONS,
  toUserId,
  type ProjectDocument,
  type ProjectId
} from '@openzcad/shared';
import worker from '../apps/web/worker/index';

const owner = toUserId('user_owner');

const env = {
  ENVIRONMENT: 'development' as const,
  AUTH_MODE: 'development' as const
} as never;

/** Saves `count` revisions in sequence, each fenced against the last. */
async function saveRepeatedly(
  service: InMemoryPersistenceService,
  projectId: ProjectId,
  start: ProjectDocument,
  count: number
): Promise<ProjectDocument> {
  let current = start;
  for (let index = 0; index < count; index += 1) {
    current = await service.saveRevision(owner, {
      projectId,
      reason: `Save ${index}`,
      expectedVersion: current.version,
      document: current
    });
  }
  return current;
}

describe('revision retention', () => {
  it('keeps a bounded history rather than one copy per save', async () => {
    // Each revision is a whole copy of the document, so an unbounded history is
    // an unbounded multiple of the project itself.
    const service = new InMemoryPersistenceService();
    const created = await service.createProject(owner, { name: 'Busy' });
    await saveRepeatedly(
      service,
      created.document.projectId,
      created.document,
      MAX_PROJECT_REVISIONS + 12
    );

    const usage = await service.getStorageUsage(owner);
    expect(usage.maxRevisionsPerProject).toBe(MAX_PROJECT_REVISIONS);
    expect(usage.revisionCount).toBe(MAX_PROJECT_REVISIONS);
  });

  it('bounds each project separately rather than the account as a whole', async () => {
    const service = new InMemoryPersistenceService();
    const first = await service.createProject(owner, { name: 'First' });
    const second = await service.createProject(owner, { name: 'Second' });
    await saveRepeatedly(
      service,
      first.document.projectId,
      first.document,
      MAX_PROJECT_REVISIONS + 3
    );
    await saveRepeatedly(
      service,
      second.document.projectId,
      second.document,
      4
    );

    const usage = await service.getStorageUsage(owner);
    expect(usage.revisionCount).toBe(MAX_PROJECT_REVISIONS + 4);
  });

  it('does not let retention housekeeping cost anybody a save', async () => {
    const service = new InMemoryPersistenceService();
    const created = await service.createProject(owner, { name: 'Persistent' });
    const latest = await saveRepeatedly(
      service,
      created.document.projectId,
      created.document,
      MAX_PROJECT_REVISIONS + 5
    );

    const loaded = await service.loadProject(owner, created.document.projectId);
    expect(loaded?.version).toBe(latest.version);
    expect(loaded?.checkpoints.at(-1)?.reason).toBe(
      `Save ${MAX_PROJECT_REVISIONS + 4}`
    );
  });

  it('leaves history alone when continuous sync writes the document', async () => {
    const service = new InMemoryPersistenceService();
    const created = await service.createProject(owner, { name: 'Autosaved' });
    const before = await service.getStorageUsage(owner);

    let current = created.document;
    for (let index = 0; index < 20; index += 1) {
      await service.saveDocument(owner, {
        projectId: current.projectId,
        expectedVersion: current.version,
        document: current
      });
      current = { ...current, version: current.version };
    }

    const after = await service.getStorageUsage(owner);
    expect(after.revisionCount).toBe(before.revisionCount);
    expect(after.revisionBytes).toBe(before.revisionBytes);
  });
});

describe('account storage accounting', () => {
  it('reports nothing for an account with no projects', async () => {
    const service = new InMemoryPersistenceService();
    const usage = await service.getStorageUsage(toUserId('user_empty'));
    expect(usage).toEqual({
      projectCount: 0,
      documentBytes: 0,
      revisionBytes: 0,
      revisionCount: 0,
      documentLimitBytes: MAX_PERSISTED_DOCUMENT_BYTES,
      maxRevisionsPerProject: MAX_PROJECT_REVISIONS
    });
  });

  it('counts each project once and names the ceiling', async () => {
    const service = new InMemoryPersistenceService();
    await service.createProject(owner, { name: 'One' });
    await service.createProject(owner, { name: 'Two' });

    const usage = await service.getStorageUsage(owner);
    expect(usage.projectCount).toBe(2);
    expect(usage.documentBytes).toBeGreaterThan(0);
    expect(usage.documentLimitBytes).toBe(MAX_PERSISTED_DOCUMENT_BYTES);
  });

  it('does not count another account’s projects', async () => {
    const service = new InMemoryPersistenceService();
    await service.createProject(owner, { name: 'Mine' });
    await service.createProject(toUserId('user_other'), { name: 'Theirs' });

    expect((await service.getStorageUsage(owner)).projectCount).toBe(1);
  });

  it('answers the storage route with the account totals', async () => {
    const document = createProjectDocument('Routed', toUserId('user_local'));
    await worker.fetch(
      new Request('https://example.com/api/projects', {
        method: 'POST',
        body: JSON.stringify({ name: document.name, document })
      }),
      env
    );

    const response = await worker.fetch(
      new Request('https://example.com/api/account/storage'),
      env
    );
    expect(response.status).toBe(200);
    const usage = (await response.json()) as {
      projectCount: number;
      documentLimitBytes: number;
    };
    expect(usage.projectCount).toBeGreaterThan(0);
    expect(usage.documentLimitBytes).toBe(MAX_PERSISTED_DOCUMENT_BYTES);
  });
});

describe('the size ceiling', () => {
  it('refuses an oversize revision before it reaches the store', async () => {
    const service = new InMemoryPersistenceService();
    const created = await service.createProject(owner, { name: 'Huge' });
    const oversize: ProjectDocument = {
      ...created.document,
      derived: {
        ...created.document.derived,
        warnings: ['x'.repeat(MAX_PERSISTED_DOCUMENT_BYTES + 1)]
      }
    };

    await expect(
      service.saveRevision(owner, {
        projectId: created.document.projectId,
        reason: 'Too big',
        expectedVersion: created.document.version,
        document: oversize
      })
    ).rejects.toMatchObject({ name: 'DocumentTooLargeError' });
  });

  it('refuses an oversize autosave the same way', async () => {
    const service = new InMemoryPersistenceService();
    const created = await service.createProject(owner, { name: 'Huge' });
    const oversize: ProjectDocument = {
      ...created.document,
      derived: {
        ...created.document.derived,
        warnings: ['x'.repeat(MAX_PERSISTED_DOCUMENT_BYTES + 1)]
      }
    };

    await expect(
      service.saveDocument(owner, {
        projectId: created.document.projectId,
        expectedVersion: created.document.version,
        document: oversize
      })
    ).rejects.toMatchObject({ name: 'DocumentTooLargeError' });
  });

  it('leaves the stored document untouched when it refuses one', async () => {
    const service = new InMemoryPersistenceService();
    const created = await service.createProject(owner, { name: 'Intact' });
    const oversize: ProjectDocument = {
      ...created.document,
      name: 'Overwritten',
      derived: {
        ...created.document.derived,
        warnings: ['x'.repeat(MAX_PERSISTED_DOCUMENT_BYTES + 1)]
      }
    };
    await service
      .saveDocument(owner, {
        projectId: created.document.projectId,
        expectedVersion: created.document.version,
        document: oversize
      })
      .catch(() => undefined);

    const loaded = await service.loadProject(owner, created.document.projectId);
    expect(loaded?.name).toBe('Intact');
  });

  it('does not count the derived projection against the ceiling', async () => {
    // Meshes are stripped before the measurement, so a document is refused for
    // the size of its history, never for the size of its last rebuild.
    const service = new InMemoryPersistenceService();
    const created = await service.createProject(owner, { name: 'Meshy' });
    const heavyDerived: ProjectDocument = {
      ...created.document,
      derived: {
        ...created.document.derived,
        bodyRepresentations: {
          body_1: { blob: 'x'.repeat(MAX_PERSISTED_DOCUMENT_BYTES + 1) }
        } as never
      }
    };

    await expect(
      service.saveDocument(owner, {
        projectId: created.document.projectId,
        expectedVersion: created.document.version,
        document: heavyDerived
      })
    ).resolves.toMatchObject({ projectId: created.document.projectId });
  });
});
