import { describe, expect, it, vi } from 'vitest';
import worker from '../apps/web/worker/index';
import { CommandManager, commandFactories } from '@openzcad/command-system';
import {
  createProjectDocument,
  createSavedRevision,
  withoutDerivedProjection
} from '@openzcad/document-core';
import { splitProjectStorageUpload } from '@openzcad/persistence';
import {
  toUserId,
  type CreateProjectResponse,
  type ProjectDocument,
  type SaveProjectDocumentResponse
} from '@openzcad/shared';
import { migratedDatabase, sqliteD1 } from './support/sqlite-d1';

/** The worker's development identity. */
const OWNER = toUserId('user_beta_dev');
const STEP_TEXT = `ISO-10303-21;\n${'CLOSED_SHELL'.repeat(20_000)}\nEND-ISO-10303-21;`;

function objectBucket() {
  const objects = new Map<string, ArrayBuffer>();
  return {
    objects,
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

function setup() {
  const db = migratedDatabase();
  db.prepare('INSERT INTO users (id, email, created_at) VALUES (?, ?, ?)').run(
    OWNER,
    'dev@example.test',
    '2026-10-20T00:00:00.000Z'
  );
  const bucket = objectBucket();
  const env = {
    ENVIRONMENT: 'development' as const,
    AUTH_MODE: 'development' as const,
    DB: sqliteD1(db),
    PROJECT_STORAGE: bucket as unknown as R2Bucket,
    ARTIFACTS: {} as R2Bucket,
    PROJECT_ROOM: { getByName: vi.fn() }
  };
  const call = (method: string, path: string, body?: unknown) =>
    worker.fetch(
      new Request(`https://example.com${path}`, {
        method,
        ...(body === undefined ? {} : { body: JSON.stringify(body) })
      }),
      env
    );
  return { db, bucket, call };
}

/** A new account project, created by the browser with embedded imports. */
function importedProject(): ProjectDocument {
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
  manager.execute(
    commandFactories.importMesh({
      name: 'Bracket mesh',
      artifactId: 'artifact_split_mesh',
      sourceName: 'bracket.stl',
      triangleCount: 2,
      vertices: [0, 0, 0, 10, 0, 0, 0, 5, 0, 0, 0, 3],
      indices: [0, 1, 2, 0, 2, 3]
    })
  );
  return withoutDerivedProjection(manager.document);
}

const decoder = new TextDecoder();
async function storedText(body: ArrayBuffer): Promise<string> {
  const stream = new Response(body).body!.pipeThrough(
    new DecompressionStream('gzip')
  );
  return decoder.decode(await new Response(stream).arrayBuffer());
}

function assetKeys(bucket: ReturnType<typeof objectBucket>): string[] {
  return [...bucket.objects.keys()].filter((key) => key.includes('/assets/'));
}

async function created(
  call: ReturnType<typeof setup>['call'],
  project = importedProject()
) {
  const response = await call('POST', '/api/projects', {
    name: project.name,
    ...(await splitProjectStorageUpload(project).then((split) => ({
      initialDocument: split.document,
      storageAssets: split.storageAssets
    })))
  });
  expect(response.status).toBe(201);
  return ((await response.json()) as CreateProjectResponse).document;
}

describe('browser-split document writes through the worker (ADR-024 Phase 1)', () => {
  it('stores browser-split payloads under content-addressed keys and loads the whole document back', async () => {
    const { db, bucket, call } = setup();
    const project = importedProject();
    const document = await created(call, project);
    expect(document.nodes).toEqual(project.nodes);
    expect(document.editHistory).toEqual(project.editHistory);

    const keys = assetKeys(bucket);
    expect(keys.map((key) => key.split('.').slice(1).join('.')).sort()).toEqual(
      ['mesh.json.gz', 'step.txt.gz']
    );
    const rows = db
      .prepare(
        'SELECT kind, object_key, stored_bytes FROM project_storage_assets WHERE project_id = ? ORDER BY kind'
      )
      .all(document.projectId) as Array<{
      kind: string;
      object_key: string;
      stored_bytes: number;
    }>;
    expect(rows.map((row) => row.kind)).toEqual([
      'mesh-payload',
      'step-source'
    ]);
    for (const row of rows)
      expect(bucket.objects.get(row.object_key)!.byteLength).toBe(
        row.stored_bytes
      );
    const documentObjects = [...bucket.objects.entries()].filter(([key]) =>
      key.includes('/documents/')
    );
    expect(documentObjects).toHaveLength(1);
    expect(await storedText(documentObjects[0]![1])).not.toContain(
      'CLOSED_SHELLCLOSED_SHELL'
    );
    expect(
      await storedText(
        bucket.objects.get(keys.find((k) => k.endsWith('step.txt.gz'))!)!
      )
    ).toBe(STEP_TEXT);

    // A named save and an autosave of the same imports reuse the stored bytes.
    const named = createSavedRevision(document, 'Named');
    const saved = await call(
      'POST',
      `/api/projects/${document.projectId}/revisions`,
      {
        projectId: document.projectId,
        reason: 'Named',
        expectedVersion: document.version,
        savedRevisionId: named.revisions.at(-1)!.revisionId,
        ...(await splitProjectStorageUpload(named))
      }
    );
    expect(saved.status).toBe(200);
    const revision = (await saved.json()) as ProjectDocument;
    expect(revision.nodes).toEqual(document.nodes);

    const next = { ...revision, version: revision.version + 1 };
    const autosaved = await call(
      'PUT',
      `/api/projects/${document.projectId}/document`,
      {
        projectId: document.projectId,
        expectedVersion: revision.version,
        ...(await splitProjectStorageUpload(next))
      }
    );
    expect(autosaved.status).toBe(200);
    expect(
      ((await autosaved.json()) as SaveProjectDocumentResponse).version
    ).toBe(next.version);
    const assetPuts = bucket.put.mock.calls.filter(([key]) =>
      key.includes('/assets/')
    );
    expect(assetPuts).toHaveLength(2);

    const loaded = await call('GET', `/api/projects/${document.projectId}`);
    expect(loaded.status).toBe(200);
    const reloaded = (await loaded.json()) as ProjectDocument;
    expect(reloaded.version).toBe(next.version);
    expect(reloaded.nodes).toEqual(document.nodes);
    expect(reloaded.commandLog).toEqual(document.commandLog);
    expect(reloaded.editHistory).toEqual(document.editHistory);
  });

  it('keeps the asset keys a pre-Phase 1 save writes, so both shapes share stored bytes', async () => {
    const { bucket, call } = setup();
    const document = await created(call);
    const keys = assetKeys(bucket).sort();
    const next = { ...document, version: document.version + 1 };
    const legacy = await call(
      'PUT',
      `/api/projects/${document.projectId}/document`,
      {
        projectId: document.projectId,
        expectedVersion: document.version,
        document: next
      }
    );
    expect(legacy.status).toBe(200);
    expect(assetKeys(bucket).sort()).toEqual(keys);
    expect(
      bucket.put.mock.calls.filter(([key]) => key.includes('/assets/'))
    ).toHaveLength(2);
  });

  it.each([
    [
      'bytes that fail their checksum',
      async (body: Record<string, unknown>) => ({
        ...body,
        storageAssets: (
          body.storageAssets as Array<{ kind: string; storedBody: string }>
        ).map((asset) =>
          asset.kind === 'mesh-payload'
            ? {
                ...asset,
                storedBody: (
                  body.storageAssets as Array<{
                    kind: string;
                    storedBody: string;
                  }>
                ).find((other) => other.kind === 'step-source')!.storedBody
              }
            : asset
        )
      })
    ],
    [
      'a document missing one of its uploads',
      async (body: Record<string, unknown>) => ({
        ...body,
        storageAssets: (body.storageAssets as Array<{ kind: string }>).filter(
          (asset) => asset.kind === 'step-source'
        )
      })
    ],
    [
      'a projection the account would store differently',
      async (body: Record<string, unknown>) => {
        // Without a browser-minted save point the account mints one, so the
        // projection no longer describes what it would store.
        const { savedRevisionId: _minted, ...rest } = body;
        return rest;
      }
    ]
  ])(
    'refuses %s with STORAGE_ASSET_INVALID and writes nothing',
    async (_name, tamper) => {
      const { bucket, call } = setup();
      const document = await created(call);
      const before = new Map(bucket.objects);
      const putsBefore = bucket.put.mock.calls.length;
      const named = createSavedRevision(document, 'Named');
      const response = await call(
        'POST',
        `/api/projects/${document.projectId}/revisions`,
        await tamper({
          projectId: document.projectId,
          reason: 'Named',
          expectedVersion: document.version,
          savedRevisionId: named.revisions.at(-1)!.revisionId,
          ...(await splitProjectStorageUpload(named))
        })
      );
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        code: 'STORAGE_ASSET_INVALID'
      });
      expect(bucket.put.mock.calls.length).toBe(putsBefore);
      expect(bucket.objects).toEqual(before);
      const loaded = (await (
        await call('GET', `/api/projects/${document.projectId}`)
      ).json()) as ProjectDocument;
      expect(loaded.version).toBe(document.version);
    }
  );
});
