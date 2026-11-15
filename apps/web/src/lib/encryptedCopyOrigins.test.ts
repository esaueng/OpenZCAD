/**
 * Review round 11 of PR #1418: two more ways a project this device keeps
 * encrypted reached a new project id without its encryption requirement
 * (`carryEncryptionRequirement`), so the new project could be adopted in
 * plaintext:
 *
 * - a backup of the project, restored here: the restore worker rekeys the
 *   copy, and the page saved it without the source's requirement;
 * - a copy made through the project's share link by a device that already
 *   keeps it encrypted (as a member, say).
 *
 * Both run here through the real code paths: the worker module itself
 * behind the page's worker client, and the share-link copy the page saves.
 */
import 'fake-indexeddb/auto';
import { Blob as NodeBlob, File as NodeFile } from 'node:buffer';
import { IDBFactory } from 'fake-indexeddb';
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi
} from 'vitest';
import {
  createProjectDocument,
  reidentifyProjectDocument
} from '@openzcad/document-core';
import { toProjectId, toUserId, type ProjectDocument } from '@openzcad/shared';
import {
  api,
  E2EE_PLAINTEXT_REFUSED_CODE,
  encryptionRequired,
  rememberEncryptedProject
} from './api';
import { loadLocalProject, saveImportedProject } from './localProjectStore';
import { restoreProjectInWorker } from './projectBackupWorkerClient';
import type { ProjectBackup } from './projectBackup';
import { saveShareLinkCopy } from './shareLinkCopy';

vi.mock('./e2ee/encryptedProjects', () => ({
  encryptedProjectStore: vi.fn(),
  encryptedProjectShelf: vi.fn(async () => new Map()),
  createEncryptedProject: vi.fn(),
  copyEncryptedProject: vi.fn()
}));

/** Every request that left the page; the account answers 200. */
const network = vi.fn(
  async (_input: RequestInfo | URL, _init?: RequestInit) =>
    new Response(JSON.stringify({ enabled: false }), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    })
);
const writes = () =>
  network.mock.calls.filter(
    ([, init]) => !['GET', undefined].includes(init?.method)
  );

type Handler = (event: MessageEvent) => Promise<void>;
/** The restore worker's own message handler (`projectBackupWorker.ts`). */
let workerHandler: Handler;

beforeAll(async () => {
  const scope = self as unknown as { onmessage: unknown };
  const previous = scope.onmessage;
  await import('../worker/projectBackupWorker');
  workerHandler = scope.onmessage as Handler;
  scope.onmessage = previous;
});

/**
 * Runs the real worker module in this page: what the client posts reaches
 * its handler, and what the handler posts reaches the client's listener.
 */
class InPageWorker {
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  onmessageerror: (() => void) | null = null;
  terminate = vi.fn();
  postMessage(data: unknown) {
    const reply = vi.spyOn(self, 'postMessage').mockImplementation(((
      message: unknown
    ) => {
      this.onmessage?.({ data: message } as MessageEvent);
    }) as typeof self.postMessage);
    void workerHandler({ data } as MessageEvent).finally(() =>
      reply.mockRestore()
    );
  }
}

beforeEach(() => {
  vi.stubGlobal('indexedDB', new IDBFactory());
  vi.stubGlobal('Blob', NodeBlob);
  vi.stubGlobal('fetch', network);
  vi.stubGlobal('Worker', InPageWorker);
});

afterEach(() => {
  network.mockClear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const ACCOUNT = toUserId('user_copy_origins');
let counter = 0;
const nextId = (label: string) => `proj_${label}_${(counter += 1)}`;

function projectNamed(projectId: string): ProjectDocument {
  return reidentifyProjectDocument(
    createProjectDocument('Secret bracket', toUserId('device')),
    toProjectId(projectId)
  );
}

/** A backup file of the project, as Export writes it. */
function backupFile(document: ProjectDocument): File {
  const backup: ProjectBackup = {
    format: 'openzcad-project',
    version: 1,
    document,
    files: []
  };
  return new NodeFile([JSON.stringify(backup)], 'Secret bracket.openzcad');
}

/** The plaintext sends an adoption or a save of the project would make. */
async function expectPlaintextRefused(document: ProjectDocument) {
  for (const send of [
    () =>
      api.saveProjectDocument({
        projectId: document.projectId,
        expectedVersion: document.version,
        document
      }),
    () =>
      api.duplicateProject(document.projectId, {
        document,
        importSources: []
      })
  ]) {
    await expect(send()).rejects.toMatchObject({
      code: E2EE_PLAINTEXT_REFUSED_CODE
    });
  }
  expect(writes()).toEqual([]);
}

describe('a backup of a project this device keeps encrypted, restored here', () => {
  it('carries the requirement across the worker to the copy before the page saves it', async () => {
    const source = nextId('backup_pinned');
    rememberEncryptedProject(source);
    const restored = await restoreProjectInWorker(
      backupFile(projectNamed(source)),
      ACCOUNT
    );
    // The worker rekeyed it: a new project of this account.
    expect(restored.document.projectId).not.toBe(source);
    expect(restored.document.ownerUserId).toBe(ACCOUNT);
    expect(encryptionRequired(restored.document.projectId)).toBe(true);

    await saveImportedProject(restored);
    expect(
      (await loadLocalProject(restored.document.projectId))?.projectId
    ).toBe(restored.document.projectId);
    await expectPlaintextRefused(restored.document);
  });

  it('restores a backup of a project this device holds nothing for as any device project', async () => {
    const restored = await restoreProjectInWorker(
      backupFile(projectNamed(nextId('backup_plain'))),
      ACCOUNT
    );
    expect(encryptionRequired(restored.document.projectId)).toBe(false);
  });
});

describe('a share-link copy of a project this device keeps encrypted', () => {
  it('carries the requirement to the copy', async () => {
    const source = nextId('shared_pinned');
    // A member who also opened the project's share link.
    rememberEncryptedProject(source);
    const copy = await saveShareLinkCopy(
      projectNamed(source),
      'Secret bracket copy',
      ACCOUNT
    );
    expect(copy.projectId).not.toBe(source);
    expect(encryptionRequired(copy.projectId)).toBe(true);
    expect((await loadLocalProject(copy.projectId))?.projectId).toBe(
      copy.projectId
    );
    await expectPlaintextRefused(copy);
  });

  it('copies a shared project this device holds nothing for as any device project', async () => {
    const copy = await saveShareLinkCopy(
      projectNamed(nextId('shared_plain')),
      'Shared copy',
      ACCOUNT
    );
    expect(encryptionRequired(copy.projectId)).toBe(false);
  });

  // Last: a store that could not save stays degraded for this page.
  it('copies nothing when the requirement cannot be recorded', async () => {
    const source = nextId('shared_unsaved');
    rememberEncryptedProject(source);
    vi.spyOn(window.localStorage, 'setItem').mockImplementation(() => {
      throw new DOMException('Quota exceeded', 'QuotaExceededError');
    });
    const save = vi.fn(async () => undefined);
    await expect(
      saveShareLinkCopy(projectNamed(source), 'Copy', ACCOUNT, save)
    ).rejects.toThrow();
    expect(save).not.toHaveBeenCalled();
  });
});
