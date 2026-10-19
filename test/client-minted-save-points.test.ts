import { describe, expect, it, vi } from 'vitest';
import worker from '../apps/web/worker/index';
import {
  D1R2PersistenceService,
  resolveKeptCollaborationDocument
} from '@openzcad/cloudflare-adapters';
import {
  addPrimitiveFeature,
  createProjectDocument,
  createSavedRevision,
  withoutDerivedProjection
} from '@openzcad/document-core';
import {
  assertClientSavePoint,
  MAX_SAVE_POINT_CLOCK_SKEW_MS,
  ProjectAdoptionError,
  RevisionIdCollisionError,
  SavePointRequestError
} from '@openzcad/persistence';
import {
  KEPT_LOCAL_VERSION_REASON,
  toRevisionId,
  toUserId,
  type CreateProjectResponse,
  type ProjectDocument,
  type RevisionId
} from '@openzcad/shared';
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

function minted(document: ProjectDocument, reason: string) {
  const saved = createSavedRevision(withoutDerivedProjection(document), reason);
  return {
    document: saved,
    savedRevisionId: saved.revisions.at(-1)!.revisionId
  };
}

function withLastRevision(
  document: ProjectDocument,
  change: Partial<ProjectDocument['revisions'][number]>
): ProjectDocument {
  const revisions = [...document.revisions];
  revisions[revisions.length - 1] = { ...revisions.at(-1)!, ...change };
  return { ...document, revisions };
}

function withLastCheckpoint(
  document: ProjectDocument,
  change: Partial<ProjectDocument['checkpoints'][number]>
): ProjectDocument {
  const checkpoints = [...document.checkpoints];
  checkpoints[checkpoints.length - 1] = { ...checkpoints.at(-1)!, ...change };
  return { ...document, checkpoints };
}

/** Every way a client-minted save point can be malformed, and what is wrong. */
function malformedSavePoints(
  document: ProjectDocument,
  reason: string
): Array<[string, { document: ProjectDocument; savedRevisionId: RevisionId }]> {
  const good = minted(document, reason);
  const revision = good.document.revisions.at(-1)!;
  const later = new Date(
    Date.now() + MAX_SAVE_POINT_CLOCK_SKEW_MS + 60_000
  ).toISOString();
  const earlier = new Date(
    Date.now() - MAX_SAVE_POINT_CLOCK_SKEW_MS - 60_000
  ).toISOString();
  return [
    [
      'names a revision that is not the newest',
      {
        document: good.document,
        savedRevisionId: toRevisionId(`rev_${crypto.randomUUID()}`)
      }
    ],
    [
      'carries a malformed id',
      {
        document: withLastCheckpoint(
          withLastRevision(good.document, {
            revisionId: toRevisionId('rev_chosen-by-hand')
          }),
          { revisionId: toRevisionId('rev_chosen-by-hand') }
        ),
        savedRevisionId: toRevisionId('rev_chosen-by-hand')
      }
    ],
    [
      'records another reason',
      {
        document: withLastRevision(good.document, { reason: 'Something else' }),
        savedRevisionId: good.savedRevisionId
      }
    ],
    [
      'has no checkpoint naming it',
      {
        document: {
          ...good.document,
          checkpoints: good.document.checkpoints.slice(0, -1)
        },
        savedRevisionId: good.savedRevisionId
      }
    ],
    [
      'checkpoints another version',
      {
        document: withLastCheckpoint(good.document, {
          documentVersion: good.document.version + 1
        }),
        savedRevisionId: good.savedRevisionId
      }
    ],
    [
      'is dated in the future',
      {
        document: withLastRevision(good.document, { createdAt: later }),
        savedRevisionId: good.savedRevisionId
      }
    ],
    [
      'is dated in the past',
      {
        document: withLastCheckpoint(good.document, { createdAt: earlier }),
        savedRevisionId: good.savedRevisionId
      }
    ],
    [
      'is not an ISO timestamp',
      {
        document: withLastRevision(good.document, {
          createdAt: 'Mon, 19 Oct 2026 10:00:00 GMT'
        }),
        savedRevisionId: good.savedRevisionId
      }
    ],
    [
      'repeats an earlier revision id',
      {
        document: {
          ...good.document,
          revisions: [revision, ...good.document.revisions]
        },
        savedRevisionId: good.savedRevisionId
      }
    ]
  ];
}

describe('client-minted save points (ADR-024 Phase 1)', () => {
  it('accepts the save point createSavedRevision mints', () => {
    const document = createProjectDocument('Bracket', toUserId('owner'));
    const { document: saved, savedRevisionId } = minted(document, 'Saved');
    expect(
      assertClientSavePoint(saved, {
        revisionId: savedRevisionId,
        reason: 'Saved'
      }).revisionId
    ).toBe(savedRevisionId);
  });

  it.each(
    malformedSavePoints(
      createProjectDocument('Bracket', toUserId('owner')),
      'Before machining'
    )
  )('refuses a save point that %s', (_label, request) => {
    expect(() =>
      assertClientSavePoint(request.document, {
        revisionId: request.savedRevisionId,
        reason: 'Before machining'
      })
    ).toThrow(SavePointRequestError);
  });
});

describe('browser-built projects and save points through the Worker', () => {
  async function createdProject() {
    // A legacy create names the development account the routes run as.
    const legacy = await worker.fetch(
      post('/api/projects', { name: 'Legacy create' }),
      env
    );
    expect(legacy.status).toBe(201);
    const { document: legacyDocument } =
      (await legacy.json()) as CreateProjectResponse;
    const initial = createProjectDocument(
      'Browser built',
      legacyDocument.ownerUserId,
      'inch'
    );
    const response = await worker.fetch(
      post('/api/projects', {
        name: 'Browser built',
        units: 'inch',
        initialDocument: withoutDerivedProjection(initial)
      }),
      env
    );
    expect(response.status).toBe(201);
    const created = (await response.json()) as CreateProjectResponse;
    return { initial, created };
  }

  it('stores the browser-built document under its own id', async () => {
    const { initial, created } = await createdProject();
    expect(created.document.projectId).toBe(initial.projectId);
    expect(created.document.revisions).toEqual(initial.revisions);
    expect(created.document.checkpoints).toEqual(initial.checkpoints);
    expect(created.project.projectId).toBe(initial.projectId);
  });

  it('refuses a browser-built document it would not store', async () => {
    const { initial, created } = await createdProject();
    const owner = created.document.ownerUserId;
    const cases: Array<[string, unknown, number, string]> = [
      [
        'Theirs',
        createProjectDocument('Theirs', toUserId('someone_else')),
        400,
        'SAVE_POINT_INVALID'
      ],
      [
        'Ours',
        {
          ...createProjectDocument('Ours', owner),
          projectId: 'proj_handpicked'
        },
        400,
        'SAVE_POINT_INVALID'
      ],
      [
        'Another name',
        createProjectDocument('Ours', owner),
        400,
        'SAVE_POINT_INVALID'
      ],
      [initial.name, initial, 409, 'PROJECT_ID_TAKEN']
    ];
    for (const [name, initialDocument, status, code] of cases) {
      const response = await worker.fetch(
        post('/api/projects', { name, initialDocument }),
        env
      );
      expect(response.status, name).toBe(status);
      expect(((await response.json()) as { code?: string }).code).toBe(code);
    }
  });

  it('stores a browser-minted save point and refuses its replay', async () => {
    const { created } = await createdProject();
    const edited = addPrimitiveFeature(created.document, {
      name: 'Box',
      primitiveKind: 'box',
      dimensions: { width: 1, depth: 2, height: 3 }
    });
    const save = minted(edited, 'Before machining');
    const path = `/api/projects/${created.document.projectId}/revisions`;
    const body = {
      projectId: created.document.projectId,
      reason: 'Before machining',
      expectedVersion: created.document.version,
      ...save
    };
    const response = await worker.fetch(post(path, body), env);
    expect(response.status).toBe(200);
    const stored = (await response.json()) as ProjectDocument;
    expect(stored.revisions.at(-1)).toEqual(save.document.revisions.at(-1));
    expect(stored.checkpoints.at(-1)).toEqual(save.document.checkpoints.at(-1));

    const replay = await worker.fetch(
      post(path, { ...body, expectedVersion: stored.version }),
      env
    );
    expect(replay.status).toBe(409);
    expect(((await replay.json()) as { code?: string }).code).toBe(
      'REVISION_ID_CONFLICT'
    );
  });

  it('refuses malformed browser-minted save points with a 400', async () => {
    const { created } = await createdProject();
    for (const [label, request] of malformedSavePoints(
      created.document,
      'Before machining'
    )) {
      const response = await worker.fetch(
        post(`/api/projects/${created.document.projectId}/revisions`, {
          projectId: created.document.projectId,
          reason: 'Before machining',
          expectedVersion: created.document.version,
          ...request
        }),
        env
      );
      expect(response.status, label).toBe(400);
    }
  });

  it('still mints the save point for a pre-Phase 1 client', async () => {
    const { created } = await createdProject();
    const response = await worker.fetch(
      post(`/api/projects/${created.document.projectId}/revisions`, {
        projectId: created.document.projectId,
        reason: 'Old client',
        expectedVersion: created.document.version,
        document: created.document
      }),
      env
    );
    expect(response.status).toBe(200);
    const stored = (await response.json()) as ProjectDocument;
    expect(stored.revisions).toHaveLength(
      created.document.revisions.length + 1
    );
    expect(stored.checkpoints.at(-1)?.reason).toBe('Old client');
  });
});

describe('browser-built projects and save points in D1', () => {
  async function setup() {
    const db = migratedDatabase();
    const owner = toUserId('minting_owner');
    const other = toUserId('minting_other');
    for (const userId of [owner, other]) {
      db.prepare(
        'INSERT INTO users (id, email, created_at) VALUES (?, ?, ?)'
      ).run(userId, `${userId}@example.test`, '2026-10-19T00:00:00.000Z');
    }
    const service = new D1R2PersistenceService({ DB: sqliteD1(db) });
    const initial = withoutDerivedProjection(
      createProjectDocument('Browser built', owner)
    );
    const { document } = await service.createProject(owner, {
      name: 'Browser built',
      initialDocument: initial
    });
    return { db, owner, other, service, initial, document };
  }

  it('creates under the client id, saves as sent and refuses replays', async () => {
    const fixture = await setup();
    try {
      expect(fixture.document.projectId).toBe(fixture.initial.projectId);
      expect(
        await fixture.service.loadProject(
          fixture.owner,
          fixture.initial.projectId
        )
      ).toEqual(fixture.document);
      await expect(
        fixture.service.createProject(fixture.other, {
          name: 'Browser built',
          initialDocument: { ...fixture.initial, ownerUserId: fixture.other }
        })
      ).rejects.toMatchObject({
        constructor: ProjectAdoptionError,
        code: 'PROJECT_ID_TAKEN'
      });

      const save = minted(fixture.document, 'Named');
      const stored = await fixture.service.saveRevision(fixture.owner, {
        projectId: fixture.document.projectId,
        reason: 'Named',
        expectedVersion: fixture.document.version,
        ...save
      });
      expect(stored).toEqual(save.document);
      const rows = fixture.db
        .prepare('SELECT id, reason FROM revisions WHERE project_id = ?')
        .all(fixture.document.projectId);
      expect(rows).toEqual([{ id: save.savedRevisionId, reason: 'Named' }]);
      expect(
        await fixture.service.loadRevision(
          fixture.owner,
          fixture.document.projectId,
          save.savedRevisionId
        )
      ).toEqual(save.document);

      await expect(
        fixture.service.saveRevision(fixture.owner, {
          projectId: fixture.document.projectId,
          reason: 'Named',
          expectedVersion: stored.version,
          ...save
        })
      ).rejects.toBeInstanceOf(RevisionIdCollisionError);

      // A well-formed save point on another project carrying an id that a
      // stored revision row already uses: only the store can see the replay.
      const { document: second } = await fixture.service.createProject(
        fixture.owner,
        {
          name: 'Second',
          initialDocument: withoutDerivedProjection(
            createProjectDocument('Second', fixture.owner)
          )
        }
      );
      const reused = save.savedRevisionId;
      const forged = minted(second, 'Forged').document;
      await expect(
        fixture.service.saveRevision(fixture.owner, {
          projectId: second.projectId,
          reason: 'Forged',
          expectedVersion: second.version,
          document: withLastCheckpoint(
            withLastRevision(forged, { revisionId: reused }),
            { revisionId: reused }
          ),
          savedRevisionId: reused
        })
      ).rejects.toBeInstanceOf(RevisionIdCollisionError);
      expect(
        fixture.db
          .prepare('SELECT project_id FROM revisions WHERE id = ?')
          .all(reused)
      ).toEqual([{ project_id: fixture.document.projectId }]);
    } finally {
      fixture.db.close();
    }
  });

  it.each(
    malformedSavePoints(
      createProjectDocument('Shape only', toUserId('minting_owner')),
      'Named'
    ).map(([label]) => label)
  )('refuses a save point that %s before writing', async (label) => {
    const fixture = await setup();
    try {
      const request = malformedSavePoints(fixture.document, 'Named').find(
        ([candidate]) => candidate === label
      )![1];
      await expect(
        fixture.service.saveRevision(fixture.owner, {
          projectId: fixture.document.projectId,
          reason: 'Named',
          expectedVersion: fixture.document.version,
          ...request
        })
      ).rejects.toBeInstanceOf(SavePointRequestError);
      expect(
        fixture.db
          .prepare(
            'SELECT COUNT(*) AS count FROM revisions WHERE project_id = ?'
          )
          .get(fixture.document.projectId)
      ).toEqual({ count: 0 });
    } finally {
      fixture.db.close();
    }
  });
});

describe('a kept version the browser minted', () => {
  const latest = createSavedRevision(
    addPrimitiveFeature(createProjectDocument('Room', toUserId('owner')), {
      name: 'Room box',
      primitiveKind: 'box',
      dimensions: { width: 1, depth: 1, height: 1 }
    }),
    'Room save'
  );
  const local = addPrimitiveFeature(
    { ...latest, version: latest.version - 1 },
    {
      name: 'Local box',
      primitiveKind: 'box',
      dimensions: { width: 2, depth: 2, height: 2 }
    }
  );
  const kept = createSavedRevision(
    { ...local, version: Math.max(latest.version, local.version) + 1 },
    KEPT_LOCAL_VERSION_REASON
  );
  const keptId = kept.revisions.at(-1)!.revisionId;

  it('is accepted exactly as sent', () => {
    expect(
      resolveKeptCollaborationDocument(latest, kept, latest.version, keptId)
    ).toEqual({ kind: 'accept', document: kept });
  });

  it('must move past the room version', () => {
    expect(
      resolveKeptCollaborationDocument(
        latest,
        { ...kept, version: latest.version },
        latest.version,
        keptId
      ).kind
    ).toBe('conflict');
  });

  it('is refused when its save point is malformed or replayed', () => {
    expect(
      resolveKeptCollaborationDocument(
        latest,
        withLastRevision(kept, { reason: 'Something else' }),
        latest.version,
        keptId
      ).kind
    ).toBe('invalid');
    const replayedId = latest.revisions.at(-1)!.revisionId;
    expect(
      resolveKeptCollaborationDocument(
        latest,
        withLastCheckpoint(withLastRevision(kept, { revisionId: replayedId }), {
          revisionId: replayedId
        }),
        latest.version,
        replayedId
      ).kind
    ).toBe('invalid');
  });

  it('is still minted by the room for a pre-Phase 1 client', () => {
    const resolution = resolveKeptCollaborationDocument(
      latest,
      local,
      latest.version
    );
    expect(resolution.kind).toBe('accept');
    if (resolution.kind !== 'accept') return;
    expect(resolution.document.revisions.at(-1)?.reason).toBe(
      KEPT_LOCAL_VERSION_REASON
    );
    expect(resolution.document.version).toBe(latest.version + 1);
  });
});
