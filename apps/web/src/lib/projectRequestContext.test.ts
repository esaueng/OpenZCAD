/**
 * The write gate's invariant (`projectWriteGate.ts`): every request that
 * carries a project's content declares, as request-local context, the
 * project and whether its payload is plaintext or encrypted, and the gate
 * checks it synchronously immediately before the send. These are the
 * races found between a sender's decision and its send (PR #1418).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { createProjectDocument } from '@openzcad/document-core';
import { toProjectId, toUserId, type ProjectDocument } from '@openzcad/shared';
import {
  api,
  ApiError,
  E2EE_CUTOVER_UNRESOLVED_CODE,
  E2EE_PINS_RESET_ELSEWHERE_CODE,
  E2EE_PLAINTEXT_REFUSED_CODE,
  isEncryptedProject
} from './api';
import { archiveArtifact } from './archiveArtifact';
import { uploadArtifactBody } from './artifactUpload';
import { uploadCloudThumbnail } from './cloudThumbnail';
import { desktopFetch } from './desktopBridge';
import { uploadTransport } from './e2ee/encryptedContentBlobs';
import { localStorageEncryptedProjectPins } from './e2ee/encryptedProjectPins';
import { projectMeasurementCloudApi } from './measurementCloudSync';
import {
  projectRequest,
  sendProjectFrame,
  ungatedFetch,
  UndeclaredProjectRequestError
} from './projectWriteGate';
import { workspaceSessionApi } from './workspaceResume';
import { expectDeclaredProjectContext } from '../test/projectRequestContext';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));

/** Every request the page sends; each answers success. */
const network = vi.fn(
  async (_input: RequestInfo | URL, _init?: RequestInit) =>
    new Response(
      JSON.stringify({
        ok: true,
        uploadId: 'mp_1',
        artifactId: 'artifact_ctx',
        artifact: null,
        partNumber: 1,
        etag: 'etag',
        session: {
          uploadSessionId: 'upload_ctx',
          artifactId: 'artifact_ctx',
          uploadUrl: '/api/uploads/upload_ctx/content'
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
  delete (window as Window & { __TAURI_INTERNALS__?: unknown })
    .__TAURI_INTERNALS__;
  vi.mocked(invoke).mockReset();
  vi.restoreAllMocks();
});

const pathOf = (input: RequestInfo | URL): string =>
  typeof input === 'string'
    ? input
    : input instanceof URL
      ? input.href
      : input.url;

const sentPaths = () =>
  network.mock.calls.map(
    ([input, init]) => `${init?.method ?? 'GET'} ${pathOf(input)}`
  );

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

/** Another tab's view of the same pins. */
const otherTab = () => localStorageEncryptedProjectPins(window.localStorage);

let counter = 0;
function freshDocument(): ProjectDocument {
  counter += 1;
  return createProjectDocument(`Context ${counter}`, toUserId('user_ctx'));
}

describe('every content path declares its request context', () => {
  it('a document save and a named save', async () => {
    const document = freshDocument();
    const projectId = document.projectId;
    await api.saveProjectDocument({
      projectId,
      expectedVersion: document.version,
      document
    });
    await api
      .saveRevision({
        projectId,
        reason: 'Named',
        expectedVersion: document.version,
        document
      })
      .catch(() => undefined);
    const content = expectDeclaredProjectContext(network.mock.calls, {
      projectId,
      payload: 'plaintext'
    });
    expect(content).toHaveLength(2);
  });

  it('a copy', async () => {
    const projectId = 'proj_ctx_copy';
    await api.duplicateProject(projectId).catch(() => undefined);
    expectDeclaredProjectContext(network.mock.calls, {
      projectId,
      payload: 'plaintext'
    });
  });

  it('an archived file: session, upload and finalize', async () => {
    const projectId = 'proj_ctx_archive';
    await archiveArtifact(api, toProjectId(projectId), {
      fileName: 'model.step',
      contentType: 'model/step',
      kind: 'source' as never,
      body: new Blob(['solid'])
    });
    expect(sentPaths()).toEqual(
      expect.arrayContaining([
        'POST /api/uploads',
        'PUT /api/uploads/upload_ctx/content',
        'POST /api/artifacts/finalize'
      ])
    );
    expect(
      expectDeclaredProjectContext(network.mock.calls, {
        projectId,
        payload: 'plaintext'
      })
    ).toHaveLength(3);
  });

  it('a multipart upload: every part, the completion and the abort', async () => {
    const projectId = 'proj_ctx_multipart';
    const session = {
      projectId,
      payload: 'plaintext' as const,
      uploadSessionId: 'upload_ctx',
      uploadUrl: '/api/uploads/upload_ctx/content'
    };
    await uploadArtifactBody(api, session, new Blob(['x'.repeat(20)]), {
      partBytes: 8,
      retryDelay: () => Promise.resolve()
    });
    expect(
      expectDeclaredProjectContext(network.mock.calls, {
        projectId,
        payload: 'plaintext'
      })
    ).toHaveLength(5);
    network.mockClear();
    const answer = network.getMockImplementation()!;
    network.mockImplementation(async (input, init) =>
      pathOf(input).includes('/parts/')
        ? new Response('down', { status: 503 })
        : answer(input, init)
    );
    try {
      await expect(
        uploadArtifactBody(api, session, new Blob(['x'.repeat(20)]), {
          partBytes: 8,
          retryDelay: () => Promise.resolve()
        })
      ).rejects.toThrow();
    } finally {
      network.mockImplementation(answer);
    }
    expect(sentPaths()).toContain(
      'DELETE /api/uploads/upload_ctx/multipart?uploadId=mp_1'
    );
    expectDeclaredProjectContext(network.mock.calls, {
      projectId,
      payload: 'plaintext'
    });
  });

  it('an encrypted upload declares its body encrypted', async () => {
    const projectId = 'proj_ctx_encrypted_upload';
    await uploadArtifactBody(
      uploadTransport(),
      {
        projectId,
        payload: 'encrypted',
        uploadSessionId: 'upload_ctx',
        uploadUrl: '/api/uploads/upload_ctx/content'
      },
      new Blob(['sealed'])
    ).catch(() => undefined);
    expectDeclaredProjectContext(network.mock.calls, {
      projectId,
      payload: 'encrypted'
    });
  });

  it('a thumbnail', async () => {
    const projectId = 'proj_ctx_thumbnail';
    await uploadCloudThumbnail(api, {
      projectId: toProjectId(projectId),
      version: 1,
      updatedAt: '2026-11-13T00:00:00.000Z',
      source: 'data:image/webp;base64,cHJldmlldw=='
    }).catch(() => undefined);
    expect(
      expectDeclaredProjectContext(network.mock.calls, {
        projectId,
        payload: 'plaintext'
      })
    ).toHaveLength(3);
  });

  it('measurements and view state', async () => {
    const projectId = 'proj_ctx_side_records';
    await projectMeasurementCloudApi
      .saveProjectMeasurements({
        projectId,
        expectedRevision: 1,
        record: {} as never
      })
      .catch(() => undefined);
    await workspaceSessionApi
      .save({ projectId, deviceId: 'device_1' } as never)
      .catch(() => undefined);
    expect(
      expectDeclaredProjectContext(network.mock.calls, {
        projectId,
        payload: 'plaintext'
      })
    ).toHaveLength(2);
  });

  it('refuses a content request that declared nothing, sending nothing', async () => {
    for (const path of [
      '/api/projects/proj_ctx_bare/document',
      '/api/projects/proj_ctx_bare/revisions',
      '/api/projects/proj_ctx_bare/collaboration',
      '/api/projects/proj_ctx_bare/measurements',
      '/api/projects/proj_ctx_bare/workspace-sessions',
      '/api/uploads',
      '/api/artifacts/finalize'
    ]) {
      await expect(
        desktopFetch(path, {
          method: path.endsWith('document') ? 'PUT' : 'POST',
          body: JSON.stringify({ projectId: 'proj_ctx_bare' })
        })
      ).rejects.toBeInstanceOf(UndeclaredProjectRequestError);
    }
    expect(network).not.toHaveBeenCalled();
  });

  it('treats a plaintext route as plaintext whatever is declared', async () => {
    const projectId = 'proj_ctx_misdeclared';
    otherTab().pin(projectId);
    expect(
      await codeOf(
        desktopFetch(
          `/api/projects/${projectId}/document`,
          projectRequest(
            { projectId, payload: 'encrypted' },
            { method: 'PUT', body: '{}' }
          )
        )
      )
    ).toBe(E2EE_PLAINTEXT_REFUSED_CODE);
    expect(network).not.toHaveBeenCalled();
  });
});

describe('a plaintext choice made before an await', () => {
  it('stops the upload when the project is pinned while its session opens', async () => {
    // Reproduced: the archive chose plaintext, awaited the session, and
    // the content went out after another tab pinned the project.
    const projectId = 'proj_race_archive';
    const answer = network.getMockImplementation()!;
    network.mockImplementationOnce(async (input, init) => {
      otherTab().pin(projectId);
      return answer(input, init);
    });
    expect(
      await codeOf(
        archiveArtifact(api, toProjectId(projectId), {
          fileName: 'model.step',
          contentType: 'model/step',
          kind: 'source' as never,
          body: new Blob(['secret geometry'])
        })
      )
    ).toBe(E2EE_PLAINTEXT_REFUSED_CODE);
    expect(isEncryptedProject(projectId)).toBe(true);
    expect(sentPaths()).toEqual(['POST /api/uploads']);
  });

  it('stops a document save when the project is pinned while it is prepared', async () => {
    const document = freshDocument();
    const projectId = document.projectId;
    const saving = api.saveProjectDocument({
      projectId,
      expectedVersion: document.version,
      document
    });
    // Decided plaintext already; pinned by another tab before it sends.
    otherTab().pin(projectId);
    expect(await codeOf(saving)).toBe(E2EE_PLAINTEXT_REFUSED_CODE);
    expect(network).not.toHaveBeenCalled();
  });

  it('refuses a plaintext room frame of a project pinned meanwhile', () => {
    const projectId = 'proj_race_frame';
    const socket = { send: vi.fn() };
    sendProjectFrame({ projectId, payload: 'plaintext' }, socket, '{}');
    expect(socket.send).toHaveBeenCalledTimes(1);
    otherTab().pin(projectId);
    expect(() =>
      sendProjectFrame({ projectId, payload: 'plaintext' }, socket, '{}')
    ).toThrow(expect.objectContaining({ code: E2EE_PLAINTEXT_REFUSED_CODE }));
    expect(socket.send).toHaveBeenCalledTimes(1);
    // Its encrypted frames still go.
    sendProjectFrame({ projectId, payload: 'encrypted' }, socket, '{}');
    expect(socket.send).toHaveBeenCalledTimes(2);
  });
});

describe('the desktop app checks again immediately before the native send', () => {
  function desktop() {
    (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ =
      {};
    vi.mocked(invoke).mockResolvedValue({
      status: 200,
      body: Array.from(new TextEncoder().encode('{}')),
      contentType: 'application/json'
    });
  }

  /** A body whose read runs `meanwhile` (another tab's step). */
  function bodyReading(meanwhile: () => void): Blob {
    const body = new Blob(['content']);
    vi.spyOn(body, 'arrayBuffer').mockImplementation(async () => {
      meanwhile();
      return new TextEncoder().encode('content').buffer;
    });
    return body;
  }

  const nativeSends = () =>
    vi
      .mocked(invoke)
      .mock.calls.filter(([command]) => command === 'desktop_api_request');

  it.each([
    [
      'its switch to encryption is marked unresolved',
      'proj_native_unresolved',
      'plaintext' as const,
      (projectId: string) => otherTab().markCutoverUnresolved(projectId),
      E2EE_CUTOVER_UNRESOLVED_CODE
    ],
    [
      'it is pinned as encrypted',
      'proj_native_pinned',
      'plaintext' as const,
      (projectId: string) => otherTab().pin(projectId),
      E2EE_PLAINTEXT_REFUSED_CODE
    ],
    [
      'its pin is reset in another tab',
      'proj_native_reset',
      'encrypted' as const,
      (projectId: string) => otherTab().resetProject(projectId),
      E2EE_PINS_RESET_ELSEWHERE_CODE
    ]
  ])(
    'sends nothing when %s while the body is read',
    async (_name, projectId, payload, meanwhile, code) => {
      desktop();
      if (payload === 'encrypted') {
        otherTab().pin(projectId);
        expect(isEncryptedProject(projectId)).toBe(true);
      }
      const path =
        payload === 'encrypted'
          ? `/api/e2ee/projects/${projectId}/document`
          : `/api/projects/${projectId}/document`;
      expect(
        await codeOf(
          desktopFetch(
            path,
            projectRequest(
              { projectId, payload },
              {
                method: 'PUT',
                body: bodyReading(() => meanwhile(projectId))
              }
            )
          )
        )
      ).toBe(code);
      expect(nativeSends()).toEqual([]);
    }
  );

  it('keeps an encrypted write of a project pinned meanwhile going', async () => {
    desktop();
    const projectId = 'proj_native_encrypted';
    const response = await desktopFetch(
      `/api/e2ee/projects/${projectId}/document`,
      projectRequest(
        { projectId, payload: 'encrypted' },
        { method: 'PUT', body: bodyReading(() => otherTab().pin(projectId)) }
      )
    );
    expect(response.status).toBe(200);
    expect(nativeSends()).toHaveLength(1);
  });

  it('carries the migration exemption with the request, across its awaits', async () => {
    desktop();
    const projectId = 'proj_native_migration';
    otherTab().pin(projectId);
    otherTab().markCutoverUnresolved(projectId);
    let ordinary: Promise<unknown> | null = null;
    const migration = ungatedFetch(desktopFetch)(
      `/api/e2ee/projects/${projectId}/migration/cutover`,
      {
        method: 'POST',
        body: bodyReading(() => {
          // An ordinary write started while the migration's request
          // awaits its body: the exemption is not its.
          ordinary = desktopFetch(`/api/e2ee/projects/${projectId}/document`, {
            method: 'PUT',
            body: '{}'
          });
        })
      }
    );
    expect((await migration).status).toBe(200);
    expect(await codeOf(ordinary!)).toBe(E2EE_CUTOVER_UNRESOLVED_CODE);
    expect(
      nativeSends().map(
        ([, args]) => (args as { request: { path: string } }).request.path
      )
    ).toEqual([`/api/e2ee/projects/${projectId}/migration/cutover`]);
  });
});
