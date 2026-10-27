import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { D1R2PersistenceService } from '@openzcad/cloudflare-adapters';
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
