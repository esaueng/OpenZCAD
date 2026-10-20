import { describe, expect, it, vi } from 'vitest';
import worker from '../apps/web/worker/index';
import { D1R2PersistenceService } from '@openzcad/cloudflare-adapters';
import {
  adoptProjectDocument,
  createProjectDocument,
  createSavedRevision,
  duplicateProjectDocument,
  normalizeDocument,
  reidentifyProjectDocument,
  withoutDerivedProjection
} from '@openzcad/document-core';
import {
  ADOPTION_CHECKPOINT_REASON,
  assertClientAdoption,
  assertClientProjectCopy,
  MAX_SAVE_POINT_CLOCK_SKEW_MS,
  ProjectAdoptionError,
  projectCopyDocumentDigest,
  RevisionIdCollisionError,
  SavePointRequestError
} from '@openzcad/persistence';
import {
  createId,
  projectBranchPoint,
  toProjectId,
  toRevisionId,
  toUserId,
  type CreateProjectResponse,
  type ProjectDocument,
  type UserId
} from '@openzcad/shared';
import { buildCloudProjectCopy } from '../apps/web/src/lib/cloudProjectCopy';
import {
  parseCreateProjectRequest,
  parseDuplicateProjectRequest
} from '../apps/web/worker/validation';
import { migratedDatabase, sqliteD1 } from './support/sqlite-d1';

const env = {
  ENVIRONMENT: 'development' as const,
  AUTH_MODE: 'development' as const,
  ARTIFACTS: {} as R2Bucket,
  PROJECT_ROOM: { getByName: vi.fn() }
};

function post(path: string, body: unknown): Request {
  return new Request(`https://example.com${path}`, {
    method: 'POST',
    body: JSON.stringify(body)
  });
}

const later = () =>
  new Date(Date.now() + MAX_SAVE_POINT_CLOCK_SKEW_MS + 60_000).toISOString();
const earlier = () =>
  new Date(Date.now() - MAX_SAVE_POINT_CLOCK_SKEW_MS - 60_000).toISOString();

function withLast<T extends 'revisions' | 'checkpoints'>(
  document: ProjectDocument,
  key: T,
  change: Partial<ProjectDocument[T][number]>
): ProjectDocument {
  const records = [...document[key]];
  records[records.length - 1] = { ...records.at(-1)!, ...change };
  return { ...document, [key]: records };
}

function sourceDocument(owner: UserId): ProjectDocument {
  return createSavedRevision(
    createProjectDocument('Bracket', owner),
    'Before drilling'
  );
}

function adopted(local: ProjectDocument, owner: UserId): ProjectDocument {
  return withoutDerivedProjection(
    adoptProjectDocument(
      reidentifyProjectDocument(local, toProjectId(createId('proj'))),
      owner,
      local.name
    )
  );
}

/** Every way a browser-built copy can be malformed, and what is wrong. */
function malformedCopies(
  source: ProjectDocument,
  owner: UserId
): Array<[string, ProjectDocument]> {
  const copy = duplicateProjectDocument(source, 'Bracket (copy)', owner);
  const foreignImport = structuredClone(copy);
  const featureId = 'feat_foreign';
  foreignImport.nodes[featureId] = {
    id: featureId,
    kind: 'feature',
    featureId,
    name: 'Scan',
    data: {
      featureKind: 'imported-mesh',
      artifactId: 'artifact_owned_by_another_project',
      meshPayloadRef: {
        marker: 'openzcad-source-ref',
        version: 1,
        hashAlgorithm: 'sha256',
        checksumSha256: 'a'.repeat(64),
        logicalBytes: 10
      }
    }
  } as unknown as ProjectDocument['nodes'][string];
  return [
    ['belongs to someone else', { ...copy, ownerUserId: toUserId('other') }],
    [
      'carries a hand-picked id',
      reidentifyProjectDocument(copy, toProjectId('proj_handpicked'))
    ],
    [
      'keeps the source project id in its root node',
      { ...copy, projectId: toProjectId(createId('proj')) }
    ],
    [
      'does not end with a copy revision',
      withLast(copy, 'revisions', { reason: 'Edited' })
    ],
    [
      'has a malformed revision id',
      withLast(
        withLast(copy, 'revisions', { revisionId: toRevisionId('rev_mine') }),
        'checkpoints',
        { revisionId: toRevisionId('rev_mine') }
      )
    ],
    [
      'checkpoints another version',
      withLast(copy, 'checkpoints', { documentVersion: copy.version + 1 })
    ],
    [
      'has no checkpoint',
      { ...copy, checkpoints: copy.checkpoints.slice(0, -1) }
    ],
    [
      'is dated in the future',
      withLast(copy, 'revisions', { createdAt: later() })
    ],
    [
      'is dated in the past',
      withLast(copy, 'checkpoints', { createdAt: earlier() })
    ],
    [
      'repeats a revision id',
      { ...copy, revisions: [copy.revisions.at(-1)!, ...copy.revisions] }
    ],
    ['references an archived import of another project', foreignImport]
  ];
}

describe('browser-built copies (ADR-024 Phase 1)', () => {
  const owner = toUserId('copy_owner');

  it('accepts the copy duplicateProjectDocument builds', () => {
    const source = sourceDocument(owner);
    const copy = duplicateProjectDocument(source, 'Bracket (copy)', owner);
    expect(
      assertClientProjectCopy(copy, {
        userId: owner,
        sourceProjectId: source.projectId
      })
    ).toEqual(copy.revisions.at(-1));
  });

  it.each(malformedCopies(sourceDocument(owner), owner))(
    'refuses a copy that %s',
    (_label, copy) => {
      expect(() =>
        assertClientProjectCopy(copy, {
          userId: owner,
          sourceProjectId: 'proj_source'
        })
      ).toThrow(SavePointRequestError);
    }
  );

  it('refuses a branch that does not record the requested save state', () => {
    const source = sourceDocument(owner);
    const revision = source.revisions.at(-1)!;
    const branch = duplicateProjectDocument(
      source,
      'Bracket (copy)',
      owner,
      projectBranchPoint(source, revision)
    );
    const expected = {
      userId: owner,
      sourceProjectId: source.projectId,
      revisionId: revision.revisionId
    };
    expect(() => assertClientProjectCopy(branch, expected)).not.toThrow();
    expect(() =>
      assertClientProjectCopy(branch, {
        ...expected,
        revisionId: `rev_${crypto.randomUUID()}`
      })
    ).toThrow(SavePointRequestError);
    expect(() =>
      assertClientProjectCopy(branch, {
        ...expected,
        sourceProjectId: 'proj_elsewhere'
      })
    ).toThrow(SavePointRequestError);
    // A plain duplicate is not a branch, even when it names the save state.
    expect(() =>
      assertClientProjectCopy(
        duplicateProjectDocument(source, 'Bracket (copy)', owner),
        expected
      )
    ).toThrow(SavePointRequestError);
    expect(() =>
      assertClientProjectCopy(branch, { ...expected, name: 'Another name' })
    ).toThrow(SavePointRequestError);
  });

  it('sends a digest equal to the stored copy’s canonical digest', async () => {
    const source = sourceDocument(owner);
    const request = await buildCloudProjectCopy(
      { projectId: source.projectId, projectName: source.name },
      owner,
      ['Bracket', 'Bracket (copy)'],
      {
        loadProject: async () => source,
        loadRevision: async () => null
      }
    );
    expect(request!.document!.name).toBe('Bracket (copy 2)');
    expect(request!.importSources).toEqual([]);
    // What the store keeps: the wire form, normalized without derived state.
    const stored = withoutDerivedProjection(
      normalizeDocument(
        JSON.parse(
          JSON.stringify(withoutDerivedProjection(request!.document!))
        ) as ProjectDocument
      )
    );
    expect(await projectCopyDocumentDigest(stored)).toBe(
      request!.documentDigest
    );
  });

  it('asks the device for a save state the account no longer stores', async () => {
    const source = sourceDocument(owner);
    await expect(
      buildCloudProjectCopy(
        {
          projectId: source.projectId,
          projectName: source.name,
          saveState: { revisionId: 'rev_pruned', reason: 'Old' }
        },
        owner,
        [],
        {
          loadProject: async () => source,
          loadRevision: async () => null
        }
      )
    ).resolves.toBeNull();
  });
});

describe('browser re-homed adoptions (ADR-024 Phase 1)', () => {
  const owner = toUserId('adoption_owner');
  const local = () => sourceDocument(toUserId('device_user'));

  it('accepts the adoption adoptProjectDocument builds', () => {
    const device = local();
    const document = adopted(device, owner);
    expect(document.checkpoints.at(-1)?.reason).toBe(
      ADOPTION_CHECKPOINT_REASON
    );
    expect(() =>
      assertClientAdoption(document, {
        userId: owner,
        name: device.name,
        localProjectId: device.projectId
      })
    ).not.toThrow();
  });

  it.each<[string, (device: ProjectDocument) => ProjectDocument]>([
    [
      'keeps the device id',
      (device) => ({ ...adopted(device, owner), projectId: device.projectId })
    ],
    ['belongs to someone else', (device) => adopted(device, toUserId('other'))],
    [
      'lacks its "Saved to account" checkpoint',
      (device) =>
        withLast(adopted(device, owner), 'checkpoints', { reason: 'Saved' })
    ],
    [
      'checkpoints in the future',
      (device) =>
        withLast(adopted(device, owner), 'checkpoints', { createdAt: later() })
    ],
    [
      'carries a hand-picked id',
      (device) =>
        reidentifyProjectDocument(
          adopted(device, owner),
          toProjectId('proj_handpicked')
        )
    ]
  ])('refuses an adoption that %s', (_label, build) => {
    const device = local();
    expect(() =>
      assertClientAdoption(build(device), {
        userId: owner,
        name: device.name,
        localProjectId: device.projectId
      })
    ).toThrow(SavePointRequestError);
  });

  it('accepts an earlier "Saved to account" checkpoint adoption kept', () => {
    const device = local();
    const document = withLast(adopted(device, owner), 'checkpoints', {
      createdAt: earlier()
    });
    expect(() =>
      assertClientAdoption(document, {
        userId: owner,
        name: device.name,
        localProjectId: device.projectId
      })
    ).not.toThrow();
  });
});

describe('request parsing', () => {
  it('requires a digest and well-formed import sources with a copy', () => {
    const owner = toUserId('parse_owner');
    const document = duplicateProjectDocument(
      sourceDocument(owner),
      'Copy',
      owner
    );
    const digest = 'a'.repeat(64);
    expect(
      parseDuplicateProjectRequest(
        { document, documentDigest: digest },
        'proj_source'
      )
    ).toMatchObject({ documentDigest: digest, importSources: [] });
    for (const body of [
      { document },
      { document, documentDigest: 'not-hex' },
      { document, documentDigest: digest, importSources: [{}] },
      {
        document,
        documentDigest: digest,
        importSources: [
          {
            artifactId: 'artifact_local_x',
            kind: 'step-import',
            checksumSha256: digest,
            logicalBytes: 1
          }
        ]
      },
      {
        document,
        documentDigest: digest,
        importSources: [
          {
            artifactId: 'artifact_x',
            kind: 'thumbnail',
            checksumSha256: digest,
            logicalBytes: 1
          }
        ]
      },
      { documentDigest: digest },
      { importSources: [] }
    ]) {
      expect(() => parseDuplicateProjectRequest(body, 'proj_source')).toThrow();
    }
  });

  it('requires the device id with a version 2 adoption and only then', () => {
    const device = sourceDocument(toUserId('device_user'));
    const document = adopted(device, toUserId('parse_owner'));
    expect(
      parseCreateProjectRequest({
        name: device.name,
        document,
        adoptionProtocolVersion: 2,
        localProjectId: device.projectId,
        sourceArtifactIds: ['artifact_a', 'artifact_a']
      })
    ).toMatchObject({
      adoptionProtocolVersion: 2,
      localProjectId: device.projectId,
      sourceArtifactIds: ['artifact_a']
    });
    for (const body of [
      { name: device.name, document, adoptionProtocolVersion: 2 },
      {
        name: device.name,
        document,
        adoptionProtocolVersion: 2,
        localProjectId: device.projectId,
        sourceArtifactIds: ['artifact_local_abc']
      },
      {
        name: device.name,
        document: device,
        adoptionProtocolVersion: 1,
        localProjectId: device.projectId
      }
    ]) {
      expect(() => parseCreateProjectRequest(body)).toThrow();
    }
  });
});

describe('browser-built copies and adoptions through the Worker', () => {
  async function accountProject() {
    const response = await worker.fetch(
      post('/api/projects', { name: 'Worker source' }),
      env
    );
    expect(response.status).toBe(201);
    return (await response.json()) as CreateProjectResponse;
  }

  async function copyBody(
    source: ProjectDocument,
    saveState?: { revisionId: string; reason: string }
  ) {
    return (await buildCloudProjectCopy(
      {
        projectId: source.projectId,
        projectName: source.name,
        ...(saveState ? { saveState } : {})
      },
      source.ownerUserId,
      [],
      {
        loadProject: async () => source,
        loadRevision: async (projectId, revisionId) => {
          const response = await worker.fetch(
            new Request(
              `https://example.com/api/projects/${projectId}/revisions/${revisionId}`
            ),
            env
          );
          return response.ok
            ? ((await response.json()) as ProjectDocument)
            : null;
        }
      }
    ))!;
  }

  it('stores a browser-built duplicate and refuses its replay', async () => {
    const { document: source } = await accountProject();
    const body = await copyBody(source);
    const path = `/api/projects/${source.projectId}/duplicate`;
    const response = await worker.fetch(post(path, body), env);
    expect(response.status).toBe(201);
    const copy = (await response.json()) as CreateProjectResponse;
    expect(copy.document.projectId).toBe(body.document!.projectId);
    expect(copy.document.checkpoints).toEqual(body.document!.checkpoints);

    const replay = await worker.fetch(post(path, body), env);
    expect(replay.status).toBe(409);
    expect(((await replay.json()) as { code?: string }).code).toBe(
      'PROJECT_ID_TAKEN'
    );
  });

  it('stores a browser-built branch of a stored save state', async () => {
    const { document: source } = await accountProject();
    const saved = await worker.fetch(
      post(`/api/projects/${source.projectId}/revisions`, {
        projectId: source.projectId,
        reason: 'Before drilling',
        expectedVersion: source.version,
        document: source
      }),
      env
    );
    const stored = (await saved.json()) as ProjectDocument;
    const revisionId = stored.revisions.at(-1)!.revisionId;
    const body = await copyBody(stored, {
      revisionId,
      reason: 'Before drilling'
    });
    const response = await worker.fetch(
      post(`/api/projects/${source.projectId}/duplicate`, body),
      env
    );
    expect(response.status).toBe(201);
    const branch = (await response.json()) as CreateProjectResponse;
    expect(branch.document.branchedFrom).toMatchObject({
      projectId: source.projectId,
      revisionId,
      checkpointReason: 'Before drilling'
    });
  });

  it('refuses a branch of a save state the account does not store', async () => {
    const { document: source } = await accountProject();
    const revisionId = `rev_${crypto.randomUUID()}`;
    const body = await buildCloudProjectCopy(
      {
        projectId: source.projectId,
        projectName: source.name,
        saveState: { revisionId, reason: 'Invented' }
      },
      source.ownerUserId,
      [],
      { loadProject: async () => source, loadRevision: async () => source }
    );
    const response = await worker.fetch(
      post(`/api/projects/${source.projectId}/duplicate`, body),
      env
    );
    expect(response.status).toBe(404);
  });

  it('refuses malformed browser-built copies with a 400', async () => {
    const { document: source } = await accountProject();
    const path = `/api/projects/${source.projectId}/duplicate`;
    for (const [label, document] of malformedCopies(
      source,
      source.ownerUserId
    )) {
      const response = await worker.fetch(
        post(path, { document, documentDigest: 'a'.repeat(64) }),
        env
      );
      expect(response.status, label).toBe(400);
    }
  });

  it('refuses a copy of a project the caller cannot read', async () => {
    const owner = toUserId('someone_else');
    const document = duplicateProjectDocument(
      sourceDocument(owner),
      'Copy',
      owner
    );
    const response = await worker.fetch(
      post(`/api/projects/proj_${crypto.randomUUID()}/duplicate`, {
        document,
        documentDigest: 'a'.repeat(64)
      }),
      env
    );
    expect(response.status).toBe(404);
  });

  it('stores a browser re-homed adoption under its own id and binds the device id', async () => {
    const { document: anyProject } = await accountProject();
    const owner = anyProject.ownerUserId;
    const device = sourceDocument(toUserId('device_user'));
    const document = adopted(device, owner);
    const body = {
      name: device.name,
      adoptionProtocolVersion: 2,
      localProjectId: device.projectId,
      document
    };
    const response = await worker.fetch(post('/api/projects', body), env);
    expect(response.status).toBe(201);
    const created = (await response.json()) as CreateProjectResponse;
    expect(created.document.projectId).toBe(document.projectId);
    expect(created.document.checkpoints.at(-1)?.reason).toBe(
      ADOPTION_CHECKPOINT_REASON
    );

    // A retry after a lost acknowledgement mints a new id; the device binding
    // still answers with the account's copy.
    const retry = await worker.fetch(
      post('/api/projects', { ...body, document: adopted(device, owner) }),
      env
    );
    expect(retry.status).toBe(409);
    const refusal = (await retry.json()) as {
      code?: string;
      projectId?: string;
    };
    expect(refusal.code).toBe('ALREADY_ADOPTED');
    expect(refusal.projectId).toBe(document.projectId);
  });

  it('refuses a malformed browser re-homed adoption with a 400', async () => {
    const { document: anyProject } = await accountProject();
    const device = sourceDocument(toUserId('device_user'));
    const response = await worker.fetch(
      post('/api/projects', {
        name: device.name,
        adoptionProtocolVersion: 2,
        localProjectId: device.projectId,
        document: adopted(device, toUserId('not_the_caller'))
      }),
      env
    );
    expect(response.status).toBe(400);
    expect(((await response.json()) as { code?: string }).code).toBe(
      'SAVE_POINT_INVALID'
    );
    expect(anyProject).toBeDefined();
  });
});

describe('browser-built copies and adoptions in D1', () => {
  function setup() {
    const db = migratedDatabase();
    const owner = toUserId('d1_copy_owner');
    db.prepare(
      'INSERT INTO users (id, email, created_at) VALUES (?, ?, ?)'
    ).run(owner, 'd1-copy-owner@example.test', '2026-10-19T00:00:00.000Z');
    return {
      db,
      owner,
      service: new D1R2PersistenceService({ DB: sqliteD1(db) })
    };
  }

  it('stores a browser-built copy and refuses a replayed id or revision', async () => {
    const { db, owner, service } = setup();
    const { document: source } = await service.createProject(owner, {
      name: 'D1 source',
      initialDocument: withoutDerivedProjection(
        createProjectDocument('D1 source', owner)
      )
    });
    const request = (await buildCloudProjectCopy(
      { projectId: source.projectId, projectName: source.name },
      owner,
      [source.name],
      { loadProject: async () => source, loadRevision: async () => null }
    ))!;
    const copy = await service.duplicateProject(owner, {
      projectId: source.projectId,
      ...request
    });
    expect(copy.document.projectId).toBe(request.document!.projectId);
    expect(copy.document.name).toBe('D1 source (copy)');
    expect(
      db
        .prepare('SELECT sort_order FROM projects WHERE id = ?')
        .get(copy.document.projectId)
    ).toEqual(
      db
        .prepare('SELECT sort_order FROM projects WHERE id = ?')
        .get(source.projectId)
    );
    await expect(
      service.duplicateProject(owner, {
        projectId: source.projectId,
        ...request
      })
    ).rejects.toMatchObject({
      constructor: ProjectAdoptionError,
      code: 'PROJECT_ID_TAKEN'
    });

    // A fresh project id whose closing revision a stored row already uses.
    const named = await service.saveRevision(owner, {
      projectId: copy.document.projectId,
      reason: 'Named',
      expectedVersion: copy.document.version,
      document: copy.document
    });
    const reused = named.revisions.at(-1)!.revisionId;
    const forged = reidentifyProjectDocument(
      withLast(
        withLast(request.document!, 'revisions', { revisionId: reused }),
        'checkpoints',
        { revisionId: reused }
      ),
      toProjectId(createId('proj'))
    );
    await expect(
      service.duplicateProject(owner, {
        projectId: source.projectId,
        document: forged,
        documentDigest: await projectCopyDocumentDigest(forged),
        importSources: []
      })
    ).rejects.toBeInstanceOf(RevisionIdCollisionError);
  });

  it('refuses a version 2 adoption whose device archive was discarded', async () => {
    const { db, owner, service } = setup();
    const { document: uploads } = await service.createProject(owner, {
      name: 'Uploads'
    });
    db.prepare(
      'INSERT INTO artifact_mesh_discards (artifact_id, project_id, object_key, claimed_at) VALUES (?, ?, ?, ?)'
    ).run(
      'artifact_discarded_upload',
      uploads.projectId,
      'discarded/object',
      '2026-10-19T00:00:00.000Z'
    );
    const device = sourceDocument(toUserId('device_user'));
    await expect(
      service.createProject(owner, {
        name: device.name,
        adoptionProtocolVersion: 2,
        localProjectId: device.projectId,
        sourceArtifactIds: ['artifact_discarded_upload'],
        document: adopted(device, owner)
      })
    ).rejects.toThrow();
    expect((await service.listProjects(owner)).projects).toHaveLength(1);
    expect(
      db
        .prepare(
          'SELECT count(*) AS count FROM project_adoptions WHERE user_id = ?'
        )
        .get(owner)
    ).toMatchObject({ count: 0 });
  });
});
