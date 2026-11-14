import { describe, expect, it, vi, type Mock } from 'vitest';
import worker from '../apps/web/worker/index';
import { CommandManager, commandFactories } from '@openzcad/command-system';
import {
  assertClaimedDeleteComplete,
  claimObjectKeysForDelete,
  ObjectKeyDeleteRetryError,
  R2_KEY_DELETE_WINDOW_MS,
  R2_KEY_TOMBSTONE_TTL_MS
} from '@openzcad/cloudflare-adapters';
import {
  createProjectDocument,
  withoutDerivedProjection
} from '@openzcad/document-core';
import { splitProjectStorageUpload } from '@openzcad/persistence';
import { toUserId, type ProjectDocument } from '@openzcad/shared';
import { migratedDatabase, sqliteD1 } from './support/sqlite-d1';

const OWNER = toUserId('user_beta_dev');
const CREATED = '2026-11-13T00:00:00.000Z';
const STEP_TEXT = `ISO-10303-21;\n${'CLOSED_SHELL'.repeat(20_000)}\nEND-ISO-10303-21;`;

function database() {
  const db = migratedDatabase();
  db.prepare('INSERT INTO users (id, email, created_at) VALUES (?, ?, ?)').run(
    OWNER,
    'dev@example.test',
    CREATED
  );
  db.prepare(
    `INSERT INTO projects (id, user_id, name, document_json, updated_at)
     VALUES ('p1', ?, 'Project', '{}', ?)`
  ).run(OWNER, CREATED);
  return db;
}

function asset(
  db: ReturnType<typeof database>,
  id: string,
  key: string,
  checksum = id
) {
  db.prepare(
    `INSERT INTO project_storage_assets
       (id, project_id, kind, object_key, checksum_sha256, logical_bytes,
        stored_bytes, content_encoding, created_at)
     VALUES (?, 'p1', 'step-source', ?, ?, 10, 10, 'gzip', ?)`
  ).run(id, key, checksum, CREATED);
}

function session(db: ReturnType<typeof database>, id: string, key: string) {
  db.prepare(
    `INSERT INTO upload_sessions
       (id, artifact_id, project_id, object_key, file_name, content_type,
        kind, metadata_json, expires_at, owner_user_id, reserved_bytes,
        reservation_state, upload_protocol_version)
     VALUES (?, ?, 'p1', ?, 'f.step', 'model/step', 'snapshot', '{}',
             '2099-01-01T00:00:00.000Z', ?, 0, 'open', 1)`
  ).run(id, `artifact_${id}`, key, OWNER);
}

describe('R2 key tombstones (migration 0050)', () => {
  it('claims a key only while no other row names it', async () => {
    const db = database();
    const d1 = sqliteD1(db);
    asset(db, 'a_old', 'assets/k');
    // The cleanup removing a_old may claim its key...
    const mine = await claimObjectKeysForDelete(d1, ['assets/k'], {
      assets: ['a_old']
    });
    expect([...mine.keys]).toEqual(['assets/k']);
    await mine.release();
    // ...but not while another row names it.
    session(db, 's_new', 'assets/k');
    const blocked = await claimObjectKeysForDelete(d1, ['assets/k'], {
      assets: ['a_old']
    });
    expect([...blocked.keys]).toEqual([]);
    await blocked.release();
  });

  it('refuses every new row naming a key while it is claimed, and only then', async () => {
    const db = database();
    const d1 = sqliteD1(db);
    const claim = await claimObjectKeysForDelete(d1, ['blobs/k', 'assets/k']);
    expect(claim.keys.size).toBe(2);
    expect(() => session(db, 's1', 'blobs/k')).toThrow('r2_key_deleting');
    expect(() => asset(db, 'a1', 'assets/k')).toThrow('r2_key_deleting');
    // A second deleter cannot claim a key already claimed.
    const second = await claimObjectKeysForDelete(d1, ['blobs/k']);
    expect(second.keys.size).toBe(0);
    await second.release();
    await claim.release();
    session(db, 's1', 'blobs/k');
    asset(db, 'a1', 'assets/k');
  });

  it('claims nothing once its fence no longer holds', async () => {
    const db = database();
    const claim = await claimObjectKeysForDelete(
      sqliteD1(db),
      ['assets/k'],
      {},
      { sql: 'EXISTS (SELECT 1 FROM projects WHERE id = ?)', binds: ['gone'] }
    );
    expect(claim.keys.size).toBe(0);
  });

  it('lets a claim that outlived its deleter go: it blocks nothing and can be taken again', async () => {
    const db = database();
    db.prepare(
      `INSERT INTO r2_key_tombstones (object_key, token, created_at)
       VALUES ('assets/k', 'dead', ?)`
    ).run(Date.now() - R2_KEY_TOMBSTONE_TTL_MS - 60_000);
    asset(db, 'a1', 'assets/other');
    session(db, 's1', 'assets/k');
    db.prepare('DELETE FROM upload_sessions').run();
    const claim = await claimObjectKeysForDelete(sqliteD1(db), ['assets/k']);
    expect([...claim.keys]).toEqual(['assets/k']);
    await claim.release();
    expect(
      db.prepare('SELECT COUNT(*) AS n FROM r2_key_tombstones').get()
    ).toEqual({ n: 0 });
  });
});

describe('a source asset whose object vanished before its row landed', () => {
  it('is stored again once the save commits', async () => {
    const db = database();
    const objects = new Map<string, ArrayBuffer>();
    let dropped: string | null = null;
    const bucket = {
      put: vi.fn(async (key: string, body: ArrayBuffer) => {
        // A cleanup deletes the content-addressed key right after this
        // write's put, under a claim it releases before the row lands.
        if (!dropped && key.includes('/assets/')) {
          dropped = key;
          return;
        }
        objects.set(key, body.slice(0));
      }),
      get: vi.fn(async (key: string) => {
        const body = objects.get(key);
        return body
          ? { arrayBuffer: async () => body.slice(0), size: body.byteLength }
          : null;
      }),
      head: vi.fn(async (key: string) => {
        const body = objects.get(key);
        return body ? { size: body.byteLength } : null;
      }),
      delete: vi.fn(async (keys: string | string[]) => {
        for (const key of typeof keys === 'string' ? [keys] : keys)
          objects.delete(key);
      })
    };
    const env = {
      ENVIRONMENT: 'development' as const,
      AUTH_MODE: 'development' as const,
      DB: sqliteD1(db),
      PROJECT_STORAGE: bucket as unknown as R2Bucket,
      ARTIFACTS: {} as R2Bucket,
      PROJECT_ROOM: { getByName: vi.fn() }
    };
    const manager = new CommandManager(
      createProjectDocument('Split bracket', OWNER)
    );
    manager.execute(
      commandFactories.importStep({
        name: 'Bracket STEP',
        artifactId: 'artifact_split_step',
        sourceName: 'bracket.step',
        stepText: STEP_TEXT
      })
    );
    const document: ProjectDocument = withoutDerivedProjection(
      manager.document
    );
    const split = await splitProjectStorageUpload(document);
    const created = await worker.fetch(
      new Request('https://example.com/api/projects', {
        method: 'POST',
        body: JSON.stringify({
          name: document.name,
          initialDocument: split.document,
          storageAssets: split.storageAssets
        })
      }),
      env
    );
    expect(created.status).toBe(201);
    expect(dropped).not.toBeNull();
    const keys = (
      db.prepare('SELECT object_key FROM project_storage_assets').all() as {
        object_key: string;
      }[]
    ).map((row) => row.object_key);
    expect(keys).toContain(dropped);
    // The asset's row names it, and its bytes are there.
    for (const key of keys) expect(objects.has(key)).toBe(true);
  });
});

describe('claimed R2 deletes (PR #1473 review)', () => {
  it('reports another deleter’s fresh claim as contended, not as a key a row names', async () => {
    const db = database();
    const d1 = sqliteD1(db);
    const first = await claimObjectKeysForDelete(d1, ['assets/k']);
    const second = await claimObjectKeysForDelete(d1, ['assets/k']);
    expect([...second.keys]).toEqual([]);
    expect([...second.contended]).toEqual(['assets/k']);
    await second.release();
    await first.release();
    session(db, 's1', 'assets/k');
    const named = await claimObjectKeysForDelete(d1, ['assets/k']);
    expect([...named.keys]).toEqual([]);
    expect([...named.contended]).toEqual([]);
  });

  it('waits for every started delete before answering, and keeps the claim on a key whose delete failed', async () => {
    const db = database();
    const d1 = sqliteD1(db);
    const claim = await claimObjectKeysForDelete(d1, ['k/1', 'k/2']);
    let release!: () => void;
    const released = new Promise<void>((resolve) => (release = resolve));
    let firstDone = false;
    const bucket = {
      delete: vi.fn(async (key: string) => {
        if (key === 'k/1') {
          await released;
          firstDone = true;
          return;
        }
        throw new Error('R2 delete failed');
      })
    };
    let answered = false;
    const pending = claim.deleteObjects(bucket).then((outcome) => {
      answered = true;
      return outcome;
    });
    for (let tick = 0; tick < 20; tick++) await Promise.resolve();
    // k/2 already failed, but k/1 is still in flight: no answer yet, so no
    // caller can release the claim under it.
    expect(bucket.delete).toHaveBeenCalledTimes(2);
    expect(answered).toBe(false);
    release();
    const outcome = await pending;
    expect(firstDone).toBe(true);
    expect([...outcome.deleted]).toEqual(['k/1']);
    expect([...outcome.failed.keys()]).toEqual(['k/2']);
    expect(() => assertClaimedDeleteComplete(claim, outcome)).toThrow(
      'R2 delete failed'
    );
    await claim.release();
    // The failed delete's key stays claimed until the claim lapses.
    expect(
      db.prepare('SELECT object_key FROM r2_key_tombstones').all()
    ).toEqual([{ object_key: 'k/2' }]);
    expect(() => session(db, 's1', 'k/2')).toThrow('r2_key_deleting');
    session(db, 's2', 'k/1');
    // A later cleanup takes the settling claim over and deletes again; its
    // release still leaves the key blocked until the claim lapses.
    const retry = await claimObjectKeysForDelete(d1, ['k/2']);
    expect([...retry.keys]).toEqual(['k/2']);
    expect([...retry.contended]).toEqual([]);
    const retried = await retry.deleteObjects({ delete: async () => {} });
    expect([...retried.deleted]).toEqual(['k/2']);
    await retry.release();
    expect(() => session(db, 's3', 'k/2')).toThrow('r2_key_deleting');
  });

  it('starts no delete once its claim is no longer held: an expired claim taken over by a writer deletes nothing', async () => {
    const db = database();
    const d1 = sqliteD1(db);
    const claim = await claimObjectKeysForDelete(d1, ['assets/k']);
    expect([...claim.keys]).toEqual(['assets/k']);
    // The deleter stalls past the claim's lifetime: the claim lapses, a
    // second cleanup drops it, and a writer stores a new row under the key.
    db.prepare('UPDATE r2_key_tombstones SET created_at = ?').run(
      Date.now() - R2_KEY_TOMBSTONE_TTL_MS - 60_000
    );
    const other = await claimObjectKeysForDelete(d1, ['assets/k']);
    await other.release();
    asset(db, 'a_new', 'assets/k');
    const bucket = { delete: vi.fn(async () => {}) };
    const outcome = await claim.deleteObjects(bucket);
    expect(bucket.delete).not.toHaveBeenCalled();
    expect([...outcome.lapsed]).toEqual(['assets/k']);
    expect(() => assertClaimedDeleteComplete(claim, outcome)).toThrow(
      ObjectKeyDeleteRetryError
    );
  });

  it('starts no delete after its delete window, though the claim still blocks writers', async () => {
    const db = database();
    const d1 = sqliteD1(db);
    const claim = await claimObjectKeysForDelete(d1, ['assets/k']);
    const now = Date.now();
    const clock = vi
      .spyOn(Date, 'now')
      .mockReturnValue(now + R2_KEY_DELETE_WINDOW_MS + 1);
    try {
      const bucket = { delete: vi.fn(async () => {}) };
      const outcome = await claim.deleteObjects(bucket);
      expect(bucket.delete).not.toHaveBeenCalled();
      expect([...outcome.lapsed]).toEqual(['assets/k']);
    } finally {
      clock.mockRestore();
    }
    // A delete is never issued later than this window, so writers stay
    // blocked for the TTL's remaining margin after the last possible one.
    expect(
      R2_KEY_TOMBSTONE_TTL_MS - R2_KEY_DELETE_WINDOW_MS
    ).toBeGreaterThanOrEqual(45 * 60 * 1000);
    expect(() => asset(db, 'a1', 'assets/k')).toThrow('r2_key_deleting');
    await claim.release();
  });
});

describe('a staged decryption revision whose asset repair failed', () => {
  it('is not journaled, and its retry stages it again with its assets', async () => {
    const { D1R2PersistenceService } =
      await import('@openzcad/cloudflare-adapters');
    const { createSavedRevision } = await import('@openzcad/document-core');
    const { objectBucket } = await import('./support/e2ee-documents');
    const db = database();
    db.prepare('UPDATE projects SET storage_format = 2 WHERE id = ?').run('p1');
    const manager = new CommandManager({
      ...createProjectDocument('Source in an old revision', OWNER),
      projectId: 'p1'
    } as ProjectDocument);
    manager.execute(
      commandFactories.importStep({
        name: 'Old source',
        artifactId: 'artifact_local_old',
        sourceName: 'old.step',
        stepText: STEP_TEXT
      })
    );
    const document = createSavedRevision(
      withoutDerivedProjection(manager.document),
      'Source before it was removed'
    );
    const revisionId = document.revisions.at(-1)!.revisionId;
    const bucket = objectBucket();
    const putMock = bucket.put as unknown as Mock<
      (key: string, body: ArrayBuffer | Uint8Array) => Promise<void>
    >;
    const put = putMock.getMockImplementation()!;
    let assetPuts = 0;
    let assetKey = '';
    putMock.mockImplementation(async (key, body) => {
      if (key.includes('/assets/')) {
        assetKey = key;
        assetPuts++;
        // A cleanup removed the first put's bytes before the row landed...
        if (assetPuts === 1) return;
        // ...and storing them again after the commit fails once.
        if (assetPuts === 2) throw new Error('transient re-put outage');
      }
      return put(key, body);
    });
    const service = new D1R2PersistenceService({
      DB: sqliteD1(db),
      PROJECT_STORAGE: bucket,
      ARTIFACTS: bucket
    } as never);
    const input = {
      projectId: 'p1',
      document,
      revision: { revisionId, reason: 'Source before it was removed' },
      fence: { sql: '1', binds: [] }
    };
    await expect(service.stageDecryptedDocument(OWNER, input)).rejects.toThrow(
      'transient re-put outage'
    );
    // The save state is not journaled as staged until its assets are in
    // R2: no revision row landed, so the retry stages it again.
    expect(
      db.prepare('SELECT id FROM revisions WHERE id = ?').get(revisionId)
    ).toBeUndefined();
    expect(bucket.objects.has(assetKey)).toBe(false);
    putMock.mockImplementation(put);
    const objectsBefore = db
      .prepare('SELECT id FROM project_document_objects')
      .all();
    const retried = await service.stageDecryptedDocument(OWNER, input);
    expect(retried.staged).toBe(false);
    expect(bucket.objects.has(assetKey)).toBe(true);
    // It reuses the failed attempt's committed object: no second copy.
    expect(db.prepare('SELECT id FROM project_document_objects').all()).toEqual(
      objectsBefore
    );
    expect(objectsBefore).toContainEqual({ id: retried.objectId });
    expect(
      db.prepare('SELECT id FROM revisions WHERE id = ?').get(revisionId)
    ).toEqual({ id: revisionId });
    // A retry after that answers staged, with its assets still in place.
    const again = await service.stageDecryptedDocument(OWNER, input);
    expect(again.staged).toBe(true);
    expect(bucket.objects.has(assetKey)).toBe(true);
  });
});

describe('a project deleted twice and created again under its id', () => {
  const PROJECT = 'proj_11111111-1111-4111-8111-111111111111';

  async function recreatable() {
    const { D1R2PersistenceService } =
      await import('@openzcad/cloudflare-adapters');
    const { objectBucket } = await import('./support/e2ee-documents');
    const db = database();
    db.prepare('DELETE FROM projects').run();
    const manager = new CommandManager({
      ...createProjectDocument('Recreated project', OWNER),
      projectId: PROJECT
    } as ProjectDocument);
    manager.execute(
      commandFactories.importStep({
        name: 'Source',
        artifactId: 'artifact_local_source',
        sourceName: 'source.step',
        stepText: STEP_TEXT
      })
    );
    const document = withoutDerivedProjection(manager.document);
    const bucket = objectBucket();
    const d1 = sqliteD1(db);
    const service = new D1R2PersistenceService({
      DB: d1,
      PROJECT_STORAGE: bucket,
      ARTIFACTS: bucket
    } as never);
    await service.createProject(OWNER, {
      name: document.name,
      initialDocument: document
    });
    const assetKey = (
      db.prepare('SELECT object_key FROM project_storage_assets').get() as {
        object_key: string;
      }
    ).object_key;
    const deleteMock = bucket.delete as unknown as Mock<
      (key: string | string[]) => Promise<void>
    >;
    return { db, d1, bucket, service, document, assetKey, deleteMock };
  }

  it('a deletion paused at an R2 delete holds its keys: the other deletion waits, and a recreated project keeps its files', async () => {
    const { db, bucket, service, document, assetKey, deleteMock } =
      await recreatable();
    const remove = deleteMock.getMockImplementation()!;
    let entered!: () => void;
    let release!: () => void;
    const atDelete = new Promise<void>((resolve) => (entered = resolve));
    const released = new Promise<void>((resolve) => (release = resolve));
    deleteMock.mockImplementationOnce(async (key) => {
      entered();
      await released;
      return remove(key);
    });
    const stale = service.deleteProject(OWNER, PROJECT);
    await atDelete;
    // Deletion B cannot finish while A holds the project's keys, so the
    // project cannot be created again under its id meanwhile.
    await expect(service.deleteProject(OWNER, PROJECT)).rejects.toThrow(
      ObjectKeyDeleteRetryError
    );
    release();
    await stale;
    expect(db.prepare('SELECT id FROM projects').all()).toEqual([]);
    await service.createProject(OWNER, {
      name: document.name,
      initialDocument: document
    });
    expect(bucket.objects.has(assetKey)).toBe(true);
    expect(db.prepare('SELECT id FROM projects').all()).toEqual([
      { id: PROJECT }
    ]);
  });

  it('a deletion that stalls before its deletes touches nothing of the project created again after another deletion finished', async () => {
    const { db, d1, bucket, document, assetKey } = await recreatable();
    const { D1R2PersistenceService } =
      await import('@openzcad/cloudflare-adapters');
    // Deletion A records the generation it destroys, then stalls before it
    // lists anything.
    let entered!: () => void;
    let release!: () => void;
    const stalled = new Promise<void>((resolve) => (entered = resolve));
    const released = new Promise<void>((resolve) => (release = resolve));
    let intercept = true;
    const wrapped = new Proxy(d1, {
      get(target, property) {
        if (property === 'prepare') {
          return (sql: string) => {
            const statement = target.prepare(sql);
            if (
              !sql.includes(
                'SELECT id FROM upload_sessions WHERE project_id IN'
              )
            ) {
              return statement;
            }
            return new Proxy(statement, {
              get(inner, key) {
                if (key === 'bind') {
                  return (...args: unknown[]) => {
                    const bound = inner.bind(...args);
                    return new Proxy(bound, {
                      get(b, k) {
                        if (k === 'all' && intercept) {
                          intercept = false;
                          return async () => {
                            entered();
                            await released;
                            return b.all();
                          };
                        }
                        const value = Reflect.get(b, k) as unknown;
                        return typeof value === 'function'
                          ? (value as (...a: unknown[]) => unknown).bind(b)
                          : value;
                      }
                    });
                  };
                }
                const value = Reflect.get(inner, key) as unknown;
                return typeof value === 'function'
                  ? (value as (...a: unknown[]) => unknown).bind(inner)
                  : value;
              }
            });
          };
        }
        const value = Reflect.get(target, property) as unknown;
        return typeof value === 'function'
          ? (value as (...a: unknown[]) => unknown).bind(target)
          : value;
      }
    });
    const staleService = new D1R2PersistenceService({
      DB: wrapped,
      PROJECT_STORAGE: bucket,
      ARTIFACTS: bucket
    } as never);
    const service = new D1R2PersistenceService({
      DB: d1,
      PROJECT_STORAGE: bucket,
      ARTIFACTS: bucket
    } as never);
    const stale = staleService.deleteProject(OWNER, PROJECT);
    await stalled;
    // Deletion B finishes; the project is created again under its id and
    // stores the same content-addressed source.
    await service.deleteProject(OWNER, PROJECT);
    expect(bucket.objects.has(assetKey)).toBe(false);
    await service.createProject(OWNER, {
      name: document.name,
      initialDocument: document
    });
    expect(bucket.objects.has(assetKey)).toBe(true);
    // A resumes: the generation it set out to destroy is gone, so it
    // deletes no object and no row of the new project.
    release();
    await stale;
    expect(bucket.objects.has(assetKey)).toBe(true);
    expect(db.prepare('SELECT id FROM projects').all()).toEqual([
      { id: PROJECT }
    ]);
    expect(
      db.prepare('SELECT object_key FROM project_storage_assets').all()
    ).toEqual([{ object_key: assetKey }]);
    expect(
      db.prepare('SELECT COUNT(*) AS n FROM project_document_objects').get()
    ).toEqual({ n: 1 });
  });
});

describe('a deletion delayed past another one, the project created again (PR #1477 review)', () => {
  const PROJECT = 'proj_22222222-2222-4222-8222-222222222222';

  async function recreatable() {
    const { D1R2PersistenceService } =
      await import('@openzcad/cloudflare-adapters');
    const { objectBucket } = await import('./support/e2ee-documents');
    const db = database();
    db.prepare('DELETE FROM projects').run();
    const manager = new CommandManager({
      ...createProjectDocument('Recreated project', OWNER),
      projectId: PROJECT
    } as ProjectDocument);
    manager.execute(
      commandFactories.importStep({
        name: 'Source',
        artifactId: 'artifact_local_source',
        sourceName: 'source.step',
        stepText: STEP_TEXT
      })
    );
    const document = withoutDerivedProjection(manager.document);
    const bucket = objectBucket();
    const d1 = sqliteD1(db);
    const service = new D1R2PersistenceService({
      DB: d1,
      PROJECT_STORAGE: bucket,
      ARTIFACTS: bucket
    } as never);
    await service.createProject(OWNER, {
      name: document.name,
      initialDocument: document
    });
    const assetKey = (
      db.prepare('SELECT object_key FROM project_storage_assets').get() as {
        object_key: string;
      }
    ).object_key;
    return { db, d1, bucket, service, document, assetKey };
  }

  /** `d1`, pausing the first run of a statement whose SQL includes `marker`. */
  function pausing(d1: D1Database, marker: string) {
    let entered!: () => void;
    let release!: () => void;
    const paused = new Promise<void>((resolve) => (entered = resolve));
    const released = new Promise<void>((resolve) => (release = resolve));
    let once = true;
    const passThrough = <T extends object>(
      target: T,
      property: PropertyKey
    ) => {
      const value = Reflect.get(target, property) as unknown;
      return typeof value === 'function'
        ? (value as (...args: unknown[]) => unknown).bind(target)
        : value;
    };
    const wrapped = new Proxy(d1, {
      get(target, property) {
        if (property !== 'prepare') return passThrough(target, property);
        return (sql: string) => {
          const statement = target.prepare(sql);
          if (!sql.includes(marker)) return statement;
          return new Proxy(statement, {
            get(inner, key) {
              if (key !== 'bind') return passThrough(inner, key);
              return (...args: unknown[]) =>
                new Proxy(inner.bind(...args), {
                  get(bound, name) {
                    if (name === 'run' && once) {
                      once = false;
                      return async () => {
                        entered();
                        await released;
                        return bound.run();
                      };
                    }
                    return passThrough(bound, name);
                  }
                });
            }
          });
        };
      }
    });
    return { wrapped, paused, release };
  }

  it('a deletion stalled before taking its cleanup claim never claims or destroys the project created again', async () => {
    const { D1R2PersistenceService } =
      await import('@openzcad/cloudflare-adapters');
    const { db, d1, bucket, service, document, assetKey } = await recreatable();
    const { wrapped, paused, release } = pausing(
      d1,
      'INSERT OR IGNORE INTO project_copy_cleanup_claims'
    );
    const a = new D1R2PersistenceService({
      DB: wrapped,
      PROJECT_STORAGE: bucket,
      ARTIFACTS: bucket
    } as never);
    // A checked ownership and stalls just before claiming the project.
    const stale = a.deleteProject(OWNER, PROJECT);
    await paused;
    // B deletes the project, and it is created again under its id.
    await service.deleteProject(OWNER, PROJECT);
    await service.createProject(OWNER, {
      name: document.name,
      initialDocument: document
    });
    expect(bucket.objects.has(assetKey)).toBe(true);
    // A resumes: the instance it checked is gone, so it claims nothing.
    release();
    await stale;
    expect(
      db.prepare('SELECT id FROM projects WHERE id = ?').get(PROJECT)
    ).toEqual({ id: PROJECT });
    expect(bucket.objects.has(assetKey)).toBe(true);
    expect(
      db.prepare('SELECT COUNT(*) AS n FROM project_copy_cleanup_claims').get()
    ).toEqual({ n: 0 });
  });

  it('a delayed room erasure of the deleted project leaves the room of the project created again', async () => {
    const { D1R2PersistenceService } =
      await import('@openzcad/cloudflare-adapters');
    const {
      createRoomContext,
      createTestRoom,
      settleRoom,
      installWorkerSocketGlobals
    } = await import('./collaboration-room-harness');
    const { db, d1, bucket, service, document, assetKey } = await recreatable();
    const storage = createRoomContext();
    let room = createTestRoom(storage.context, { DB: d1 });
    await settleRoom(room);
    let entered!: () => void;
    let release!: () => void;
    const atRoom = new Promise<void>((resolve) => (entered = resolve));
    const released = new Promise<void>((resolve) => (release = resolve));
    // A's room erasure is delayed on its way to the room.
    const a = new D1R2PersistenceService({
      DB: d1,
      PROJECT_STORAGE: bucket,
      ARTIFACTS: bucket,
      PROJECT_ROOM: {
        getByName: () => ({
          fetch: async (request: Request) => {
            entered();
            await released;
            return room.fetch(request);
          }
        })
      }
    } as never);
    const stale = a.deleteProject(OWNER, PROJECT);
    await atRoom;
    const b = new D1R2PersistenceService({
      DB: d1,
      PROJECT_STORAGE: bucket,
      ARTIFACTS: bucket,
      PROJECT_ROOM: {
        getByName: () => ({ fetch: (request: Request) => room.fetch(request) })
      }
    } as never);
    await b.deleteProject(OWNER, PROJECT);
    await service.createProject(OWNER, {
      name: document.name,
      initialDocument: document
    });
    // The recreated project's room accepts a client and stores its state.
    room = createTestRoom(storage.context, { DB: d1 });
    await settleRoom(room);
    const globals = installWorkerSocketGlobals();
    try {
      const response = await room.fetch(
        new Request(`https://room.test/?projectId=${PROJECT}`, {
          headers: {
            upgrade: 'websocket',
            'x-openzcad-user-id': OWNER,
            'x-openzcad-display-name': 'Owner',
            'x-openzcad-project-role': 'owner'
          }
        })
      );
      expect(response.status).toBe(101);
      const socket = globals.serverSockets.at(-1)!;
      const roomDocument = {
        ...createProjectDocument('Recreated room', OWNER),
        projectId: PROJECT
      };
      (
        roomDocument.nodes[roomDocument.rootNodeId] as unknown as {
          projectId: string;
        }
      ).projectId = PROJECT;
      await socket.receive(
        JSON.stringify({
          type: 'hello',
          clientId: 'client_recreated',
          displayName: 'Owner',
          baseVersion: null,
          document: roomDocument
        })
      );
      expect(storage.values.has('room:latest')).toBe(true);
      // A's erasure finally reaches the room: it names the old instance, so
      // the new room's state stays.
      release();
      await stale;
    } finally {
      globals.restore();
    }
    expect(storage.values.has('room:latest')).toBe(true);
    expect(
      db.prepare('SELECT id FROM projects WHERE id = ?').get(PROJECT)
    ).toEqual({ id: PROJECT });
    expect(bucket.objects.has(assetKey)).toBe(true);
  });
});

describe('room identity and account erasure under recreation (PR #1477 review, round 2)', () => {
  const PROJECT = 'proj_33333333-3333-4333-8333-333333333333';

  async function recreatable() {
    const { D1R2PersistenceService } =
      await import('@openzcad/cloudflare-adapters');
    const { objectBucket } = await import('./support/e2ee-documents');
    const db = database();
    db.prepare('DELETE FROM projects').run();
    const manager = new CommandManager({
      ...createProjectDocument('Recreated project', OWNER),
      projectId: PROJECT
    } as ProjectDocument);
    manager.execute(
      commandFactories.importStep({
        name: 'Source',
        artifactId: 'artifact_local_source',
        sourceName: 'source.step',
        stepText: STEP_TEXT
      })
    );
    const document = withoutDerivedProjection(manager.document);
    const bucket = objectBucket();
    const d1 = sqliteD1(db);
    const service = new D1R2PersistenceService({
      DB: d1,
      PROJECT_STORAGE: bucket,
      ARTIFACTS: bucket
    } as never);
    await service.createProject(OWNER, {
      name: document.name,
      initialDocument: document
    });
    const assetKey = (
      db.prepare('SELECT object_key FROM project_storage_assets').get() as {
        object_key: string;
      }
    ).object_key;
    return { db, d1, bucket, service, document, assetKey };
  }

  const roomDocument = () => {
    const document = {
      ...createProjectDocument('Recreated room', OWNER),
      projectId: PROJECT
    };
    (
      document.nodes[document.rootNodeId] as unknown as { projectId: string }
    ).projectId = PROJECT;
    return document;
  };

  const hello = (clientId: string) =>
    JSON.stringify({
      type: 'hello',
      clientId,
      displayName: 'Owner',
      baseVersion: null,
      document: roomDocument()
    });

  const socketRequest = () =>
    new Request(`https://room.test/?projectId=${PROJECT}`, {
      headers: {
        upgrade: 'websocket',
        'x-openzcad-user-id': OWNER,
        'x-openzcad-display-name': 'Owner',
        'x-openzcad-project-role': 'owner'
      }
    });

  it('acknowledges no room state it cannot attribute to an instance, so a stale erasure never clears acknowledged state', async () => {
    const { D1R2PersistenceService } =
      await import('@openzcad/cloudflare-adapters');
    const {
      createRoomContext,
      createTestRoom,
      settleRoom,
      installWorkerSocketGlobals
    } = await import('./collaboration-room-harness');
    const { db, d1, bucket, service, document, assetKey } = await recreatable();
    const storage = createRoomContext();
    let room = createTestRoom(storage.context, { DB: d1 });
    await settleRoom(room);
    let entered!: () => void;
    let release!: () => void;
    const atRoom = new Promise<void>((resolve) => (entered = resolve));
    const released = new Promise<void>((resolve) => (release = resolve));
    const a = new D1R2PersistenceService({
      DB: d1,
      PROJECT_STORAGE: bucket,
      ARTIFACTS: bucket,
      PROJECT_ROOM: {
        getByName: () => ({
          fetch: async (request: Request) => {
            entered();
            await released;
            return room.fetch(request);
          }
        })
      }
    } as never);
    const stale = a.deleteProject(OWNER, PROJECT);
    await atRoom;
    const b = new D1R2PersistenceService({
      DB: d1,
      PROJECT_STORAGE: bucket,
      ARTIFACTS: bucket,
      PROJECT_ROOM: {
        getByName: () => ({ fetch: (request: Request) => room.fetch(request) })
      }
    } as never);
    await b.deleteProject(OWNER, PROJECT);
    await service.createProject(OWNER, {
      name: document.name,
      initialDocument: document
    });
    // The recreated project's room cannot read its instance for a while.
    let failIdentity = true;
    const unreliable = sqliteD1(db, {
      onStatement(sql) {
        if (
          failIdentity &&
          sql.includes('SELECT instance_id FROM project_instances')
        ) {
          throw new Error('transient D1 read outage');
        }
      }
    });
    room = createTestRoom(storage.context, { DB: unreliable });
    await settleRoom(room);
    const globals = installWorkerSocketGlobals();
    try {
      // Admission stores state, so it fails (a 500 from the room) while
      // the instance is unknown; nothing is acknowledged or kept.
      const refused = await room.fetch(socketRequest()).catch(() => null);
      if (refused?.status === 101) {
        const socket = globals.serverSockets.at(-1)!;
        await socket.receive(hello('client_early'));
        expect(
          socket
            .frames()
            .some((frame) => (frame as { type?: string }).type === 'ack')
        ).toBe(false);
      }
      expect(storage.values.has('room:latest')).toBe(false);
      // Once D1 answers, the client joins and its state is acknowledged
      // under the recreated project's instance.
      failIdentity = false;
      room = createTestRoom(storage.context, { DB: unreliable });
      await settleRoom(room);
      expect((await room.fetch(socketRequest())).status).toBe(101);
      const socket = globals.serverSockets.at(-1)!;
      await socket.receive(hello('client_recreated'));
      expect(storage.values.has('room:latest')).toBe(true);
      expect(
        (storage.values.get('room:meta') as { instanceId?: string }).instanceId
      ).toMatch(/^[0-9a-f]{32}$/);
      // A's erasure of the old instance finally arrives: a no-op.
      release();
      await stale;
    } finally {
      globals.restore();
    }
    expect(storage.values.has('room:latest')).toBe(true);
    expect(
      db.prepare('SELECT id FROM projects WHERE id = ?').get(PROJECT)
    ).toEqual({ id: PROJECT });
    expect(bucket.objects.has(assetKey)).toBe(true);
  });

  it('an account erasure attempt that resumes after a retry completed it touches nothing created since', async () => {
    const { D1R2PersistenceService } =
      await import('@openzcad/cloudflare-adapters');
    const {
      createRoomContext,
      createTestRoom,
      settleRoom,
      installWorkerSocketGlobals
    } = await import('./collaboration-room-harness');
    const { deleteAccountData } =
      await import('../apps/web/worker/accountDeletion');
    const { db, d1, bucket, service, document, assetKey } = await recreatable();
    const storage = createRoomContext();
    let room = createTestRoom(storage.context, { DB: d1 });
    await settleRoom(room);
    let entered!: () => void;
    let release!: () => void;
    const atRoom = new Promise<void>((resolve) => (entered = resolve));
    const released = new Promise<void>((resolve) => (release = resolve));
    const session = {
      userId: OWNER,
      email: 'dev@example.test'
    } as never;
    const input = { scope: 'projects', confirmation: 'dev@example.test' };
    const base = {
      ENVIRONMENT: 'development',
      AUTH_MODE: 'development',
      DB: d1,
      PROJECT_STORAGE: bucket,
      ARTIFACTS: bucket
    };
    const envA = {
      ...base,
      PROJECT_ROOM: {
        getByName: () => ({
          fetch: async (request: Request) => {
            entered();
            await released;
            return room.fetch(request);
          }
        })
      }
    };
    const envB = {
      ...base,
      PROJECT_ROOM: {
        getByName: () => ({ fetch: (request: Request) => room.fetch(request) })
      }
    };
    // Attempt A pauses on its room erasure; retry B completes the request.
    const stale = deleteAccountData(
      session,
      input,
      envA as never,
      new D1R2PersistenceService(envA as never)
    );
    await atRoom;
    const completed = await deleteAccountData(
      session,
      input,
      envB as never,
      new D1R2PersistenceService(envB as never)
    );
    expect(completed.ok).toBe(true);
    expect(db.prepare('SELECT * FROM account_erasure_requests').all()).toEqual(
      []
    );
    // The project is created again, and its room stores a document.
    await service.createProject(OWNER, {
      name: document.name,
      initialDocument: document
    });
    room = createTestRoom(storage.context, { DB: d1 });
    await settleRoom(room);
    const globals = installWorkerSocketGlobals();
    try {
      expect((await room.fetch(socketRequest())).status).toBe(101);
      const socket = globals.serverSockets.at(-1)!;
      await socket.receive(hello('client_recreated'));
      expect(storage.values.has('room:latest')).toBe(true);
      // A resumes: its erasure names the old instance, and its request is
      // already complete, so it erases and deletes nothing.
      release();
      expect((await stale).ok).toBe(true);
    } finally {
      globals.restore();
    }
    expect(storage.values.has('room:latest')).toBe(true);
    expect(
      db.prepare('SELECT id FROM projects WHERE id = ?').get(PROJECT)
    ).toEqual({ id: PROJECT });
    expect(bucket.objects.has(assetKey)).toBe(true);
  });
});
