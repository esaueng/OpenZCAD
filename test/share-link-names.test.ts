import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { toUserId } from '@openzcad/shared';
import {
  isShareLinkNameStorageReady,
  loadShareLinkNames,
  MAX_SHARE_LINK_NAMES_RECORD_CHARS,
  parseSaveShareLinkNamesRequest,
  saveShareLinkNames,
  shareLinkNameErasureStatements,
  ShareLinkNamesConflictError,
  ShareLinkNamesRequestError
} from '../apps/web/worker/shareLinkNames';
import { exportAccountData } from '../apps/web/worker/accountExport';
import worker from '../apps/web/worker/index';
import { d1Database, migratedDatabase } from './d1-sqlite';

const NOW = '2026-11-22T12:00:00.000Z';

/** A record of the sealed layout at `sequence`; its content is opaque here. */
function sealed(sequence: number, fill = 7): string {
  const bytes = new Uint8Array(1 + 32 + 4 + 12 + 16 + 8).fill(fill);
  bytes[0] = 1;
  new DataView(bytes.buffer).setUint32(33, sequence);
  return Buffer.from(bytes).toString('base64url');
}

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

const save = (expectedRevision: number, sequence: number, fill?: number) =>
  parseSaveShareLinkNamesRequest({
    expectedRevision,
    record: sealed(sequence, fill)
  });

describe('share link name storage (migration 0067)', () => {
  it('is ready on the migrated schema and not before it', async () => {
    expect(await isShareLinkNameStorageReady(withUsers())).toBe(true);
    const bare = new DatabaseSync(':memory:');
    expect(await isShareLinkNameStorageReady(d1Database(bare))).toBe(false);
    bare.close();
  });

  it('stores per account with compare-and-set on the revision', async () => {
    const d1 = withUsers('owner', 'other');
    expect(await loadShareLinkNames(d1, 'owner')).toEqual({
      revision: 0,
      sequence: 0,
      record: null,
      updatedAt: null
    });
    const first = await saveShareLinkNames(d1, 'owner', save(0, 1), NOW);
    expect(first).toMatchObject({ revision: 1, sequence: 1 });

    // A second device that also started from nothing must merge first.
    const stale = saveShareLinkNames(d1, 'owner', save(0, 2));
    await expect(stale).rejects.toBeInstanceOf(ShareLinkNamesConflictError);
    await stale.catch((error: ShareLinkNamesConflictError) =>
      expect(error.current).toMatchObject({
        revision: 1,
        sequence: 1,
        record: sealed(1)
      })
    );
    expect(
      await saveShareLinkNames(d1, 'owner', save(1, 5))
    ).toMatchObject({ revision: 2, sequence: 5 });
    expect((await loadShareLinkNames(d1, 'other')).revision).toBe(0);
  });

  it('never lets a write lower or repeat the sealed sequence', async () => {
    const d1 = withUsers('owner');
    await saveShareLinkNames(d1, 'owner', save(0, 4));
    for (const sequence of [3, 4]) {
      const refused = saveShareLinkNames(d1, 'owner', save(1, sequence, 9));
      await expect(refused).rejects.toBeInstanceOf(ShareLinkNamesConflictError);
    }
    expect(await loadShareLinkNames(d1, 'owner')).toMatchObject({
      revision: 1,
      sequence: 4,
      record: sealed(4)
    });
  });

  it('refuses writes while the account is being erased, and erases with it', async () => {
    const d1 = withUsers('owner');
    await saveShareLinkNames(d1, 'owner', save(0, 1));
    db!
      .prepare(
        "INSERT INTO account_erasure_requests (user_id, scope, started_at, updated_at) VALUES (?, 'profile', 1, 1)"
      )
      .run('owner');
    await expect(
      saveShareLinkNames(d1, 'owner', save(1, 2))
    ).rejects.toThrow(/ACCOUNT_ERASURE_IN_PROGRESS/);
    await d1.batch(await shareLinkNameErasureStatements(d1, 'owner'));
    expect((await loadShareLinkNames(d1, 'owner')).revision).toBe(0);
  });

  it('goes with the user row', async () => {
    const d1 = withUsers('owner');
    await saveShareLinkNames(d1, 'owner', save(0, 1));
    db!.prepare('DELETE FROM users WHERE id = ?').run('owner');
    expect((await loadShareLinkNames(d1, 'owner')).revision).toBe(0);
  });

  it('is included, opaque, in the account export for its owner only', async () => {
    const d1 = withUsers('owner', 'other');
    await saveShareLinkNames(d1, 'owner', save(0, 1));
    await saveShareLinkNames(d1, 'other', save(0, 3, 2));
    const exported = await exportAccountData(
      { userId: toUserId('owner'), displayName: 'Owner', mode: 'development' },
      { DB: d1 }
    );
    const rows = (exported.records as Record<string, unknown[]>)
      .e2ee_share_link_names;
    expect(rows).toEqual([
      expect.objectContaining({ revision: 1, sequence: 1, record: sealed(1) })
    ]);
  });
});

describe('parseSaveShareLinkNamesRequest', () => {
  const refusal = (body: unknown) => {
    try {
      parseSaveShareLinkNamesRequest(body);
    } catch (error) {
      return error instanceof ShareLinkNamesRequestError
        ? [error.status, error.code]
        : error;
    }
    return 'accepted';
  };

  it('reads the sequence from the sealed header, not the request', () => {
    expect(
      parseSaveShareLinkNamesRequest({
        expectedRevision: 2,
        record: sealed(0x01020304),
        sequence: 1
      })
    ).toEqual({ expectedRevision: 2, record: sealed(0x01020304), sequence: 0x01020304 });
  });

  it('refuses malformed requests', () => {
    const bad = [400, 'SHARE_LINK_NAMES_INVALID'];
    expect(refusal(null)).toEqual(bad);
    expect(refusal([])).toEqual(bad);
    expect(refusal({ expectedRevision: -1, record: sealed(1) })).toEqual(bad);
    expect(refusal({ expectedRevision: 0.5, record: sealed(1) })).toEqual(bad);
    expect(refusal({ expectedRevision: 0, record: '' })).toEqual(bad);
    expect(refusal({ expectedRevision: 0, record: 'not base64url!' })).toEqual(
      bad
    );
    // Too short for a header, IV and tag; another layout version; sequence 0.
    expect(refusal({ expectedRevision: 0, record: 'AQID' })).toEqual(bad);
    const version2 = Buffer.from(sealed(1), 'base64url');
    version2[0] = 2;
    expect(
      refusal({ expectedRevision: 0, record: version2.toString('base64url') })
    ).toEqual(bad);
    expect(refusal({ expectedRevision: 0, record: sealed(0) })).toEqual(bad);
    expect(
      refusal({
        expectedRevision: 0,
        record: 'a'.repeat(MAX_SHARE_LINK_NAMES_RECORD_CHARS + 1)
      })
    ).toEqual([413, 'SHARE_LINK_NAMES_TOO_LARGE']);
  });
});

describe('/api/share-link-names', () => {
  const route = 'https://example.com/api/share-link-names';
  const env = (d1: D1Database, extra: Record<string, string> = {}) => ({
    ENVIRONMENT: 'development' as const,
    AUTH_MODE: 'development' as const,
    DB: d1,
    E2EE_KEYS_ENABLED: 'true',
    E2EE_PROJECTS_ENABLED: 'true',
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
    expect(await empty.json()).toMatchObject({
      revision: 0,
      sequence: 0,
      record: null
    });

    const written = await worker.fetch(
      put({ expectedRevision: 0, record: sealed(1) }),
      env(d1)
    );
    expect(written.status).toBe(200);
    expect(await written.json()).toMatchObject({ revision: 1, sequence: 1 });

    const conflict = await worker.fetch(
      put({ expectedRevision: 0, record: sealed(2) }),
      env(d1)
    );
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({
      code: 'SHARE_LINK_NAMES_CONFLICT',
      current: { revision: 1, sequence: 1, record: sealed(1) }
    });

    const rollback = await worker.fetch(
      put({ expectedRevision: 1, record: sealed(1, 3) }),
      env(d1)
    );
    expect(rollback.status).toBe(409);

    const malformed = await worker.fetch(
      put({ expectedRevision: 1, record: 'plain words' }),
      env(d1)
    );
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toMatchObject({
      code: 'SHARE_LINK_NAMES_INVALID'
    });
  });

  it('stays closed unless the account may encrypt projects', async () => {
    const d1 = withUsers('user_beta_dev');
    for (const request of [
      new Request(route),
      put({ expectedRevision: 0, record: sealed(1) })
    ]) {
      const response = await worker.fetch(
        request,
        env(d1, { E2EE_PROJECTS_ENABLED: 'false' })
      );
      expect(response.status).toBe(501);
      expect(await response.json()).toMatchObject({
        code: 'SHARE_LINK_NAMES_DISABLED'
      });
    }
    expect((await loadShareLinkNames(d1, 'user_beta_dev')).revision).toBe(0);
  });

  it('answers 503 before the migration is applied', async () => {
    const bare = new DatabaseSync(':memory:');
    const response = await worker.fetch(
      new Request(route),
      env(d1Database(bare))
    );
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      code: 'SHARE_LINK_NAMES_UNAVAILABLE'
    });
    bare.close();
  });
});
