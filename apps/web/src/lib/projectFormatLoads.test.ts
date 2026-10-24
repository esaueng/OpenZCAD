import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ENCRYPTED_PROJECTS_REQUIRED_CODE,
  PROJECT_FORMAT_UNSUPPORTED_CODE,
  toProjectId,
  type ProjectDocument
} from '@openzcad/shared';
import {
  api,
  ApiError,
  E2EE_LOCAL_ONLY_CODE,
  isEncryptedProject,
  isProjectFormatUnsupportedError
} from './api';
import { createProjectDocument } from '@openzcad/document-core';
import { desktopFetch } from './desktopBridge';
import { projectMeasurementCloudApi } from './measurementCloudSync';
import { workspaceSessionApi } from './workspaceResume';

vi.mock('./desktopBridge', () => ({
  desktopFetch: vi.fn(),
  isDesktopApp: () => false
}));

const { store, encryptedModule } = vi.hoisted(() => {
  const store = {
    createProject: vi.fn(),
    saveProjectDocument: vi.fn(),
    saveRevision: vi.fn(),
    loadProject: vi.fn(),
    loadRevision: vi.fn(),
    listRevisions: vi.fn(),
    projectName: vi.fn()
  };
  return {
    store,
    encryptedModule: {
      encryptedProjectStore: vi.fn(async () => store),
      createEncryptedProject: vi.fn(),
      encryptedProjectNames: vi.fn(async () => new Map<string, string>())
    }
  };
});
vi.mock('./e2ee/encryptedProjects', () => encryptedModule);

afterEach(() => vi.clearAllMocks());

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  });

const unsupported = () =>
  json(
    { error: 'Some older wording.', code: PROJECT_FORMAT_UNSUPPORTED_CODE },
    409
  );

const documentOf = (projectId: string) =>
  ({ projectId, name: 'Secret', version: 3 }) as unknown as ProjectDocument;

function sentPlaintextTo(path: string): boolean {
  return vi
    .mocked(desktopFetch)
    .mock.calls.some(
      ([input, init]) =>
        typeof input === 'string' &&
        input.startsWith(path) &&
        !['GET', undefined].includes(init?.method)
    );
}

/** The Worker's config and the account's stored opt-in; anything else via `rest`. */
function optIn(encrypt: boolean, rest: () => Response = () => json({}, 404)) {
  vi.mocked(desktopFetch).mockImplementation(async (input) => {
    if (input === '/api/e2ee/config') {
      return json({ enabled: true, projectsEnabled: true });
    }
    if (input === '/api/e2ee/project-preferences') {
      return json({ preference: { encryptNewProjects: encrypt } });
    }
    return rest();
  });
}

function listEncrypted(projectId: string, info?: unknown) {
  vi.mocked(desktopFetch).mockResolvedValue(
    json({
      projects: [
        {
          projectId,
          name: 'Encrypted project',
          revisionCount: 0,
          updatedAt: '2026-10-24T00:00:00.000Z',
          storageFormat: 2
        }
      ],
      ...(info ? { encryptedProjectInfo: [info] } : {})
    })
  );
  return api.listProjects();
}

/**
 * ADR-024 Phase 4, slice 4-5: this build opens encrypted (format 2)
 * projects through the encrypted store. A plaintext route that refuses a
 * project as encrypted moves a read there; writes go there only for
 * projects already known to be encrypted, so a document is never sent to
 * a plaintext route that would refuse it after receiving it.
 */
describe('dispatch on the storage format', () => {
  it.each(['project', 'revision'] as const)(
    'moves a %s read the plaintext route refuses to the encrypted store',
    async (kind) => {
      const projectId = `proj_read_${kind}`;
      vi.mocked(desktopFetch).mockResolvedValue(unsupported());
      store.loadProject.mockResolvedValue(documentOf(projectId));
      store.loadRevision.mockResolvedValue(documentOf(projectId));
      const read = () =>
        kind === 'project'
          ? api.loadProject(projectId)
          : api.loadRevision(projectId, 'rev_1');
      await expect(read()).resolves.toMatchObject({ name: 'Secret' });
      expect(isEncryptedProject(projectId)).toBe(true);
      // Known now: the next read skips the plaintext route.
      vi.mocked(desktopFetch).mockClear();
      await read();
      expect(desktopFetch).not.toHaveBeenCalled();
    }
  );

  it('keeps the update wording when the encrypted store refuses too', async () => {
    vi.mocked(desktopFetch).mockResolvedValue(unsupported());
    store.loadProject.mockRejectedValue(
      new ApiError(409, 'x', PROJECT_FORMAT_UNSUPPORTED_CODE)
    );
    const error = await api.loadProject('proj_unknown_format').then(
      () => null,
      (caught: unknown) => caught
    );
    expect(isProjectFormatUnsupportedError(error)).toBe(true);
    expect((error as Error).message).toBe(
      'This project is end-to-end encrypted. Update OpenZCAD to open it.'
    );
  });

  it('leaves other refusals as they were', async () => {
    vi.mocked(desktopFetch).mockResolvedValue(
      json({ error: 'Conflict', code: 'OTHER' }, 409)
    );
    const error = await api.loadProject('proj_x').then(
      () => null,
      (caught: unknown) => caught
    );
    expect(isProjectFormatUnsupportedError(error)).toBe(false);
    expect((error as Error).message).toBe('Conflict');
    expect(encryptedModule.encryptedProjectStore).not.toHaveBeenCalled();
  });

  it('lists encrypted projects with their decrypted names and saves them through the store', async () => {
    const projectId = 'proj_listed';
    const record = { projectId, sequence: 1 };
    encryptedModule.encryptedProjectNames.mockResolvedValue(
      new Map([[projectId, 'Gearbox']])
    );
    const listing = await listEncrypted(projectId, record);
    expect(listing.projects[0]).toMatchObject({ name: 'Gearbox' });
    expect(listing).not.toHaveProperty('encryptedProjectInfo');
    expect(encryptedModule.encryptedProjectNames).toHaveBeenCalledWith([
      record
    ]);

    vi.mocked(desktopFetch).mockClear();
    store.saveProjectDocument.mockResolvedValue({
      projectId,
      version: 4,
      updatedAt: 'now'
    });
    store.saveRevision.mockResolvedValue(documentOf(projectId));
    await api.saveProjectDocument({
      projectId: toProjectId(projectId),
      expectedVersion: 3,
      document: documentOf(projectId)
    });
    await api.saveRevision({
      projectId: toProjectId(projectId),
      reason: 'Named',
      expectedVersion: 4,
      document: documentOf(projectId)
    });
    expect(store.saveProjectDocument).toHaveBeenCalledOnce();
    expect(store.saveRevision).toHaveBeenCalledOnce();
    expect(desktopFetch).not.toHaveBeenCalled();
  });

  it('keeps the placeholder name when the names cannot be decrypted', async () => {
    encryptedModule.encryptedProjectNames.mockRejectedValue(
      new ApiError(403, 'locked', 'E2EE_KEYS_LOCKED')
    );
    const listing = await listEncrypted('proj_locked', {
      projectId: 'proj_locked'
    });
    expect(listing.projects[0]).toMatchObject({ name: 'Encrypted project' });
  });

  it('keeps an encrypted project’s files, measurements, view state and copies on the device', async () => {
    const projectId = 'proj_local_only';
    await listEncrypted(projectId);
    vi.mocked(desktopFetch).mockClear();
    const refusals: Promise<unknown>[] = [
      api.createUploadSession({
        projectId: toProjectId(projectId),
        fileName: 'thumb.webp',
        contentType: 'image/webp',
        kind: 'thumbnail'
      }),
      api.duplicateProject(projectId, { document: documentOf(projectId) }),
      projectMeasurementCloudApi.loadProjectMeasurements(projectId),
      projectMeasurementCloudApi.saveProjectMeasurements({
        projectId,
        expectedRevision: 0,
        record: {} as never
      }),
      workspaceSessionApi.load(projectId),
      workspaceSessionApi.save({ projectId } as never)
    ];
    for (const refusal of refusals) {
      await expect(refusal).rejects.toMatchObject({
        code: E2EE_LOCAL_ONLY_CODE
      });
    }
    expect(desktopFetch).not.toHaveBeenCalled();
  });

  it('creates through the encrypted store when the account encrypts new projects (D2)', async () => {
    const created = {
      project: {
        projectId: 'proj_new',
        name: 'Secret',
        revisionCount: 0,
        updatedAt: 'now',
        storageFormat: 2
      },
      document: documentOf('proj_new')
    };
    encryptedModule.createEncryptedProject.mockResolvedValue(created);
    optIn(true);
    await expect(
      api.createProject({
        name: 'Secret',
        initialDocument: createProjectDocument('Secret', 'user_1' as never)
      })
    ).resolves.toBe(created);
    expect(sentPlaintextTo('/api/projects')).toBe(false);
    expect(isEncryptedProject('proj_new')).toBe(true);

    // A Worker that refuses a plaintext create for that reason moves it too.
    optIn(false, () =>
      json({ error: 'Required', code: ENCRYPTED_PROJECTS_REQUIRED_CODE }, 409)
    );
    await expect(
      api.createProject({
        name: 'Secret',
        initialDocument: createProjectDocument('Secret', 'user_1' as never)
      })
    ).resolves.toBe(created);
    expect(encryptedModule.createEncryptedProject).toHaveBeenCalledTimes(2);
  });

  it('never sends a device project to an account that encrypts new projects', async () => {
    optIn(true);
    await expect(
      api.adoptProject(
        createProjectDocument('Device', 'user_1' as never),
        'user_1' as never
      )
    ).rejects.toMatchObject({ code: 'E2EE_ADOPTION_UNAVAILABLE' });
    expect(sentPlaintextTo('/api/projects')).toBe(false);
  });
});
