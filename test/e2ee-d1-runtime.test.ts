import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { D1R2PersistenceService } from '@openzcad/cloudflare-adapters';
import {
  encryptContentBlob,
  EnvelopeKey,
  parseEnvelope
} from '@openzcad/crypto';
import { toUserId } from '@openzcad/shared';
import { handleE2eeContactsRequest } from '../apps/web/worker/e2eeContacts';

// Reuse the web app's installed Wrangler rather than introducing another
// runtime dependency. Plain Node SQLite misses D1's trigger-inclusive change
// counts and its five-term compound SELECT limit.
const wrangler = createRequire(
  new URL('../apps/web/package.json', import.meta.url)
)('wrangler') as {
  getPlatformProxy(options: {
    configPath: string;
    persist: false;
    remoteBindings: false;
    envFiles: [];
  }): Promise<{
    env: { DB: D1Database; ARTIFACTS: R2Bucket };
    dispose(): Promise<void>;
  }>;
  unstable_splitSqlQuery(sql: string): string[];
};

let directory: string;
let proxy: Awaited<ReturnType<typeof wrangler.getPlatformProxy>>;
const owner = toUserId('user_d1_runtime');
const projectId = 'proj_d1_runtime';

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'openzcad-d1-runtime-'));
  const configPath = join(directory, 'wrangler.json');
  await writeFile(
    configPath,
    JSON.stringify({
      name: 'openzcad-d1-runtime-test',
      compatibility_date: '2026-04-12',
      d1_databases: [
        {
          binding: 'DB',
          database_name: 'local-test',
          database_id: '00000000-0000-0000-0000-000000000000',
          remote: false
        }
      ],
      r2_buckets: [
        { binding: 'ARTIFACTS', bucket_name: 'local-test', remote: false }
      ]
    })
  );
  proxy = await wrangler.getPlatformProxy({
    configPath,
    persist: false,
    remoteBindings: false,
    envFiles: []
  });
  const migrations = new URL('../apps/web/migrations/', import.meta.url);
  for (const file of (await readdir(migrations))
    .filter((f) => f.endsWith('.sql'))
    .sort()) {
    const sql = await readFile(new URL(file, migrations), 'utf8');
    await proxy.env.DB.batch(
      wrangler.unstable_splitSqlQuery(sql).map((s) => proxy.env.DB.prepare(s))
    );
  }
  await proxy.env.DB.batch([
    proxy.env.DB.prepare(
      'INSERT INTO users (id, created_at) VALUES (?, ?)'
    ).bind(owner, '2026-10-27'),
    proxy.env.DB.prepare(
      `INSERT INTO projects (id, user_id, name, document_json, updated_at, storage_format)
      VALUES (?, ?, '', 'e2ee-v1', '2026-10-27', 2)`
    ).bind(projectId, owner)
  ]);
}, 60_000);

afterAll(async () => {
  await proxy?.dispose();
  if (directory) await rm(directory, { recursive: true, force: true });
});

it('creates and retries an upload despite trigger accounting, and refuses a fenced-out insert', async () => {
  const service = new D1R2PersistenceService({
    DB: proxy.env.DB,
    ARTIFACTS: proxy.env.ARTIFACTS
  });
  const request = { projectId, blobId: 'a'.repeat(32), kind: 'import-source' };
  const first = await service.createEncryptedBlobUpload(owner, request, {
    sql: '1',
    binds: []
  });
  expect(first.committed).toBe(false);
  expect(
    await service.createEncryptedBlobUpload(owner, request, {
      sql: '1',
      binds: []
    })
  ).toEqual(first);
  await expect(
    service.createEncryptedBlobUpload(
      owner,
      { ...request, blobId: 'b'.repeat(32) },
      { sql: '0', binds: [] }
    )
  ).rejects.toMatchObject({ status: 401, code: 'E2EE_SESSION_REQUIRED' });
  expect(
    await proxy.env.DB.prepare(
      'SELECT COUNT(*) AS n FROM upload_sessions'
    ).first()
  ).toEqual({ n: 1 });
  expect(
    await proxy.env.DB.prepare(
      'SELECT active_sessions FROM artifact_account_usage WHERE owner_user_id = ?'
    )
      .bind(owner)
      .first()
  ).toEqual({ active_sessions: 1 });
});

it('loads contacts with every migration present under the real compound SELECT ceiling', async () => {
  const response = await handleE2eeContactsRequest(
    new Request('https://local.test/api/e2ee/contacts'),
    proxy.env.DB,
    owner,
    { sql: '0', binds: [], dispose: async () => {} },
    async () => ({})
  );
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ people: [] });
});

it('uploads and finalizes a staged asset with trigger-inclusive reservation accounting', async () => {
  const id = 'proj_d1_staging';
  const now = Date.now();
  const staging = { leaseId: 'l'.repeat(43), now };
  await proxy.env.DB.batch([
    proxy.env.DB.prepare(
      `INSERT INTO projects (id, user_id, name, document_json, updated_at)
      VALUES (?, ?, 'Staging', '{}', '2026-10-27')`
    ).bind(id, owner),
    proxy.env.DB.prepare(
      `INSERT INTO e2ee_project_migrations
      (project_id, direction, state, owner_user_id, device_id, lease_id, lease_expires_at,
       source_version, source_measurement_revision, started_at, updated_at)
      VALUES (?, 'encrypt', 'staging', ?, 'local-device', ?, ?, 1, 0, '2026-10-27', '2026-10-27')`
    ).bind(id, owner, staging.leaseId, now + 60_000)
  ]);
  const service = new D1R2PersistenceService({
    DB: proxy.env.DB,
    ARTIFACTS: proxy.env.ARTIFACTS,
    E2EE_MIGRATION_ENABLED: 'true'
  });
  const sealed = await encryptContentBlob(
    EnvelopeKey.generate(),
    'import-source',
    new TextEncoder().encode('runtime asset'),
    { compression: 'none' }
  );
  const { blobId } = sealed.reference;
  const authorization = { sql: '1', binds: [] };
  const started = await service.createEncryptedBlobUpload(
    owner,
    { projectId: id, blobId, kind: 'import-source' },
    authorization,
    staging
  );
  if (started.committed) throw new Error('Expected a new upload session');
  const bytes = sealed.envelope.buffer.slice(
    sealed.envelope.byteOffset,
    sealed.envelope.byteOffset + sealed.envelope.byteLength
  );
  await service.putUpload(owner, started.session.uploadSessionId, bytes);
  await service.putUpload(owner, started.session.uploadSessionId, bytes);
  const result = await service.finalizeEncryptedBlob(
    owner,
    {
      projectId: id,
      blobId,
      uploadSessionId: started.session.uploadSessionId,
      dedupeTag: null
    },
    authorization,
    (head) => {
      parseEnvelope(head);
    },
    staging
  );
  expect(
    new Uint8Array(
      await (await proxy.env.ARTIFACTS.get(result.objectKey))!.arrayBuffer()
    )
  ).toEqual(sealed.envelope);
  expect(
    await proxy.env.DB.prepare('SELECT id FROM upload_sessions WHERE id = ?')
      .bind(started.session.uploadSessionId)
      .first()
  ).toBeNull();
  expect(
    await proxy.env.DB.prepare(
      'SELECT reserved_bytes, finalized_bytes FROM artifact_account_usage WHERE owner_user_id = ?'
    )
      .bind(owner)
      .first()
    // Staged ciphertext is not charged until cutover (migration decision M10).
  ).toEqual({ reserved_bytes: 0, finalized_bytes: 0 });
  expect(
    await proxy.env.DB.prepare(
      'SELECT ciphertext_bytes FROM e2ee_content_blobs WHERE project_id = ? AND blob_id = ?'
    )
      .bind(id, blobId)
      .first()
  ).toEqual({ ciphertext_bytes: sealed.envelope.byteLength });
});
