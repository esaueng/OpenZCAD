import { describe, expect, it, vi } from 'vitest';
import {
  createPersistenceService,
  CLOUDFLARE_BOOLEAN_FLAGS,
  D1R2PersistenceService,
  E2eeRoomLedger,
  isCloudflareFeatureEnabled,
  isE2eeDefaultOn,
  isE2eeKeysEnabled,
  isE2eeProjectsEnabled,
  isE2eeMigrationEnabled,
  isE2eeReverseEnabled,
  MAX_E2EE_ROOM_RETAINED,
  orderE2eeSubmission,
  projectCollaborationRollout,
  resolveCollaborationDocument,
  type CloudflareEnv
} from '@openzcad/cloudflare-adapters';
import {
  createEncryptedRoom,
  fakeE2eeAccount,
  submission
} from './support/e2ee-room-fakes';
import {
  MAX_PROJECT_REVISION_RECORDS,
  toArtifactId,
  toProjectId,
  toUploadSessionId,
  toUserId
} from '@openzcad/shared';
import {
  addPrimitiveFeature,
  createProjectDocument,
  mergeCollaborationDocuments
} from '@openzcad/document-core';
import { CommandManager, commandFactories } from '@openzcad/command-system';
import { RevisionConflictError } from '@openzcad/persistence';
import type { ProjectDocument } from '@openzcad/shared';
import {
  createRoomContext,
  createTestRoom,
  settleRoom,
  storedValueBytes
} from './collaboration-room-harness';
import {
  D1_MAX_BOUND_PARAMETERS,
  migratedDatabase,
  sqliteD1
} from './support/sqlite-d1';

/** SQLite-backed Durable Object storage refuses a value over 2 MiB. */
const DURABLE_VALUE_LIMIT_BYTES = 2 * 1024 * 1024;

function roomRequest(
  document: ProjectDocument,
  body: Record<string, unknown>
): Request {
  return new Request(`https://room.test/?projectId=${document.projectId}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-openzcad-user-id': 'user_room',
      'x-openzcad-display-name': 'Room user',
      'x-openzcad-project-role': 'owner'
    },
    body: JSON.stringify(body)
  });
}

/**
 * The first statement a call prepared, past the once-per-isolate schema
 * probe for migration 0031's storage-format column (ADR-024 Phase 4).
 */
function firstQuery(prepare: { mock: { calls: unknown[][] } }): string {
  return prepare.mock.calls
    .map((call) => String(call[0]))
    .filter((query) => !query.includes("pragma_table_info('projects')"))[0]!;
}

describe('cloudflare adapters', () => {
  it('matches E2EE canaries as complete normalized emails across dependent gates', () => {
    const env = {
      E2EE_KEYS_ENABLED: 'false',
      E2EE_PROJECTS_ENABLED: 'true',
      E2EE_MIGRATION_ENABLED: 'true',
      E2EE_REVERSE_ENABLED: 'true',
      E2EE_CANARY_EMAILS: ' canary@example.com, second@example.net '
    };
    const gates = [
      isE2eeKeysEnabled,
      isE2eeProjectsEnabled,
      isE2eeMigrationEnabled,
      isE2eeReverseEnabled
    ];
    for (const email of [
      'canary@example.com',
      ' CANARY@EXAMPLE.COM ',
      'Second@Example.net'
    ]) {
      for (const gate of gates) expect(gate(env, email)).toBe(true);
      expect(isE2eeDefaultOn({ ...env, E2EE_DEFAULT_ON: 'true' }, email)).toBe(
        true
      );
    }
    for (const email of [
      undefined,
      '',
      'canary',
      'xcanary@example.com',
      'canary@example.com.evil',
      'canary+tag@example.com',
      'canary@sub.example.com',
      'canary@example.net',
      'second@example.net.evil'
    ]) {
      for (const gate of gates) expect(gate(env, email), email).toBe(false);
      expect(
        isE2eeDefaultOn({ ...env, E2EE_DEFAULT_ON: 'true' }, email),
        email
      ).toBe(false);
    }
  });
  it('keeps typed feature flags off unless explicitly enabled', () => {
    expect(CLOUDFLARE_BOOLEAN_FLAGS).toEqual([
      'AI_DEPLOYMENT_FREE_ENABLED',
      'DESKTOP_AUTH_ENABLED',
      'PROJECT_SHARING_ENABLED',
      'PROJECT_EDIT_LEASES_ENFORCED',
      'PROJECT_PERSONAL_SYNC_ENABLED',
      'E2EE_KEYS_ENABLED',
      'E2EE_PROJECTS_ENABLED',
      'E2EE_MIGRATION_ENABLED',
      'E2EE_REVERSE_ENABLED',
      'E2EE_DEFAULT_ON',
      'E2EE_PLAINTEXT_FROZEN',
      'AI_PATCH_DIRECT_EDIT_ENABLED',
      'AI_PATCH_GROWING_HOLDER_ENABLED',
      'AI_PATCH_HOLE_CONTROL_ENABLED',
      'AI_PATCH_FACE_SKETCH_ENABLED',
      'AI_PATCH_MULTI_PROFILE_EXTRUDE_ENABLED',
      'AI_PATCH_MIRROR_ENABLED',
      'AI_PATCH_SHELL_ENABLED',
      'AI_PATCH_SOLID_OFFSET_ENABLED',
      'AI_PATCH_DATUM_PLANE_ENABLED',
      'AI_PATCH_DATUM_GEOMETRY_ENABLED',
      'AI_PATCH_PARTIAL_REVOLVE_ENABLED'
    ]);
    expect(isCloudflareFeatureEnabled({}, 'PROJECT_SHARING_ENABLED')).toBe(
      false
    );
    expect(
      isCloudflareFeatureEnabled(
        { PROJECT_SHARING_ENABLED: 'definitely' },
        'PROJECT_SHARING_ENABLED'
      )
    ).toBe(false);
    for (const value of ['1', 'true', 'TRUE', ' yes ', 'on']) {
      expect(
        isCloudflareFeatureEnabled(
          { PROJECT_SHARING_ENABLED: value },
          'PROJECT_SHARING_ENABLED'
        )
      ).toBe(true);
    }
    for (const value of ['', '0', 'false', 'no', 'off']) {
      expect(
        isCloudflareFeatureEnabled(
          { PROJECT_SHARING_ENABLED: value },
          'PROJECT_SHARING_ENABLED'
        )
      ).toBe(false);
    }
  });

  it('makes encryption the default only with E2EE_DEFAULT_ON and migration open (ADR-024 8-1)', () => {
    const open = {
      E2EE_KEYS_ENABLED: 'true',
      E2EE_PROJECTS_ENABLED: 'true',
      E2EE_MIGRATION_ENABLED: 'true',
      E2EE_REVERSE_ENABLED: 'true'
    };
    expect(isE2eeDefaultOn(open, 'a@example.com')).toBe(false);
    expect(isE2eeReverseEnabled(open, 'a@example.com')).toBe(true);
    const on = { ...open, E2EE_DEFAULT_ON: 'true' };
    expect(isE2eeDefaultOn(on, 'a@example.com')).toBe(true);
    // Default-on closes the reverse path, as if its flag were off.
    expect(isE2eeReverseEnabled(on, 'a@example.com')).toBe(false);
    // Each dependency missing keeps it off, and the reverse path as it was.
    for (const missing of [
      'E2EE_KEYS_ENABLED',
      'E2EE_PROJECTS_ENABLED',
      'E2EE_MIGRATION_ENABLED'
    ] as const) {
      const env = { ...on, [missing]: 'false' };
      expect(isE2eeDefaultOn(env, 'a@example.com'), missing).toBe(false);
      expect(isE2eeReverseEnabled(env, 'a@example.com'), missing).toBe(false);
    }
    // The key canary scopes it like the other E2EE gates.
    const canary = {
      ...on,
      E2EE_KEYS_ENABLED: 'false',
      E2EE_CANARY_EMAILS: 'canary@example.com'
    };
    expect(isE2eeDefaultOn(canary, 'Canary@example.com')).toBe(true);
    expect(isE2eeDefaultOn(canary, 'other@example.com')).toBe(false);
    expect(isE2eeDefaultOn(canary)).toBe(false);
  });

  it('resolves collaboration canaries by normalized authenticated email', () => {
    const canaryEnv = {
      PROJECT_SHARING_ENABLED: 'false',
      PROJECT_EDIT_LEASES_ENFORCED: 'false',
      PROJECT_PERSONAL_SYNC_ENABLED: 'false',
      PROJECT_COLLABORATION_CANARY_EMAILS:
        ' owner@example.com, Second@Example.com '
    };

    expect(projectCollaborationRollout(canaryEnv, 'OWNER@example.com')).toEqual(
      {
        sharingEnabled: true,
        editLeasesEnforced: true,
        personalSyncEnabled: true,
        canary: true
      }
    );
    expect(projectCollaborationRollout(canaryEnv, 'other@example.com')).toEqual(
      {
        sharingEnabled: false,
        editLeasesEnforced: false,
        personalSyncEnabled: false,
        canary: false
      }
    );
    expect(
      projectCollaborationRollout(
        { PROJECT_EDIT_LEASES_ENFORCED: 'true' },
        'other@example.com'
      ).editLeasesEnforced
    ).toBe(true);
  });

  it('opens collaboration globally without requiring an email allowlist', () => {
    expect(
      projectCollaborationRollout(
        {
          PROJECT_SHARING_ENABLED: 'true',
          PROJECT_EDIT_LEASES_ENFORCED: 'true',
          PROJECT_PERSONAL_SYNC_ENABLED: 'true'
        },
        'anyone@example.com'
      )
    ).toEqual({
      sharingEnabled: true,
      editLeasesEnforced: true,
      personalSyncEnabled: true,
      canary: false
    });
  });

  it('falls back to in-memory persistence when D1 is absent', async () => {
    const service = createPersistenceService({ ENVIRONMENT: 'beta' });
    const created = await service.createProject(toUserId('user_test'), {
      name: 'CF Test'
    });
    const listed = await service.listProjects(toUserId('user_test'));

    expect(created.project.name).toBe('CF Test');
    expect(
      listed.projects.some(
        (project) => project.projectId === created.project.projectId
      )
    ).toBe(true);
  });

  it("requires an owner's sharing preference for member project access", async () => {
    const prepare = vi.fn((query: string) => ({
      bind: vi.fn(() => ({
        first: vi.fn(async () => {
          // The storage-format schema probe answers "not installed".
          if (query.includes('pragma_table_info')) return null;
          expect(query).toContain('LEFT JOIN user_settings owner_settings');
          expect(query).toContain("'$.collaboration.enabled'");
          expect(query).toContain("WHEN p.status = 'deleted' THEN NULL");
          return null;
        })
      }))
    }));
    const service = new D1R2PersistenceService({
      DB: { prepare } as unknown as D1Database,
      PROJECT_SHARING_ENABLED: 'true'
    });

    await expect(
      service.requireProjectRead(
        toUserId('user_member'),
        'project_disabled_by_owner'
      )
    ).rejects.toMatchObject({ name: 'ProjectNotFoundError' });
  });

  it("requires an owner's sharing preference when accepting invitations", async () => {
    const batch = vi.fn();
    const prepare = vi.fn((query: string) => ({
      bind: vi.fn(() => ({
        first: vi.fn(async () => {
          // The storage-format schema probe answers "not installed".
          if (query.includes('pragma_table_info')) return null;
          expect(query).toContain('LEFT JOIN user_settings owner_settings');
          expect(query).toContain("'$.collaboration.enabled'");
          expect(query).toContain("p.status != 'deleted'");
          return null;
        })
      }))
    }));
    const service = new D1R2PersistenceService({
      DB: { prepare, batch } as unknown as D1Database,
      PROJECT_SHARING_ENABLED: 'true'
    });

    await expect(
      service.acceptProjectInvitation(
        toUserId('user_invitee'),
        'invitee@example.com',
        'token-hash',
        1_800_000_000
      )
    ).rejects.toMatchObject({ code: 'INVITATION_NOT_FOUND' });
    expect(batch).not.toHaveBeenCalled();
  });

  it('rechecks trash status when an invitation is accepted', async () => {
    const statements: string[] = [];
    const prepare = vi.fn((query: string) => ({
      sql: query,
      bind: () => ({
        sql: query,
        first: async () =>
          query.includes('FROM project_invitations i')
            ? {
                id: 'invite_trash_race',
                project_id: 'project_trash_race',
                role: 'viewer',
                owner_user_id: 'user_owner'
              }
            : { count: 0 }
      })
    }));
    const batch = vi.fn(async (prepared: Array<{ sql: string }>) => {
      statements.push(...prepared.map((statement) => statement.sql));
      return [{ meta: { changes: 0 } }];
    });
    const service = new D1R2PersistenceService({
      DB: { prepare, batch } as unknown as D1Database,
      PROJECT_SHARING_ENABLED: 'true'
    });

    await expect(
      service.acceptProjectInvitation(
        toUserId('user_invitee'),
        'invitee@example.com',
        'token-hash',
        1_800_000_000
      )
    ).rejects.toMatchObject({ code: 'INVITATION_NOT_FOUND' });
    expect(firstQuery(prepare)).toContain("p.status != 'deleted'");
    expect(statements[0]).toContain("p.status != 'deleted'");
  });

  it('rejects stale R2 saves before writing project objects', async () => {
    const userId = toUserId('user_stale_save');
    const document = createProjectDocument('Stale save', userId);
    const put = vi.fn();
    const prepare = vi.fn((query: string) => ({
      bind: () => ({
        all: async () => {
          expect(query).toContain('FROM project_copy_source_archives');
          return { results: [] };
        },
        first: async () => {
          if (query.includes('user_id AS owner_user_id')) {
            return { owner_user_id: userId };
          }
          if (query.includes('SELECT document_version')) {
            return { document_version: document.version + 1 };
          }
          return null;
        }
      })
    }));
    const service = new D1R2PersistenceService({
      DB: { prepare } as unknown as D1Database,
      PROJECT_STORAGE: {
        put,
        get: vi.fn(),
        delete: vi.fn()
      } as unknown as R2Bucket
    });

    await expect(
      service.saveDocument(userId, {
        projectId: document.projectId,
        expectedVersion: document.version,
        document
      })
    ).rejects.toMatchObject({ currentVersion: document.version + 1 });
    expect(put).not.toHaveBeenCalled();
  });

  it('streams artifact downloads from object storage instead of buffering them', async () => {
    const userId = toUserId('user_stream_owner');
    const artifactRow = {
      id: 'artifact_stream',
      project_id: 'project_stream',
      kind: 'step-import',
      name: 'part.step',
      object_key: 'project_stream/uploads/abc123-part.step',
      content_type: 'model/step',
      bytes: 9,
      metadata_json: '{}',
      created_at: '2026-01-01T00:00:00.000Z'
    };
    const prepare = vi.fn((query: string) => ({
      bind: () => ({
        first: async () => {
          if (query.includes('FROM artifacts')) {
            return artifactRow;
          }
          if (query.includes('owner_user_id')) {
            return { owner_user_id: userId };
          }
          return null;
        }
      })
    }));
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('STEP DATA'));
        controller.close();
      }
    });
    // A regression here turns a multi-hundred-MB artifact into Worker memory.
    const arrayBuffer = vi.fn(async () => {
      throw new Error('download must stream, not buffer');
    });
    const service = new D1R2PersistenceService({
      DB: { prepare } as unknown as D1Database,
      ARTIFACTS: {
        get: vi.fn(async () => ({ size: 9, body, arrayBuffer }))
      } as unknown as R2Bucket
    });

    const download = await service.downloadArtifact(userId, 'artifact_stream');

    expect(download?.artifact.artifactId).toBe('artifact_stream');
    expect(download?.body).toBe(body);
    expect(arrayBuffer).not.toHaveBeenCalled();
    expect(await new Response(download!.body).text()).toBe('STEP DATA');
  });

  it('deletes unreferenced content-addressed assets when a save loses the version race', async () => {
    const userId = toUserId('user_conflict_assets');
    const manager = new CommandManager(
      createProjectDocument('Conflict import', userId)
    );
    manager.execute(
      commandFactories.importStep({
        name: 'Bracket STEP',
        artifactId: 'artifact_conflict_step',
        sourceName: 'bracket.step',
        stepText: 'ISO-10303-21;\nDATA;\nENDSEC;\nEND-ISO-10303-21;'
      })
    );
    const document = manager.document;
    const deleted: string[] = [];
    const bucket = {
      put: vi.fn(async (_key: string) => undefined),
      get: vi.fn(),
      head: vi.fn(async () => null),
      delete: vi.fn(async (key: string) => {
        deleted.push(key);
      })
    };
    const prepare = vi.fn((query: string) => ({
      bind: () => ({
        first: async () => {
          if (query.includes('owner_user_id')) {
            return { owner_user_id: userId };
          }
          if (query.includes('AS current_document_object_id')) {
            return {
              current_document_object_id: null,
              current_document_version: document.version,
              object_state: 'pending',
              project_references: 0,
              revision_references: 0
            };
          }
          if (query.includes('SELECT document_version')) {
            return { document_version: document.version };
          }
          return null;
        },
        run: async () => ({}),
        all: async () => ({ results: [] })
      })
    }));
    // The projects UPDATE (statement index 1) reports zero changed rows: a
    // concurrent writer won the version fence after this write uploaded its
    // objects.
    const batch = vi.fn(async (statements: unknown[]) =>
      statements.map((_, index) => ({
        meta: { changes: index === 1 ? 0 : 1 }
      }))
    );
    const service = new D1R2PersistenceService({
      DB: { prepare, batch } as unknown as D1Database,
      PROJECT_STORAGE: bucket as unknown as R2Bucket
    });

    await expect(
      service.saveDocument(userId, {
        projectId: document.projectId,
        expectedVersion: document.version,
        document
      })
    ).rejects.toMatchObject({ currentVersion: document.version });

    const putKeys = bucket.put.mock.calls.map(([key]) => key);
    expect(putKeys.some((key) => key.includes('/assets/'))).toBe(true);
    expect(deleted.filter((key) => key.includes('/assets/'))).toHaveLength(1);
    expect(deleted.some((key) => key.includes('/documents/'))).toBe(true);
  });

  it.each(['continuous save', 'manual revision', 'project creation'] as const)(
    'keeps an R2 document when D1 commits a %s before its response fails',
    async (operation) => {
      const userId = toUserId(
        `user_ambiguous_${operation.replaceAll(' ', '_')}`
      );
      const original = createProjectDocument('Ambiguous commit', userId);
      const bodies = new Map<string, ArrayBuffer>();
      const bucket = {
        put: vi.fn(async (key: string, body: ArrayBuffer) => {
          bodies.set(key, body.slice(0));
        }),
        get: vi.fn(async (key: string) => {
          const body = bodies.get(key);
          return body
            ? {
                arrayBuffer: async () => body.slice(0)
              }
            : null;
        }),
        head: vi.fn(async () => null),
        delete: vi.fn(async (key: string) => {
          bodies.delete(key);
        })
      };
      let project: {
        id: string;
        userId: string;
        objectId: string;
        version: number;
      } | null =
        operation === 'project creation'
          ? null
          : {
              id: original.projectId,
              userId,
              objectId: 'project_object_previous',
              version: original.version
            };
      let object: {
        id: string;
        projectId: string;
        objectKey: string;
        checksumSha256: string;
        logicalBytes: number;
        contentEncoding: string;
        state: string;
      } | null = null;

      const prepare = vi.fn((query: string) => {
        let values: unknown[] = [];
        const statement = {
          query,
          get values() {
            return values;
          },
          bind(...next: unknown[]) {
            values = next;
            return statement;
          },
          async first() {
            if (query.includes('user_id AS owner_user_id')) {
              return project ? { owner_user_id: project.userId } : null;
            }
            if (query.includes('AS current_document_object_id')) {
              return {
                current_document_object_id: project?.objectId ?? null,
                current_document_version: project?.version ?? null,
                object_state:
                  object && project?.objectId === object.id
                    ? object.state
                    : null,
                project_references:
                  object && project?.objectId === object.id ? 1 : 0,
                revision_references: 0
              };
            }
            if (
              query.includes('FROM project_document_objects') &&
              query.includes("state = 'committed'")
            ) {
              return object
                ? {
                    object_key: object.objectKey,
                    checksum_sha256: object.checksumSha256,
                    logical_bytes: object.logicalBytes,
                    content_encoding: object.contentEncoding
                  }
                : null;
            }
            if (query.includes('SELECT document_version')) {
              return project ? { document_version: project.version } : null;
            }
            if (query.includes('project_storage_assets')) {
              return null;
            }
            return null;
          },
          async run() {
            return { meta: { changes: 0 } };
          },
          async all() {
            return { results: [] };
          }
        };
        return statement;
      });

      const batch = vi.fn(
        async (
          statements: Array<{ query: string; values: readonly unknown[] }>
        ) => {
          for (const statement of statements) {
            if (
              statement.query.includes('INSERT INTO project_document_objects')
            ) {
              object = {
                id: String(statement.values[0]),
                projectId: String(statement.values[1]),
                objectKey: String(statement.values[2]),
                checksumSha256: String(statement.values[3]),
                logicalBytes: Number(statement.values[4]),
                contentEncoding: String(statement.values[6]),
                state: 'committed'
              };
            } else if (statement.query.includes('UPDATE projects')) {
              project = {
                id: String(statement.values[8]),
                userId: String(statement.values[9]),
                objectId: String(statement.values[1]),
                version: Number(statement.values[2])
              };
            } else if (statement.query.includes('INSERT INTO projects')) {
              project = {
                id: String(statement.values[0]),
                userId: String(statement.values[1]),
                objectId: String(statement.values[4]),
                version: Number(statement.values[5])
              };
            }
          }
          throw new Error('D1 response lost after commit');
        }
      );
      const service = new D1R2PersistenceService({
        DB: { prepare, batch } as unknown as D1Database,
        PROJECT_STORAGE: bucket as unknown as R2Bucket
      });

      if (operation === 'continuous save') {
        await expect(
          service.saveDocument(userId, {
            projectId: original.projectId,
            expectedVersion: original.version,
            document: original
          })
        ).resolves.toMatchObject({
          projectId: original.projectId,
          version: original.version
        });
      } else if (operation === 'manual revision') {
        await expect(
          service.saveRevision(userId, {
            projectId: original.projectId,
            expectedVersion: original.version,
            reason: 'Manual save',
            document: original
          })
        ).resolves.toMatchObject({ projectId: original.projectId });
      } else {
        await expect(
          service.createProject(userId, { name: 'Ambiguous creation' })
        ).resolves.toMatchObject({
          project: { name: 'Ambiguous creation' }
        });
      }

      expect(bucket.delete).not.toHaveBeenCalled();
      expect(object).not.toBeNull();
      expect(bodies.has(object!.objectKey)).toBe(true);
    }
  );

  it('retains an uploaded document when the D1 outcome cannot be verified', async () => {
    const userId = toUserId('user_unknown_save_outcome');
    const document = createProjectDocument('Unknown save outcome', userId);
    const bucket = {
      put: vi.fn(async () => undefined),
      get: vi.fn(),
      delete: vi.fn()
    };
    const prepare = vi.fn((query: string) => ({
      bind: () => ({
        all: async () => {
          expect(query).toContain('FROM project_copy_source_archives');
          return { results: [] };
        },
        first: async () => {
          if (query.includes('user_id AS owner_user_id')) {
            return { owner_user_id: userId };
          }
          if (query.includes('AS current_document_object_id')) {
            throw new Error('D1 verification unavailable');
          }
          if (query.includes('SELECT document_version')) {
            return { document_version: document.version };
          }
          return null;
        }
      })
    }));
    const service = new D1R2PersistenceService({
      DB: {
        prepare,
        batch: vi.fn(async () => {
          throw new Error('D1 response lost');
        })
      } as unknown as D1Database,
      PROJECT_STORAGE: bucket as unknown as R2Bucket
    });

    await expect(
      service.saveDocument(userId, {
        projectId: document.projectId,
        expectedVersion: document.version,
        document
      })
    ).rejects.toMatchObject({ name: 'ProjectObjectStorageError' });
    expect(bucket.put).toHaveBeenCalled();
    expect(bucket.delete).not.toHaveBeenCalled();
  });

  it('skips a corrupt D1 project row without hiding valid projects', async () => {
    const document = createProjectDocument(
      'Valid D1 project',
      toUserId('user_test')
    );
    const rows = [
      {
        id: document.projectId,
        name: document.name,
        updated_at: document.derived.updatedAt,
        document_json: JSON.stringify(document)
      },
      {
        id: 'project_poisoned',
        name: 'Poisoned',
        updated_at: document.derived.updatedAt,
        document_json: '{not-json'
      }
    ];
    const all = vi.fn(async () => ({ results: rows }));
    // first() answers the storage-format schema probe: not installed.
    const bind = vi.fn(() => ({ all, first: async () => null }));
    const prepare = vi.fn(() => ({ bind }));
    const consoleError = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    const service = new D1R2PersistenceService({
      DB: { prepare } as unknown as D1Database
    });

    await expect(service.listProjects(toUserId('user_test'))).resolves.toEqual({
      projects: [
        expect.objectContaining({
          projectId: document.projectId,
          name: document.name
        })
      ]
    });
    expect(consoleError).toHaveBeenCalledWith('Skipping corrupt project row.');
    expect(JSON.stringify(consoleError.mock.calls)).not.toContain(
      'project_poisoned'
    );
  });

  it('reads shelf state out of the D1 project row', async () => {
    const document = createProjectDocument('Shelved', toUserId('user_test'));
    const all = vi.fn(async () => ({
      results: [
        {
          id: document.projectId,
          name: document.name,
          updated_at: document.derived.updatedAt,
          document_json: JSON.stringify(document),
          status: 'deleted',
          pinned: 1,
          sort_order: 4,
          deleted_at: '2026-01-01T00:00:00.000Z',
          archived_at: null,
          thumbnail_artifact_id: 'artifact_thumbnail'
        }
      ]
    }));
    const prepare = vi.fn((_query: string) => ({
      // first() answers the storage-format schema probe: not installed.
      bind: () => ({ all, first: async () => null })
    }));
    const service = new D1R2PersistenceService({
      DB: { prepare } as unknown as D1Database,
      PROJECT_SHARING_ENABLED: 'true'
    });

    const listed = await service.listProjects(toUserId('user_test'));
    expect(listed.projects[0]?.organization).toEqual({
      status: 'deleted',
      pinned: true,
      sortOrder: 4,
      deletedAt: '2026-01-01T00:00:00.000Z'
    });
    expect(listed.projects[0]?.thumbnailArtifactId).toBe('artifact_thumbnail');
    // Pinned-first, then manual order: the ordering has to come from SQL,
    // because the list is not re-sorted after it is read.
    expect(firstQuery(prepare)).toContain(
      'ORDER BY p.pinned DESC, p.sort_order ASC, p.updated_at DESC'
    );
    expect(firstQuery(prepare)).toContain('project_members');
    expect(firstQuery(prepare)).toContain("p.status != 'deleted'");
  });

  it('replaces a finalized D1 thumbnail and deletes its superseded object', async () => {
    const owner = toUserId('user_thumbnail_owner');
    const projectId = toProjectId('project_thumbnail');
    const artifactId = toArtifactId('artifact_thumbnail_new');
    const uploadSessionId = toUploadSessionId('upload_thumbnail_new');
    const queries: string[] = [];
    const batch = vi.fn(async () =>
      Array.from({ length: 4 }, () => ({ meta: { changes: 1 } }))
    );
    const prepare = vi.fn((query: string) => ({
      bind: (..._values: unknown[]) => {
        queries.push(query);
        return {
          run: async () => ({ success: true, meta: { changes: 1 } }),
          first: async () => {
            if (query.includes('SELECT user_id AS owner_user_id')) {
              return { owner_user_id: owner };
            }
            if (query.includes('FROM upload_sessions WHERE id = ?')) {
              return {
                id: uploadSessionId,
                artifact_id: artifactId,
                object_key: 'project_thumbnail/uploads/new.webp',
                project_id: projectId,
                file_name: 'thumbnail.webp',
                content_type: 'image/webp',
                kind: 'thumbnail',
                metadata_json: '{}',
                expires_at: '2099-01-01T00:00:00.000Z',
                owner_user_id: owner,
                reserved_bytes: 123,
                reservation_state: 'completed',
                multipart_upload_id: 'r2_thumbnail',
                single_part: 1,
                upload_protocol_version: 1,
                completion_started_at: null
              };
            }
            return null;
          },
          all: async () => ({
            results: query.includes('SELECT object_key FROM artifacts')
              ? [{ object_key: 'project_thumbnail/uploads/old.webp' }]
              : []
          })
        };
      }
    }));
    const deleteObject = vi.fn().mockResolvedValue(undefined);
    const service = new D1R2PersistenceService({
      DB: { prepare, batch } as unknown as D1Database,
      ARTIFACTS: {
        head: vi.fn().mockResolvedValue({ size: 123 }),
        delete: deleteObject
      } as unknown as R2Bucket
    });

    await expect(
      service.finalizeArtifact(owner, {
        projectId,
        uploadSessionId,
        artifactId
      })
    ).resolves.toMatchObject({ artifactId, kind: 'thumbnail', bytes: 123 });
    expect(
      queries.some(
        (query) =>
          query.includes('DELETE FROM artifacts') &&
          query.includes("WHERE project_id = ? AND kind = 'thumbnail'")
      )
    ).toBe(true);
    expect(batch).toHaveBeenCalledTimes(1);
    expect(deleteObject).toHaveBeenCalledWith(
      'project_thumbnail/uploads/old.webp'
    );
  });

  it('duplicates from D1 without requiring disabled sharing schema', async () => {
    const userId = toUserId('user_duplicate_owner');
    const source = createProjectDocument('Bracket', userId);
    const queries: string[] = [];
    const run = vi.fn(async () => ({ success: true }));
    const prepare = vi.fn((query: string) => {
      queries.push(query);
      if (query.includes('project_members')) {
        throw new Error('no such table: project_members');
      }
      return {
        bind: (..._bindings: unknown[]) => ({
          all: async () => {
            if (query.includes('SELECT name FROM projects')) {
              return { results: [{ name: source.name }] };
            }
            return {
              results: [
                {
                  id: source.projectId,
                  name: source.name,
                  updated_at: source.derived.updatedAt,
                  document_json: JSON.stringify(source),
                  status: 'active',
                  pinned: 0,
                  sort_order: 7,
                  deleted_at: null,
                  archived_at: null
                }
              ]
            };
          },
          first: async () => {
            if (query.includes('SELECT user_id AS owner_user_id')) {
              return { owner_user_id: userId };
            }
            if (
              query.includes(
                'SELECT document_json, document_object_id FROM projects'
              )
            ) {
              return {
                document_json: JSON.stringify(source),
                document_object_id: null
              };
            }
            if (query.includes('SELECT sort_order FROM projects')) {
              return { sort_order: 7 };
            }
            return null;
          },
          run
        })
      };
    });
    const service = new D1R2PersistenceService({
      DB: { prepare } as unknown as D1Database,
      PROJECT_SHARING_ENABLED: 'false'
    });

    await expect(service.listProjects(userId)).resolves.toMatchObject({
      projects: [{ projectId: source.projectId, name: 'Bracket' }]
    });
    const copy = await service.duplicateProject(userId, {
      projectId: source.projectId
    });

    expect(copy.project.projectId).not.toBe(source.projectId);
    expect(copy.project.name).toBe('Bracket (copy)');
    expect(copy.document.ownerUserId).toBe(userId);
    expect(queries).not.toContainEqual(
      expect.stringContaining('project_members')
    );
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('stores an adopted project under its device edit time, not the sync time', async () => {
    const userId = toUserId('user_adopt_owner');
    const source: ProjectDocument = {
      ...createProjectDocument('Bracket', userId),
      derived: {
        bodyRepresentations: {},
        exportableBodyIds: [],
        warnings: [],
        updatedAt: '2026-01-01T00:00:00.000Z'
      }
    };
    const inserts: unknown[][] = [];
    const prepare = vi.fn((query: string) => ({
      bind: (...bindings: unknown[]) => ({
        first: async () => null,
        run: async () => {
          if (query.includes('INSERT INTO projects')) {
            inserts.push(bindings);
          }
          return { success: true };
        }
      })
    }));
    const service = new D1R2PersistenceService({
      DB: {
        prepare,
        batch: async (statements: { run(): Promise<unknown> }[]) =>
          Promise.all(statements.map((statement) => statement.run()))
      } as unknown as D1Database
    });

    const created = await service.createProject(userId, {
      name: source.name,
      document: source
    });

    expect(created.project.updatedAt).toBe('2026-01-01T00:00:00.000Z');
    expect(created.document.derived.updatedAt).toBe('2026-01-01T00:00:00.000Z');
    expect(inserts).toHaveLength(1);
    expect(inserts[0]).toContain('2026-01-01T00:00:00.000Z');
  });

  it('destroys a purged project together with everything hanging off it', async () => {
    const statements: string[] = [];
    const all = vi.fn(async () => ({ results: [{ id: 'proj_expired' }] }));
    const batch = vi.fn(async () => []);
    const prepare = vi.fn((query: string) => {
      statements.push(query);
      // first() answers the schema probes for later tables: not installed.
      return {
        bind: () => ({
          all,
          query,
          first: async () => null,
          run: async () => ({ success: true })
        })
      };
    });
    const roomFetch = vi.fn(
      async (_request: Request) => new Response(null, { status: 204 })
    );
    const getByName = vi.fn(() => ({ fetch: roomFetch }));
    const service = new D1R2PersistenceService({
      DB: { prepare, batch } as unknown as D1Database,
      PROJECT_ROOM: {
        getByName
      } as unknown as CloudflareEnv['PROJECT_ROOM']
    });

    expect(await service.purgeExpiredProjects(toUserId('user_test'))).toEqual([
      'proj_expired'
    ]);
    expect(statements[0]).toContain("status = 'deleted'");
    const destroyed = statements.slice(1).join('\n');
    for (const table of [
      'project_access_events',
      'project_invitations',
      'project_members',
      'upload_sessions',
      'artifacts',
      'project_measurements',
      'revisions',
      'projects'
    ]) {
      expect(destroyed).toContain(`DELETE FROM ${table}`);
    }
    expect(batch).toHaveBeenCalledTimes(1);
    // The project's collaboration room is erased too: its Durable Object
    // storage holds the latest document and snapshot history, which the
    // D1/R2 sweeps above never reach.
    expect(getByName).toHaveBeenCalledWith('proj_expired');
    expect(roomFetch).toHaveBeenCalledTimes(1);
    const eraseRequest = roomFetch.mock.calls[0]![0];
    expect(eraseRequest.method).toBe('DELETE');
    expect(
      eraseRequest.headers.get('x-openzcad-internal-project-erasure')
    ).toBe('v1');
    expect(new URL(eraseRequest.url).searchParams.get('projectId')).toBe(
      'proj_expired'
    );
  });

  it('keeps project rows retryable when room erasure fails', async () => {
    const batch = vi.fn(async () => []);
    const prepare = vi.fn((query: string) => ({
      bind: () => ({
        run: async () => ({ success: true }),
        first: async () => null,
        all: async () => ({
          results: query.includes('SELECT object_key')
            ? []
            : [{ id: 'proj_expired' }]
        })
      })
    }));
    const service = new D1R2PersistenceService({
      DB: { prepare, batch } as unknown as D1Database,
      PROJECT_ROOM: {
        getByName: () => ({
          fetch: async () => new Response('nope', { status: 500 })
        })
      } as unknown as CloudflareEnv['PROJECT_ROOM']
    });

    await expect(
      service.purgeExpiredProjects(toUserId('user_test'))
    ).rejects.toThrow('room erasure failed');
    expect(batch).not.toHaveBeenCalled();
  });

  it('keeps project rows retryable when R2 deletion fails', async () => {
    const batch = vi.fn(async () => []);
    const deleteObject = vi.fn(async () => {
      throw new Error('R2 unavailable');
    });
    const prepare = vi.fn((query: string) => ({
      bind: () => ({
        run: async () => ({ success: true }),
        first: async () => null,
        all: async () => ({
          results: query.includes('SELECT object_key')
            ? [{ object_key: 'proj_expired/source.step' }]
            : [{ id: 'proj_expired' }]
        })
      })
    }));
    const service = new D1R2PersistenceService({
      DB: { prepare, batch } as unknown as D1Database,
      ARTIFACTS: { delete: deleteObject } as unknown as R2Bucket
    });

    await expect(
      service.purgeExpiredProjects(toUserId('user_test'))
    ).rejects.toThrow('R2 unavailable');
    expect(batch).not.toHaveBeenCalled();
  });

  it.each([
    ['document objects', true],
    ['inline JSON', false]
  ] as const)(
    'commits only one of two interleaved saves from the same version (%s)',
    async (_storage, objectStorage) => {
      const owner = toUserId('user_cas_owner');
      const db = migratedDatabase();
      db.prepare(
        `INSERT INTO users (id, email, created_at) VALUES (?, ?, ?)`
      ).run(owner, 'owner@example.com', '2026-01-01T00:00:00.000Z');
      const objects = new Map<string, ArrayBuffer>();
      // Hold each document upload until both saves have made one, so both
      // pass the version precheck before either commits: only the UPDATE's
      // `document_version = ?` predicate is left to refuse the loser.
      let gated = false;
      let uploads = 0;
      let releaseUploads!: () => void;
      const bothUploading = new Promise<void>((resolve) => {
        releaseUploads = resolve;
      });
      const bucket = {
        put: async (key: string, body: ArrayBuffer) => {
          objects.set(key, body);
          if (!gated) return null;
          uploads += 1;
          if (uploads === 2) releaseUploads();
          if (uploads <= 2) await bothUploading;
          return null;
        },
        get: async (key: string) => {
          const body = objects.get(key);
          return body ? { arrayBuffer: async () => body.slice(0) } : null;
        },
        delete: async (key: string) => {
          objects.delete(key);
        }
      } as unknown as R2Bucket;
      const service = new D1R2PersistenceService({
        DB: sqliteD1(db),
        ...(objectStorage ? { ARTIFACTS: bucket } : {})
      });
      const created = await service.createProject(owner, { name: 'CAS' });
      gated = true;
      const edit = (name: string) => {
        const manager = new CommandManager(created.document, owner);
        manager.execute(
          commandFactories.addPrimitive({
            name,
            primitiveKind: 'box',
            dimensions: { width: 1, height: 1, depth: 1 }
          })
        );
        return manager.document;
      };
      const first = edit('From tab A');
      const second = edit('From tab B');
      expect(first.version).toBe(second.version);

      const outcomes = await Promise.allSettled(
        [first, second].map((document) =>
          service.saveDocument(owner, {
            projectId: created.document.projectId,
            expectedVersion: created.document.version,
            document
          })
        )
      );

      const saved = outcomes.filter(
        (outcome) => outcome.status === 'fulfilled'
      );
      const refused = outcomes.filter(
        (outcome) => outcome.status === 'rejected'
      );
      expect(saved).toHaveLength(1);
      expect(refused).toHaveLength(1);
      expect((refused[0] as PromiseRejectedResult).reason).toBeInstanceOf(
        RevisionConflictError
      );
      const winner = outcomes[0]!.status === 'fulfilled' ? first : second;
      const stored = await service.loadProject(
        owner,
        created.document.projectId
      );
      expect(stored?.version).toBe(winner.version);
      expect(
        Object.values(stored!.nodes)
          .filter((node) => node.kind === 'feature')
          .map((node) => node.name)
      ).toEqual(
        Object.values(winner.nodes)
          .filter((node) => node.kind === 'feature')
          .map((node) => node.name)
      );
    }
  );

  it.each([50, 51, 100])(
    'purges %i expired projects within D1 bound-parameter limit',
    async (count) => {
      const owner = toUserId('user_purge_owner');
      const db = migratedDatabase();
      db.prepare(
        `INSERT INTO users (id, email, created_at) VALUES (?, ?, ?)`
      ).run(owner, 'owner@example.com', '2026-01-01T00:00:00.000Z');
      const expired = new Date(Date.now() - 40 * 86_400_000).toISOString();
      for (let index = 0; index < count; index += 1) {
        db.prepare(
          `INSERT INTO projects (id, user_id, name, document_json, updated_at, status, deleted_at)
           VALUES (?, ?, ?, '{}', ?, 'deleted', ?)`
        ).run(`proj_trash_${index}`, owner, `Old ${index}`, expired, expired);
      }
      let widest = 0;
      const service = new D1R2PersistenceService({
        DB: sqliteD1(db, {
          onStatement: (_sql, bindings) => {
            widest = Math.max(widest, bindings.length);
          }
        }),
        // A bucket makes the purge sweep artifacts, document objects and
        // storage assets — the object-key UNION binds the id list twice.
        ARTIFACTS: {
          get: async () => null,
          put: async () => null,
          delete: async () => undefined,
          list: async () => ({ objects: [], truncated: false })
        } as unknown as R2Bucket
      });

      // 51 used to bind 102 parameters in one statement. D1 refused it, and
      // the same rows were selected again on every project listing.
      await expect(service.purgeExpiredProjects(owner)).resolves.toHaveLength(
        count
      );
      expect(widest).toBeLessThanOrEqual(D1_MAX_BOUND_PARAMETERS);
      expect(
        db
          .prepare(
            'SELECT COUNT(*) AS remaining FROM projects WHERE user_id = ?'
          )
          .get(owner)
      ).toEqual({ remaining: 0 });
    }
  );

  it('accepts newer collaboration documents and rejects divergent peers', () => {
    const base = createProjectDocument('Room', toUserId('user_room'));
    const first = addPrimitiveFeature(base, {
      name: 'A',
      primitiveKind: 'box',
      dimensions: { width: 1, height: 1, depth: 1 }
    });
    const divergent = addPrimitiveFeature(base, {
      name: 'B',
      primitiveKind: 'sphere',
      dimensions: { radius: 1 }
    });
    const newer = addPrimitiveFeature(first, {
      name: 'C',
      primitiveKind: 'cylinder',
      dimensions: { radius: 1, height: 2 }
    });

    expect(resolveCollaborationDocument(null, first).kind).toBe('accept');
    expect(resolveCollaborationDocument(first, newer).kind).toBe('accept');
    expect(resolveCollaborationDocument(first, first).kind).toBe('same');
    expect(resolveCollaborationDocument(first, divergent).kind).toBe(
      'conflict'
    );
    // The room never merges (ADR-024 Phase 1): a stale submission is a
    // conflict carrying its base, which the browser merges and resubmits.
    const stale = resolveCollaborationDocument(first, divergent, base);
    expect(stale).toEqual({ kind: 'conflict', document: first, base });
    const merged = mergeCollaborationDocuments(base, first, divergent)!;
    expect(merged.version).toBe(Math.max(first.version, divergent.version) + 1);
    expect(merged.featureOrder).toHaveLength(2);
    expect(merged.bodyOrder).toHaveLength(2);
    expect(resolveCollaborationDocument(first, merged, first)).toEqual({
      kind: 'accept',
      document: merged
    });
  });

  it('rejects a future-schema collaboration snapshot before normalization', async () => {
    const { context } = createRoomContext();
    const base = createProjectDocument('Future Room', toUserId('user_room'));
    const future = {
      ...base,
      schemaVersion: 999
    } as unknown as ProjectDocument;
    const room = createTestRoom(context, {});

    const response = await room.fetch(
      roomRequest(future, {
        clientId: 'client_future',
        document: future,
        baseVersion: null
      })
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      type: 'error',
      code: 'document-invalid'
    });
  });

  it('rejects a collaboration snapshot with more revisions than browsers keep', async () => {
    const { context } = createRoomContext();
    const base = createProjectDocument('Long Room', toUserId('user_room'));
    const record = base.revisions[0]!;
    const oversized = {
      ...base,
      // Stored unread, a longer list than the newest 500 every browser keeps
      // would fail every other editor's lineage check.
      revisions: Array.from(
        { length: MAX_PROJECT_REVISION_RECORDS + 1 },
        (_, index) => ({ ...record, revisionId: `rev_long_${index}` })
      )
    } as unknown as ProjectDocument;
    const room = createTestRoom(context, {});

    const response = await room.fetch(
      roomRequest(oversized, {
        clientId: 'client_long',
        document: oversized,
        baseVersion: null
      })
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      type: 'error',
      code: 'document-invalid'
    });
  });

  it.each(['derived', 'assets'] as const)(
    'rejects a collaboration snapshot without its %s',
    async (field) => {
      const { context } = createRoomContext();
      const base = createProjectDocument('Bare Room', toUserId('user_room'));
      const bare: Record<string, unknown> = { ...base };
      delete bare[field];
      const document = bare as unknown as ProjectDocument;
      const room = createTestRoom(context, {});

      const response = await room.fetch(
        roomRequest(document, {
          clientId: 'client_bare',
          document,
          baseVersion: null
        })
      );

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({
        type: 'error',
        code: 'document-invalid'
      });
    }
  );

  it('accepts undo and redo as forward collaboration revisions', () => {
    const manager = new CommandManager(
      createProjectDocument('Undo Room', toUserId('user_room'))
    );
    const added = manager.execute(
      commandFactories.addPrimitive({
        name: 'A',
        primitiveKind: 'box',
        dimensions: { width: 1, height: 1, depth: 1 }
      })
    );
    const undone = manager.undo();
    const redone = manager.redo();

    expect(undone.version).toBeGreaterThan(added.version);
    expect(redone.version).toBeGreaterThan(undone.version);
    expect(resolveCollaborationDocument(added, undone).kind).toBe('accept');
    expect(resolveCollaborationDocument(undone, redone).kind).toBe('accept');
  });

  it('restores the latest collaboration document from durable storage', async () => {
    const { context } = createRoomContext();
    const base = createProjectDocument('Durable Room', toUserId('user_room'));
    const first = addPrimitiveFeature(base, {
      name: 'A',
      primitiveKind: 'box',
      dimensions: { width: 1, height: 1, depth: 1 }
    });
    const divergent = addPrimitiveFeature(base, {
      name: 'B',
      primitiveKind: 'sphere',
      dimensions: { radius: 1 }
    });
    const request = (document: typeof first) =>
      roomRequest(document, { clientId: 'client_test', document });

    const original = createTestRoom(context, {});
    expect((await original.fetch(request(first))).status).toBe(200);

    const restored = createTestRoom(context, {});
    const conflict = await restored.fetch(request(divergent));
    expect(conflict.status).toBe(409);
    await expect(conflict.json()).resolves.toMatchObject({
      type: 'conflict',
      document: { version: first.version }
    });
  });

  it('returns the base with a stale conflict and accepts the browser merge', async () => {
    const { context } = createRoomContext();
    const base = createProjectDocument('Race Room', toUserId('user_room'));
    // Two clients edit disjoint parts of the same base at the same time.
    const fromA = addPrimitiveFeature(base, {
      name: 'A',
      primitiveKind: 'box',
      dimensions: { width: 1, height: 1, depth: 1 }
    });
    const fromB = addPrimitiveFeature(base, {
      name: 'B',
      primitiveKind: 'sphere',
      dimensions: { radius: 1 }
    });
    const submit = (
      clientId: string,
      document: typeof fromA,
      baseVersion: number | null
    ) => roomRequest(document, { clientId, document, baseVersion });

    const room = createTestRoom(context, {});

    // Both clients join on the shared base first; this is what puts the common
    // ancestor into room history so a three-way merge is possible at all.
    expect((await room.fetch(submit('client_a', base, null))).status).toBe(200);

    // A lands first and is stored verbatim, so it needs no document echoed back.
    const ackA = (await (
      await room.fetch(submit('client_a', fromA, base.version))
    ).json()) as { type: string; version: number; document?: typeof fromA };
    expect(ackA.type).toBe('ack');
    expect(ackA.document).toBeUndefined();

    // B is behind. The room does not merge: it refuses with its latest
    // document and B's base, and stores nothing.
    const staleB = await room.fetch(submit('client_b', fromB, base.version));
    expect(staleB.status).toBe(409);
    const conflict = (await staleB.json()) as {
      type: string;
      document: ProjectDocument;
      base?: ProjectDocument;
    };
    expect(conflict).toMatchObject({
      type: 'conflict',
      document: { version: fromA.version },
      base: { version: base.version }
    });

    // B merges in the browser and resubmits on the room's latest version.
    const merged = mergeCollaborationDocuments(
      conflict.base!,
      conflict.document,
      fromB
    )!;
    expect(merged.version).toBe(Math.max(fromA.version, fromB.version) + 1);
    expect(merged.featureOrder).toHaveLength(2);
    expect(merged.bodyOrder).toHaveLength(2);
    const ackB = (await (
      await room.fetch(submit('client_b', merged, fromA.version))
    ).json()) as { type: string; version: number; document?: typeof fromA };
    // B already holds the merged document, so nothing is echoed back.
    expect(ackB).toEqual({ type: 'ack', version: merged.version });

    const restored = createTestRoom(context, {});
    const ackC = (await (
      await restored.fetch(submit('client_b', merged, merged.version))
    ).json()) as { type: string; version: number; document?: typeof fromA };
    expect(ackC.type).toBe('ack');
    expect(ackC.document).toBeUndefined();
  });

  it('keeps every stored value under the durable-storage limit', async () => {
    const { context, values } = createRoomContext();
    const base = createProjectDocument('Heavy Room', toUserId('user_room'));
    // ~1 MB of document. Under the old layout the room wrote latest plus its
    // whole history into one value, so a handful of these blew past 2 MiB.
    const heavy = addPrimitiveFeature(base, {
      name: 'Heavy',
      primitiveKind: 'box',
      dimensions: { width: 1, height: 1, depth: 1 }
    });
    heavy.nodes[heavy.rootNodeId]!.metadata = {
      padding: 'H'.repeat(1_000_000)
    };
    const at = (version: number): ProjectDocument => ({
      ...structuredClone(heavy),
      version
    });

    const room = createTestRoom(context, {});
    for (let offset = 0; offset < 4; offset += 1) {
      const document = at(heavy.version + offset);
      const response = await room.fetch(
        roomRequest(document, {
          clientId: 'client_heavy',
          document,
          baseVersion: null
        })
      );
      expect(response.status).toBe(200);
    }

    const sizes = storedValueBytes(values);
    const total = Array.from(sizes.values()).reduce(
      (sum, bytes) => sum + bytes,
      0
    );
    // The room now holds more than one value could ever have carried...
    expect(total).toBeGreaterThan(DURABLE_VALUE_LIMIT_BYTES);
    // ...yet no individual key is anywhere near the per-value ceiling.
    for (const [key, bytes] of sizes) {
      expect(bytes, `${key} is ${bytes} bytes`).toBeLessThan(
        DURABLE_VALUE_LIMIT_BYTES
      );
    }
    expect(values.has('room:latest')).toBe(true);
    expect(
      Array.from(values.keys()).filter((key) => key.startsWith('room:history:'))
        .length
    ).toBeGreaterThan(0);
  });

  it('refuses an unstorable document without moving room state', async () => {
    const { context, values } = createRoomContext();
    const base = createProjectDocument('Overflow Room', toUserId('user_room'));
    const accepted = addPrimitiveFeature(base, {
      name: 'Keeper',
      primitiveKind: 'box',
      dimensions: { width: 1, height: 1, depth: 1 }
    });
    const room = createTestRoom(context, {});
    expect(
      (
        await room.fetch(
          roomRequest(accepted, {
            clientId: 'client_ok',
            document: accepted,
            baseVersion: null
          })
        )
      ).status
    ).toBe(200);

    // Past what one durable value holds, but under the HTTP body ceiling.
    const oversize = addPrimitiveFeature(accepted, {
      name: 'X'.repeat(1_550_000),
      primitiveKind: 'sphere',
      dimensions: { radius: 1 }
    });
    const rejected = await room.fetch(
      roomRequest(oversize, {
        clientId: 'client_big',
        document: oversize,
        baseVersion: null
      })
    );
    expect(rejected.status).toBe(413);
    await expect(rejected.json()).resolves.toMatchObject({
      type: 'error',
      code: 'document-too-large'
    });

    // The rejection has to happen before any mutation, or the room serves a
    // document that storage never took and reverts on the next eviction.
    expect((values.get('room:latest') as ProjectDocument).version).toBe(
      accepted.version
    );
    const restored = createTestRoom(context, {});
    const state = await restored.fetch(
      roomRequest(accepted, {
        clientId: 'client_ok',
        document: accepted,
        baseVersion: null
      })
    );
    await expect(state.json()).resolves.toMatchObject({
      type: 'ack',
      version: accepted.version
    });
  });

  it('rejects an over-long snapshot body before parsing it', async () => {
    const { context } = createRoomContext();
    const base = createProjectDocument('Flood Room', toUserId('user_room'));
    const room = createTestRoom(context, {});
    const response = await room.fetch(
      roomRequest(base, {
        clientId: 'client_flood',
        padding: 'p'.repeat(1_700_000),
        document: base
      })
    );
    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toMatchObject({
      type: 'error',
      code: 'document-too-large'
    });
  });

  it.each([
    ['without content-length', undefined],
    ['with an underreported content-length', '1']
  ])('counts streamed snapshot bytes %s', async (_label, contentLength) => {
    const { context } = createRoomContext();
    const base = createProjectDocument(
      'Stream Flood Room',
      toUserId('user_room')
    );
    const room = createTestRoom(context, {});
    const chunk = new TextEncoder().encode('😀'.repeat(250_000));
    let pulls = 0;
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        if (pulls > 3) {
          controller.close();
          return;
        }
        controller.enqueue(chunk);
      },
      cancel() {
        cancelled = true;
      }
    });
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'x-openzcad-user-id': 'user_room',
      'x-openzcad-display-name': 'Room user',
      'x-openzcad-project-role': 'owner'
    };
    if (contentLength !== undefined) {
      headers['content-length'] = contentLength;
    }
    const request = new Request(
      `https://room.test/?projectId=${base.projectId}`,
      {
        method: 'POST',
        headers,
        body,
        duplex: 'half'
      } as RequestInit & { duplex: 'half' }
    );
    expect(request.headers.get('content-length')).toBe(contentLength ?? null);

    const response = await room.fetch(request);

    expect(response.status).toBe(413);
    // The stream queues one chunk ahead, but cancellation prevents the final
    // pull that request.text() would need in order to reach EOF.
    expect(pulls).toBe(3);
    expect(cancelled).toBe(true);
    await expect(response.json()).resolves.toMatchObject({
      type: 'error',
      code: 'document-too-large'
    });
  });

  it('migrates a legacy single-value room into per-document keys', async () => {
    const base = createProjectDocument('Legacy Room', toUserId('user_room'));
    const first = addPrimitiveFeature(base, {
      name: 'A',
      primitiveKind: 'box',
      dimensions: { width: 1, height: 1, depth: 1 }
    });
    const divergent = addPrimitiveFeature(base, {
      name: 'B',
      primitiveKind: 'sphere',
      dimensions: { radius: 1 }
    });
    const values = new Map<string, unknown>([
      [
        'room-state',
        {
          projectId: base.projectId,
          latestDocument: first,
          history: [base, first]
        }
      ]
    ]);
    const { context } = createRoomContext(values);

    const room = createTestRoom(context, {});
    await settleRoom(room);

    expect(values.has('room-state')).toBe(false);
    expect(values.get('room:meta')).toMatchObject({
      projectId: base.projectId,
      latestVersion: first.version,
      historyVersions: [base.version, first.version]
    });
    expect((values.get('room:latest') as ProjectDocument).version).toBe(
      first.version
    );
    expect(values.has(`room:history:${base.version}`)).toBe(true);

    // The migrated history still serves as the merge ancestor the room hands
    // a stale browser, which is the only reason to carry it across at all.
    const conflict = (await (
      await room.fetch(
        roomRequest(divergent, {
          clientId: 'client_legacy',
          document: divergent,
          baseVersion: base.version
        })
      )
    ).json()) as { type: string; base?: ProjectDocument };
    expect(conflict.type).toBe('conflict');
    expect(conflict.base).toEqual(base);
  });

  it('leaves a migrated room alone when the legacy key reappears', async () => {
    const base = createProjectDocument('Stale Room', toUserId('user_room'));
    const current = addPrimitiveFeature(base, {
      name: 'Current',
      primitiveKind: 'box',
      dimensions: { width: 1, height: 1, depth: 1 }
    });
    const values = new Map<string, unknown>([
      ['room-state', { projectId: base.projectId, latestDocument: base }],
      [
        'room:meta',
        {
          schema: 1,
          projectId: base.projectId,
          latestVersion: current.version,
          historyVersions: []
        }
      ],
      ['room:latest', current]
    ]);
    const { context } = createRoomContext(values);

    const room = createTestRoom(context, {});
    await settleRoom(room);

    expect(values.has('room-state')).toBe(false);
    // The split layout wins; the stale legacy value must not roll the room back.
    expect((values.get('room:latest') as ProjectDocument).version).toBe(
      current.version
    );
    const conflict = await room.fetch(
      roomRequest(base, {
        clientId: 'client_stale',
        document: addPrimitiveFeature(base, {
          name: 'Other',
          primitiveKind: 'sphere',
          dimensions: { radius: 1 }
        })
      })
    );
    expect(conflict.status).toBe(409);
  });

  it('drops the oldest history entries instead of growing without bound', async () => {
    const { context, values } = createRoomContext();
    const base = createProjectDocument('Long Room', toUserId('user_room'));
    let document = addPrimitiveFeature(base, {
      name: 'Seed',
      primitiveKind: 'box',
      dimensions: { width: 1, height: 1, depth: 1 }
    });
    const room = createTestRoom(context, {});
    for (let step = 0; step < 30; step += 1) {
      const next: ProjectDocument = {
        ...document,
        version: document.version + 1
      };
      await room.fetch(
        roomRequest(next, {
          clientId: 'client_long',
          document: next,
          baseVersion: null
        })
      );
      document = next;
    }

    const historyKeys = Array.from(values.keys()).filter((key) =>
      key.startsWith('room:history:')
    );
    expect(historyKeys.length).toBeLessThanOrEqual(20);
    const meta = values.get('room:meta') as { historyVersions: number[] };
    // Every version the index advertises must still have its key, or a restart
    // loses the ancestor a merge was going to use.
    for (const version of meta.historyVersions) {
      expect(values.has(`room:history:${version}`)).toBe(true);
    }
    expect(meta.historyVersions).toHaveLength(historyKeys.length);
  });
});

// --- End-to-end encrypted projects (ADR-024 slice 4-9) ---------------------

describe('encrypted collaboration room ordering (ADR-024 slice 4-9)', () => {
  const PROJECT = 'proj_encrypted_http';

  function encryptedPost(body: unknown, headers: Record<string, string> = {}) {
    return new Request(`https://room.test/?projectId=${PROJECT}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-openzcad-user-id': 'user_room',
        'x-openzcad-display-name': 'Room user',
        'x-openzcad-project-role': 'owner',
        'x-openzcad-project-format': '2',
        'x-openzcad-write-credential': `desktop_access_tokens:${'b'.repeat(64)}`,
        ...headers
      },
      body: JSON.stringify(body)
    });
  }

  it('names a checkpoint through the encrypted revision path', async () => {
    const stored = vi.spyOn(
      D1R2PersistenceService.prototype,
      'storeCollaborationCheckpoint'
    );
    try {
      const { context } = createRoomContext();
      const account = fakeE2eeAccount(PROJECT);
      const room = createEncryptedRoom(context, account);
      const first = account.headRecord;
      const response = await room.fetch(
        encryptedPost({
          clientId: 'client_laptop',
          revisionId: 'rev_named',
          version: submission({
            projectId: PROJECT,
            documentVersion: 2,
            keyEpoch: 0,
            previousVersionHash: first.versionHash,
            body: 'named'
          })
        })
      );
      expect(response.status).toBe(200);
      const named = account.headRecord;
      expect(await response.json()).toEqual({
        type: 'e2ee-ack',
        record: named
      });
      expect(account.writes).toEqual([
        {
          userId: 'user_room',
          credential: {
            table: 'desktop_access_tokens',
            tokenHash: 'b'.repeat(64)
          },
          expectedVersion: 1,
          revisionId: 'rev_named',
          versionHash: named.versionHash
        }
      ]);
      expect(stored).not.toHaveBeenCalled();

      // A stale named save is a conflict carrying its base, never a write.
      const stale = await room.fetch(
        encryptedPost({
          clientId: 'client_desktop',
          revisionId: 'rev_stale',
          version: submission({
            projectId: PROJECT,
            documentVersion: 2,
            keyEpoch: 0,
            previousVersionHash: first.versionHash,
            body: 'stale named'
          })
        })
      );
      expect(stale.status).toBe(409);
      expect(await stale.json()).toMatchObject({
        type: 'e2ee-conflict',
        latest: { record: named },
        base: { record: first }
      });
      expect(account.writes).toHaveLength(1);
      expect(stored).not.toHaveBeenCalled();
    } finally {
      stored.mockRestore();
    }
  });

  it('refuses plaintext snapshots to an encrypted room and envelopes to a plaintext one', async () => {
    const account = fakeE2eeAccount(PROJECT);
    const encrypted = createEncryptedRoom(createRoomContext().context, account);
    await encrypted.fetch(
      encryptedPost({
        clientId: 'client_laptop',
        version: submission({
          projectId: PROJECT,
          documentVersion: 2,
          keyEpoch: 0,
          previousVersionHash: account.headRecord.versionHash,
          body: 'second'
        })
      })
    );
    const document = {
      ...createProjectDocument('Leak', toUserId('user_room')),
      projectId: PROJECT
    } as ProjectDocument;
    const plaintext = await encrypted.fetch(
      roomRequest(document, { clientId: 'client_old', document })
    );
    expect(plaintext.status).toBe(409);
    expect(await plaintext.json()).toMatchObject({ code: 'format-mismatch' });

    const { context, values } = createRoomContext();
    const plain = createEncryptedRoom(context, account);
    expect(
      (
        await plain.fetch(
          roomRequest(document, { clientId: 'client_plain', document })
        )
      ).status
    ).toBe(200);
    const envelope = await plain.fetch(
      encryptedPost({
        clientId: 'client_laptop',
        version: submission({
          projectId: PROJECT,
          documentVersion: 2,
          keyEpoch: 0,
          previousVersionHash: account.headRecord.versionHash,
          body: 'into plaintext'
        })
      })
    );
    expect(envelope.status).toBe(409);
    expect(values.get('room:meta')).not.toHaveProperty('format');
    expect(account.writes).toHaveLength(1);
  });

  it('orders by previous-version hash, version and key epoch', () => {
    const latest = {
      documentVersion: 4,
      keyEpoch: 2,
      versionHash: '4'.repeat(64),
      prefix: '',
      signature: '',
      signerUserId: 'user_room',
      signerDeviceId: 'device',
      createdAt: '',
      wrappedVersionKey: '',
      envelopeBytes: 1
    };
    const retained = ['3'.repeat(64)];
    const order = (
      submission: Partial<Parameters<typeof orderE2eeSubmission>[4]>
    ) =>
      orderE2eeSubmission(PROJECT, latest, 2, retained, {
        projectId: PROJECT,
        kind: 'document',
        documentVersion: 5,
        keyEpoch: 2,
        previousVersionHash: latest.versionHash,
        versionHash: '5'.repeat(64),
        ...submission
      });
    expect(order({})).toEqual({ kind: 'advance' });
    expect(order({ versionHash: latest.versionHash })).toEqual({
      kind: 'same'
    });
    expect(
      order({ previousVersionHash: '3'.repeat(64), documentVersion: 99 })
    ).toEqual({
      kind: 'conflict',
      baseHash: '3'.repeat(64)
    });
    expect(order({ previousVersionHash: null })).toEqual({
      kind: 'conflict',
      baseHash: null
    });
    expect(order({ keyEpoch: 1 })).toEqual({ kind: 'epoch-stale' });
    expect(order({ keyEpoch: 3 }).kind).toBe('invalid');
    expect(order({ documentVersion: 4 }).kind).toBe('invalid');
    expect(order({ projectId: 'proj_other' }).kind).toBe('invalid');
    expect(order({ kind: 'project-info' }).kind).toBe('invalid');
  });

  it('keeps a bounded set of merge bases under their own keys', async () => {
    const values = new Map<string, unknown>();
    const ledger = new E2eeRoomLedger({
      get: async (key) => values.get(key) as never,
      put: async (entries) => {
        for (const [key, value] of Object.entries(entries))
          values.set(key, value);
      },
      delete: async (keys) => {
        for (const key of keys) values.delete(key);
        return keys.length;
      }
    });
    await ledger.load();
    const hashes: string[] = [];
    for (let version = 1; version <= MAX_E2EE_ROOM_RETAINED + 5; version++) {
      const hash = version.toString(16).padStart(64, '0');
      hashes.push(hash);
      await ledger.advance({
        record: {
          documentVersion: version,
          keyEpoch: 0,
          versionHash: hash,
          prefix: '',
          signature: '',
          signerUserId: null,
          signerDeviceId: 'device',
          createdAt: '',
          wrappedVersionKey: '',
          envelopeBytes: 1
        },
        envelope: new Uint8Array([version])
      });
    }
    expect(ledger.retained).toEqual(hashes.slice(4, -1));
    expect(ledger.latest?.record.versionHash).toBe(hashes.at(-1));
    const keys = [...values.keys()].filter((key) =>
      key.startsWith('room:e2ee:v:')
    );
    expect(keys).toHaveLength(MAX_E2EE_ROOM_RETAINED + 1);
    expect(await ledger.version(hashes[0]!)).toBeNull();
    expect((await ledger.version(hashes[4]!))?.envelope).toEqual(
      new Uint8Array([5])
    );
    // A restarted room reads the same ledger back.
    const again = new E2eeRoomLedger({
      get: async (key) => values.get(key) as never,
      put: async () => {},
      delete: async () => 0
    });
    await again.load();
    expect(again.latest?.record.versionHash).toBe(hashes.at(-1));
    expect(again.retained).toEqual(ledger.retained);
  });
});
