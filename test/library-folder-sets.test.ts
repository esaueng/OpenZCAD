import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { toUserId } from '@openzcad/shared';
import {
  isLibraryFolderStorageReady,
  LibraryFolderRequestError,
  LibraryFolderRevisionConflictError,
  libraryFolderErasureStatements,
  loadLibraryFolderSet,
  MAX_LIBRARY_FOLDER_RECORD_CHARS,
  parseSaveLibraryFolderSetRequest,
  saveLibraryFolderSet
} from '../apps/web/worker/libraryFolderSets';
import { exportAccountData } from '../apps/web/worker/accountExport';
import worker from '../apps/web/worker/index';
import { d1Database, migratedDatabase } from './d1-sqlite';

const SET = JSON.stringify({ version: 2, folders: {}, members: {} });
const NOW = '2026-10-30T12:00:00.000Z';

let db: DatabaseSync | undefined;
afterEach(() => {
  db?.close();
  db = undefined;
});

function withUsers(...ids: string[]) {
  db = migratedDatabase();
  for (const id of ids) {
    db.prepare(
      'INSERT INTO users (id, email, created_at) VALUES (?, ?, ?)'
    ).run(id, `${id}@example.com`, NOW);
  }
  return d1Database(db);
}

function save(expectedRevision: number, format: 1 | 2 = 1, record = SET) {
  return { expectedRevision, format, record };
}

describe('library folder storage (migration 0045)', () => {
  it('is ready on the migrated schema and not before it', async () => {
    expect(await isLibraryFolderStorageReady(withUsers())).toBe(true);
    const bare = new DatabaseSync(':memory:');
    expect(await isLibraryFolderStorageReady(d1Database(bare))).toBe(false);
    bare.close();
  });

  it('stores per account with compare-and-set on the revision', async () => {
    const d1 = withUsers('owner', 'other');
    expect(await loadLibraryFolderSet(d1, 'owner')).toEqual({
      revision: 0,
      format: null,
      record: null,
      updatedAt: null
    });

    const first = await saveLibraryFolderSet(d1, 'owner', save(0), NOW);
    expect(first).toMatchObject({ revision: 1, format: 1, record: SET });

    // A second device that also started from nothing must merge, not overwrite.
    const stale = saveLibraryFolderSet(d1, 'owner', save(0, 2, 'c2VhbGVk'));
    await expect(stale).rejects.toBeInstanceOf(
      LibraryFolderRevisionConflictError
    );
    await stale.catch((error: LibraryFolderRevisionConflictError) =>
      expect(error.current).toMatchObject({ revision: 1, record: SET })
    );

    const second = await saveLibraryFolderSet(
      d1,
      'owner',
      save(1, 2, 'c2VhbGVk')
    );
    expect(second).toMatchObject({ revision: 2, format: 2 });
    await expect(
      saveLibraryFolderSet(d1, 'owner', save(1))
    ).rejects.toBeInstanceOf(LibraryFolderRevisionConflictError);

    expect((await loadLibraryFolderSet(d1, 'other')).revision).toBe(0);
  });

  it('refuses writes while the account is being erased, and erases with it', async () => {
    const d1 = withUsers('owner');
    await saveLibraryFolderSet(d1, 'owner', save(0));
    db!
      .prepare(
        "INSERT INTO account_erasure_requests (user_id, scope, started_at, updated_at) VALUES (?, 'profile', 1, 1)"
      )
      .run('owner');
    await expect(saveLibraryFolderSet(d1, 'owner', save(1))).rejects.toThrow(
      /ACCOUNT_ERASURE_IN_PROGRESS/
    );

    await d1.batch(await libraryFolderErasureStatements(d1, 'owner'));
    expect((await loadLibraryFolderSet(d1, 'owner')).revision).toBe(0);
  });

  it('goes with the user row', async () => {
    const d1 = withUsers('owner');
    await saveLibraryFolderSet(d1, 'owner', save(0));
    db!.prepare('DELETE FROM users WHERE id = ?').run('owner');
    expect((await loadLibraryFolderSet(d1, 'owner')).revision).toBe(0);
  });

  it('is included in the account export for its owner only', async () => {
    const d1 = withUsers('owner', 'other');
    await saveLibraryFolderSet(d1, 'owner', save(0));
    await saveLibraryFolderSet(d1, 'other', save(0, 2, 'b3RoZXI'));
    const exported = await exportAccountData(
      { userId: toUserId('owner'), displayName: 'Owner', mode: 'development' },
      { DB: d1 }
    );
    const rows = (exported.records as Record<string, unknown[]>)
      .library_folder_sets;
    expect(rows).toHaveLength(1);
    expect(rows![0]).toMatchObject({ format: 1, revision: 1, record: SET });
  });
});

describe('parseSaveLibraryFolderSetRequest', () => {
  const refusal = (body: unknown) => {
    try {
      parseSaveLibraryFolderSetRequest(body);
    } catch (error) {
      return error instanceof LibraryFolderRequestError
        ? [error.status, error.code]
        : error;
    }
    return 'accepted';
  };

  it('accepts a plaintext set and a sealed record', () => {
    expect(parseSaveLibraryFolderSetRequest(save(0))).toEqual(save(0));
    expect(parseSaveLibraryFolderSetRequest(save(3, 2, 'a-b_c'))).toEqual(
      save(3, 2, 'a-b_c')
    );
  });

  it('refuses malformed requests', () => {
    const bad = [400, 'LIBRARY_FOLDERS_INVALID'];
    expect(refusal(null)).toEqual(bad);
    expect(refusal({ ...save(0), expectedRevision: -1 })).toEqual(bad);
    expect(refusal({ ...save(0), expectedRevision: 1.5 })).toEqual(bad);
    expect(refusal({ ...save(0), format: 3 })).toEqual(bad);
    expect(refusal(save(0, 1, ''))).toEqual(bad);
    expect(refusal(save(0, 1, 'not json'))).toEqual(bad);
    expect(refusal(save(0, 1, '{"version":1}'))).toEqual(bad);
    expect(refusal(save(0, 1, '[]'))).toEqual(bad);
    expect(refusal(save(0, 2, 'not base64url!'))).toEqual(bad);
    expect(
      refusal(save(0, 2, 'a'.repeat(MAX_LIBRARY_FOLDER_RECORD_CHARS + 1)))
    ).toEqual([413, 'LIBRARY_FOLDERS_TOO_LARGE']);
  });
});

describe('/api/library-folders', () => {
  const route = 'https://example.com/api/library-folders';
  const env = (d1: D1Database, extra: Record<string, string> = {}) => ({
    ENVIRONMENT: 'development' as const,
    AUTH_MODE: 'development' as const,
    DB: d1,
    ...extra
  });
  const put = (body: unknown) =>
    new Request(route, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body)
    });

  it('reads, writes and answers a conflict with the current copy', async () => {
    const d1 = withUsers('user_beta_dev');
    const empty = await worker.fetch(new Request(route), env(d1));
    expect(empty.status).toBe(200);
    expect(await empty.json()).toMatchObject({ revision: 0, record: null });

    const written = await worker.fetch(put(save(0)), env(d1));
    expect(written.status).toBe(200);
    expect(await written.json()).toMatchObject({ revision: 1, record: SET });

    const conflict = await worker.fetch(put(save(0)), env(d1));
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({
      code: 'LIBRARY_FOLDERS_REVISION_CONFLICT',
      current: { revision: 1, format: 1, record: SET }
    });

    const malformed = await worker.fetch(put({ format: 1 }), env(d1));
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toMatchObject({
      code: 'LIBRARY_FOLDERS_INVALID'
    });
  });

  it('answers 503 before the migration is applied', async () => {
    const bare = new DatabaseSync(':memory:');
    const response = await worker.fetch(
      new Request(route),
      env(d1Database(bare))
    );
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      code: 'LIBRARY_FOLDERS_UNAVAILABLE'
    });
    bare.close();
  });

  it('stores only sealed folders where encryption is the default', async () => {
    const d1 = withUsers('user_beta_dev');
    const encrypted = env(d1, {
      E2EE_KEYS_ENABLED: 'true',
      E2EE_PROJECTS_ENABLED: 'true',
      E2EE_MIGRATION_ENABLED: 'true',
      E2EE_DEFAULT_ON: 'true'
    });
    const plaintext = await worker.fetch(put(save(0)), encrypted);
    expect(plaintext.status).toBe(409);
    expect(await plaintext.json()).toMatchObject({
      code: 'LIBRARY_FOLDERS_ENCRYPTION_REQUIRED'
    });
    expect((await loadLibraryFolderSet(d1, 'user_beta_dev')).revision).toBe(0);

    const sealed = await worker.fetch(put(save(0, 2, 'c2VhbGVk')), encrypted);
    expect(sealed.status).toBe(200);
  });
});
