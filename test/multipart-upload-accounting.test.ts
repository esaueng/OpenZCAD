import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { beforeEach, describe, expect, it } from 'vitest';
import { D1R2PersistenceService } from '@openzcad/cloudflare-adapters';
import { ArtifactQuotaError, ProjectNotFoundError } from '@openzcad/persistence';
import {
  MAX_ACCOUNT_ARTIFACT_BYTES,
  MAX_ACTIVE_ARTIFACT_UPLOAD_SESSIONS,
  MAX_ARTIFACT_PART_BYTES,
  toProjectId,
  toUserId,
  type UploadSessionRecord
} from '@openzcad/shared';

const OWNER = toUserId('user_upload_owner');
const OTHER_OWNER = toUserId('user_upload_other');
const PROJECT = toProjectId('project_upload_owner');
const OTHER_PROJECT = toProjectId('project_upload_other');
const MIGRATIONS = new URL('../apps/web/migrations/', import.meta.url);

type BatchResult = Awaited<ReturnType<D1Database['batch']>>[number];

interface SqliteStatement extends D1PreparedStatement {
  run(): Promise<BatchResult>;
}

class SqliteD1 {
  failNextBatch = false;
  failAfterRun: RegExp | null = null;
  beforeRun: ((query: string) => void) | null = null;

  constructor(readonly sqlite: DatabaseSync) {}

  private statement(query: string, bindings: unknown[]): SqliteStatement {
    const execute = () =>
      this.sqlite.prepare(query).run(...(bindings as never[]));
    const statement = {
      bind: (...next: unknown[]) => this.statement(query, next),
      first: async () => {
        const row = this.sqlite.prepare(query).get(...(bindings as never[]));
        return row === undefined ? null : (row as Record<string, unknown>);
      },
      all: async () => ({
        results: this.sqlite.prepare(query).all(...(bindings as never[]))
      }),
      run: async () => {
        this.beforeRun?.(query);
        const result = execute();
        const response = {
          success: true,
          meta: { changes: Number(result.changes) },
          results: []
        } as unknown as BatchResult;
        if (this.failAfterRun?.test(query)) {
          this.failAfterRun = null;
          throw new Error('D1 response was lost after commit');
        }
        return response;
      }
    };
    return statement as unknown as SqliteStatement;
  }

  readonly database = {
    prepare: (query: string) => this.statement(query, []),
    batch: async (statements: D1PreparedStatement[]) => {
      if (this.failNextBatch) {
        this.failNextBatch = false;
        throw new Error('D1 batch interrupted before commit');
      }
      this.sqlite.exec('BEGIN IMMEDIATE');
      try {
        const results: BatchResult[] = [];
        for (const statement of statements as SqliteStatement[]) {
          results.push(await statement.run());
        }
        this.sqlite.exec('COMMIT');
        return results;
      } catch (error) {
        this.sqlite.exec('ROLLBACK');
        throw error;
      }
    }
  };
}

interface MultipartState {
  key: string;
  parts: Map<number, { bytes: Uint8Array; etag: string }>;
}

class FakeR2 {
  readonly objects = new Map<string, Uint8Array>();
  readonly multipart = new Map<string, MultipartState>();
  failUploadBeforeR2 = false;
  failDeleteCount = 0;
  throwAfterComplete = false;
  beforePartCommit: (() => Promise<void>) | null = null;
  beforeCompleteCommit: (() => Promise<void>) | null = null;
  beforeCreate: (() => Promise<void>) | null = null;
  private nextUpload = 0;
  private nextEtag = 0;

  private bytes(body: unknown): Uint8Array {
    if (body instanceof ArrayBuffer) return new Uint8Array(body.slice(0));
    if (ArrayBuffer.isView(body)) {
      return new Uint8Array(
        body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength)
      );
    }
    throw new Error('Unsupported fake R2 body');
  }

  private missing(): Error {
    return Object.assign(
      new Error('NoSuchUpload: multipart upload not found'),
      {
        name: 'NoSuchUpload',
        code: 'NoSuchUpload'
      }
    );
  }

  private resumed(key: string, uploadId: string) {
    return {
      key,
      uploadId,
      uploadPart: async (partNumber: number, body: unknown) => {
        await this.beforePartCommit?.();
        if (this.failUploadBeforeR2) {
          this.failUploadBeforeR2 = false;
          throw new Error('Worker stopped before the R2 part write');
        }
        const upload = this.multipart.get(uploadId);
        if (!upload || upload.key !== key) throw this.missing();
        const bytes = this.bytes(body);
        const etag = `etag-${partNumber}-${++this.nextEtag}`;
        upload.parts.set(partNumber, { bytes, etag });
        return { partNumber, etag };
      },
      complete: async (
        requested: Array<{ partNumber: number; etag: string }>
      ) => {
        await this.beforeCompleteCommit?.();
        const upload = this.multipart.get(uploadId);
        if (!upload || upload.key !== key) throw this.missing();
        const chunks = requested.map((part) => {
          const stored = upload.parts.get(part.partNumber);
          if (!stored || stored.etag !== part.etag) {
            throw new Error('R2 multipart part mismatch');
          }
          return stored.bytes;
        });
        const size = chunks.reduce((total, chunk) => total + chunk.length, 0);
        const assembled = new Uint8Array(size);
        let offset = 0;
        for (const chunk of chunks) {
          assembled.set(chunk, offset);
          offset += chunk.length;
        }
        this.objects.set(key, assembled);
        this.multipart.delete(uploadId);
        if (this.throwAfterComplete) {
          this.throwAfterComplete = false;
          throw new Error('Worker stopped after R2 completion');
        }
        return { key, size };
      },
      abort: async () => {
        const upload = this.multipart.get(uploadId);
        if (!upload || upload.key !== key) throw this.missing();
        this.multipart.delete(uploadId);
      }
    };
  }

  readonly bucket = {
    createMultipartUpload: async (key: string) => {
      await this.beforeCreate?.();
      const uploadId = `multipart-${++this.nextUpload}`;
      this.multipart.set(uploadId, { key, parts: new Map() });
      return this.resumed(key, uploadId);
    },
    resumeMultipartUpload: (key: string, uploadId: string) =>
      this.resumed(key, uploadId),
    head: async (key: string) => {
      const body = this.objects.get(key);
      return body ? { key, size: body.byteLength } : null;
    },
    get: async (key: string) => {
      const body = this.objects.get(key);
      return body
        ? { key, size: body.byteLength, arrayBuffer: async () => body.slice().buffer }
        : null;
    },
    put: async (key: string, body: unknown) => {
      const bytes = this.bytes(body);
      this.objects.set(key, bytes);
      return { key, size: bytes.byteLength };
    },
    delete: async (key: string) => {
      if (this.failDeleteCount > 0) {
        this.failDeleteCount -= 1;
        throw new Error('R2 delete temporarily unavailable');
      }
      this.objects.delete(key);
    }
  } as unknown as R2Bucket;
}

function migrationFiles(through = 20, after = 0): string[] {
  return readdirSync(MIGRATIONS)
    .filter((name) => {
      const number = Number.parseInt(name.slice(0, 4), 10);
      return number > after && number <= through;
    })
    .sort();
}

function applyMigrations(db: DatabaseSync, through = 20, after = 0): void {
  for (const file of migrationFiles(through, after)) {
    db.exec('BEGIN');
    try {
      db.exec(readFileSync(new URL(file, MIGRATIONS), 'utf8'));
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }
}

function seedAccount(db: DatabaseSync, owner: string, project: string): void {
  db.prepare(`INSERT INTO users (id, email, created_at) VALUES (?, ?, ?)`).run(
    owner,
    `${owner}@example.com`,
    '2026-01-01T00:00:00.000Z'
  );
  db.prepare(
    `INSERT INTO projects (id, user_id, name, document_json, updated_at)
     VALUES (?, ?, 'Upload project', '{}', ?)`
  ).run(project, owner, '2026-01-01T00:00:00.000Z');
}

function usage(db: DatabaseSync, owner = OWNER) {
  return db
    .prepare(
      `SELECT finalized_bytes, reserved_bytes, active_sessions
       FROM artifact_account_usage WHERE owner_user_id = ?`
    )
    .get(owner) as
    | {
        finalized_bytes: number;
        reserved_bytes: number;
        active_sessions: number;
      }
    | undefined;
}

function uploadRow(db: DatabaseSync, sessionId: string) {
  return db
    .prepare(
      `SELECT reserved_bytes, reservation_state, multipart_upload_id
       FROM upload_sessions WHERE id = ?`
    )
    .get(sessionId) as
    | {
        reserved_bytes: number;
        reservation_state: string;
        multipart_upload_id: string | null;
      }
    | undefined;
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function createMultipart(
  service: D1R2PersistenceService,
  owner = OWNER,
  projectId = PROJECT
): Promise<{ session: UploadSessionRecord; uploadId: string }> {
  const { session } = await service.createUploadSession(owner, {
    projectId,
    fileName: 'assembly.step',
    contentType: 'model/step',
    kind: 'snapshot'
  });
  const { uploadId } = await service.createMultipartUpload(
    owner,
    session.uploadSessionId
  );
  return { session, uploadId };
}

let sqlite: DatabaseSync;
let d1: SqliteD1;
let r2: FakeR2;
let service: D1R2PersistenceService;

beforeEach(() => {
  sqlite = new DatabaseSync(':memory:');
  applyMigrations(sqlite);
  seedAccount(sqlite, OWNER, PROJECT);
  seedAccount(sqlite, OTHER_OWNER, OTHER_PROJECT);
  d1 = new SqliteD1(sqlite);
  r2 = new FakeR2();
  service = new D1R2PersistenceService({
    DB: d1.database,
    ARTIFACTS: r2.bucket
  });
});

describe('durable multipart quota accounting', () => {
  it('rechecks project trash state when an editor inserts a session', async () => {
    sqlite.prepare(
      `INSERT INTO project_members
       (project_id, user_id, role, added_by_user_id, created_at, updated_at)
       VALUES (?, ?, 'editor', ?, 1, 1)`
    ).run(PROJECT, OTHER_OWNER, OWNER);
    const sharingService = new D1R2PersistenceService({
      DB: d1.database,
      ARTIFACTS: r2.bucket,
      PROJECT_SHARING_ENABLED: 'true'
    });
    d1.beforeRun = (query) => {
      if (query.includes('INSERT INTO upload_sessions')) {
        d1.beforeRun = null;
        sqlite.prepare(`UPDATE projects SET status = 'deleted' WHERE id = ?`).run(PROJECT);
      }
    };
    await expect(
      sharingService.createUploadSession(OTHER_OWNER, {
        projectId: PROJECT,
        fileName: 'blocked.step',
        contentType: 'model/step',
        kind: 'snapshot'
      })
    ).rejects.toThrow(ProjectNotFoundError);
    expect(
      sqlite.prepare(`SELECT COUNT(*) AS count FROM upload_sessions`).get()
    ).toMatchObject({ count: 0 });
    await expect(
      sharingService.createUploadSession(OWNER, {
        projectId: PROJECT,
        fileName: 'owner.step',
        contentType: 'model/step',
        kind: 'snapshot'
      })
    ).resolves.toHaveProperty('session');
  });

  it('resumes a single PUT after a transient R2 part failure without double reservation', async () => {
    const { session } = await service.createUploadSession(OWNER, {
      projectId: PROJECT,
      fileName: 'retry.step',
      contentType: 'model/step',
      kind: 'snapshot'
    });
    r2.failUploadBeforeR2 = true;
    await expect(
      service.putUpload(OWNER, session.uploadSessionId, new ArrayBuffer(6))
    ).rejects.toThrow('before the R2 part write');
    expect(uploadRow(sqlite, session.uploadSessionId)).toMatchObject({
      reservation_state: 'uploading',
      reserved_bytes: 6
    });
    await expect(
      service.putUpload(OWNER, session.uploadSessionId, new ArrayBuffer(6))
    ).resolves.toBeUndefined();
    expect(uploadRow(sqlite, session.uploadSessionId)).toMatchObject({
      reservation_state: 'completed',
      reserved_bytes: 6
    });
    expect(usage(sqlite)?.reserved_bytes).toBe(6);
  });

  it('resumes a single PUT after the part ETag response is lost', async () => {
    const { session } = await service.createUploadSession(OWNER, {
      projectId: PROJECT,
      fileName: 'retry.step',
      contentType: 'model/step',
      kind: 'snapshot'
    });
    d1.failAfterRun = /SET etag = \?/;
    await expect(
      service.putUpload(OWNER, session.uploadSessionId, new ArrayBuffer(6))
    ).rejects.toThrow('D1 response was lost after commit');
    expect(uploadRow(sqlite, session.uploadSessionId)).toMatchObject({
      reservation_state: 'uploading',
      reserved_bytes: 6
    });
    await expect(
      service.putUpload(OWNER, session.uploadSessionId, new ArrayBuffer(6))
    ).resolves.toBeUndefined();
    expect(usage(sqlite)?.reserved_bytes).toBe(6);
  });

  it('reconciles a lost single-PUT completion response on retry', async () => {
    const { session } = await service.createUploadSession(OWNER, {
      projectId: PROJECT,
      fileName: 'retry.step',
      contentType: 'model/step',
      kind: 'snapshot'
    });
    d1.failAfterRun = /SET reservation_state = 'completed'/;
    await expect(
      service.putUpload(OWNER, session.uploadSessionId, new ArrayBuffer(7))
    ).rejects.toThrow('D1 response was lost after commit');
    expect(uploadRow(sqlite, session.uploadSessionId)).toMatchObject({
      reservation_state: 'completed',
      reserved_bytes: 7
    });
    await expect(
      service.putUpload(OWNER, session.uploadSessionId, new ArrayBuffer(7))
    ).resolves.toBeUndefined();
    expect(usage(sqlite)?.reserved_bytes).toBe(7);
  });

  it('refuses to finalize an unreserved object on an open session', async () => {
    const { session } = await service.createUploadSession(OWNER, {
      projectId: PROJECT,
      fileName: 'old.step',
      contentType: 'model/step',
      kind: 'snapshot'
    });
    r2.objects.set(session.objectKey, new Uint8Array(5));
    await expect(
      service.finalizeArtifact(OWNER, {
        projectId: PROJECT,
        uploadSessionId: session.uploadSessionId,
        artifactId: session.artifactId
      })
    ).resolves.toBeNull();
    expect(
      sqlite.prepare(`SELECT COUNT(*) AS count FROM artifacts`).get()
    ).toMatchObject({ count: 0 });
    expect(usage(sqlite)).toMatchObject({
      finalized_bytes: 0,
      reserved_bytes: 0,
      active_sessions: 1
    });
  });

  it('lets only one upload mode claim an open session', async () => {
    const { session } = await service.createUploadSession(OWNER, {
      projectId: PROJECT,
      fileName: 'assembly.step',
      contentType: 'model/step',
      kind: 'snapshot'
    });
    const entered = deferred();
    const release = deferred();
    r2.beforeCreate = async () => {
      entered.resolve();
      await release.promise;
    };
    const single = service.putUpload(OWNER, session.uploadSessionId, new ArrayBuffer(6));
    await entered.promise;
    r2.beforeCreate = null;
    const { uploadId } = await service.createMultipartUpload(
      OWNER,
      session.uploadSessionId
    );
    release.resolve();
    await expect(single).rejects.toThrow('changed during upload');
    expect(r2.multipart.size).toBe(1);
    expect(uploadRow(sqlite, session.uploadSessionId)).toMatchObject({
      reservation_state: 'uploading',
      multipart_upload_id: uploadId,
      reserved_bytes: 0
    });
    await service.abortMultipartUpload(OWNER, session.uploadSessionId, uploadId);
    expect(r2.multipart.size).toBe(0);
  });

  it('reserves a single PUT before R2 and fences a stale concurrent retry', async () => {
    const { session } = await service.createUploadSession(OWNER, {
      projectId: PROJECT,
      fileName: 'small.step',
      contentType: 'model/step',
      kind: 'snapshot'
    });
    const entered = deferred();
    const release = deferred();
    let partCalls = 0;
    r2.beforePartCommit = async () => {
      partCalls += 1;
      if (partCalls === 1) {
        entered.resolve();
        await release.promise;
      }
    };
    const pending = service.putUpload(OWNER, session.uploadSessionId, new ArrayBuffer(9));
    await entered.promise;
    expect(uploadRow(sqlite, session.uploadSessionId)).toMatchObject({
      reservation_state: 'uploading',
      reserved_bytes: 9
    });
    expect(usage(sqlite)?.reserved_bytes).toBe(9);
    const internalUploadId = uploadRow(sqlite, session.uploadSessionId)?.multipart_upload_id;
    expect(internalUploadId).toBeTruthy();
    await expect(
      service.createMultipartUpload(OWNER, session.uploadSessionId)
    ).rejects.toThrow('single upload storage');
    await expect(
      service.putUploadPart(
        OWNER,
        session.uploadSessionId,
        internalUploadId!,
        1,
        new ArrayBuffer(9)
      )
    ).rejects.toThrow('Multipart upload was not found');
    await expect(
      service.completeMultipartUpload(OWNER, session.uploadSessionId, {
        uploadId: internalUploadId!,
        parts: []
      })
    ).rejects.toThrow('Multipart upload was not found');
    await expect(
      service.abortMultipartUpload(OWNER, session.uploadSessionId, internalUploadId!)
    ).rejects.toThrow('single upload storage');
    const request = {
      projectId: PROJECT,
      uploadSessionId: session.uploadSessionId,
      artifactId: session.artifactId
    };
    await expect(service.finalizeArtifact(OWNER, request)).resolves.toBeNull();
    await expect(
      service.putUpload(OWNER, session.uploadSessionId, new ArrayBuffer(9))
    ).resolves.toBeUndefined();
    release.resolve();
    await expect(pending).rejects.toThrow('NoSuchUpload');
    expect(uploadRow(sqlite, session.uploadSessionId)).toMatchObject({
      reservation_state: 'completed',
      reserved_bytes: 9
    });
    await expect(
      service.createMultipartUpload(OWNER, session.uploadSessionId)
    ).rejects.toThrow('single upload storage');
    await expect(
      service.putUploadPart(
        OWNER,
        session.uploadSessionId,
        internalUploadId!,
        1,
        new ArrayBuffer(9)
      )
    ).rejects.toThrow('Multipart upload was not found');
    await expect(
      service.completeMultipartUpload(OWNER, session.uploadSessionId, {
        uploadId: internalUploadId!,
        parts: []
      })
    ).rejects.toThrow('Multipart upload was not found');
    await expect(
      service.abortMultipartUpload(OWNER, session.uploadSessionId, internalUploadId!)
    ).rejects.toThrow('single upload storage');
    await expect(
      service.putUpload(OWNER, session.uploadSessionId, new ArrayBuffer(9))
    ).resolves.toBeUndefined();
    await expect(
      service.putUpload(OWNER, session.uploadSessionId, new Uint8Array(9).fill(1).buffer)
    ).rejects.toThrow('already in use');
    expect((await service.finalizeArtifact(OWNER, request))?.bytes).toBe(9);
    expect(usage(sqlite)).toMatchObject({
      finalized_bytes: 9,
      reserved_bytes: 0,
      active_sessions: 0
    });
  });

  it('aborts a delayed single part before expiry releases its reservation', async () => {
    const { session } = await service.createUploadSession(OWNER, {
      projectId: PROJECT,
      fileName: 'small.step',
      contentType: 'model/step',
      kind: 'snapshot'
    });
    const entered = deferred();
    const release = deferred();
    r2.beforePartCommit = async () => {
      entered.resolve();
      await release.promise;
    };
    const pending = service.putUpload(OWNER, session.uploadSessionId, new ArrayBuffer(8));
    await entered.promise;
    sqlite
      .prepare(`UPDATE upload_sessions SET expires_at = ? WHERE id = ?`)
      .run('2020-01-01T00:00:00.000Z', session.uploadSessionId);
    await expect(service.purgeExpiredUploadSessions()).resolves.toBe(1);
    release.resolve();
    await expect(pending).rejects.toThrow('NoSuchUpload');
    expect(r2.objects.size).toBe(0);
    expect(r2.multipart.size).toBe(0);
    expect(uploadRow(sqlite, session.uploadSessionId)).toBeUndefined();
    expect(usage(sqlite)).toMatchObject({ reserved_bytes: 0, active_sessions: 0 });
  });

  it('keeps a completing single PUT indexed until R2 completion settles', async () => {
    const { session } = await service.createUploadSession(OWNER, {
      projectId: PROJECT,
      fileName: 'thumbnail.webp',
      contentType: 'image/webp',
      kind: 'thumbnail'
    });
    const entered = deferred();
    const release = deferred();
    r2.beforeCompleteCommit = async () => {
      entered.resolve();
      await release.promise;
    };
    const pending = service.putUpload(OWNER, session.uploadSessionId, new ArrayBuffer(7));
    await entered.promise;
    sqlite
      .prepare(`UPDATE upload_sessions SET expires_at = ? WHERE id = ?`)
      .run('2020-01-01T00:00:00.000Z', session.uploadSessionId);
    await expect(service.purgeExpiredUploadSessions()).resolves.toBe(0);
    expect(uploadRow(sqlite, session.uploadSessionId)).toMatchObject({
      reservation_state: 'completing',
      reserved_bytes: 7
    });
    release.resolve();
    await pending;
    expect(r2.objects.size).toBe(1);
    await expect(service.purgeExpiredUploadSessions()).resolves.toBe(1);
    expect(r2.objects.size).toBe(0);
    expect(usage(sqlite)).toMatchObject({ reserved_bytes: 0, active_sessions: 0 });
  });

  it('aborts a stale completion before deleting its R2 index', async () => {
    const { session } = await service.createUploadSession(OWNER, {
      projectId: PROJECT,
      fileName: 'small.step',
      contentType: 'model/step',
      kind: 'snapshot'
    });
    const entered = deferred();
    const release = deferred();
    r2.beforeCompleteCommit = async () => {
      entered.resolve();
      await release.promise;
    };
    const pending = service.putUpload(OWNER, session.uploadSessionId, new ArrayBuffer(6));
    await entered.promise;
    sqlite
      .prepare(
        `UPDATE upload_sessions
         SET expires_at = ?, completion_started_at = 0 WHERE id = ?`
      )
      .run('2020-01-01T00:00:00.000Z', session.uploadSessionId);
    await expect(service.purgeExpiredUploadSessions()).resolves.toBe(1);
    release.resolve();
    await expect(pending).rejects.toThrow('NoSuchUpload');
    expect(r2.objects.size).toBe(0);
    expect(r2.multipart.size).toBe(0);
    expect(usage(sqlite)).toMatchObject({ reserved_bytes: 0, active_sessions: 0 });
  });
  it('atomically admits only one concurrent session near quota and isolates accounts', async () => {
    sqlite
      .prepare(
        `INSERT INTO artifacts
       (id, project_id, kind, name, object_key, content_type, bytes,
        metadata_json, created_at)
       VALUES ('artifact_existing', ?, 'snapshot', 'existing.step',
               'existing/key', 'model/step', ?, '{}', ?)`
      )
      .run(PROJECT, MAX_ACCOUNT_ARTIFACT_BYTES - 4, '2026-01-01T00:00:00.000Z');
    const first = await createMultipart(service);
    const second = await createMultipart(service);
    const peer = new D1R2PersistenceService({
      DB: d1.database,
      ARTIFACTS: r2.bucket
    });

    const attempts = await Promise.allSettled([
      service.putUploadPart(
        OWNER,
        first.session.uploadSessionId,
        first.uploadId,
        1,
        new ArrayBuffer(4)
      ),
      peer.putUploadPart(
        OWNER,
        second.session.uploadSessionId,
        second.uploadId,
        1,
        new ArrayBuffer(4)
      )
    ]);

    expect(
      attempts.filter((result) => result.status === 'fulfilled')
    ).toHaveLength(1);
    const rejected = attempts.find((result) => result.status === 'rejected');
    expect(
      rejected?.status === 'rejected' ? rejected.reason : null
    ).toBeInstanceOf(ArtifactQuotaError);
    const admitted = attempts[0]?.status === 'fulfilled' ? first : second;
    await expect(
      service.putUploadPart(
        OWNER,
        admitted.session.uploadSessionId,
        admitted.uploadId,
        1,
        new ArrayBuffer(4)
      )
    ).resolves.toMatchObject({ partNumber: 1 });
    expect(usage(sqlite)).toMatchObject({ reserved_bytes: 4 });

    const other = await createMultipart(service, OTHER_OWNER, OTHER_PROJECT);
    await expect(
      service.putUploadPart(
        OTHER_OWNER,
        other.session.uploadSessionId,
        other.uploadId,
        1,
        new ArrayBuffer(4)
      )
    ).resolves.toMatchObject({ partNumber: 1 });
    await expect(
      service.abortMultipartUpload(
        OTHER_OWNER,
        first.session.uploadSessionId,
        first.uploadId
      )
    ).rejects.toThrow();
    expect(usage(sqlite, OTHER_OWNER)).toMatchObject({ reserved_bytes: 4 });
  });

  it('serializes concurrent parts and charges retries or replacements by delta', async () => {
    const { session, uploadId } = await createMultipart(service);
    const concurrent = await Promise.all([
      service.putUploadPart(
        OWNER,
        session.uploadSessionId,
        uploadId,
        1,
        new ArrayBuffer(3)
      ),
      service.putUploadPart(
        OWNER,
        session.uploadSessionId,
        uploadId,
        2,
        new ArrayBuffer(5)
      )
    ]);
    expect(concurrent).toHaveLength(2);
    expect(uploadRow(sqlite, session.uploadSessionId)?.reserved_bytes).toBe(8);

    await service.putUploadPart(
      OWNER,
      session.uploadSessionId,
      uploadId,
      1,
      new ArrayBuffer(3)
    );
    expect(uploadRow(sqlite, session.uploadSessionId)?.reserved_bytes).toBe(8);
    await service.putUploadPart(
      OWNER,
      session.uploadSessionId,
      uploadId,
      1,
      new ArrayBuffer(7)
    );
    expect(uploadRow(sqlite, session.uploadSessionId)?.reserved_bytes).toBe(12);
    expect(
      sqlite
        .prepare(
          `SELECT COUNT(*) AS count FROM artifact_upload_parts
           WHERE upload_session_id = ?`
        )
        .get(session.uploadSessionId)
    ).toMatchObject({ count: 2 });
  });

  it('fences concurrent replacements of the same part without double charging', async () => {
    const { session, uploadId } = await createMultipart(service);
    const attempts = await Promise.allSettled([
      service.putUploadPart(
        OWNER,
        session.uploadSessionId,
        uploadId,
        1,
        new ArrayBuffer(3)
      ),
      service.putUploadPart(
        OWNER,
        session.uploadSessionId,
        uploadId,
        1,
        new ArrayBuffer(7)
      )
    ]);
    expect(
      attempts.filter((result) => result.status === 'fulfilled')
    ).toHaveLength(1);
    expect(
      sqlite
        .prepare(
          `SELECT COUNT(*) AS count, SUM(bytes) AS bytes
         FROM artifact_upload_parts WHERE upload_session_id = ?`
        )
        .get(session.uploadSessionId)
    ).toMatchObject({ count: 1, bytes: 7 });
    expect(usage(sqlite)?.reserved_bytes).toBe(7);
  });

  it('enforces session, part, upload-byte, and reserved-account caps in D1', async () => {
    for (
      let index = 0;
      index < MAX_ACTIVE_ARTIFACT_UPLOAD_SESSIONS;
      index += 1
    ) {
      await service.createUploadSession(OWNER, {
        projectId: PROJECT,
        fileName: `${index}.step`,
        contentType: 'model/step',
        kind: 'snapshot'
      });
    }
    await expect(
      service.createUploadSession(OWNER, {
        projectId: PROJECT,
        fileName: 'too-many.step',
        contentType: 'model/step',
        kind: 'snapshot'
      })
    ).rejects.toThrow(`${MAX_ACTIVE_ARTIFACT_UPLOAD_SESSIONS}`);

    sqlite.exec(`DELETE FROM upload_sessions`);
    const sessions = await Promise.all([
      createMultipart(service),
      createMultipart(service),
      createMultipart(service)
    ]);
    const insertPart = sqlite.prepare(
      `INSERT INTO artifact_upload_parts
       (upload_session_id, part_number, bytes, etag, reservation_token)
       VALUES (?, ?, ?, 'etag', ?)`
    );
    for (const target of sessions.slice(0, 2)) {
      for (let part = 1; part <= 32; part += 1) {
        insertPart.run(
          target.session.uploadSessionId,
          part,
          MAX_ARTIFACT_PART_BYTES,
          `${target.uploadId}-${part}`
        );
      }
      expect(() =>
        insertPart.run(
          target.session.uploadSessionId,
          33,
          1,
          `${target.uploadId}-overflow`
        )
      ).toThrow('artifact_upload_byte_limit');
    }
    expect(usage(sqlite)?.reserved_bytes).toBe(MAX_ACCOUNT_ARTIFACT_BYTES);
    expect(() =>
      insertPart.run(
        sessions[2].session.uploadSessionId,
        1,
        1,
        'account-overflow'
      )
    ).toThrow('artifact_reserved_byte_limit');
    await expect(
      service.putUploadPart(
        OWNER,
        sessions[2].session.uploadSessionId,
        sessions[2].uploadId,
        65,
        new ArrayBuffer(1)
      )
    ).rejects.toThrow('out of range');
  });

  it('atomically converts a completed reservation and makes finalize retryable', async () => {
    const { session, uploadId } = await createMultipart(service);
    const part = await service.putUploadPart(
      OWNER,
      session.uploadSessionId,
      uploadId,
      1,
      new ArrayBuffer(9)
    );
    await service.completeMultipartUpload(OWNER, session.uploadSessionId, {
      uploadId,
      parts: [part]
    });
    expect(usage(sqlite)).toMatchObject({
      finalized_bytes: 0,
      reserved_bytes: 9,
      active_sessions: 1
    });

    const request = {
      projectId: PROJECT,
      uploadSessionId: session.uploadSessionId,
      artifactId: session.artifactId
    };
    const artifact = await service.finalizeArtifact(OWNER, request);
    expect(artifact?.bytes).toBe(9);
    expect(usage(sqlite)).toMatchObject({
      finalized_bytes: 9,
      reserved_bytes: 0,
      active_sessions: 0
    });
    await expect(service.finalizeArtifact(OWNER, request)).resolves.toEqual(
      artifact
    );
    await expect(
      service.abortMultipartUpload(OWNER, session.uploadSessionId, uploadId)
    ).resolves.toBeUndefined();
    expect(usage(sqlite)).toMatchObject({
      reserved_bytes: 0,
      active_sessions: 0
    });
  });

  it('can abort a completed multipart object before artifact finalization', async () => {
    const upload = await createMultipart(service);
    const part = await service.putUploadPart(
      OWNER,
      upload.session.uploadSessionId,
      upload.uploadId,
      1,
      new ArrayBuffer(8)
    );
    await service.completeMultipartUpload(
      OWNER,
      upload.session.uploadSessionId,
      {
        uploadId: upload.uploadId,
        parts: [part]
      }
    );
    await service.abortMultipartUpload(
      OWNER,
      upload.session.uploadSessionId,
      upload.uploadId
    );
    expect(usage(sqlite)).toMatchObject({
      reserved_bytes: 0,
      active_sessions: 0
    });
    expect(r2.objects.size).toBe(0);
  });

  it('releases abort and expiry reservations exactly once across retries', async () => {
    const aborted = await createMultipart(service);
    await service.putUploadPart(
      OWNER,
      aborted.session.uploadSessionId,
      aborted.uploadId,
      1,
      new ArrayBuffer(5)
    );
    await service.abortMultipartUpload(
      OWNER,
      aborted.session.uploadSessionId,
      aborted.uploadId
    );
    await service.abortMultipartUpload(
      OWNER,
      aborted.session.uploadSessionId,
      aborted.uploadId
    );
    expect(usage(sqlite)).toMatchObject({
      reserved_bytes: 0,
      active_sessions: 0
    });

    const expired = await createMultipart(service);
    await service.putUploadPart(
      OWNER,
      expired.session.uploadSessionId,
      expired.uploadId,
      1,
      new ArrayBuffer(7)
    );
    sqlite
      .prepare(`UPDATE upload_sessions SET expires_at = ? WHERE id = ?`)
      .run('2020-01-01T00:00:00.000Z', expired.session.uploadSessionId);
    r2.failDeleteCount = 1;
    await expect(service.purgeExpiredUploadSessions()).resolves.toBe(0);
    expect(uploadRow(sqlite, expired.session.uploadSessionId)).toMatchObject({
      reserved_bytes: 7,
      reservation_state: 'aborting'
    });
    await expect(service.purgeExpiredUploadSessions()).resolves.toBe(1);
    await expect(service.purgeExpiredUploadSessions()).resolves.toBe(0);
    expect(usage(sqlite)).toMatchObject({
      reserved_bytes: 0,
      active_sessions: 0
    });
  });

  it('recovers interruptions at the D1/R2 boundaries without losing charges', async () => {
    const upload = await createMultipart(service);
    r2.failUploadBeforeR2 = true;
    await expect(
      service.putUploadPart(
        OWNER,
        upload.session.uploadSessionId,
        upload.uploadId,
        1,
        new ArrayBuffer(6)
      )
    ).rejects.toThrow('before the R2 part write');
    expect(
      uploadRow(sqlite, upload.session.uploadSessionId)?.reserved_bytes
    ).toBe(6);
    const part = await service.putUploadPart(
      OWNER,
      upload.session.uploadSessionId,
      upload.uploadId,
      1,
      new ArrayBuffer(6)
    );
    expect(
      uploadRow(sqlite, upload.session.uploadSessionId)?.reserved_bytes
    ).toBe(6);

    r2.throwAfterComplete = true;
    d1.failAfterRun = /SET reservation_state = 'completed'/;
    await expect(
      service.completeMultipartUpload(OWNER, upload.session.uploadSessionId, {
        uploadId: upload.uploadId,
        parts: [part]
      })
    ).rejects.toThrow('D1 response was lost after commit');
    await expect(
      service.completeMultipartUpload(OWNER, upload.session.uploadSessionId, {
        uploadId: upload.uploadId,
        parts: [part]
      })
    ).resolves.toBeUndefined();
    expect(uploadRow(sqlite, upload.session.uploadSessionId)).toMatchObject({
      reserved_bytes: 6,
      reservation_state: 'completed'
    });

    d1.failNextBatch = true;
    await expect(
      service.abortMultipartUpload(
        OWNER,
        upload.session.uploadSessionId,
        upload.uploadId
      )
    ).rejects.toThrow('D1 batch interrupted before commit');
    expect(uploadRow(sqlite, upload.session.uploadSessionId)).toMatchObject({
      reserved_bytes: 6,
      reservation_state: 'aborting'
    });

    sqlite
      .prepare(`UPDATE upload_sessions SET expires_at = ? WHERE id = ?`)
      .run('2020-01-01T00:00:00.000Z', upload.session.uploadSessionId);
    await expect(service.purgeExpiredUploadSessions()).resolves.toBe(1);
    await expect(service.purgeExpiredUploadSessions()).resolves.toBe(0);
    expect(usage(sqlite)).toMatchObject({
      reserved_bytes: 0,
      active_sessions: 0
    });
  });

  it('does not steal a live completion but reclaims an abandoned lease', async () => {
    const upload = await createMultipart(service);
    const part = await service.putUploadPart(
      OWNER,
      upload.session.uploadSessionId,
      upload.uploadId,
      1,
      new ArrayBuffer(4)
    );
    sqlite
      .prepare(
        `UPDATE upload_sessions
       SET reservation_state = 'completing', completion_started_at = ?
       WHERE id = ?`
      )
      .run(Date.now(), upload.session.uploadSessionId);
    await expect(
      service.completeMultipartUpload(OWNER, upload.session.uploadSessionId, {
        uploadId: upload.uploadId,
        parts: [part]
      })
    ).rejects.toThrow('in progress');

    sqlite
      .prepare(
        `UPDATE upload_sessions SET completion_started_at = 0 WHERE id = ?`
      )
      .run(upload.session.uploadSessionId);
    await expect(
      service.completeMultipartUpload(OWNER, upload.session.uploadSessionId, {
        uploadId: upload.uploadId,
        parts: [part]
      })
    ).resolves.toBeUndefined();
    expect(uploadRow(sqlite, upload.session.uploadSessionId)).toMatchObject({
      reservation_state: 'completed',
      reserved_bytes: 4
    });
  });

  it('allows fenced account erasure to abort and release active uploads', async () => {
    const upload = await createMultipart(service);
    await service.putUploadPart(
      OWNER,
      upload.session.uploadSessionId,
      upload.uploadId,
      1,
      new ArrayBuffer(3)
    );
    sqlite
      .prepare(
        `INSERT INTO account_erasure_requests
       (user_id, scope, started_at, updated_at) VALUES (?, 'projects', 1, 1)`
      )
      .run(OWNER);

    await expect(service.deleteOwnedProjects(OWNER)).resolves.toEqual([
      PROJECT
    ]);
    expect(usage(sqlite)).toMatchObject({
      reserved_bytes: 0,
      active_sessions: 0
    });
  });

  it('allows fenced account erasure to clean a single-part reservation', async () => {
    const { session } = await service.createUploadSession(OWNER, {
      projectId: PROJECT,
      fileName: 'thumbnail.webp',
      contentType: 'image/webp',
      kind: 'thumbnail'
    });
    await service.putUpload(OWNER, session.uploadSessionId, new ArrayBuffer(5));
    sqlite
      .prepare(
        `INSERT INTO account_erasure_requests
         (user_id, scope, started_at, updated_at) VALUES (?, 'projects', 1, 1)`
      )
      .run(OWNER);
    await expect(service.deleteOwnedProjects(OWNER)).resolves.toEqual([PROJECT]);
    expect(r2.objects.size).toBe(0);
    expect(usage(sqlite)).toMatchObject({ reserved_bytes: 0, active_sessions: 0 });
  });
});

describe('migration 0017 legacy handling', () => {
  it('extracts and cleans valid legacy multipart sessions while old inserts fail closed', async () => {
    const db = new DatabaseSync(':memory:');
    applyMigrations(db, 16);
    seedAccount(db, OWNER, PROJECT);
    db.prepare(
      `INSERT INTO upload_sessions
       (id, artifact_id, project_id, object_key, file_name, content_type,
        expires_at, kind, metadata_json)
       VALUES ('legacy_upload', 'legacy_artifact', ?, 'legacy/key', 'old.step',
               'model/step', '2030-01-01T00:00:00.000Z', 'snapshot', ?)`
    ).run(
      PROJECT,
      JSON.stringify({
        label: 'legacy',
        __openzcadMultipartUploadId: 'old-r2-id'
      })
    );
    applyMigrations(db, 17, 16);
    expect(
      db
        .prepare(
          `SELECT reservation_state, multipart_upload_id, metadata_json,
                  expires_at
         FROM upload_sessions WHERE id = 'legacy_upload'`
        )
        .get()
    ).toMatchObject({
      reservation_state: 'legacy',
      multipart_upload_id: 'old-r2-id',
      metadata_json: JSON.stringify({ label: 'legacy' }),
      expires_at: '1970-01-01T00:00:00.000Z'
    });
    expect(() =>
      db
        .prepare(
          `UPDATE upload_sessions SET metadata_json = ? WHERE id = 'legacy_upload'`
        )
        .run(JSON.stringify({ __openzcadMultipartUploadId: 'rollback-id' }))
    ).toThrow('artifact_upload_metadata_immutable');
    expect(() =>
      db
        .prepare(
          `INSERT INTO upload_sessions
         (id, artifact_id, project_id, object_key, file_name, content_type,
          expires_at, kind, metadata_json)
         VALUES ('old_worker', 'old_artifact', ?, 'old/key', 'old.step',
                 'model/step', '2030-01-01T00:00:00.000Z', 'snapshot', '{}')`
        )
        .run(PROJECT)
    ).toThrow('artifact_upload_owner_required');

    applyMigrations(db, 20, 17);
    const adapter = new SqliteD1(db);
    const bucket = new FakeR2();
    const legacyService = new D1R2PersistenceService({
      DB: adapter.database,
      ARTIFACTS: bucket.bucket
    });
    await expect(legacyService.purgeExpiredUploadSessions()).resolves.toBe(1);
    expect(uploadRow(db, 'legacy_upload')).toBeUndefined();
  });

  it('rolls the migration back instead of guessing through malformed legacy state', () => {
    const db = new DatabaseSync(':memory:');
    applyMigrations(db, 16);
    seedAccount(db, OWNER, PROJECT);
    db.prepare(
      `INSERT INTO upload_sessions
       (id, artifact_id, project_id, object_key, file_name, content_type,
        expires_at, kind, metadata_json)
       VALUES ('bad_upload', 'bad_artifact', ?, 'bad/key', 'bad.step',
               'model/step', '2030-01-01T00:00:00.000Z', 'snapshot', '{')`
    ).run(PROJECT);

    expect(() => applyMigrations(db, 17, 16)).toThrow();
    expect(
      db
        .prepare(
          `SELECT name FROM sqlite_schema
         WHERE type = 'table' AND name = 'artifact_account_usage'`
        )
        .get()
    ).toBeUndefined();
    expect(
      db.prepare(`SELECT id FROM upload_sessions WHERE id = 'bad_upload'`).get()
    ).toMatchObject({ id: 'bad_upload' });
  });
});

describe('migration 0020 single-part compatibility', () => {
  it('retires old open sessions without shortening their cleanup window', async () => {
    const db = new DatabaseSync(':memory:');
    applyMigrations(db, 19);
    seedAccount(db, OWNER, PROJECT);
    const expiry = '2030-01-01T00:00:00.000Z';
    db.prepare(
      `INSERT INTO upload_sessions
       (id, artifact_id, project_id, object_key, file_name, content_type,
        expires_at, kind, metadata_json, owner_user_id, reservation_state)
       VALUES ('old_open', 'old_artifact', ?, 'old/key', 'old.step',
        'model/step', ?, 'snapshot', '{}', ?, 'open')`
    ).run(PROJECT, expiry, OWNER);

    applyMigrations(db, 20, 19);
    expect(
      db.prepare(
        `SELECT reservation_state, expires_at, single_part
         FROM upload_sessions WHERE id = 'old_open'`
      ).get()
    ).toMatchObject({
      reservation_state: 'legacy',
      expires_at: expiry,
      single_part: 0
    });
    const migrated = new D1R2PersistenceService({
      DB: new SqliteD1(db).database,
      ARTIFACTS: new FakeR2().bucket
    });
    await expect(migrated.purgeExpiredUploadSessions()).resolves.toBe(0);
    expect(
      db.prepare(`SELECT id FROM upload_sessions WHERE id = 'old_open'`).get()
    ).toMatchObject({ id: 'old_open' });
    expect(() =>
      db.prepare(
        `INSERT INTO upload_sessions
         (id, artifact_id, project_id, object_key, file_name, content_type,
          expires_at, kind, metadata_json, owner_user_id, reservation_state)
         VALUES ('old_worker_new', 'old_worker_artifact', ?, 'old/new', 'old.step',
          'model/step', ?, 'snapshot', '{}', ?, 'open')`
      ).run(PROJECT, expiry, OWNER)
    ).toThrow('artifact_upload_protocol_version_required');
    db.close();
  });
});
