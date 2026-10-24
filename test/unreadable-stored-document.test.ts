import { describe, expect, it } from 'vitest';
import { D1R2PersistenceService } from '@openzcad/cloudflare-adapters';
import {
  createProjectDocument,
  withoutDerivedProjection
} from '@openzcad/document-core';
import {
  InMemoryPersistenceService,
  isUnreadableStoredDocument,
  markUnreadableStoredDocument,
  ProjectObjectStorageError,
  reconcileCopiedImportSources
} from '@openzcad/persistence';
import { toUserId, type ProjectDocument } from '@openzcad/shared';
import { migratedDatabase, sqliteD1 } from './support/sqlite-d1';

const owner = toUserId('unreadable_owner');

/**
 * ADR-024 Phase 1: loads serve a stored document this build cannot read as
 * stored, and the browser refuses it and keeps its own copy. A structurally
 * malformed document (no `nodes` here) must reach the browser that way rather
 * than failing the load in a step that walks its contents.
 */
describe('unreadable stored documents', () => {
  it('pass through source-alias reconciliation untouched', () => {
    const malformed = markUnreadableStoredDocument({
      ...createProjectDocument('Malformed', owner),
      nodes: null
    } as unknown as ProjectDocument);
    expect(reconcileCopiedImportSources(malformed, [])).toBe(malformed);
  });

  it('load from D1 as stored instead of failing the request', async () => {
    const db = migratedDatabase();
    db.prepare(
      'INSERT INTO users (id, email, created_at) VALUES (?, ?, ?)'
    ).run(owner, `${owner}@example.test`, '2026-10-24T00:00:00.000Z');
    const service = new D1R2PersistenceService({ DB: sqliteD1(db) });
    const initial = withoutDerivedProjection(
      createProjectDocument('Stored', owner)
    );
    const { document } = await service.createProject(owner, {
      name: 'Stored',
      initialDocument: initial
    });
    db.prepare('UPDATE projects SET document_json = ? WHERE id = ?').run(
      JSON.stringify({ ...document, nodes: null }),
      document.projectId
    );
    const loaded = await service.loadProject(owner, document.projectId);
    expect(loaded).toMatchObject({
      projectId: document.projectId,
      nodes: null
    });
    expect(isUnreadableStoredDocument(loaded)).toBe(true);
  });

  it('load from memory as stored, and are never served through a share link', async () => {
    const service = new InMemoryPersistenceService();
    const created = await service.createProject(owner, { name: 'Memory' });
    const malformed = {
      ...structuredClone(created.document),
      nodes: null
    } as unknown as ProjectDocument;
    (
      service as unknown as { projects: Map<string, ProjectDocument> }
    ).projects.set(created.document.projectId, malformed);
    const loaded = await service.loadProject(owner, created.document.projectId);
    expect(loaded).toMatchObject({ nodes: null });
    await service.createProjectShareLink(owner, created.document.projectId, {
      shareLinkId: 'share_unreadable',
      mode: 'tweak',
      tokenHash: 'unreadable-token-hash',
      createdAt: Math.floor(Date.now() / 1000)
    });
    // A share serves only the shared projection, which it cannot build here.
    await expect(
      service.loadSharedProjectByTokenHash('unreadable-token-hash')
    ).rejects.toBeInstanceOf(ProjectObjectStorageError);
  });
});
