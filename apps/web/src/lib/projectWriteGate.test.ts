import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { toProjectId, type ProjectDocument } from '@openzcad/shared';
import {
  api,
  ApiError,
  beginEncryptCutover,
  E2EE_CUTOVER_UNRESOLVED_CODE,
  E2EE_PINS_RESET_ELSEWHERE_CODE,
  encryptedPinsResetElsewhere,
  isEncryptedProject,
  rememberProjectFormats,
  requireDurablePin,
  treatProjectAsNotEncrypted
} from './api';
import { desktopFetch } from './desktopBridge';
import {
  ENCRYPTED_PROJECT_PIN_PREFIX,
  localStorageEncryptedProjectPins
} from './e2ee/encryptedProjectPins';
import { createEncryptedDocumentsApi } from './e2ee/encryptedDocumentsApi';
import {
  createContentBlobsApi,
  uploadTransport
} from './e2ee/encryptedContentBlobs';
import { createReplacedEnvelopesApi } from './e2ee/replacedEnvelopes';
import { createProjectMigrationsApi } from './e2ee/projectMigrationsApi';
import { loadEncryptedRoomCodec } from './e2ee/encryptedRoomCodec';
import {
  projectWriteBlocked,
  ungatedFetch,
  UnownedProjectWriteError
} from './projectWriteGate';
import { uploadArtifactBody } from './artifactUpload';

// The room codec's store: the gate refuses before it is ever used.
const roomAccess = vi.hoisted(() => ({
  currentHead: vi.fn(() => null),
  seal: vi.fn()
}));
vi.mock('./e2ee/encryptedProjects', () => ({
  encryptedProjectStore: async () => ({ roomAccess: () => roomAccess }),
  encryptedMeasurements: vi.fn(),
  encryptedViewStates: vi.fn()
}));

/** Every request the page sends; each answers success. */
const network = vi.fn(
  async (_input: RequestInfo | URL, _init?: RequestInit) =>
    new Response(
      JSON.stringify({
        ok: true,
        uploadId: 'mp_1',
        session: {
          uploadSessionId: 'upload_open',
          uploadUrl: '/api/uploads/upload_open/content'
        }
      }),
      { status: 200, headers: { 'content-type': 'application/json' } }
    )
);

beforeEach(() => {
  vi.stubGlobal('fetch', network);
});

afterEach(() => {
  network.mockClear();
  vi.unstubAllGlobals();
});

const pathOf = (input: RequestInfo | URL): string =>
  typeof input === 'string'
    ? input
    : input instanceof URL
      ? input.href
      : input.url;

/** The requests that reached the network for the project. */
function sentFor(projectId: string) {
  return network.mock.calls.filter(([input, init]) =>
    `${pathOf(input)} ${typeof init?.body === 'string' ? init.body : ''}`.includes(
      projectId
    )
  );
}

async function codeOf(call: Promise<unknown>): Promise<string | undefined> {
  try {
    await call;
  } catch (error) {
    return error instanceof ApiError
      ? error.code
      : `unexpected: ${error instanceof Error ? error.message : typeof error}`;
  }
  return undefined;
}

const documentOf = (projectId: string) =>
  ({ projectId, name: 'Secret', version: 3 }) as unknown as ProjectDocument;
const envelope = new Uint8Array([1, 2, 3]);

/** Each outbound write path of a project, as the page's clients send it. */
function writePaths(projectId: string): [string, () => Promise<unknown>][] {
  const documents = createEncryptedDocumentsApi();
  const blobs = createContentBlobsApi();
  const replaced = createReplacedEnvelopesApi();
  const id = toProjectId(projectId);
  return [
    [
      'document save',
      () =>
        api.saveProjectDocument({
          projectId: id,
          expectedVersion: 3,
          document: documentOf(projectId)
        })
    ],
    [
      'revision save',
      () =>
        api.saveRevision({
          projectId: id,
          reason: 'Named',
          expectedVersion: 3,
          document: documentOf(projectId)
        })
    ],
    [
      'encrypted document save (background sync)',
      () => documents.saveDocument(projectId, { version: 4 } as never, envelope)
    ],
    [
      'encrypted revision save',
      () => documents.saveRevision(projectId, { version: 4 } as never, envelope)
    ],
    [
      'encrypted project info (thumbnail, export list)',
      () => documents.saveInfo(projectId, {} as never)
    ],
    [
      'encrypted upload',
      () =>
        blobs.startUpload(projectId, { blobId: 'blob_1', kind: 'thumbnail' })
    ],
    [
      'encrypted upload finalize',
      () => blobs.finalize(projectId, 'blob_1', { uploadSessionId: 'upload_1' })
    ],
    [
      'plaintext upload session',
      () =>
        desktopFetch('/api/uploads', {
          method: 'POST',
          body: JSON.stringify({ projectId, kind: 'thumbnail' })
        })
    ],
    [
      'plaintext artifact finalize',
      () =>
        desktopFetch('/api/artifacts/finalize', {
          method: 'POST',
          body: JSON.stringify({
            projectId,
            uploadSessionId: 'upload_1',
            artifactId: 'artifact_1'
          })
        })
    ],
    [
      'encrypted measurements',
      () => replaced.saveMeasurements(projectId, {} as never)
    ],
    [
      'plaintext measurements',
      () =>
        desktopFetch(
          `/api/projects/${encodeURIComponent(projectId)}/measurements`,
          { method: 'PUT', body: JSON.stringify({ expectedRevision: 1 }) }
        )
    ],
    [
      'encrypted view state',
      () => replaced.saveViewState(projectId, 'session_1', {} as never)
    ],
    [
      'plaintext view state',
      () =>
        desktopFetch(
          `/api/projects/${encodeURIComponent(projectId)}/workspace-sessions`,
          { method: 'PUT', body: JSON.stringify({ projectId }) }
        )
    ],
    [
      'room submission over HTTP',
      () =>
        desktopFetch(
          `/api/projects/${encodeURIComponent(projectId)}/collaboration`,
          { method: 'POST', body: '{}' }
        )
    ],
    ['copy', () => api.duplicateProject(projectId)],
    [
      'rename',
      () => api.updateProject({ projectId: id, name: 'Renamed' } as never)
    ]
  ];
}

describe('a switch to encryption this device did not see finish', () => {
  const projectId = 'proj_gate_unresolved';
  beforeEach(() => {
    if (!isEncryptedProject(projectId)) beginEncryptCutover(projectId);
  });

  it.each(writePaths(projectId))('sends nothing: %s', async (_name, write) => {
    expect(await codeOf(write())).toBe(E2EE_CUTOVER_UNRESOLVED_CODE);
    expect(sentFor(projectId)).toEqual([]);
  });

  it('sends nothing to its room', async () => {
    expect(projectWriteBlocked(projectId)).toBe(true);
    const codec = await loadEncryptedRoomCodec(projectId);
    expect(await codeOf(codec.encode(documentOf(projectId), 3))).toBe(
      E2EE_CUTOVER_UNRESOLVED_CODE
    );
    expect(roomAccess.seal).not.toHaveBeenCalled();
    expect(sentFor(projectId)).toEqual([]);
  });

  it.each([
    ['the account upload routes', () => api],
    ['the encrypted upload routes', () => uploadTransport()]
  ])(
    'stops each part upload into a session opened before it (%s)',
    async (_name, transport) => {
      const other = `proj_gate_upload_late_${_name.length}`;
      const { session } = await api.createUploadSession({
        projectId: toProjectId(other),
        fileName: 'part.bin',
        contentType: 'application/octet-stream',
        kind: 'source'
      } as never);
      beginEncryptCutover(other);
      network.mockClear();
      for (const body of [new Blob(['x']), new Blob(['x'.repeat(20)])]) {
        expect(
          await codeOf(
            uploadArtifactBody(
              transport(),
              { ...session, projectId: other, uploadUrl: session.uploadUrl! },
              body,
              { partBytes: 8, retryDelay: () => Promise.resolve() }
            )
          )
        ).toBe(E2EE_CUTOVER_UNRESOLVED_CODE);
      }
      expect(network).not.toHaveBeenCalled();
    }
  );

  it('refuses a part sent before its session’s answer is noted anywhere', async () => {
    // The race the response-noting gate lost: the session opens, the
    // switch is noted unresolved, and a part goes out in the same task,
    // before anything could have read the answer that opened it.
    const other = 'proj_gate_upload_race';
    const opened = await desktopFetch('/api/uploads', {
      method: 'POST',
      body: JSON.stringify({ projectId: other, kind: 'source' })
    });
    const { session } = (await opened.json()) as {
      session: { uploadSessionId: string };
    };
    beginEncryptCutover(other);
    network.mockClear();
    // Unnamed: refused, whoever's session it is.
    await expect(
      api.uploadArtifactPart(
        session.uploadSessionId,
        'mp_1',
        1,
        new Blob(['x'])
      )
    ).rejects.toBeInstanceOf(UnownedProjectWriteError);
    await expect(
      uploadTransport().createMultipartUpload(session.uploadSessionId)
    ).rejects.toBeInstanceOf(UnownedProjectWriteError);
    expect(network).not.toHaveBeenCalled();
  });

  it('lets this device’s own encrypt run resolve it', async () => {
    const migrations = createProjectMigrationsApi(ungatedFetch(desktopFetch));
    await migrations.cutover(projectId, 'lease_1').catch(() => undefined);
    expect(network.mock.calls.map(([input]) => pathOf(input))).toContain(
      `/api/e2ee/projects/${projectId}/migration/cutover`
    );
    // Only that call: the next ordinary one is refused again.
    network.mockClear();
    expect(
      await codeOf(
        desktopFetch(`/api/e2ee/projects/${projectId}/document`, {
          method: 'PUT'
        })
      )
    ).toBe(E2EE_CUTOVER_UNRESOLVED_CODE);
    expect(network).not.toHaveBeenCalled();
  });

  it('still reads it', async () => {
    await desktopFetch(`/api/e2ee/projects/${projectId}/document`);
    expect(sentFor(projectId)).toHaveLength(1);
  });
});

describe('a project nothing holds back', () => {
  const projectId = 'proj_gate_open';
  it.each(
    writePaths(projectId).filter(
      ([name]) =>
        !['document save', 'revision save', 'copy', 'rename'].includes(name)
    )
  )('is sent: %s', async (_name, write) => {
    await write().catch(() => undefined);
    expect(sentFor(projectId).length).toBeGreaterThan(0);
  });
});

describe('an upload session', () => {
  const projectId = 'proj_gate_upload_open';
  const session = {
    projectId,
    uploadSessionId: 'upload_open',
    uploadUrl: '/api/uploads/upload_open/content'
  };
  const noDelay = { retryDelay: () => Promise.resolve() };

  it('sends a writable project’s upload, every part as that project’s', async () => {
    await uploadArtifactBody(api, session, new Blob(['x'.repeat(20)]), {
      partBytes: 8,
      ...noDelay
    });
    await uploadArtifactBody(api, session, new Blob(['x']));
    expect(
      network.mock.calls.map(
        ([input, init]) => `${init?.method ?? 'GET'} ${pathOf(input)}`
      )
    ).toEqual([
      'POST /api/uploads/upload_open/multipart',
      'PUT /api/uploads/upload_open/parts/1?uploadId=mp_1',
      'PUT /api/uploads/upload_open/parts/2?uploadId=mp_1',
      'PUT /api/uploads/upload_open/parts/3?uploadId=mp_1',
      'POST /api/uploads/upload_open/multipart/complete',
      'PUT /api/uploads/upload_open/content'
    ]);
  });

  it('refuses a request into a session nobody named the project of', async () => {
    await expect(
      desktopFetch('/api/uploads/upload_open/content', {
        method: 'PUT',
        body: new Blob(['x'])
      })
    ).rejects.toBeInstanceOf(UnownedProjectWriteError);
    await expect(
      api.completeMultipartUpload('upload_open', { uploadId: 'mp', parts: [] })
    ).rejects.toBeInstanceOf(UnownedProjectWriteError);
    expect(network).not.toHaveBeenCalled();
  });

  it.each([
    ['another session', '/api/uploads/upload_other/content'],
    [
      'another origin',
      'https://elsewhere.example/api/uploads/upload_open/content'
    ],
    [
      'a protocol-relative address',
      '//elsewhere.example/api/uploads/upload_open/content'
    ],
    ['another route', '/api/projects/proj_other/document'],
    ['a query', '/api/uploads/upload_open/content?to=elsewhere'],
    ['a dot segment', '/api/uploads/upload_other/../upload_open/content/..']
  ])(
    'refuses an upload address for %s, sending nothing',
    async (_name, uploadUrl) => {
      await expect(
        uploadArtifactBody(api, { ...session, uploadUrl }, new Blob(['x']))
      ).rejects.toThrow('upload address for something else');
      expect(network).not.toHaveBeenCalled();
    }
  );
});

describe('a reset made in another tab', () => {
  /** Another tab's view of the same storage. */
  const otherTab = () => localStorageEncryptedProjectPins(window.localStorage);

  it('keeps a tab opened with a saved pin encrypted, and stops its writes', async () => {
    const projectId = 'proj_gate_opened_pinned';
    window.localStorage.setItem(ENCRYPTED_PROJECT_PIN_PREFIX + projectId, '1');
    // The editor opened it: held as encrypted from the saved pin.
    expect(isEncryptedProject(projectId)).toBe(true);

    otherTab().resetProject(projectId);

    // Not plaintext: its next save neither goes out in plaintext nor at all.
    expect(isEncryptedProject(projectId)).toBe(true);
    expect(encryptedPinsResetElsewhere()).toBe(true);
    for (const [, write] of writePaths(projectId)) {
      expect(await codeOf(write())).toBe(E2EE_PINS_RESET_ELSEWHERE_CODE);
    }
    expect(sentFor(projectId)).toEqual([]);
    expect(projectWriteBlocked(projectId)).toBe(true);
  });

  it('never recreates the pin the owner just reset', () => {
    const projectId = 'proj_gate_listed_pinned';
    rememberProjectFormats([
      { projectId: toProjectId(projectId), storageFormat: 2 }
    ]);
    expect(
      window.localStorage.getItem(ENCRYPTED_PROJECT_PIN_PREFIX + projectId)
    ).not.toBeNull();

    otherTab().resetProject(projectId);

    expect(() => requireDurablePin(projectId)).toThrow(
      expect.objectContaining({ code: E2EE_PINS_RESET_ELSEWHERE_CODE })
    );
    rememberProjectFormats([
      { projectId: toProjectId(projectId), storageFormat: 2 }
    ]);
    expect(
      window.localStorage.getItem(ENCRYPTED_PROJECT_PIN_PREFIX + projectId)
    ).toBeNull();
    expect(projectWriteBlocked(projectId)).toBe(true);
  });

  it('is not stale in the tab that made the reset', () => {
    const projectId = 'proj_gate_reset_here';
    rememberProjectFormats([
      { projectId: toProjectId(projectId), storageFormat: 2 }
    ]);
    treatProjectAsNotEncrypted(projectId, { confirmedByOwner: true });
    expect(projectWriteBlocked(projectId)).toBe(false);
    expect(isEncryptedProject(projectId)).toBe(false);
  });
});
