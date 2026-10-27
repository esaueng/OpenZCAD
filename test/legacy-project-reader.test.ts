import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { D1R2PersistenceService } from '@openzcad/cloudflare-adapters';
import {
  createProjectDocument,
  importStepBody,
  assertStorableDocument
} from '@openzcad/document-core';
import {
  LEGACY_PROJECT_FRAME_CONTENT_TYPE,
  MAX_CLOUD_PROJECT_WRITE_BYTES,
  decodeE2eeFrame,
  encodeE2eeFrame,
  toUserId,
  type LegacyProjectStorageMetadata
} from '@openzcad/shared';
import { readLegacyProjectFrame } from '../apps/web/src/lib/legacyProjectReader';
import { createMigrationPlaintextSource } from '../apps/web/src/lib/e2ee/migrationPlaintextSource';
import worker from '../apps/web/worker/index';
import {
  OWNER,
  OTHER,
  makeAccount,
  newServer,
  type Account
} from './support/e2ee-documents';

let owner: Account;
let other: Account;
beforeAll(async () => {
  owner = await makeAccount(OWNER, ['owner']);
  other = await makeAccount(OTHER, ['other']);
});
afterEach(() => vi.restoreAllMocks());

async function setup(inline = false) {
  const srv = newServer([owner, other]);
  const service = new D1R2PersistenceService(srv.env);
  const initial = importStepBody(
    createProjectDocument('Legacy import', toUserId(OWNER)),
    {
      name: 'Bracket',
      artifactId: 'artifact_local_part',
      sourceName: 'part.step',
      stepText: 'ISO-10303-21;\nEND-ISO-10303-21;'
    }
  ).document;
  const created = await service.createProject(toUserId(OWNER), {
    name: initial.name,
    initialDocument: initial
  });
  const projectId = created.document.projectId;
  if (inline)
    srv.db
      .prepare(
        'UPDATE projects SET document_json = ?, document_object_id = NULL WHERE id = ?'
      )
      .run(JSON.stringify(created.document), projectId);
  const expected = await service.loadProject(toUserId(OWNER), projectId);
  const fetcher = (path: string, init?: RequestInit) =>
    worker.fetch(
      new Request(`https://example.com${path}`, {
        ...init,
        headers: {
          'x-openzcad-development-user': OWNER,
          ...Object.fromEntries(new Headers(init?.headers))
        }
      }),
      srv.env
    );
  return { srv, service, projectId, expected, fetcher };
}

describe('browser legacy CAD reads (ADR-024 8-3)', () => {
  it.each([true, false])(
    'opens an inline=%s head and retained revision without the Worker CAD parser',
    async (inline) => {
      const { srv, projectId, expected, fetcher } = await setup(inline);
      srv.db
        .prepare(
          `INSERT INTO revisions (id, project_id, reason, document_json, document_object_id, created_at)
      SELECT 'revision_legacy', id, 'Before migration', document_json, document_object_id, updated_at FROM projects WHERE id = ?`
        )
        .run(projectId);
      vi.spyOn(
        D1R2PersistenceService.prototype,
        'loadProject'
      ).mockRejectedValue(new Error('Worker CAD parser called'));
      vi.spyOn(
        D1R2PersistenceService.prototype,
        'loadRevision'
      ).mockRejectedValue(new Error('Worker CAD parser called'));
      for (const suffix of ['', '/revisions/revision_legacy']) {
        const response = await fetcher(
          `/api/projects/${projectId}${suffix}?storage=raw`
        );
        expect(response.status).toBe(200);
        expect(response.headers.get('content-type')).toBe(
          LEGACY_PROJECT_FRAME_CONTENT_TYPE
        );
        const opened = await readLegacyProjectFrame(
          response,
          projectId,
          fetcher
        );
        expect(assertStorableDocument(opened)).toEqual(expected);
      }
      const migration = createMigrationPlaintextSource(fetcher);
      expect(await migration.loadProject(projectId)).toEqual(expected);
      expect(
        await migration.loadRevision(projectId, 'revision_legacy')
      ).toEqual(expected);
      expect(await migration.loadRevision(projectId, 'pruned')).toBeNull();
    }
  );

  it('retains project authorization, format refusal and asset scoping', async () => {
    const { srv, projectId, fetcher } = await setup();
    expect(
      (
        await srv.call('GET', `/api/projects/${projectId}?storage=raw`, {
          user: OTHER
        })
      ).status
    ).toBe(404);
    const row = srv.db
      .prepare(
        'SELECT object_key FROM project_storage_assets WHERE project_id = ?'
      )
      .get(projectId) as { object_key: string };
    expect(
      (
        await fetcher(
          `/api/projects/${projectId}/storage-assets?key=${encodeURIComponent(row.object_key)}`
        )
      ).status
    ).toBe(200);
    expect(
      (
        await srv.call(
          'GET',
          `/api/projects/${projectId}/storage-assets?key=${encodeURIComponent(row.object_key)}`,
          { user: OTHER }
        )
      ).status
    ).toBe(404);
    expect(
      (
        await fetcher(
          `/api/projects/${projectId}/storage-assets?key=${encodeURIComponent('e2ee/other/secret')}`
        )
      ).status
    ).toBe(404);
    srv.db
      .prepare('UPDATE projects SET storage_format = 2 WHERE id = ?')
      .run(projectId);
    expect(
      (await fetcher(`/api/projects/${projectId}?storage=raw`)).status
    ).toBe(409);
    expect(
      (
        await fetcher(
          `/api/projects/${projectId}/storage-assets?key=${encodeURIComponent(row.object_key)}`
        )
      ).status
    ).toBe(409);
  });

  it('still reads frozen plaintext without allowing new writes', async () => {
    const { srv, projectId, expected, fetcher } = await setup();
    srv.env.E2EE_PLAINTEXT_FROZEN = 'true';
    const response = await fetcher(`/api/projects/${projectId}?storage=raw`);
    expect(await readLegacyProjectFrame(response, projectId, fetcher)).toEqual(
      expected
    );
    expect(
      (await srv.call('POST', '/api/projects', { body: { name: 'Refused' } }))
        .status
    ).toBe(409);
  });

  it('refuses changed metadata, ciphertext corruption, missing assets and excessive output', async () => {
    const { srv, projectId, fetcher } = await setup();
    const response = await fetcher(`/api/projects/${projectId}?storage=raw`);
    const frame = decodeE2eeFrame(new Uint8Array(await response.arrayBuffer()));
    const metadata = frame.metadata as LegacyProjectStorageMetadata;
    for (const change of [
      { projectId: 'another' },
      { logicalBytes: MAX_CLOUD_PROJECT_WRITE_BYTES + 1 },
      { checksumSha256: '0'.repeat(64) }
    ]) {
      await expect(
        readLegacyProjectFrame(
          new Response(
            encodeE2eeFrame({ ...metadata, ...change }, frame.payload)
          ),
          projectId,
          fetcher
        )
      ).rejects.toThrow();
    }
    const corrupted = frame.payload.slice();
    corrupted[corrupted.length - 1]! ^= 1;
    await expect(
      readLegacyProjectFrame(
        new Response(encodeE2eeFrame(metadata, corrupted)),
        projectId,
        fetcher
      )
    ).rejects.toThrow();
    srv.bucket.objects.clear();
    await expect(
      readLegacyProjectFrame(
        new Response(encodeE2eeFrame(metadata, frame.payload)),
        projectId,
        fetcher
      )
    ).rejects.toThrow();
  });

  it('relays malformed stored JSON untouched and lets the browser reject it', async () => {
    const { srv, projectId, fetcher } = await setup(true);
    srv.db
      .prepare('UPDATE projects SET document_json = ? WHERE id = ?')
      .run('not JSON', projectId);
    const response = await fetcher(`/api/projects/${projectId}?storage=raw`);
    expect(response.status).toBe(200);
    await expect(
      readLegacyProjectFrame(response, projectId, fetcher)
    ).rejects.toThrow();
  });
});
