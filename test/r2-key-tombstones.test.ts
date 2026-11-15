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

describe('an account erasure attempt a retry overtook (PR #1477 review, round 3)', () => {
  const PROJECT = 'proj_44444444-4444-4444-8444-444444444444';

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

  /** `d1`, pausing the first `method` call of a statement naming `marker`. */
  function pausing(d1: D1Database, marker: string, method: 'first' | 'all') {
    let entered!: () => void;
    let release!: () => void;
    const paused = new Promise<void>((resolve) => (entered = resolve));
    const released = new Promise<void>((resolve) => (release = resolve));
    let once = true;
    const pass = <T extends object>(target: T, property: PropertyKey) => {
      const value = Reflect.get(target, property) as unknown;
      return typeof value === 'function'
        ? (value as (...args: unknown[]) => unknown).bind(target)
        : value;
    };
    const wrapped = new Proxy(d1, {
      get(target, property) {
        if (property !== 'prepare') return pass(target, property);
        return (sql: string) => {
          const statement = target.prepare(sql);
          if (!sql.includes(marker)) return statement;
          return new Proxy(statement, {
            get(inner, key) {
              if (key !== 'bind') return pass(inner, key);
              return (...args: unknown[]) =>
                new Proxy(inner.bind(...args), {
                  get(bound, name) {
                    if (name === method && once) {
                      once = false;
                      return async () => {
                        entered();
                        await released;
                        return method === 'first' ? bound.first() : bound.all();
                      };
                    }
                    return pass(bound, name);
                  }
                });
            }
          });
        };
      }
    });
    return { wrapped, paused, release };
  }

  for (const [label, marker, method] of [
    ['before listing its projects', 'FROM projects p WHERE p.user_id', 'all'],
    ['between listing and its room erasure', 'SELECT 1 AS current', 'first']
  ] as const) {
    it(`a stalled attempt (${label}) touches nothing created after the retry completed`, async () => {
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
      const { db, d1, bucket, service, document, assetKey } =
        await recreatable();
      const { wrapped, paused, release } = pausing(d1, marker, method);
      const storage = createRoomContext();
      let room = createTestRoom(storage.context, { DB: d1 });
      await settleRoom(room);
      const rooms = {
        getByName: () => ({ fetch: (request: Request) => room.fetch(request) })
      };
      const base = {
        ENVIRONMENT: 'development',
        AUTH_MODE: 'development',
        DB: d1,
        PROJECT_STORAGE: bucket,
        ARTIFACTS: bucket,
        PROJECT_ROOM: rooms
      };
      const envA = { ...base, DB: wrapped };
      const session = { userId: OWNER, email: 'dev@example.test' } as never;
      const input = { scope: 'projects', confirmation: 'dev@example.test' };
      const stale = deleteAccountData(
        session,
        input,
        envA as never,
        new D1R2PersistenceService(envA as never)
      );
      await paused;
      // A retry of the same request completes it.
      expect(
        (
          await deleteAccountData(
            session,
            input,
            base as never,
            new D1R2PersistenceService(base as never)
          )
        ).ok
      ).toBe(true);
      expect(
        db.prepare('SELECT * FROM account_erasure_requests').all()
      ).toEqual([]);
      // The project is created again, and its room acknowledges a document.
      await service.createProject(OWNER, {
        name: document.name,
        initialDocument: document
      });
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
          ...createProjectDocument('New room', OWNER),
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
            clientId: 'new-client',
            displayName: 'Owner',
            baseVersion: null,
            document: roomDocument
          })
        );
        expect(storage.values.has('room:latest')).toBe(true);
        // A resumes: its request is complete, so it stops.
        release();
        expect((await stale).ok).toBe(true);
      } finally {
        globals.restore();
      }
      expect(
        db.prepare('SELECT id FROM projects WHERE id = ?').get(PROJECT)
      ).toEqual({ id: PROJECT });
      expect(bucket.objects.has(assetKey)).toBe(true);
      expect(storage.values.has('room:latest')).toBe(true);
    });
  }
});

describe('pending object admission (PR #1477 review, round 4)', () => {
  const pending = (
    attempt: string,
    key: string,
    extra: { bytes?: number; projectId?: string; owner?: string } = {}
  ) => ({
    key,
    attempt,
    projectId: extra.projectId ?? 'p1',
    ownerUserId: extra.owner ?? OWNER,
    bytes: extra.bytes ?? 10,
    bucket: 'artifacts' as const
  });

  it('refuses a pending record while a cleanup claims its key, and a claim while another attempt’s record names it', async () => {
    const { recordPendingObject } =
      await import('@openzcad/cloudflare-adapters');
    const db = database();
    const d1 = sqliteD1(db);
    // A failed attempt's rollback claims its own pending key...
    expect(await recordPendingObject(d1, pending('old', 'e2ee/p1/b1'))).toBe(
      'recorded'
    );
    const rollback = await claimObjectKeysForDelete(d1, ['e2ee/p1/b1'], {
      pending: ['old']
    });
    expect([...rollback.keys]).toEqual(['e2ee/p1/b1']);
    // ...so a retry cannot record the key (and put under it) until the
    // rollback is done, however its delete then fares.
    expect(await recordPendingObject(d1, pending('retry', 'e2ee/p1/b1'))).toBe(
      'key-deleting'
    );
    expect(() =>
      db
        .prepare(
          `INSERT INTO r2_pending_objects
             (object_key, attempt, project_id, owner_user_id, object_bytes,
              bucket, created_at)
           VALUES ('e2ee/p1/b1', 'raw', 'p1', ?, 1, 'artifacts', 0)`
        )
        .run(OWNER)
    ).toThrow('r2_key_deleting');
    db.prepare(`DELETE FROM r2_pending_objects WHERE attempt = 'old'`).run();
    await rollback.release();
    expect(await recordPendingObject(d1, pending('retry', 'e2ee/p1/b1'))).toBe(
      'recorded'
    );
    // The other way round: while the retry's record stands, no other
    // cleanup can claim the key.
    const blocked = await claimObjectKeysForDelete(d1, ['e2ee/p1/b1'], {
      pending: ['old']
    });
    expect(blocked.keys.size).toBe(0);
    await blocked.release();
  });

  it('bounds the pending objects of one account across its projects, in bytes and in count', async () => {
    const { PENDING_OBJECTS_PER_ACCOUNT, recordPendingObject } =
      await import('@openzcad/cloudflare-adapters');
    const db = database();
    const d1 = sqliteD1(db);
    db.prepare(
      'UPDATE users SET project_storage_limit_bytes = 1000 WHERE id = ?'
    ).run(OWNER);
    // One attempt whose own objects exceed the allowance could never commit.
    expect(
      await recordPendingObject(d1, pending('big', 'k/big', { bytes: 1001 }))
    ).toBe('too-large');
    expect(
      await recordPendingObject(d1, pending('a1', 'k/1', { bytes: 600 }))
    ).toBe('recorded');
    // Another project of the same account shares the budget...
    expect(
      await recordPendingObject(
        d1,
        pending('a2', 'k/2', { bytes: 500, projectId: 'p2' })
      )
    ).toBe('account-full');
    expect(
      await recordPendingObject(
        d1,
        pending('a2', 'k/2', { bytes: 400, projectId: 'p2' })
      )
    ).toBe('recorded');
    // ...another account does not.
    expect(
      await recordPendingObject(
        d1,
        pending('a3', 'k/3', { bytes: 900, owner: 'someone_else' })
      )
    ).toBe('recorded');
    // A committed row clears its record, and with it the charge.
    db.prepare(`DELETE FROM r2_pending_objects WHERE attempt = 'a1'`).run();
    expect(
      await recordPendingObject(d1, pending('a4', 'k/4', { bytes: 600 }))
    ).toBe('recorded');
    // The record count is bounded as well, whatever the sizes.
    db.prepare('DELETE FROM r2_pending_objects').run();
    db.prepare(
      'UPDATE users SET project_storage_limit_bytes = 1000000000000 WHERE id = ?'
    ).run(OWNER);
    const insert = db.prepare(
      `INSERT INTO r2_pending_objects
         (object_key, attempt, project_id, owner_user_id, object_bytes,
          bucket, created_at)
       VALUES (?, 'many', 'p1', ?, 0, 'artifacts', 0)`
    );
    for (let index = 0; index < PENDING_OBJECTS_PER_ACCOUNT; index += 1) {
      insert.run(`k/many/${index}`, OWNER);
    }
    expect(await recordPendingObject(d1, pending('one', 'k/one'))).toBe(
      'account-full'
    );
  });

  it('drains only the account’s own aged records when asked to, removing them by primary key', async () => {
    const { drainPendingObjects, recordPendingObject } =
      await import('@openzcad/cloudflare-adapters');
    const db = database();
    const statements: string[] = [];
    const d1 = sqliteD1(db, { onStatement: (sql) => statements.push(sql) });
    await recordPendingObject(d1, pending('mine', 'k/mine'));
    await recordPendingObject(
      d1,
      pending('theirs', 'k/theirs', { owner: 'someone_else' })
    );
    db.prepare('UPDATE r2_pending_objects SET created_at = 0').run();
    const removed: string[] = [];
    await drainPendingObjects(
      d1,
      { artifacts: { delete: async (key: string) => removed.push(key) } },
      null,
      { olderThanMs: 60_000, ownerUserId: OWNER }
    );
    expect(removed).toEqual(['k/mine']);
    expect(db.prepare('SELECT attempt FROM r2_pending_objects').all()).toEqual([
      { attempt: 'theirs' }
    ]);
    // The sweep's final DELETE looks each drained (key, attempt) up by the
    // primary key; it never scans every account's pending records.
    const remove = statements.find((sql) =>
      sql.trim().startsWith('DELETE FROM r2_pending_objects')
    )!;
    const plan = db
      .prepare(`EXPLAIN QUERY PLAN ${remove}`)
      .all('[["k","a"]]') as { detail: string }[];
    const details = plan.map((row) => row.detail).join(' | ');
    expect(details).toMatch(/SEARCH r2_pending_objects USING PRIMARY KEY/);
    expect(details).not.toMatch(/SCAN r2_pending_objects/);
  });
});

describe('the final batch of an erasure a retry completed (PR #1477 review, round 4)', () => {
  async function pausedAtFinalBatch(scope: 'profile' | 'all') {
    const { D1R2PersistenceService } =
      await import('@openzcad/cloudflare-adapters');
    const { objectBucket } = await import('./support/e2ee-documents');
    const { deleteAccountData } =
      await import('../apps/web/worker/accountDeletion');
    const db = database();
    db.prepare('DELETE FROM projects').run();
    const d1 = sqliteD1(db);
    const bucket = objectBucket();
    let entered!: () => void;
    let release!: () => void;
    const atBatch = new Promise<void>((resolve) => (entered = resolve));
    const released = new Promise<void>((resolve) => (release = resolve));
    let once = true;
    // Attempt A's D1: its first batch (the final profile batch) waits.
    const paused = new Proxy(d1, {
      get(target, property) {
        const value = Reflect.get(target, property) as unknown;
        if (property === 'batch' && once) {
          return async (statements: D1PreparedStatement[]) => {
            once = false;
            entered();
            await released;
            return target.batch(statements);
          };
        }
        return typeof value === 'function'
          ? (value as (...args: unknown[]) => unknown).bind(target)
          : value;
      }
    });
    const base = {
      ENVIRONMENT: 'development',
      AUTH_MODE: 'development',
      DB: d1,
      PROJECT_STORAGE: bucket,
      ARTIFACTS: bucket,
      PROJECT_ROOM: {
        getByName: () => ({
          fetch: async () => new Response(null, { status: 204 })
        })
      }
    };
    const envA = { ...base, DB: paused };
    const session = { userId: OWNER, email: 'dev@example.test' } as never;
    const input = { scope, confirmation: 'dev@example.test' };
    const stale = deleteAccountData(
      session,
      input,
      envA as never,
      new D1R2PersistenceService(envA as never)
    );
    await atBatch;
    // A retry of the same request completes it.
    expect(
      (
        await deleteAccountData(
          session,
          input,
          base as never,
          new D1R2PersistenceService(base as never)
        )
      ).ok
    ).toBe(true);
    expect(db.prepare('SELECT * FROM account_erasure_requests').all()).toEqual(
      []
    );
    return { db, stale, release };
  }

  for (const scope of ['profile', 'all'] as const) {
    it(`a stale ${scope} batch deletes nothing the account stored after the retry`, async () => {
      const { db, stale, release } = await pausedAtFinalBatch(scope);
      // The account comes back and stores new profile data.
      if (scope === 'all') {
        db.prepare(
          'INSERT INTO users (id, email, created_at) VALUES (?, ?, ?)'
        ).run(OWNER, 'dev@example.test', CREATED);
      } else {
        db.prepare('UPDATE users SET email = ? WHERE id = ?').run(
          'dev@example.test',
          OWNER
        );
      }
      db.prepare(
        `INSERT INTO user_settings (user_id, settings_json, updated_at)
         VALUES (?, '{"units":"mm"}', ?)`
      ).run(OWNER, CREATED);
      // A resumes: its request is gone, so its whole batch is refused.
      release();
      expect((await stale).ok).toBe(true);
      expect(
        db.prepare('SELECT email FROM users WHERE id = ?').get(OWNER)
      ).toEqual({ email: 'dev@example.test' });
      expect(
        db.prepare('SELECT settings_json FROM user_settings').all()
      ).toEqual([{ settings_json: '{"units":"mm"}' }]);
    });
  }

  it('a stale batch never clears a later erasure request', async () => {
    const { db, stale, release } = await pausedAtFinalBatch('profile');
    db.prepare(
      `INSERT INTO account_erasure_requests
         (user_id, scope, started_at, updated_at, request_token)
       VALUES (?, 'profile', 1, 1, 'later')`
    ).run(OWNER);
    release();
    expect((await stale).ok).toBe(true);
    expect(
      db.prepare('SELECT request_token FROM account_erasure_requests').all()
    ).toEqual([{ request_token: 'later' }]);
  });
});

/**
 * `d1`, whose statements naming `marker` wait at `method` until `release`
 * (every one of them when `all`, else the first), reporting each arrival.
 */
function holding(
  d1: D1Database,
  marker: string,
  method: 'run' | 'all',
  every = false
) {
  let release!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  let arrivals = 0;
  const arrived: (() => void)[] = [];
  const arrival = (count: number) =>
    new Promise<void>((resolve) => {
      if (arrivals >= count) resolve();
      else arrived.push(() => arrivals >= count && resolve());
    });
  let once = true;
  const pass = <T extends object>(target: T, property: PropertyKey) => {
    const value = Reflect.get(target, property) as unknown;
    return typeof value === 'function'
      ? (value as (...args: unknown[]) => unknown).bind(target)
      : value;
  };
  const wrapped = new Proxy(d1, {
    get(target, property) {
      if (property !== 'prepare') return pass(target, property);
      return (sql: string) => {
        const statement = target.prepare(sql);
        if (!sql.includes(marker)) return statement;
        return new Proxy(statement, {
          get(inner, key) {
            if (key !== 'bind') return pass(inner, key);
            return (...args: unknown[]) =>
              new Proxy(inner.bind(...args), {
                get(bound, name) {
                  if (name === method && (every || once)) {
                    once = false;
                    return async () => {
                      const result =
                        method === 'all' ? await bound.all() : null;
                      arrivals += 1;
                      for (const notify of arrived) notify();
                      await released;
                      return method === 'all' ? result : bound.run();
                    };
                  }
                  return pass(bound, name);
                }
              });
          }
        });
      };
    }
  });
  return { wrapped, release, arrival };
}

describe('pending records that outlive a failed write (PR #1477 review, round 5)', () => {
  it('two copy rollbacks that block each other’s claim keep their records, so the sweep still removes the object', async () => {
    const { discardCopiedObjects } =
      await import('../apps/web/worker/e2eeProjectCopies');
    const { drainPendingObjects, recordPendingObject } =
      await import('@openzcad/cloudflare-adapters');
    const { objectBucket } = await import('./support/e2ee-documents');
    const db = database();
    const d1 = sqliteD1(db);
    const bucket = objectBucket();
    const key = 'e2ee/proj_copy/blob_1';
    bucket.objects.set(key, new Uint8Array([1, 2, 3]).buffer);
    for (const attempt of ['copy-a', 'copy-b']) {
      expect(
        await recordPendingObject(d1, {
          key,
          attempt,
          projectId: 'proj_copy',
          ownerUserId: OWNER,
          bytes: 3,
          bucket: 'artifacts'
        })
      ).toBe('recorded');
    }
    // Both rollbacks take their claims (each blocked by the other's
    // record) before either goes on.
    const { wrapped, release, arrival } = holding(
      d1,
      'SELECT object_key, token, settling FROM r2_key_tombstones',
      'all',
      true
    );
    const rollbacks = Promise.all([
      discardCopiedObjects(wrapped, bucket as never, [key], 'copy-a'),
      discardCopiedObjects(wrapped, bucket as never, [key], 'copy-b')
    ]);
    await arrival(2);
    release();
    await rollbacks;
    // Neither deleted the object, so neither may forget it.
    expect(bucket.objects.has(key)).toBe(true);
    expect(
      db
        .prepare('SELECT attempt FROM r2_pending_objects ORDER BY attempt')
        .all()
    ).toEqual([{ attempt: 'copy-a' }, { attempt: 'copy-b' }]);
    // Once both are abandoned, one sweep removes the object and a record,
    // exempting both attempts; the next removes what is left.
    db.prepare('UPDATE r2_pending_objects SET created_at = 0').run();
    await drainPendingObjects(d1, { artifacts: bucket as never }, null, {
      olderThanMs: 60_000,
      limit: 1
    });
    expect(bucket.objects.has(key)).toBe(false);
    await drainPendingObjects(d1, { artifacts: bucket as never }, null, {
      olderThanMs: 60_000
    });
    expect(db.prepare('SELECT * FROM r2_pending_objects').all()).toEqual([]);
  });

  it('a project’s deletion removes only the pending records it swept: a write admitted after its listing stays for the sweep', async () => {
    const { D1R2PersistenceService, drainPendingObjects, recordPendingObject } =
      await import('@openzcad/cloudflare-adapters');
    const { objectBucket } = await import('./support/e2ee-documents');
    const db = database();
    const d1 = sqliteD1(db);
    const bucket = objectBucket();
    const record = (key: string, attempt: string) =>
      recordPendingObject(d1, {
        key,
        attempt,
        projectId: 'p1',
        ownerUserId: OWNER,
        bytes: 3,
        bucket: 'project-storage'
      });
    // A body an earlier failed save could not remove.
    const early = 'e2ee/p1/v/hash.early';
    expect(await record(early, 'early')).toBe('recorded');
    bucket.objects.set(early, new Uint8Array([1, 2, 3]).buffer);
    // The deletion pauses after listing what it sweeps, before its claim.
    const { wrapped, release, arrival } = holding(
      d1,
      'INSERT INTO r2_key_tombstones',
      'run'
    );
    const env = {
      DB: wrapped,
      PROJECT_STORAGE: bucket,
      ARTIFACTS: bucket
    };
    const deletion = new D1R2PersistenceService(env as never).deleteProject(
      OWNER,
      'p1'
    );
    await arrival(1);
    // A save already past its access check records and puts a new body,
    // then fails without removing it.
    const late = 'e2ee/p1/v/hash.late';
    expect(await record(late, 'late')).toBe('recorded');
    bucket.objects.set(late, new Uint8Array([4, 5, 6]).buffer);
    release();
    await deletion;
    expect(db.prepare('SELECT id FROM projects').all()).toEqual([]);
    expect(bucket.objects.has(early)).toBe(false);
    // The late body is still recorded, so the sweep reclaims it; the early
    // record, young enough that its put could still land, stays detached.
    expect(
      db
        .prepare(
          'SELECT object_key, attempt, project_id FROM r2_pending_objects ORDER BY attempt'
        )
        .all()
    ).toEqual([
      { object_key: early, attempt: 'early', project_id: '' },
      { object_key: late, attempt: 'late', project_id: 'p1' }
    ]);
    db.prepare('UPDATE r2_pending_objects SET created_at = 0').run();
    await drainPendingObjects(
      d1,
      { 'project-storage': bucket as never },
      null,
      {
        olderThanMs: 60_000
      }
    );
    expect(bucket.objects.has(late)).toBe(false);
    expect(db.prepare('SELECT * FROM r2_pending_objects').all()).toEqual([]);
  });
});

describe('a forced drain of writes that may still be putting (PR #1477 review, round 6)', () => {
  it('deletes the objects but keeps young records, detached, so its loop ends and the sweep reclaims a late put', async () => {
    const { drainPendingObjects, recordPendingObject } =
      await import('@openzcad/cloudflare-adapters');
    const { objectBucket } = await import('./support/e2ee-documents');
    const db = database();
    const d1 = sqliteD1(db);
    const bucket = objectBucket();
    const key = 'e2ee/p1/v/hash.inflight';
    expect(
      await recordPendingObject(d1, {
        key,
        attempt: 'inflight',
        projectId: 'p1',
        ownerUserId: OWNER,
        bytes: 3,
        bucket: 'project-storage'
      })
    ).toBe('recorded');
    // The encrypted-data drop reclaims every pending write of its project,
    // however young: done in one pass, nothing left for this project.
    expect(
      await drainPendingObjects(
        d1,
        { 'project-storage': bucket as never },
        'p1'
      )
    ).toBe(false);
    expect(
      await drainPendingObjects(
        d1,
        { 'project-storage': bucket as never },
        'p1'
      )
    ).toBe(false);
    // The write's put lands after that delete: its record still tracks it.
    bucket.objects.set(key, new Uint8Array([1, 2, 3]).buffer);
    expect(
      db.prepare('SELECT object_key, project_id FROM r2_pending_objects').all()
    ).toEqual([{ object_key: key, project_id: '' }]);
    db.prepare('UPDATE r2_pending_objects SET created_at = 0').run();
    await drainPendingObjects(
      d1,
      { 'project-storage': bucket as never },
      null,
      {
        olderThanMs: 60 * 60 * 1000
      }
    );
    expect(bucket.objects.has(key)).toBe(false);
    expect(db.prepare('SELECT * FROM r2_pending_objects').all()).toEqual([]);
  });
});
