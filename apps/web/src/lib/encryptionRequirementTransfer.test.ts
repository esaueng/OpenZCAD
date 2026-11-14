/**
 * Review round 10 of PR #1418: an encryption requirement known for a
 * source project must travel with its content whenever that content moves
 * under a new or different project id (`carryEncryptionRequirement`), and
 * be enforced at the send for the destination. These reproduce the two
 * paths that lost it: an adoption the account redirected
 * (`ALREADY_ADOPTED`) and a device copy made when the account did not
 * answer for the source.
 */
import 'fake-indexeddb/auto';
import { Blob as NodeBlob } from 'node:buffer';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CommandManager, commandFactories } from '@openzcad/command-system';
import {
  createProjectDocument,
  duplicateProjectDocument,
  reidentifyProjectDocument
} from '@openzcad/document-core';
import { toProjectId, toUserId, type ProjectDocument } from '@openzcad/shared';
import {
  api,
  ApiError,
  carryEncryptionRequirement,
  E2EE_PLAINTEXT_REFUSED_CODE,
  encryptionRequired,
  isEncryptedProject,
  rememberEncryptedProject
} from './api';
import {
  loadLocalProject,
  saveLastSyncedVersion,
  saveLocalProject
} from './localProjectStore';
import {
  adoptLocalProject,
  type LocalProjectAdoptionState
} from './projectIdentityTransfer';
import { localStorageEncryptedProjectPins } from './e2ee/encryptedProjectPins';

const { store, encryptedModule } = vi.hoisted(() => {
  const store = {
    loadProject: vi.fn(),
    saveProjectDocument: vi.fn(),
    saveRevision: vi.fn()
  };
  return {
    store,
    encryptedModule: {
      encryptedProjectStore: vi.fn(async () => store),
      encryptedProjectShelf: vi.fn(async () => new Map()),
      createEncryptedProject: vi.fn(),
      copyEncryptedProject: vi.fn()
    }
  };
});
vi.mock('./e2ee/encryptedProjects', () => encryptedModule);

/** Every request that left the page; the account answers 200 `{}`. */
const network = vi.fn(
  async (_input: RequestInfo | URL, _init?: RequestInit) =>
    new Response(JSON.stringify({ enabled: false }), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    })
);

beforeEach(() => {
  vi.stubGlobal('indexedDB', new IDBFactory());
  vi.stubGlobal('Blob', NodeBlob);
  vi.stubGlobal('fetch', network);
});

afterEach(() => {
  network.mockClear();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

const ACCOUNT = toUserId('user_transfer');

const urlOf = (input: RequestInfo | URL): string =>
  typeof input === 'string'
    ? input
    : input instanceof URL
      ? input.href
      : input.url;

/** Requests that carried something out: every write. */
const writes = () =>
  network.mock.calls
    .filter(([, init]) => !['GET', undefined].includes(init?.method))
    .map(([input, init]) => `${init?.method} ${urlOf(input)}`);
/** Plaintext reads of a project's document. */
const plaintextReads = (projectId: string) =>
  network.mock.calls
    .filter(
      ([input, init]) =>
        ['GET', undefined].includes(init?.method) &&
        urlOf(input).startsWith(`/api/projects/${projectId}`)
    )
    .map(([input]) => urlOf(input));

let counter = 0;
const nextId = (label: string) => `proj_${label}_${(counter += 1)}`;

/** A device project and its older ancestor (the same work, fewer edits). */
function deviceProject(projectId: string): {
  ancestor: ProjectDocument;
  local: ProjectDocument;
} {
  const manager = new CommandManager(
    reidentifyProjectDocument(
      createProjectDocument('Secret bracket', toUserId('device')),
      toProjectId(projectId)
    )
  );
  const ancestor = manager.document;
  manager.execute(
    commandFactories.renameNode({
      nodeId: manager.document.rootNodeId,
      name: 'Encrypted since'
    })
  );
  return { ancestor, local: manager.document };
}

function adoptionState(
  accepted: ProjectDocument[] = []
): LocalProjectAdoptionState {
  return {
    localUserId: toUserId('device'),
    manager: () => null,
    setDoc: () => undefined,
    remoteVersions: new Map(),
    setProjects: () => undefined,
    setArtifacts: () => undefined,
    accountUserId: ACCOUNT,
    setCloudProjectIds: () => undefined,
    cloudProjectIds: new Set(),
    setStatus: () => undefined,
    summarize: (document) => ({
      projectId: document.projectId,
      name: document.name,
      revisionCount: 0,
      updatedAt: '2026-11-14T00:00:00.000Z'
    }),
    acceptAccountDocument: async (remote) => {
      accepted.push(remote);
      return remote;
    }
  };
}

const alreadyAdopted = (projectId: string) =>
  new ApiError(409, 'Already saved to your account.', 'ALREADY_ADOPTED', {
    projectId
  });

describe('an adoption the account redirects to another project', () => {
  // Finding 1: the account omits pinned P from its listing, an editor save
  // adopts it, and the encrypted adoption answers ALREADY_ADOPTED naming
  // unpinned B, where a pre-encryption ancestor is served in plaintext.
  it('pins the account’s project before anything moves, and never reads or writes it in plaintext', async () => {
    const source = nextId('pinned');
    const redirected = nextId('redirect');
    const { ancestor, local } = deviceProject(source);
    expect(rememberEncryptedProject(source)).toBe(true);
    await saveLocalProject(local);
    encryptedModule.createEncryptedProject.mockRejectedValue(
      alreadyAdopted(redirected)
    );
    // B's pre-encryption ancestor, as the account would serve it.
    const remote = {
      ...reidentifyProjectDocument(ancestor, toProjectId(redirected)),
      ownerUserId: ACCOUNT
    };
    store.loadProject.mockResolvedValue(remote);
    await saveLastSyncedVersion(redirected, remote.version);
    store.saveProjectDocument.mockResolvedValue({
      version: local.version + 1,
      updatedAt: '2026-11-14T00:00:01.000Z'
    });

    const accepted: ProjectDocument[] = [];
    const outcome = await adoptLocalProject(source, adoptionState(accepted));

    // Pinned before the rekey, so it is read and written encrypted only.
    expect(isEncryptedProject(redirected)).toBe(true);
    expect(store.loadProject).toHaveBeenCalledWith(redirected);
    expect(plaintextReads(redirected)).toEqual([]);
    expect(writes()).toEqual([]);
    // The newer local work was saved, encrypted, to the account's project.
    expect(outcome.state).toBe('already-adopted');
    expect(store.saveProjectDocument).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: redirected })
    );
  });

  it('moves nothing when the account’s project cannot be read encrypted', async () => {
    const source = nextId('pinned_unreadable');
    const redirected = nextId('redirect_plain');
    const { local } = deviceProject(source);
    rememberEncryptedProject(source);
    await saveLocalProject(local);
    encryptedModule.createEncryptedProject.mockRejectedValue(
      alreadyAdopted(redirected)
    );
    // B exists only in plaintext: the encrypted route does not have it.
    store.loadProject.mockRejectedValue(new ApiError(404, 'Not found.'));

    await expect(
      adoptLocalProject(source, adoptionState())
    ).rejects.toBeInstanceOf(ApiError);
    expect(isEncryptedProject(redirected)).toBe(true);
    expect(plaintextReads(redirected)).toEqual([]);
    expect(writes()).toEqual([]);
    // Nothing was rekeyed: the device copy is where it was.
    expect((await loadLocalProject(source))?.projectId).toBe(source);
    expect(await loadLocalProject(redirected)).toBeNull();
    // A later save of that project goes only through the encrypted routes.
    store.saveProjectDocument.mockResolvedValue({
      version: 2,
      updatedAt: '2026-11-14T00:00:01.000Z'
    });
    await api.saveProjectDocument({
      projectId: toProjectId(redirected),
      expectedVersion: 1,
      document: { ...local, projectId: toProjectId(redirected) }
    });
    expect(store.saveProjectDocument).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: redirected })
    );
    expect(writes()).toEqual([]);
  });

  it('refuses the recovery when the requirement cannot be saved', async () => {
    const source = nextId('pinned_full');
    const redirected = nextId('redirect_full');
    const { local } = deviceProject(source);
    rememberEncryptedProject(source);
    await saveLocalProject(local);
    encryptedModule.createEncryptedProject.mockRejectedValue(
      alreadyAdopted(redirected)
    );
    // Another tab reset the destination: this tab may not pin it.
    localStorageEncryptedProjectPins(window.localStorage).resetProject(
      redirected
    );
    localStorageEncryptedProjectPins(window.localStorage).pin(redirected);
    const original = window.localStorage.getItem.bind(window.localStorage);
    let seen = 0;
    vi.spyOn(window.localStorage, 'getItem').mockImplementation((key) => {
      // The reset generation this tab saw first, then another tab's reset.
      if (key.includes(`reset:v1:${redirected}`) && (seen += 1) > 1) {
        return 'zz.another-tab';
      }
      return original(key);
    });
    await expect(adoptLocalProject(source, adoptionState())).rejects.toThrow();
    expect(store.loadProject).not.toHaveBeenCalled();
    expect(writes()).toEqual([]);
    expect((await loadLocalProject(source))?.projectId).toBe(source);
  });
});

describe('a device copy of a project this device keeps encrypted', () => {
  // Finding 3: the account answers the encrypted source's load with 404,
  // so Duplicate falls back to a device copy under a fresh id, and with
  // "Encrypt new projects" off its save to the account went out in
  // plaintext.
  it('carries the requirement, so its adoption is encrypted whatever the account’s setting', async () => {
    const source = nextId('pinned_copied');
    rememberEncryptedProject(source);
    const { local } = deviceProject(source);
    const copy = duplicateProjectDocument(
      local,
      'Secret bracket copy',
      ACCOUNT
    );
    carryEncryptionRequirement(source, copy.projectId, { account: false });
    await saveLocalProject(copy);
    expect(encryptionRequired(copy.projectId)).toBe(true);
    // A device copy: not held as stored encrypted by the account.
    expect(isEncryptedProject(copy.projectId)).toBe(false);

    encryptedModule.createEncryptedProject.mockImplementation(
      async (request: { document: ProjectDocument; name: string }) => ({
        project: {
          projectId: request.document.projectId,
          name: request.name,
          revisionCount: 0,
          updatedAt: '2026-11-14T00:00:00.000Z',
          storageFormat: 2,
          documentVersion: request.document.version
        },
        document: request.document
      })
    );
    const outcome = await adoptLocalProject(copy.projectId, adoptionState());
    expect(outcome.state).toBe('adopted');
    expect(encryptedModule.createEncryptedProject).toHaveBeenCalledTimes(1);
    // Neither the account's setting was asked nor anything sent plaintext.
    expect(writes()).toEqual([]);
  });

  it('refuses the copy’s plaintext at the send', async () => {
    const source = nextId('pinned_copy_send');
    rememberEncryptedProject(source);
    const { local } = deviceProject(source);
    const copy = duplicateProjectDocument(local, 'Copy', ACCOUNT);
    carryEncryptionRequirement(source, copy.projectId, { account: false });
    for (const send of [
      () =>
        api.saveProjectDocument({
          projectId: copy.projectId,
          expectedVersion: copy.version,
          document: copy
        }),
      () =>
        api.duplicateProject(copy.projectId, {
          document: copy,
          importSources: []
        }),
      () =>
        api.finalizeArtifact({
          projectId: copy.projectId
        } as Parameters<typeof api.finalizeArtifact>[0])
    ]) {
      await expect(send()).rejects.toMatchObject({
        code: E2EE_PLAINTEXT_REFUSED_CODE
      });
    }
    expect(writes()).toEqual([]);
  });

  it('carries nothing from a source this device does not keep encrypted', () => {
    const source = nextId('plain');
    const copy = nextId('plain_copy');
    carryEncryptionRequirement(source, copy, { account: false });
    expect(encryptionRequired(copy)).toBe(false);
  });

  it('carries the requirement of a source whose switch did not finish here', () => {
    const source = nextId('unresolved');
    const copy = nextId('unresolved_copy');
    const pins = localStorageEncryptedProjectPins(window.localStorage);
    pins.pin(source);
    pins.markCutoverUnresolved(source);
    carryEncryptionRequirement(source, copy, { account: false });
    expect(encryptionRequired(copy)).toBe(true);
    // Kept across a reload: another page reads it from storage.
    expect(
      localStorageEncryptedProjectPins(window.localStorage).encryptionRequired(
        copy
      )
    ).toBe(true);
  });
});
