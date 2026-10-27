import { describe, expect, it } from 'vitest';
import {
  D1R2PersistenceService,
  isE2eeReverseEnabled,
  type CloudflareEnv
} from '@openzcad/cloudflare-adapters';
import { createProjectDocument } from '@openzcad/document-core';
import { PlaintextProjectFrozenError } from '@openzcad/persistence';
import { toUserId } from '@openzcad/shared';
import worker from '../apps/web/worker/index';
import { migratedDatabase, sqliteD1 } from './support/sqlite-d1';
import { objectBucket } from './support/e2ee-documents';

async function fixture() {
  const db = migratedDatabase();
  const userId = toUserId('user_beta_dev');
  db.prepare('INSERT INTO users (id, email, created_at) VALUES (?, ?, ?)').run(
    userId,
    'owner@example.test',
    '2026-10-27T00:00:00.000Z'
  );
  const env: CloudflareEnv = {
    DB: sqliteD1(db),
    ENVIRONMENT: 'development',
    AUTH_MODE: 'development',
    PROJECT_PERSONAL_SYNC_ENABLED: 'true',
    PROJECT_SHARING_ENABLED: 'true',
    E2EE_PLAINTEXT_FROZEN: 'false',
    ARTIFACTS: objectBucket() as unknown as CloudflareEnv['ARTIFACTS'],
    PROJECT_ROOM: {
      getByName: () => ({
        fetch: async () => new Response(null, { status: 204 })
      })
    } as unknown as CloudflareEnv['PROJECT_ROOM']
  };
  const service = new D1R2PersistenceService(env);
  const { document } = await service.createProject(userId, {
    name: 'Legacy',
    initialDocument: createProjectDocument('Legacy', userId)
  });
  const call = (method: string, path: string, body?: unknown) =>
    worker.fetch(
      new Request(`https://example.com${path}`, {
        method,
        ...(body === undefined
          ? {}
          : {
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify(body)
            })
      }),
      env
    );
  return { db, env, service, document, userId, call };
}

describe('deployment-wide legacy plaintext freeze (ADR-024 8-4)', () => {
  it('is off by default and preserves legacy reads and deletion when enabled', async () => {
    const f = await fixture();
    expect(
      (await f.call('GET', `/api/projects/${f.document.projectId}`)).status
    ).toBe(200);
    f.env.E2EE_PLAINTEXT_FROZEN = 'true';
    expect(
      (await f.call('GET', `/api/projects/${f.document.projectId}`)).status
    ).toBe(200);
    expect(
      (await f.call('GET', `/api/projects/${f.document.projectId}/revisions`))
        .status
    ).toBe(200);
    expect((await f.call('GET', '/api/projects')).status).toBe(200);
    expect(
      await (await f.call('GET', '/api/e2ee/config')).json()
    ).toMatchObject({ plaintextFrozen: true });
    // The freeze is independent of account eligibility or a misspelled prerequisite.
    expect(
      isE2eeReverseEnabled({
        ...f.env,
        E2EE_REVERSE_ENABLED: 'true',
        E2EE_KEYS_ENABLED: 'true',
        E2EE_PROJECTS_ENABLED: 'true',
        E2EE_MIGRATION_ENABLED: 'true'
      })
    ).toBe(false);
    expect(
      (await f.call('DELETE', `/api/projects/${f.document.projectId}`)).status
    ).toBe(204);
  });

  it('refuses old-client content and upload writes before parsing their bodies', async () => {
    const f = await fixture();
    f.env.E2EE_PLAINTEXT_FROZEN = 'true';
    const project = `/api/projects/${f.document.projectId}`;
    for (const [method, path] of [
      ['POST', '/api/projects'],
      ['PUT', `${project}/document`],
      ['POST', `${project}/revisions`],
      ['POST', `${project}/duplicate`],
      ['PUT', `${project}/measurements`],
      ['PUT', `${project}/workspace-sessions`],
      ['POST', `${project}/share-links`],
      ['POST', `${project}/invitations`],
      ['POST', `${project}/collaboration/ticket`],
      ['POST', '/api/project-invitations/accept'],
      ['POST', '/api/uploads'],
      ['PUT', '/api/uploads/u/content'],
      ['POST', '/api/uploads/u/multipart'],
      ['PUT', '/api/uploads/u/parts/1'],
      ['POST', '/api/uploads/u/complete'],
      ['POST', '/api/artifacts/finalize'],
      ['POST', '/api/imports/finalize']
    ]) {
      const response = await f.call(method!, path!, { invalid: true });
      expect(response.status, path).toBe(409);
      expect(await response.json(), path).toMatchObject({
        code: 'E2EE_PLAINTEXT_FROZEN'
      });
    }
    const stored = await f.service.loadProject(f.userId, f.document.projectId);
    expect(stored).toEqual(f.document);
    expect(
      (await f.call('PUT', '/api/projects/proj_unknown/document', {})).status
    ).not.toBe(409);
  });

  it('fences persistence callers independently of Worker dispatch and permits recovery when switched off', async () => {
    const f = await fixture();
    f.env.E2EE_PLAINTEXT_FROZEN = 'true';
    await expect(
      f.service.createProject(f.userId, { name: 'Blocked' })
    ).rejects.toBeInstanceOf(PlaintextProjectFrozenError);
    await expect(
      f.service.saveDocument(f.userId, {
        projectId: f.document.projectId,
        expectedVersion: f.document.version,
        document: { ...f.document, version: f.document.version + 1 }
      })
    ).rejects.toBeInstanceOf(PlaintextProjectFrozenError);
    await expect(
      f.service.putUpload(f.userId, 'old-upload', new ArrayBuffer(1))
    ).rejects.toBeInstanceOf(PlaintextProjectFrozenError);
    await expect(
      f.service.putUploadPart(
        f.userId,
        'old-upload',
        'multipart',
        1,
        new ArrayBuffer(1)
      )
    ).rejects.toBeInstanceOf(PlaintextProjectFrozenError);
    f.env.E2EE_PLAINTEXT_FROZEN = 'false';
    await expect(
      f.service.createProject(f.userId, { name: 'Recovered' })
    ).resolves.toBeDefined();
  });
});
