import { afterEach, describe, expect, it, vi } from 'vitest';
import { createProjectDocument } from '@openzcad/document-core';
import { toProjectId, toUserId, type ProjectDocument } from '@openzcad/shared';
import {
  api,
  ApiError,
  beginEncryptCutover,
  E2EE_CUTOVER_UNRESOLVED_CODE,
  E2EE_FORMAT_MISMATCH_CODE,
  E2EE_LOCAL_ONLY_CODE,
  encryptCutoverUnresolved,
  encryptedPinProblem,
  encryptedProjectPinsUnavailable,
  isEncryptedProject,
  rememberEncryptedProject,
  rememberProjectFormats,
  resetEncryptedProjectPins,
  treatProjectAsNotEncrypted,
  type OwnerConfirmation
} from './api';
import { desktopFetch } from './desktopBridge';
import {
  ENCRYPTED_PROJECT_PIN_PREFIX,
  ENCRYPTED_PROJECT_PIN_FAILED_KEY
} from './e2ee/encryptedProjectPins';
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
      encryptedProjectShelf: vi.fn(async () => new Map()),
      copyEncryptedProject: vi.fn()
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

  it('sends nothing in plaintext when the pins cannot be read', async () => {
    const projectId = 'proj_pin_unreadable';
    await listAs(projectId, 2);

    // After a reload, storage throws on read: the pin cannot be seen.
    const real = window.localStorage;
    const unreadable = {
      getItem: () => {
        throw new Error('SecurityError');
      },
      setItem: (key: string, value: string) => real.setItem(key, value),
      removeItem: (key: string) => real.removeItem(key)
    };
    const descriptor = Object.getOwnPropertyDescriptor(window, 'localStorage');
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      get: () => unreadable
    });
    const storageOverride = {
      restore: () => {
        if (descriptor)
          Object.defineProperty(window, 'localStorage', descriptor);
        else delete (window as { localStorage?: Storage }).localStorage;
      }
    };
    try {
      vi.resetModules();
      const reloaded = await import('./api');
      const { desktopFetch: fetchAfterReload } =
        await import('./desktopBridge');
      vi.mocked(fetchAfterReload).mockResolvedValue(
        json({ projects: [summary(projectId, 1)] })
      );
      await reloaded.api.listProjects();
      vi.mocked(fetchAfterReload).mockReset();
      vi.mocked(fetchAfterReload).mockResolvedValue(json({}));
      store.saveProjectDocument.mockRejectedValue(
        new ApiError(404, 'No encrypted head')
      );

      await expect(
        reloaded.api.saveProjectDocument({
          projectId: toProjectId(projectId),
          expectedVersion: 3,
          document: documentOf(projectId)
        })
      ).rejects.toMatchObject({
        code: reloaded.E2EE_PIN_STORAGE_UNAVAILABLE_CODE
      });
      expect(reloaded.isEncryptedProject(projectId)).toBe(true);
      expect(
        vi
          .mocked(fetchAfterReload)
          .mock.calls.filter(
            ([input]) => typeof input === 'string' && input.includes(projectId)
          )
      ).toEqual([]);
    } finally {
      storageOverride.restore();
    }
  });

  it('sends nothing in plaintext after a reload when a pin could not be saved', async () => {
    const projectId = 'proj_pin_unsaved';
    const real = window.localStorage;
    const descriptor = Object.getOwnPropertyDescriptor(window, 'localStorage');
    const useStorage = (storage: unknown) =>
      Object.defineProperty(window, 'localStorage', {
        configurable: true,
        get: () => storage
      });
    const restore = () => {
      if (descriptor) Object.defineProperty(window, 'localStorage', descriptor);
      else delete (window as { localStorage?: Storage }).localStorage;
    };
    try {
      // Storage is full: the pin does not fit, the shorter failure mark does.
      useStorage({
        getItem: (key: string) => real.getItem(key),
        setItem: (key: string, value: string) => {
          if (key.startsWith(ENCRYPTED_PROJECT_PIN_PREFIX)) {
            throw new Error('QuotaExceededError');
          }
          real.setItem(key, value);
        },
        removeItem: (key: string) => real.removeItem(key)
      });
      vi.resetModules();
      const first = await import('./api');
      const { desktopFetch: firstFetch } = await import('./desktopBridge');
      vi.mocked(firstFetch).mockResolvedValue(
        json({ projects: [summary(projectId, 2)] })
      );
      await first.api.listProjects();
      expect(first.isEncryptedProject(projectId)).toBe(true);

      // Reload with room again; the account now lists it as plaintext.
      restore();
      vi.resetModules();
      const reloaded = await import('./api');
      const { desktopFetch: fetchAfterReload } =
        await import('./desktopBridge');
      vi.mocked(fetchAfterReload).mockResolvedValue(
        json({ projects: [summary(projectId, 1)] })
      );
      await reloaded.api.listProjects();
      vi.mocked(fetchAfterReload).mockReset();
      vi.mocked(fetchAfterReload).mockResolvedValue(json({}));
      store.saveProjectDocument.mockRejectedValue(
        new ApiError(404, 'No encrypted head')
      );

      expect(reloaded.isEncryptedProject(projectId)).toBe(true);
      await expect(
        reloaded.api.saveProjectDocument({
          projectId: toProjectId(projectId),
          expectedVersion: 3,
          document: documentOf(projectId)
        })
      ).rejects.toMatchObject({
        code: reloaded.E2EE_PIN_STORAGE_UNAVAILABLE_CODE
      });
      expect(
        vi
          .mocked(fetchAfterReload)
          .mock.calls.filter(
            ([input]) => typeof input === 'string' && input.includes(projectId)
          )
      ).toEqual([]);
    } finally {
      restore();
      real.removeItem(ENCRYPTED_PROJECT_PIN_FAILED_KEY);
    }
  });

  it('does not open an encrypted project whose pin cannot be saved', async () => {
    const projectId = 'proj_pin_unsavable';
    const real = window.localStorage;
    const descriptor = Object.getOwnPropertyDescriptor(window, 'localStorage');
    let refusing = false;
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      get: () => ({
        getItem: (key: string) => real.getItem(key),
        setItem: (key: string, value: string) => {
          if (refusing) throw new Error('SecurityError');
          real.setItem(key, value);
        },
        removeItem: (key: string) => real.removeItem(key)
      })
    });
    try {
      vi.resetModules();
      const page = await import('./api');
      const { desktopFetch: pageFetch } = await import('./desktopBridge');
      // Storage refuses every write, the failure key included.
      refusing = true;
      vi.mocked(pageFetch).mockResolvedValue(
        json({ projects: [summary(projectId, 2)] })
      );
      await page.api.listProjects();
      store.loadProject.mockResolvedValue(documentOf(projectId));

      await expect(page.api.loadProject(projectId)).rejects.toMatchObject({
        code: page.E2EE_PIN_STORAGE_UNAVAILABLE_CODE
      });
      expect(store.loadProject).not.toHaveBeenCalled();
    } finally {
      if (descriptor) Object.defineProperty(window, 'localStorage', descriptor);
      else delete (window as { localStorage?: Storage }).localStorage;
      real.removeItem(ENCRYPTED_PROJECT_PIN_FAILED_KEY);
    }
  });

  it('pins a project whose encrypted details it shows, whatever the listing says', async () => {
    const projectId = 'proj_pin_from_shelf';
    vi.mocked(desktopFetch).mockResolvedValue(
      json({
        projects: [summary(projectId, 1)],
        encryptedProjectInfo: [{ projectId }]
      })
    );
    encryptedModule.encryptedProjectShelf.mockResolvedValueOnce(
      new Map([[projectId, { name: 'Decrypted name' }]])
    );
    const listing = await api.listProjects();
    expect(listing.projects[0]?.name).toBe('Decrypted name');
    expect(isEncryptedProject(projectId)).toBe(true);
  });

  it('shows no encrypted details and opens no encrypted room without a saved pin', async () => {
    const projectId = 'proj_pin_shelf_unsaved';
    const real = window.localStorage;
    const descriptor = Object.getOwnPropertyDescriptor(window, 'localStorage');
    let refusing = false;
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      get: () => ({
        getItem: (key: string) => real.getItem(key),
        setItem: (key: string, value: string) => {
          if (refusing) throw new Error('SecurityError');
          real.setItem(key, value);
        },
        removeItem: (key: string) => real.removeItem(key)
      })
    });
    try {
      vi.resetModules();
      const page = await import('./api');
      const { desktopFetch: pageFetch } = await import('./desktopBridge');
      refusing = true;
      vi.mocked(pageFetch).mockResolvedValue(
        json({
          projects: [summary(projectId, 1)],
          encryptedProjectInfo: [{ projectId }]
        })
      );
      encryptedModule.encryptedProjectShelf.mockResolvedValueOnce(
        new Map([[projectId, { name: 'Decrypted name' }]])
      );
      const listing = await page.api.listProjects();
      expect(listing.projects[0]?.name).toBe('Listed');

      const { loadEncryptedRoomCodec } =
        await import('./e2ee/encryptedRoomCodec');
      await expect(loadEncryptedRoomCodec(projectId)).rejects.toMatchObject({
        code: page.E2EE_PIN_STORAGE_UNAVAILABLE_CODE
      });
    } finally {
      if (descriptor) Object.defineProperty(window, 'localStorage', descriptor);
      else delete (window as { localStorage?: Storage }).localStorage;
      real.removeItem(ENCRYPTED_PROJECT_PIN_FAILED_KEY);
    }
  });

  it('refuses an encrypted copy the account answers for under another id', async () => {
    const sourceId = 'proj_pin_copy_source';
    await listAs(sourceId, 2);
    const copy = createProjectDocument('Copy', toUserId('user_owner'));
    encryptedModule.copyEncryptedProject.mockResolvedValueOnce({
      project: summary('proj_someone_else', 2),
      document: copy
    });
    await expect(
      api.duplicateProject(sourceId, { document: copy })
    ).rejects.toMatchObject({ status: 502 });
    expect(isEncryptedProject('proj_someone_else')).toBe(false);
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

describe('a switch to encryption this device did not see finish', () => {
  it('names the unfinished switch when a write fails, and sends nothing in plaintext', async () => {
    const projectId = 'proj_pin_unresolved';
    beginEncryptCutover(projectId);
    // The cutover failed: the account still lists it as plaintext.
    await listAs(projectId, 1);
    vi.mocked(desktopFetch).mockResolvedValue(json({}));
    store.saveProjectDocument.mockRejectedValue(
      new ApiError(404, 'No encrypted head')
    );
    store.saveRevision.mockRejectedValue(
      new ApiError(404, 'No encrypted head')
    );

    const { document, revision } = await saveBoth(projectId);
    expect(document).toMatchObject({ code: E2EE_CUTOVER_UNRESOLVED_CODE });
    expect(revision).toMatchObject({ code: E2EE_CUTOVER_UNRESOLVED_CODE });
    expect(encryptedPinProblem(projectId)).toBe('unresolved');
    expect(plaintextWrites(projectId)).toEqual([]);
  });

  it('is never cleared by the account’s word, only by the owner’s confirmed reset', async () => {
    const plaintext = createProjectDocument('Stuck', toUserId('user_owner'));
    const projectId = plaintext.projectId;
    beginEncryptCutover(projectId);
    await listAs(projectId, 1);
    await listAs(projectId, 2);
    await listAs(projectId, 1);
    rememberProjectFormats([{ projectId: toProjectId(projectId) }]);
    expect(isEncryptedProject(projectId)).toBe(true);
    expect(encryptCutoverUnresolved(projectId)).toBe(true);

    // Anything short of the owner's confirmation does nothing.
    treatProjectAsNotEncrypted(projectId, {
      confirmedByOwner: false
    } as unknown as OwnerConfirmation);
    expect(isEncryptedProject(projectId)).toBe(true);
    expect(encryptCutoverUnresolved(projectId)).toBe(true);

    treatProjectAsNotEncrypted(projectId, { confirmedByOwner: true });
    expect(isEncryptedProject(projectId)).toBe(false);
    expect(encryptCutoverUnresolved(projectId)).toBe(false);
    expect(encryptedPinProblem(projectId)).toBeNull();

    // It now follows the account: plaintext, as listed.
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

  it('resets a project encrypted here but decrypted elsewhere only once confirmed', async () => {
    const projectId = 'proj_pin_decrypted_elsewhere';
    await listAs(projectId, 2);
    await listAs(projectId, 1);
    expect(encryptedPinProblem(projectId)).toBe('mismatch');
    treatProjectAsNotEncrypted(projectId, { confirmedByOwner: true });
    expect(isEncryptedProject(projectId)).toBe(false);
    expect(encryptedPinProblem(projectId)).toBeNull();
    // A later listing that reports it encrypted pins it again.
    await listAs(projectId, 2);
    expect(isEncryptedProject(projectId)).toBe(true);
  });
});

describe('resetting pins this device could not save', () => {
  it('keeps every saved pin, and the next listing pins the rest again', async () => {
    const kept = 'proj_pin_kept_on_reset';
    const lost = 'proj_pin_lost_on_reset';
    expect(rememberEncryptedProject(kept)).toBe(true);
    // Another tab could not save a pin.
    window.localStorage.setItem(ENCRYPTED_PROJECT_PIN_FAILED_KEY, '1');
    try {
      expect(encryptedProjectPinsUnavailable()).toBe(true);
      expect(isEncryptedProject(lost)).toBe(true);
      // The account's word does not end it.
      await listAs(lost, 1);
      expect(encryptedProjectPinsUnavailable()).toBe(true);
      expect(
        resetEncryptedProjectPins({
          confirmedByOwner: false
        } as unknown as OwnerConfirmation)
      ).toBe(false);
      expect(encryptedProjectPinsUnavailable()).toBe(true);

      expect(resetEncryptedProjectPins({ confirmedByOwner: true })).toBe(true);
      expect(encryptedProjectPinsUnavailable()).toBe(false);
      expect(
        window.localStorage.getItem(ENCRYPTED_PROJECT_PIN_FAILED_KEY)
      ).toBeNull();
      expect(isEncryptedProject(kept)).toBe(true);
      expect(isEncryptedProject(lost)).toBe(false);
      await listAs(lost, 2);
      expect(isEncryptedProject(lost)).toBe(true);
      expect(
        window.localStorage.getItem(ENCRYPTED_PROJECT_PIN_PREFIX + lost)
      ).not.toBeNull();
    } finally {
      window.localStorage.removeItem(ENCRYPTED_PROJECT_PIN_FAILED_KEY);
    }
  });
});
