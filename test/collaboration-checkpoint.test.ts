import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { D1R2PersistenceService } from '@openzcad/cloudflare-adapters';
import { createHash } from 'node:crypto';
import {
  addPrimitiveFeature,
  importMeshBody,
  importStepBody
} from '@openzcad/document-core';
import {
  encodeImportedMeshPayload,
  MAX_PROJECT_REVISIONS,
  toUserId,
  type ProjectDocument
} from '@openzcad/shared';
import { ProjectNotFoundError } from '@openzcad/persistence';
import * as fakeIndexedDb from '../apps/web/node_modules/fake-indexeddb';
import {
  loadLocalSaveState,
  saveLocalProject
} from '../apps/web/src/lib/localProjectStore';
import { migratedDatabase, sqliteD1 } from './support/sqlite-d1';
import {
  createRoomContext,
  createTestRoom,
  installWorkerSocketGlobals
} from './collaboration-room-harness';

let globals: ReturnType<typeof installWorkerSocketGlobals>;
beforeAll(() => {
  globals = installWorkerSocketGlobals();
  Object.assign(globalThis, fakeIndexedDb);
});
afterAll(() => globals.restore());

function objectBucket() {
  const objects = new Map<string, ArrayBuffer>();
  const multipart = new Map<string, Map<number, ArrayBuffer>>();
  let nextUpload = 0;
  const upload = (key: string, uploadId: string) => ({
    key,
    uploadId,
    uploadPart: async (partNumber: number, body: ArrayBuffer) => {
      multipart.get(uploadId)!.set(partNumber, body.slice(0));
      return { partNumber, etag: `part-${partNumber}` };
    },
    complete: async (parts: { partNumber: number }[]) => {
      const chunks = parts.map((part) =>
        multipart.get(uploadId)!.get(part.partNumber)!
      );
      const body = new Uint8Array(
        chunks.reduce((sum, part) => sum + part.byteLength, 0)
      );
      let offset = 0;
      for (const chunk of chunks) {
        body.set(new Uint8Array(chunk), offset);
        offset += chunk.byteLength;
      }
      objects.set(key, body.buffer);
      multipart.delete(uploadId);
      return { key, size: body.byteLength };
    },
    abort: async () => {
      multipart.delete(uploadId);
    }
  });
  return {
    objects,
    createMultipartUpload: async (key: string) => {
      const uploadId = `checkpoint_upload_${++nextUpload}`;
      multipart.set(uploadId, new Map());
      return upload(key, uploadId);
    },
    resumeMultipartUpload: upload,
    put: vi.fn(async (key: string, body: ArrayBuffer) => {
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
}

async function setup(
  bucket?: ReturnType<typeof objectBucket>,
  artifacts?: ReturnType<typeof objectBucket>
) {
  const db = migratedDatabase();
  const owner = toUserId('checkpoint_owner');
  const editor = toUserId('checkpoint_editor');
  const viewer = toUserId('checkpoint_viewer');
  for (const userId of [owner, editor, viewer]) {
    db.prepare(
      'INSERT INTO users (id, email, created_at) VALUES (?, ?, ?)'
    ).run(userId, `${userId}@example.test`, '2026-10-14T00:00:00.000Z');
  }
  let statementHook: ((sql: string) => void) | undefined;
  const env = {
    DB: sqliteD1(db, { onStatement: (sql) => statementHook?.(sql) }),
    PROJECT_STORAGE: bucket as unknown as R2Bucket | undefined,
    ARTIFACTS: artifacts as unknown as R2Bucket | undefined,
    PROJECT_SHARING_ENABLED: 'true',
    PROJECT_EDIT_LEASES_ENFORCED: 'true'
  };
  const service = new D1R2PersistenceService(env);
  const { document } = await service.createProject(owner, {
    name: 'Durable shared checkpoint'
  });
  for (const [userId, role] of [
    [editor, 'editor'],
    [viewer, 'viewer']
  ]) {
    db.prepare(
      `INSERT INTO project_members
         (project_id, user_id, role, added_by_user_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, 1, 1)`
    ).run(document.projectId, userId!, role!, owner);
  }
  const storage = createRoomContext();
  const room = createTestRoom(storage.context, env);
  const clientId = 'checkpoint_client';
  await room.fetch(
    new Request(`https://room.test/?projectId=${document.projectId}`, {
      headers: {
        upgrade: 'websocket',
        'x-openzcad-user-id': editor,
        'x-openzcad-display-name': 'Editor',
        'x-openzcad-project-role': 'editor'
      }
    })
  );
  const socket = globals.serverSockets.at(-1)!;
  await socket.receive(
    JSON.stringify({
      type: 'hello',
      clientId,
      displayName: 'Editor',
      baseVersion: null,
      document: null
    })
  );
  await socket.receive(JSON.stringify({ type: 'lease-acquire', clientId }));
  const grant = socket.lastFrame();
  if (grant?.type !== 'lease-granted') throw new Error('Missing editor lease.');
  const leaseId = grant.lease.leaseId;
  await socket.receive(
    JSON.stringify({
      type: 'document',
      clientId,
      baseVersion: null,
      document,
      leaseId
    })
  );
  expect(socket.lastFrame()).toMatchObject({
    type: 'ack',
    version: document.version
  });
  const post = (
    body: Record<string, unknown>,
    actor = editor,
    role = 'editor'
  ) =>
    room.fetch(
      new Request(`https://room.test/?projectId=${document.projectId}`, {
        method: 'POST',
        headers: {
          'x-openzcad-user-id': actor,
          'x-openzcad-display-name': 'Checkpoint author',
          'x-openzcad-project-role': role,
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          clientId,
          baseVersion: document.version,
          leaseId,
          document,
          ...body
        })
      })
    );
  return {
    db,
    owner,
    editor,
    viewer,
    env,
    service,
    document,
    storage,
    room,
    post,
    clientId,
    leaseId,
    leaseExpiresAt: grant.lease.expiresAt,
    socket,
    setStatementHook: (hook: (sql: string) => void) => {
      statementHook = hook;
    }
  };
}

it.each(['inline', 'R2'] as const)(
  'stores a member named checkpoint in %s that a fresh device can restore after later edits',
  async (mode) => {
    const fixture = await setup(mode === 'R2' ? objectBucket() : undefined);
    try {
      const response = await fixture.post({
        checkpointReason: 'Before machining'
      });
      expect(response.status).toBe(200);
      const ack = (await response.json()) as {
        type: string;
        version: number;
        document?: ProjectDocument;
      };
      expect(
        ack.document,
        'A named checkpoint must acknowledge its durable server-minted snapshot'
      ).toBeDefined();
      const saved = ack.document!;
      expect(ack).toMatchObject({
        type: 'ack',
        version: fixture.document.version + 1
      });
      const checkpoint = saved.checkpoints.at(-1)!;
      expect(checkpoint).toMatchObject({
        reason: 'Before machining',
        documentVersion: saved.version
      });
      expect(saved.nodes).toEqual(fixture.document.nodes);
      expect(saved.editHistory).toEqual(fixture.document.editHistory);
      const edited = addPrimitiveFeature(saved, {
        name: 'Later box',
        primitiveKind: 'box',
        dimensions: { width: 2, height: 3, depth: 4 }
      });
      await fixture.socket.receive(
        JSON.stringify({
          type: 'document',
          clientId: fixture.clientId,
          baseVersion: saved.version,
          document: edited,
          leaseId: fixture.leaseId
        })
      );
      await fixture.service.saveDocument(fixture.owner, {
        projectId: edited.projectId,
        expectedVersion: fixture.document.version,
        document: edited
      });
      await saveLocalProject(edited);
      expect(
        await loadLocalSaveState(edited.projectId, checkpoint.checkpointId)
      ).toBeNull();
      const fresh = new D1R2PersistenceService(fixture.env);
      expect(
        await fresh.loadRevision(
          fixture.editor,
          edited.projectId,
          checkpoint.revisionId
        )
      ).toEqual(saved);
      expect(
        (await fresh.listRevisions(fixture.editor, edited.projectId))
          .revisions[0]
      ).toMatchObject({
        revisionId: checkpoint.revisionId,
        reason: 'Before machining',
        authorUserId: fixture.editor
      });
      await expect(
        fresh.saveRevision(fixture.editor, {
          projectId: edited.projectId,
          expectedVersion: edited.version,
          document: edited,
          reason: 'REST bypass'
        })
      ).rejects.toBeInstanceOf(ProjectNotFoundError);
    } finally {
      fixture.db.close();
    }
  }
);

it('retains R2 checkpoint source assets without changing the account head', async () => {
  const bucket = objectBucket();
  const fixture = await setup(bucket);
  try {
    const imported = importStepBody(fixture.document, {
      name: 'Bracket',
      artifactId: 'artifact_checkpoint_step',
      sourceName: 'bracket.step',
      stepText: 'ISO-10303-21;\nDATA;\nENDSEC;\nEND-ISO-10303-21;'
    }).document;
    const response = await fixture.post({
      checkpointReason: 'Imported bracket',
      document: imported
    });
    expect(response.status).toBe(200);
    const { document: saved } = (await response.json()) as {
      document: ProjectDocument;
    };
    expect(
      await fixture.service.loadProject(fixture.owner, imported.projectId)
    ).toEqual(fixture.document);
    expect(
      await fixture.service.loadRevision(
        fixture.editor,
        imported.projectId,
        saved.checkpoints.at(-1)!.revisionId
      )
    ).toEqual(saved);
    expect(
      fixture.db
        .prepare(
          'SELECT COUNT(*) AS count FROM project_storage_assets WHERE project_id=?'
        )
        .get(imported.projectId)
    ).toMatchObject({ count: 1 });
  } finally {
    fixture.db.close();
  }
});

it.each(['viewer', 'wrong lease', 'revoked member'] as const)(
  'refuses a named checkpoint from %s',
  async (scenario) => {
    const fixture = await setup();
    try {
      if (scenario === 'revoked member')
        fixture.db
          .prepare(
            'DELETE FROM project_members WHERE project_id=? AND user_id=?'
          )
          .run(fixture.document.projectId, fixture.editor);
      const response = await fixture.post(
        {
          checkpointReason: 'Denied',
          ...(scenario === 'wrong lease' ? { leaseId: 'wrong' } : {})
        },
        scenario === 'viewer' ? fixture.viewer : fixture.editor,
        scenario === 'viewer' ? 'viewer' : 'editor'
      );
      expect(response.status).toBe(scenario === 'wrong lease' ? 409 : 403);
      expect(await response.json()).toMatchObject({
        type: 'error',
        code:
          scenario === 'wrong lease' ? 'lease-required' : 'permission-denied'
      });
      expect(fixture.storage.values.get('room:latest')).toEqual(
        fixture.document
      );
      expect(
        (
          await fixture.service.listRevisions(
            fixture.owner,
            fixture.document.projectId
          )
        ).revisions
      ).toHaveLength(0);
    } finally {
      fixture.db.close();
    }
  }
);

it('refuses a stale clicked model instead of naming a newer room model', async () => {
  const fixture = await setup();
  try {
    const latest = addPrimitiveFeature(fixture.document, {
      name: 'Newer box',
      primitiveKind: 'box',
      dimensions: { width: 1, height: 2, depth: 3 }
    });
    expect((await fixture.post({ document: latest })).status).toBe(200);
    const response = await fixture.post({
      checkpointReason: 'Stale clicked model'
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      type: 'conflict',
      document: { version: latest.version }
    });
    expect(
      (await fixture.service.listRevisions(fixture.owner, latest.projectId))
        .revisions
    ).toHaveLength(0);
    expect(fixture.storage.values.get('room:latest')).toEqual(latest);
  } finally {
    fixture.db.close();
  }
});

it('serializes concurrent checkpoint requests and refuses the stale loser', async () => {
  const fixture = await setup();
  try {
    const responses = await Promise.all([
      fixture.post({ checkpointReason: 'First point' }),
      fixture.post({ checkpointReason: 'Second point' })
    ]);
    expect(responses.map((response) => response.status)).toEqual([200, 409]);
    const revisions = (
      await fixture.service.listRevisions(
        fixture.editor,
        fixture.document.projectId
      )
    ).revisions;
    expect(revisions).toHaveLength(1);
    expect(revisions[0]!.reason).toBe('First point');
  } finally {
    fixture.db.close();
  }
});

it('keeps ordinary room writes independent of revision storage', async () => {
  const fixture = await setup();
  try {
    const edited = addPrimitiveFeature(fixture.document, {
      name: 'Ordinary box',
      primitiveKind: 'box',
      dimensions: { width: 1, height: 2, depth: 3 }
    });
    const response = await fixture.post({ document: edited });
    expect(await response.json()).toEqual({
      type: 'ack',
      version: edited.version
    });
    expect(
      (await fixture.service.listRevisions(fixture.editor, edited.projectId))
        .revisions
    ).toHaveLength(0);
  } finally {
    fixture.db.close();
  }
});

it.each(['D1', 'room publication'] as const)(
  'keeps the prior room head and refuses success when %s storage fails',
  async (stage) => {
    const fixture = await setup();
    try {
      if (stage === 'D1')
        vi.spyOn(fixture.env.DB, 'batch').mockRejectedValueOnce(
          new Error('D1 storage unavailable')
        );
      else
        vi.spyOn(fixture.storage.context.storage, 'put').mockRejectedValueOnce(
          new Error('Room storage unavailable')
        );
      const response = await fixture.post({ checkpointReason: 'Failed point' });
      expect(response.status).toBe(500);
      expect(await response.json()).toMatchObject({
        type: 'error',
        code: 'internal'
      });
      expect(fixture.storage.values.get('room:latest')).toEqual(
        fixture.document
      );
      expect(
        await fixture.service.loadProject(
          fixture.owner,
          fixture.document.projectId
        )
      ).toEqual(fixture.document);
    } finally {
      fixture.db.close();
    }
  }
);

function seedRetainedRevisions(fixture: Awaited<ReturnType<typeof setup>>) {
  const head = fixture.db
    .prepare(
      'SELECT document_json, document_object_id FROM projects WHERE id = ?'
    )
    .get(fixture.document.projectId) as {
    document_json: string;
    document_object_id: string | null;
  };
  for (let index = 0; index < MAX_PROJECT_REVISIONS; index += 1) {
    fixture.db
      .prepare(
        `INSERT INTO revisions
           (id, project_id, reason, document_json, document_object_id,
            document_bytes, created_at, author_user_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        `retained_${index.toString().padStart(3, '0')}`,
        fixture.document.projectId,
        `Retained point ${index}`,
        head.document_json,
        head.document_object_id,
        Buffer.byteLength(JSON.stringify(fixture.document)),
        new Date(Date.UTC(2026, 9, 1, 0, 0, index)).toISOString(),
        fixture.owner
      );
  }
}

for (const mode of ['inline', 'R2'] as const) {
  it.each(['room storage failure', 'publication refusal'] as const)(
    `keeps every retained ${mode} revision when checkpoint publication ends in %s`,
    async (stage) => {
      const bucket = mode === 'R2' ? objectBucket() : undefined;
      const fixture = await setup(bucket);
      try {
        seedRetainedRevisions(fixture);
        const retained = () =>
          fixture.db
            .prepare(
              "SELECT * FROM revisions WHERE project_id = ? AND id LIKE 'retained_%' ORDER BY id"
            )
            .all(fixture.document.projectId);
        const before = retained();
        const objectKeys = new Set(bucket?.objects.keys());
        if (stage === 'room storage failure') {
          vi.spyOn(
            fixture.storage.context.storage,
            'put'
          ).mockRejectedValueOnce(new Error('Room storage unavailable'));
        } else {
          fixture.setStatementHook((sql) => {
            if (!sql.includes('SELECT 1 AS allowed WHERE NOT EXISTS')) return;
            fixture.db
              .prepare(
                'INSERT OR IGNORE INTO project_copy_cleanup_claims (project_id, claimed_at) VALUES (?, ?)'
              )
              .run(fixture.document.projectId, '2026-10-15T00:00:00.000Z');
          });
        }
        const response = await fixture.post({
          checkpointReason: 'Failed point'
        });
        expect(response.status).toBe(
          stage === 'room storage failure' ? 500 : 400
        );
        expect(retained()).toEqual(before);
        for (const key of objectKeys)
          expect(bucket?.objects.has(key)).toBe(true);
        expect(fixture.storage.values.get('room:latest')).toEqual(
          fixture.document
        );
      } finally {
        fixture.db.close();
      }
    }
  );

  it(`prunes retained ${mode} revisions only after the checkpoint is published`, async () => {
    const fixture = await setup(mode === 'R2' ? objectBucket() : undefined);
    try {
      seedRetainedRevisions(fixture);
      let publishedBeforePruning = false;
      fixture.setStatementHook((sql) => {
        if (!sql.includes('DELETE FROM revisions WHERE project_id')) return;
        const latest = fixture.storage.values.get(
          'room:latest'
        ) as ProjectDocument;
        publishedBeforePruning =
          latest.checkpoints.at(-1)?.reason === 'Published point';
      });
      const response = await fixture.post({
        checkpointReason: 'Published point'
      });
      expect(response.status).toBe(200);
      expect(publishedBeforePruning).toBe(true);
      const { document } = (await response.json()) as {
        document: ProjectDocument;
      };
      expect(fixture.storage.values.get('room:latest')).toEqual(document);
      const rows = fixture.db
        .prepare('SELECT id FROM revisions WHERE project_id = ? ORDER BY id')
        .all(fixture.document.projectId);
      expect(rows).toHaveLength(MAX_PROJECT_REVISIONS);
      expect(rows).not.toContainEqual({ id: 'retained_000' });
      expect(rows).toContainEqual({
        id: document.checkpoints.at(-1)!.revisionId
      });
    } finally {
      fixture.db.close();
    }
  });
}

it('recovers a durably committed R2 checkpoint whose D1 acknowledgement was lost', async () => {
  const fixture = await setup(objectBucket());
  try {
    const batch = fixture.env.DB.batch.bind(fixture.env.DB);
    vi.spyOn(fixture.env.DB, 'batch').mockImplementationOnce(
      async (statements) => {
        await batch(statements);
        throw new Error('D1 response lost');
      }
    );
    const response = await fixture.post({ checkpointReason: 'Verified point' });
    expect(response.status).toBe(200);
    const { document: saved } = (await response.json()) as {
      document: ProjectDocument;
    };
    expect(
      await fixture.service.loadRevision(
        fixture.editor,
        saved.projectId,
        saved.checkpoints.at(-1)!.revisionId
      )
    ).toEqual(saved);
  } finally {
    fixture.db.close();
  }
});

it('rechecks membership after R2 upload and cleans an unpublished snapshot', async () => {
  const bucket = objectBucket();
  const fixture = await setup(bucket);
  try {
    const before = new Set(bucket.objects.keys());
    const put = bucket.put.getMockImplementation()!;
    bucket.put.mockImplementationOnce(async (key, body) => {
      await put(key, body);
      fixture.db
        .prepare(
          "UPDATE project_members SET role='viewer' WHERE project_id=? AND user_id=?"
        )
        .run(fixture.document.projectId, fixture.editor);
    });
    const response = await fixture.post({
      checkpointReason: 'Revoked during upload'
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: 'permission-denied' });
    expect(new Set(bucket.objects.keys())).toEqual(before);
    expect(fixture.storage.values.get('room:latest')).toEqual(fixture.document);
    expect(
      (
        await fixture.service.listRevisions(
          fixture.owner,
          fixture.document.projectId
        )
      ).revisions
    ).toHaveLength(0);
  } finally {
    fixture.db.close();
  }
});

it('refuses a checkpoint when merging would replace the clicked model with combined edits', async () => {
  const fixture = await setup();
  try {
    const roomModel = addPrimitiveFeature(fixture.document, {
      name: 'Room box',
      primitiveKind: 'box',
      dimensions: { width: 1, height: 2, depth: 3 }
    });
    const clickedModel = addPrimitiveFeature(fixture.document, {
      name: 'Clicked box',
      primitiveKind: 'box',
      dimensions: { width: 3, height: 2, depth: 1 }
    });
    expect((await fixture.post({ document: roomModel })).status).toBe(200);
    const response = await fixture.post({
      checkpointReason: 'Clicked point',
      document: clickedModel
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      type: 'conflict',
      document: roomModel
    });
    expect(fixture.storage.values.get('room:latest')).toEqual(roomModel);
    expect(
      (await fixture.service.listRevisions(fixture.owner, roomModel.projectId))
        .revisions
    ).toHaveLength(0);
  } finally {
    fixture.db.close();
  }
});

it('refuses a checkpoint whose lease expires during R2 upload', async () => {
  const bucket = objectBucket();
  const fixture = await setup(bucket);
  const clock = vi.spyOn(Date, 'now');
  try {
    const before = new Set(bucket.objects.keys());
    const put = bucket.put.getMockImplementation()!;
    bucket.put.mockImplementationOnce(async (key, body) => {
      await put(key, body);
      clock.mockReturnValue(fixture.leaseExpiresAt + 1);
    });
    const response = await fixture.post({
      checkpointReason: 'Expired during upload'
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: 'lease-required' });
    expect(new Set(bucket.objects.keys())).toEqual(before);
    expect(fixture.storage.values.get('room:latest')).toEqual(fixture.document);
    expect(
      (
        await fixture.service.listRevisions(
          fixture.owner,
          fixture.document.projectId
        )
      ).revisions
    ).toHaveLength(0);
  } finally {
    clock.mockRestore();
    fixture.db.close();
  }
});

it('atomically refuses a checkpoint when membership changes immediately before the revision insert', async () => {
  const bucket = objectBucket();
  const fixture = await setup(bucket);
  try {
    const before = new Set(bucket.objects.keys());
    let revoked = false;
    fixture.setStatementHook((sql) => {
      if (!revoked && sql.includes('INSERT INTO revisions')) {
        revoked = true;
        fixture.db
          .prepare(
            "UPDATE project_members SET role='viewer' WHERE project_id=? AND user_id=?"
          )
          .run(fixture.document.projectId, fixture.editor);
      }
    });
    const response = await fixture.post({
      checkpointReason: 'Revoked at insertion'
    });
    expect(revoked).toBe(true);
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: 'permission-denied' });
    expect(new Set(bucket.objects.keys())).toEqual(before);
    expect(fixture.storage.values.get('room:latest')).toEqual(fixture.document);
    expect(
      (
        await fixture.service.listRevisions(
          fixture.owner,
          fixture.document.projectId
        )
      ).revisions
    ).toHaveLength(0);
  } finally {
    fixture.db.close();
  }
});

it.each([123, 'x'.repeat(501)])(
  'refuses a malformed checkpoint reason before storing a snapshot',
  async (checkpointReason) => {
    const fixture = await setup();
    try {
      expect((await fixture.post({ checkpointReason })).status).toBe(400);
      expect(fixture.storage.values.get('room:latest')).toEqual(
        fixture.document
      );
      expect(
        (
          await fixture.service.listRevisions(
            fixture.owner,
            fixture.document.projectId
          )
        ).revisions
      ).toHaveLength(0);
    } finally {
      fixture.db.close();
    }
  }
);

it('refuses a named checkpoint with a forged document owner', async () => {
  const fixture = await setup();
  try {
    const response = await fixture.post({
      checkpointReason: 'Forged owner',
      document: { ...fixture.document, ownerUserId: fixture.editor }
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: 'document-invalid' });
    expect(fixture.storage.values.get('room:latest')).toEqual(fixture.document);
    expect(
      (
        await fixture.service.listRevisions(
          fixture.owner,
          fixture.document.projectId
        )
      ).revisions
    ).toHaveLength(0);
  } finally {
    fixture.db.close();
  }
});

const meshBytes = encodeImportedMeshPayload({
  vertices: [0, 0, 0, 1, 0, 0, 0, 1, 0],
  indices: [0, 1, 2]
});
function meshDocument(document: ProjectDocument, artifactId: string) {
  return importMeshBody(document, {
    name: 'Scan',
    sourceName: 'scan.stl',
    artifactId,
    triangleCount: 1,
    meshPayloadRef: {
      marker: 'openzcad-source-ref',
      version: 1,
      hashAlgorithm: 'sha256',
      checksumSha256: createHash('sha256').update(meshBytes).digest('hex'),
      logicalBytes: meshBytes.length
    }
  }).document;
}

it.each([
  ['inline', 'discarded source'],
  ['R2', 'discarded source'],
  ['inline', 'copy cleanup'],
  ['R2', 'copy cleanup']
] as const)(
  'atomically refuses a %s checkpoint when %s wins before the revision insert',
  async (mode, claim) => {
    const bucket = mode === 'R2' ? objectBucket() : undefined;
    const fixture = await setup(bucket);
    try {
      const before = new Set(bucket?.objects.keys());
      const artifactId = 'artifact_checkpoint_atomic_mesh';
      const document =
        claim === 'discarded source'
          ? meshDocument(fixture.document, artifactId)
          : fixture.document;
      let claimed = false;
      fixture.setStatementHook((sql) => {
        if (claimed || !sql.includes('INSERT INTO revisions')) return;
        claimed = true;
        if (claim === 'discarded source')
          fixture.db
            .prepare(
              'INSERT INTO artifact_mesh_discards (artifact_id, project_id, object_key, claimed_at) VALUES (?, ?, ?, ?)'
            )
            .run(
              artifactId,
              document.projectId,
              `${document.projectId}/${artifactId}`,
              '2026-10-14T00:00:00.000Z'
            );
        else
          fixture.db
            .prepare(
              'INSERT INTO project_copy_cleanup_claims (project_id, claimed_at) VALUES (?, ?)'
            )
            .run(document.projectId, '2026-10-14T00:00:00.000Z');
      });
      const response = await fixture.post({
        document,
        checkpointReason: 'Removed before insertion'
      });
      expect(claimed).toBe(true);
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({
        type: 'error',
        code: 'permission-denied'
      });
      expect(
        fixture.db
          .prepare('SELECT COUNT(*) AS count FROM revisions WHERE project_id=?')
          .get(document.projectId)
      ).toMatchObject({ count: 0 });
      expect(fixture.storage.values.get('room:latest')).toEqual(
        fixture.document
      );
      if (bucket) expect(new Set(bucket.objects.keys())).toEqual(before);
    } finally {
      fixture.db.close();
    }
  }
);

it('refuses success when copy cleanup blocks room publication after the snapshot was stored', async () => {
  const fixture = await setup();
  try {
    let claimed = false;
    fixture.setStatementHook((sql) => {
      if (claimed || !sql.includes('SELECT 1 AS allowed WHERE NOT EXISTS'))
        return;
      claimed = true;
      fixture.db
        .prepare(
          'INSERT INTO project_copy_cleanup_claims (project_id, claimed_at) VALUES (?, ?)'
        )
        .run(fixture.document.projectId, '2026-10-14T00:00:00.000Z');
    });
    const response = await fixture.post({
      checkpointReason: 'Publication refused'
    });
    expect(claimed).toBe(true);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      type: 'error',
      code: 'document-invalid'
    });
    expect(
      fixture.db
        .prepare('SELECT COUNT(*) AS count FROM revisions WHERE project_id=?')
        .get(fixture.document.projectId)
    ).toMatchObject({ count: 1 });
    expect(fixture.storage.values.get('room:latest')).toEqual(fixture.document);
  } finally {
    fixture.db.close();
  }
});

it('does not store a checkpoint referencing a payload discarded during its R2 upload', async () => {
  const bucket = objectBucket();
  const artifacts = objectBucket();
  const fixture = await setup(bucket, artifacts);
  try {
    const { session } = await fixture.service.createUploadSession(
      fixture.owner,
      {
        projectId: fixture.document.projectId,
        fileName: 'scan.ozmesh',
        kind: 'mesh-payload',
        contentType: 'application/octet-stream'
      }
    );
    await fixture.service.putUpload(
      fixture.owner,
      session.uploadSessionId,
      meshBytes.buffer
    );
    const artifact = await fixture.service.finalizeArtifact(fixture.owner, {
      projectId: fixture.document.projectId,
      uploadSessionId: session.uploadSessionId,
      artifactId: session.artifactId
    });
    expect(artifact).not.toBeNull();
    const document = meshDocument(fixture.document, session.artifactId);
    const before = new Set(bucket.objects.keys());
    const put = bucket.put.getMockImplementation()!;
    bucket.put.mockImplementationOnce(async (key, body) => {
      await put(key, body);
      expect(
        await fixture.service.discardMeshPayload(
          fixture.owner,
          document.projectId,
          session.artifactId
        )
      ).toEqual({ deleted: true });
    });
    const response = await fixture.post({
      document,
      checkpointReason: 'Removed during upload'
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      type: 'error',
      code: 'permission-denied'
    });
    expect(artifacts.objects.size).toBe(0);
    expect(new Set(bucket.objects.keys())).toEqual(before);
    expect(
      fixture.db
        .prepare('SELECT COUNT(*) AS count FROM revisions WHERE project_id=?')
        .get(document.projectId)
    ).toMatchObject({ count: 0 });
    expect(fixture.storage.values.get('room:latest')).toEqual(fixture.document);
  } finally {
    fixture.db.close();
  }
});
