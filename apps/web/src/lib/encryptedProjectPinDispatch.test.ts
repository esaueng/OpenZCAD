import { afterEach, describe, expect, it, vi } from 'vitest';
import { createProjectDocument } from '@openzcad/document-core';
import { toProjectId, toUserId, type ProjectDocument } from '@openzcad/shared';
import {
  api,
  ApiError,
  E2EE_FORMAT_MISMATCH_CODE,
  E2EE_LOCAL_ONLY_CODE,
  isEncryptedProject
} from './api';
import { desktopFetch } from './desktopBridge';
import { createDecryptionController } from './e2ee/projectDecryption';
import type * as DecryptionEngineModule from './e2ee/projectDecryptionEngine';

vi.mock('./desktopBridge', () => ({
  desktopFetch: vi.fn(),
  isDesktopApp: () => false
}));

const { store, encryptedModule } = vi.hoisted(() => {
  const store = {
    saveProjectDocument: vi.fn(),
    saveRevision: vi.fn(),
    loadProject: vi.fn()
  };
  return {
    store,
    encryptedModule: {
      encryptedProjectStore: vi.fn(async () => store),
      encryptedProjectShelf: vi.fn(async () => new Map())
    }
  };
});
vi.mock('./e2ee/encryptedProjects', () => encryptedModule);

// The page's decrypt engine, reduced to its cutover: the controller wires
// `onCutover` exactly as it does for the real engine.
vi.mock('./e2ee/projectDecryptionEngine', async (importOriginal) => {
  const actual = await importOriginal<typeof DecryptionEngineModule>();
  return {
    ...actual,
    createProjectDecryptionEngine: (deps: {
      onCutover?(projectId: string): void;
    }) => ({
      decrypt: async (project: { projectId: string }) => {
        deps.onCutover?.(project.projectId);
      },
      cancel: async () => undefined
    })
  };
});

afterEach(() => {
  vi.clearAllMocks();
});

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  });

const documentOf = (projectId: string) =>
  ({ projectId, name: 'Secret', version: 3 }) as unknown as ProjectDocument;

function summary(projectId: string, storageFormat: 1 | 2) {
  return {
    projectId,
    name: 'Listed',
    revisionCount: 0,
    updatedAt: '2026-11-13T00:00:00.000Z',
    storageFormat
  };
}

async function listAs(projectId: string, storageFormat: 1 | 2) {
  vi.mocked(desktopFetch).mockResolvedValue(
    json({ projects: [summary(projectId, storageFormat)] })
  );
  await api.listProjects();
  vi.mocked(desktopFetch).mockReset();
}

/** Any request that carried a body, which a plaintext write always does. */
function plaintextWrites(projectId: string) {
  return vi
    .mocked(desktopFetch)
    .mock.calls.filter(
      ([input, init]) =>
        typeof input === 'string' &&
        input.includes(projectId) &&
        !['GET', undefined].includes(init?.method)
    );
}

async function saveBoth(projectId: string) {
  const document = await api
    .saveProjectDocument({
      projectId: toProjectId(projectId),
      expectedVersion: 3,
      document: documentOf(projectId)
    })
    .then(
      () => null,
      (error: unknown) => error
    );
  const revision = await api
    .saveRevision({
      projectId: toProjectId(projectId),
      reason: 'Named',
      expectedVersion: 3,
      document: documentOf(projectId)
    })
    .then(
      () => null,
      (error: unknown) => error
    );
  return { document, revision };
}

describe('an encrypted project stays encrypted on this device', () => {
  it('keeps writes on the encrypted routes when a later listing reports plaintext', async () => {
    const projectId = 'proj_pin_downgraded';
    await listAs(projectId, 2);
    await listAs(projectId, 1);
    vi.mocked(desktopFetch).mockResolvedValue(json({}));
    store.saveProjectDocument.mockResolvedValue({ projectId, version: 4 });
    store.saveRevision.mockResolvedValue(documentOf(projectId));

    expect(isEncryptedProject(projectId)).toBe(true);
    expect(await saveBoth(projectId)).toEqual({
      document: null,
      revision: null
    });
    expect(store.saveProjectDocument).toHaveBeenCalledOnce();
    expect(store.saveRevision).toHaveBeenCalledOnce();
    await expect(
      api.createUploadSession({ projectId } as never)
    ).rejects.toMatchObject({ code: E2EE_LOCAL_ONLY_CODE });
    expect(plaintextWrites(projectId)).toEqual([]);
  });

  it('names the disagreement when the encrypted route refuses, and sends nothing in plaintext', async () => {
    const projectId = 'proj_pin_refused';
    await listAs(projectId, 2);
    await listAs(projectId, 1);
    vi.mocked(desktopFetch).mockResolvedValue(json({}));
    store.saveProjectDocument.mockRejectedValue(
      new ApiError(404, 'No encrypted head')
    );
    store.saveRevision.mockRejectedValue(
      new ApiError(404, 'No encrypted head')
    );
    store.loadProject.mockRejectedValue(new ApiError(404, 'No encrypted head'));

    const { document, revision } = await saveBoth(projectId);
    expect(document).toMatchObject({ code: E2EE_FORMAT_MISMATCH_CODE });
    expect(revision).toMatchObject({ code: E2EE_FORMAT_MISMATCH_CODE });
    await expect(api.loadProject(projectId)).rejects.toMatchObject({
      code: E2EE_FORMAT_MISMATCH_CODE
    });
    expect(plaintextWrites(projectId)).toEqual([]);
    expect(desktopFetch).not.toHaveBeenCalledWith(
      `/api/projects/${projectId}`,
      expect.anything()
    );

    // A listing that agrees again clears the disagreement, not the pin.
    await listAs(projectId, 2);
    await expect(
      api.saveRevision({
        projectId: toProjectId(projectId),
        reason: 'Named',
        expectedVersion: 3,
        document: documentOf(projectId)
      })
    ).rejects.toMatchObject({ message: 'No encrypted head' });
  });

  it('pins a project a plaintext route answered is stored encrypted', async () => {
    const projectId = 'proj_pin_from_route';
    vi.mocked(desktopFetch).mockResolvedValue(
      json({ error: 'x', code: 'PROJECT_FORMAT_UNSUPPORTED' }, 409)
    );
    store.loadProject.mockResolvedValue(documentOf(projectId));
    await api.loadProject(projectId);
    expect(isEncryptedProject(projectId)).toBe(true);
    await listAs(projectId, 1);
    expect(isEncryptedProject(projectId)).toBe(true);
  });

  it('keeps the pin across a reload', async () => {
    const projectId = 'proj_pin_reloaded';
    await listAs(projectId, 2);

    vi.resetModules();
    const reloaded = await import('./api');
    const { desktopFetch: fetchAfterReload } = await import('./desktopBridge');
    expect(reloaded.isEncryptedProject(projectId)).toBe(true);

    vi.mocked(fetchAfterReload).mockResolvedValue(
      json({ projects: [summary(projectId, 1)] })
    );
    await reloaded.api.listProjects();
    vi.mocked(fetchAfterReload).mockReset();
    vi.mocked(fetchAfterReload).mockResolvedValue(json({}));
    store.saveProjectDocument.mockResolvedValue({ projectId, version: 4 });

    await reloaded.api.saveProjectDocument({
      projectId: toProjectId(projectId),
      expectedVersion: 3,
      document: documentOf(projectId)
    });
    expect(reloaded.isEncryptedProject(projectId)).toBe(true);
    expect(store.saveProjectDocument).toHaveBeenCalledOnce();
    expect(
      vi
        .mocked(fetchAfterReload)
        .mock.calls.filter(
          ([input]) => typeof input === 'string' && input.includes(projectId)
        )
    ).toEqual([]);
  });

  it('is unpinned by this device’s own decrypt run', async () => {
    const plaintext = createProjectDocument(
      'Decrypted',
      toUserId('user_owner')
    );
    const projectId = plaintext.projectId;
    await listAs(projectId, 2);
    const controller = createDecryptionController({
      userId: 'user_owner',
      locks: null,
      migrations: {
        status: async () => ({ migration: null })
      } as never,
      listProjects: async () => [summary(projectId, 2)] as never,
      openReaders: async () => ({ deviceId: 'device_1', readers: {} as never })
    });
    await controller.refresh();
    expect(isEncryptedProject(projectId)).toBe(true);

    await controller.run(projectId);
    expect(isEncryptedProject(projectId)).toBe(false);

    vi.mocked(desktopFetch).mockResolvedValue(
      json({ projectId, version: 4, updatedAt: 'now' })
    );
    await api.saveProjectDocument({
      projectId,
      expectedVersion: plaintext.version,
      document: plaintext
    });
    expect(store.saveProjectDocument).not.toHaveBeenCalled();
    expect(plaintextWrites(projectId)).toHaveLength(1);
  });
});
