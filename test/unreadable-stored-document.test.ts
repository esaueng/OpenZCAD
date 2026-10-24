import { describe, expect, it } from 'vitest';
import { D1R2PersistenceService } from '@openzcad/cloudflare-adapters';
import {
  createProjectDocument,
  importStepBody,
  withoutDerivedProjection
} from '@openzcad/document-core';
import {
  decodeProjectStorageBody,
  hydratedForLoad,
  InMemoryPersistenceService,
  prepareProjectStorageSnapshot,
  isUnreadableStoredDocument,
  markUnreadableStoredDocument,
  normalizedForLoad,
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
  it.each([null, 'document', 7])(
    'report a stored %s as an unreadable account copy',
    (value) => {
      expect(() =>
        normalizedForLoad(value as unknown as ProjectDocument)
      ).toThrow(ProjectObjectStorageError);
    }
  );

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
    // A stored document without its own id is still loaded by the route
    // id; the archive lookup never reads the untrusted stored id.
    const { projectId: _id, ...anonymous } = document;
    db.prepare('UPDATE projects SET document_json = ? WHERE id = ?').run(
      JSON.stringify(anonymous),
      document.projectId
    );
    await expect(
      service.loadProject(owner, document.projectId)
    ).resolves.not.toHaveProperty('projectId');
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
    // A malformed document without its own id loads by the requested id.
    const { projectId: _id, ...anonymous } = malformed as unknown as Record<
      string,
      unknown
    >;
    (service as unknown as { projects: Map<string, unknown> }).projects.set(
      created.document.projectId,
      anonymous
    );
    expect(
      await service.loadProject(owner, created.document.projectId)
    ).toMatchObject({ nodes: null });
    (
      service as unknown as { projects: Map<string, ProjectDocument> }
    ).projects.set(created.document.projectId, malformed);
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

describe('hydratedForLoad', () => {
  async function stored() {
    const document = importStepBody(createProjectDocument('Stored', owner), {
      name: 'Part',
      artifactId: 'artifact_local_part',
      sourceName: 'part.step',
      stepText: 'ISO-10303-21; HEADER; ENDSEC; DATA; ENDSEC; END-ISO-10303-21;'
    }).document;
    const prepared = await prepareProjectStorageSnapshot(document);
    expect(prepared.assets.length).toBeGreaterThan(0);
    const read = async (reference: { objectKey: string }) => {
      const asset = prepared.assets.find(
        (candidate) => candidate.objectKey === reference.objectKey
      )!;
      return decodeProjectStorageBody(
        asset.storedBody.slice().buffer,
        asset.contentEncoding,
        asset.logicalBytes
      );
    };
    return { document, snapshot: prepared.snapshot, read };
  }

  it('hydrates and normalizes a readable object', async () => {
    const { document, snapshot, read } = await stored();
    const loaded = await hydratedForLoad(snapshot, document.projectId, read);
    expect(loaded.projectId).toBe(document.projectId);
    expect(isUnreadableStoredDocument(loaded)).toBe(false);
  });

  it('reports a failing asset read as it is, not as unreadable contents', async () => {
    // A transient R2 outage stays an outage instead of entering repair.
    const { document, snapshot } = await stored();
    const outage = new TypeError('network connection lost');
    await expect(
      hydratedForLoad(snapshot, document.projectId, async () => {
        throw outage;
      })
    ).rejects.toBe(outage);
  });

  it('serves contents it cannot walk as stored, for the browser to refuse', async () => {
    const { document, snapshot, read } = await stored();
    const malformed = {
      ...snapshot,
      document: {
        ...(snapshot.document as Record<string, unknown>),
        nodes: null
      }
    };
    const loaded = await hydratedForLoad(malformed, document.projectId, read);
    expect(isUnreadableStoredDocument(loaded)).toBe(true);
  });

  it.each([null, 'snapshot', 3])(
    'reports a stored %s as an unreadable account copy',
    async (value) => {
      await expect(
        hydratedForLoad(value, 'project', async () => new Uint8Array())
      ).rejects.toBeInstanceOf(ProjectObjectStorageError);
    }
  );
});
