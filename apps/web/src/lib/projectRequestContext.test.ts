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
import {
  PROJECT_STORAGE_FORMAT_E2EE_V1,
  toProjectId,
  toUserId,
  type ProjectDocument
} from '@openzcad/shared';
import type { CadDocumentDigest } from '@openzcad/ai-contracts';
import {
  api,
  ApiError,
  E2EE_CUTOVER_UNRESOLVED_CODE,
  E2EE_PINS_RESET_ELSEWHERE_CODE,
  E2EE_PLAINTEXT_REFUSED_CODE,
  isEncryptedProject,
  rememberProjectFormats
} from './api';
import { AssistantStreamError, streamAssistantReply } from './assistantStream';
import { archiveArtifact } from './archiveArtifact';
import { uploadArtifactBody } from './artifactUpload';
import { uploadCloudThumbnail } from './cloudThumbnail';
import { desktopFetch } from './desktopBridge';
import { uploadTransport } from './e2ee/encryptedContentBlobs';
import { localStorageEncryptedProjectPins } from './e2ee/encryptedProjectPins';
import { createEncryptedDocumentsApi } from './e2ee/encryptedDocumentsApi';
import { projectMeasurementCloudApi } from './measurementCloudSync';
import {
  assistantProjectRequest,
  migrationRun,
  projectRequest,
  sendProjectFrame,
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

  it('a new project and an adoption, by the device project it comes from', async () => {
    const created = freshDocument();
    await api.createProject({ name: created.name, initialDocument: created });
    expectDeclaredProjectContext(network.mock.calls, {
      projectId: created.projectId,
      payload: 'plaintext'
    });
    network.mockClear();
    const device = freshDocument();
    await api.adoptProject(device, toUserId('user_ctx')).catch(() => undefined);
    // The adoption mints the account's id; it declares the device's own.
    expectDeclaredProjectContext(network.mock.calls, {
      projectId: device.projectId,
      payload: 'plaintext'
    });
  });

  it('an assistant request, about its project', async () => {
    const projectId = 'proj_ctx_assistant';
    await streamAssistantReply({
      prompt: 'Make the wall 3 mm',
      digest: assistantDigest(projectId)
    }).catch(() => undefined);
    expectDeclaredProjectContext(network.mock.calls, {
      projectId,
      payload: 'plaintext'
    });
  });

  it.each([
    ['an import’s finalize', '/api/imports/finalize'],
    ['an archived file’s finalize', '/api/artifacts/finalize'],
    ['a create', '/api/projects'],
    ['an assistant request', '/api/assistant/proposals']
  ])('refuses %s that declared nothing', async (_name, path) => {
    await expect(
      desktopFetch(path, { method: 'POST', body: '{}' })
    ).rejects.toBeInstanceOf(UndeclaredProjectRequestError);
    expect(network).not.toHaveBeenCalled();
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
    const run = migrationRun('encrypt');
    const migration = run.during(projectId, () =>
      run.fetch(desktopFetch)(
        `/api/e2ee/projects/${projectId}/migration/cutover`,
        {
          method: 'POST',
          body: bodyReading(() => {
            // An ordinary write started while the migration's request
            // awaits its body: the exemption is not its.
            ordinary = desktopFetch(
              `/api/e2ee/projects/${projectId}/document`,
              { method: 'PUT', body: '{}' }
            );
          })
        }
      )
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

function assistantDigest(projectId: string): CadDocumentDigest {
  return { projectId, name: 'Bracket' } as unknown as CadDocumentDigest;
}

describe('a project the account’s listing leaves out', () => {
  /** Listed encrypted once, then left out of the next listing. */
  function pinnedThenOmitted(document: ProjectDocument): void {
    rememberProjectFormats([
      {
        projectId: document.projectId,
        storageFormat: PROJECT_STORAGE_FORMAT_E2EE_V1
      }
    ]);
    rememberProjectFormats([
      { projectId: toProjectId('proj_listed_other'), storageFormat: 1 }
    ]);
  }

  const plaintextCreates = () =>
    sentPaths().filter((sent) => /^POST \/api\/projects\/?$/.test(sent));

  it('is never adopted from its device copy in plaintext', async () => {
    const device = freshDocument();
    pinnedThenOmitted(device);
    expect(isEncryptedProject(device.projectId)).toBe(true);
    // The account does not encrypt new projects (its config is off here):
    // the device project's own pin decides, so only an encrypted adoption
    // is tried, and nothing goes to the plaintext create.
    await expect(
      api.adoptProject(device, toUserId('user_ctx'))
    ).rejects.toBeDefined();
    expect(plaintextCreates()).toEqual([]);
  });

  it('is not adopted at all while its switch to encryption is unfinished', async () => {
    const device = freshDocument();
    otherTab().pin(device.projectId);
    otherTab().markCutoverUnresolved(device.projectId);
    expect(await codeOf(api.adoptProject(device, toUserId('user_ctx')))).toBe(
      E2EE_CUTOVER_UNRESOLVED_CODE
    );
    expect(sentPaths()).toEqual([]);
  });

  it('stops a plaintext adoption when the device project is pinned meanwhile', async () => {
    const device = freshDocument();
    const answer = network.getMockImplementation()!;
    network.mockImplementation(async (input, init) => {
      // While the account's setting is read, another tab pins it.
      if (pathOf(input) === '/api/e2ee/config') {
        otherTab().pin(device.projectId);
      }
      return answer(input, init);
    });
    try {
      expect(await codeOf(api.adoptProject(device, toUserId('user_ctx')))).toBe(
        E2EE_PLAINTEXT_REFUSED_CODE
      );
    } finally {
      network.mockImplementation(answer);
    }
    expect(plaintextCreates()).toEqual([]);
  });
});

describe('an assistant request', () => {
  function desktop(meanwhile: (command: string) => void = () => undefined) {
    (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ =
      {};
    vi.mocked(invoke).mockImplementation(async (command: string) => {
      meanwhile(command);
      if (command === 'desktop_prepare_access') return 'handle-assistant';
      return {
        status: 200,
        body: Array.from(new TextEncoder().encode('{}')),
        contentType: 'application/json'
      };
    });
  }

  const nativeSends = () =>
    vi
      .mocked(invoke)
      .mock.calls.filter(([command]) => command === 'desktop_api_request');

  it('sends nothing of a project pinned while the desktop app readies its credential', async () => {
    // Reproduced: the panel saw a plaintext project, the request awaited
    // the native host, and another tab pinned the project meanwhile.
    const projectId = 'proj_assistant_native';
    desktop((command) => {
      if (command === 'desktop_prepare_access') otherTab().pin(projectId);
    });
    const reply = streamAssistantReply({
      prompt: 'Make the wall 3 mm',
      digest: assistantDigest(projectId)
    });
    await expect(reply).rejects.toBeInstanceOf(AssistantStreamError);
    await expect(reply).rejects.toMatchObject({ code: 'AI_E2EE_PROJECT' });
    expect(nativeSends()).toEqual([]);
  });

  it('sends nothing of a project whose switch is marked unresolved meanwhile', async () => {
    const projectId = 'proj_assistant_unresolved';
    desktop((command) => {
      if (command === 'desktop_prepare_access') {
        otherTab().pin(projectId);
        otherTab().markCutoverUnresolved(projectId);
      }
    });
    await expect(
      streamAssistantReply({ prompt: 'Hi', digest: assistantDigest(projectId) })
    ).rejects.toMatchObject({ code: 'AI_E2EE_PROJECT' });
    expect(nativeSends()).toEqual([]);
  });

  // Owner decision (2026-11-14): no consent exception in this PR. A
  // request for a project this device holds as encrypted is refused before
  // the send, whatever consent the panel verified (`consentedProjectId`).
  it.each([
    ['pinned', (projectId: string) => otherTab().pin(projectId)],
    [
      'unresolved',
      (projectId: string) => otherTab().markCutoverUnresolved(projectId)
    ],
    [
      'required to stay encrypted',
      (projectId: string) => otherTab().requireEncryption(projectId)
    ]
  ])(
    'refuses a %s project even with its consent verified',
    async (state, hold) => {
      const projectId = `proj_assistant_held_${state.replace(/\W/g, '_')}`;
      expect(hold(projectId)).toBe(true);
      desktop();
      await expect(
        streamAssistantReply({
          prompt: 'Hi',
          digest: assistantDigest(projectId),
          consentedProjectId: projectId
        })
      ).rejects.toMatchObject({ code: 'AI_E2EE_PROJECT' });
      // The send gate refuses the request itself too, whatever sent it.
      await expect(
        desktopFetch(
          '/api/assistant/proposals',
          assistantProjectRequest(projectId, { method: 'POST', body: '{}' })
        )
      ).rejects.toBeInstanceOf(ApiError);
      expect(nativeSends()).toEqual([]);
    }
  );

  it('refuses a pinned project in the browser too, consent or not', async () => {
    const projectId = 'proj_assistant_held_browser';
    otherTab().pin(projectId);
    await expect(
      streamAssistantReply({
        prompt: 'Hi',
        digest: assistantDigest(projectId),
        consentedProjectId: projectId
      })
    ).rejects.toMatchObject({ code: 'AI_E2EE_PROJECT' });
    await expect(
      desktopFetch(
        '/api/assistant/proposals',
        assistantProjectRequest(projectId, { method: 'POST', body: '{}' })
      )
    ).rejects.toMatchObject({ code: E2EE_PLAINTEXT_REFUSED_CODE });
    expect(network).not.toHaveBeenCalled();
  });

  it('sends a project this device does not hold as encrypted, as on main', async () => {
    const projectId = 'proj_assistant_plain';
    desktop();
    await streamAssistantReply({
      prompt: 'Hi',
      digest: assistantDigest(projectId)
    }).catch(() => undefined);
    expect(nativeSends().length).toBeGreaterThan(0);
  });

  it('checks the project again before a native retry', async () => {
    const projectId = 'proj_assistant_retry_pinned';
    (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ =
      {};
    let readied = 0;
    vi.mocked(invoke).mockImplementation(async (command: string) => {
      if (command === 'desktop_prepare_access') {
        readied += 1;
        if (readied > 1) otherTab().pin(projectId);
        return `handle-${readied}`;
      }
      return { status: 401, body: [], contentType: 'application/json' };
    });
    await expect(
      desktopFetch(
        '/api/assistant/proposals',
        assistantProjectRequest(projectId, { method: 'POST', body: '{}' })
      )
    ).rejects.toMatchObject({ code: E2EE_PLAINTEXT_REFUSED_CODE });
    expect(nativeSends()).toHaveLength(1);
  });
});

describe('the desktop app’s credential for a project request', () => {
  const nativeCommands = () =>
    vi
      .mocked(invoke)
      .mock.calls.map(([command, args]) =>
        command === 'desktop_api_request' &&
        (args as { request: { prepared?: string } }).request.prepared
          ? `${command} prepared`
          : command
      );

  function desktop(
    statuses: number[],
    meanwhile: () => void = () => undefined
  ) {
    (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ =
      {};
    let readied = 0;
    vi.mocked(invoke).mockImplementation(async (command: string) => {
      if (command === 'desktop_prepare_access') {
        readied += 1;
        if (readied > 1) meanwhile();
        return `handle-${readied}`;
      }
      return {
        status: statuses.shift() ?? 200,
        body: Array.from(new TextEncoder().encode('{}')),
        contentType: 'application/json'
      };
    });
  }

  const save = (projectId: string) =>
    desktopFetch(
      `/api/projects/${projectId}/document`,
      projectRequest(
        { projectId, payload: 'plaintext' },
        { method: 'PUT', body: '{}' }
      )
    );

  it('is readied before the gate’s last check, and sent without a refresh', async () => {
    desktop([200]);
    expect((await save('proj_native_prepared')).status).toBe(200);
    expect(nativeCommands()).toEqual([
      'desktop_prepare_access',
      'desktop_api_request prepared'
    ]);
  });

  it('checks the gate again before the one retry after a 401', async () => {
    const projectId = 'proj_native_retry';
    // The account refuses the credential; while a fresh one is readied,
    // another tab pins the project.
    desktop([401], () => otherTab().pin(projectId));
    expect(await codeOf(save(projectId))).toBe(E2EE_PLAINTEXT_REFUSED_CODE);
    expect(nativeCommands()).toEqual([
      'desktop_prepare_access',
      'desktop_api_request prepared',
      'desktop_prepare_access'
    ]);
  });

  it('retries once with a fresh credential when nothing changed', async () => {
    desktop([401, 401]);
    expect((await save('proj_native_retried')).status).toBe(401);
    expect(nativeCommands()).toEqual([
      'desktop_prepare_access',
      'desktop_api_request prepared',
      'desktop_prepare_access',
      'desktop_api_request prepared'
    ]);
  });

  it('sends each readied credential with the one request it was readied for', async () => {
    desktop([401, 200]);
    expect((await save('proj_native_handles')).status).toBe(200);
    const handles = vi
      .mocked(invoke)
      .mock.calls.filter(([command]) => command === 'desktop_api_request')
      .map(
        ([, args]) =>
          (args as { request: { prepared?: string } }).request.prepared
      );
    expect(handles).toEqual(['handle-1', 'handle-2']);
  });

  it('sends a project request without a readied credential as unprepared nowhere', async () => {
    // Signed out: no handle. The request still goes to Rust as a project
    // request (answered there with a local 401), never refreshed and
    // replayed.
    (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ =
      {};
    vi.mocked(invoke).mockImplementation(async (command: string) =>
      command === 'desktop_prepare_access'
        ? null
        : { status: 401, body: [], contentType: 'application/json' }
    );
    expect((await save('proj_native_signed_out')).status).toBe(401);
    const sends = vi
      .mocked(invoke)
      .mock.calls.filter(([command]) => command === 'desktop_api_request')
      .map(
        ([, args]) =>
          (args as { request: { prepared?: string } }).request.prepared
      );
    expect(sends).toEqual(['']);
  });

  // Review round 10, finding 6: an encrypted create named no project, so
  // the desktop host refreshed and replayed it.
  it('sends an encrypted create as its chosen project’s request', async () => {
    desktop([200]);
    const projectId = 'proj_native_encrypted_create';
    await createEncryptedDocumentsApi(desktopFetch)
      .create(
        { projectId } as Parameters<
          ReturnType<typeof createEncryptedDocumentsApi>['create']
        >[0],
        new Uint8Array([1, 2, 3])
      )
      .catch(() => undefined);
    expect(nativeCommands()).toEqual([
      'desktop_prepare_access',
      'desktop_api_request prepared'
    ]);
  });

  it('refuses an encrypted create that does not name its project', async () => {
    desktop([200]);
    await expect(
      desktopFetch('/api/e2ee/projects', {
        method: 'POST',
        body: new Uint8Array([1])
      })
    ).rejects.toBeInstanceOf(UndeclaredProjectRequestError);
    expect(nativeCommands()).toEqual([]);
  });

  it('refuses an encrypted create of a project whose switch is unresolved', async () => {
    desktop([200]);
    const projectId = 'proj_native_create_unresolved';
    otherTab().pin(projectId);
    otherTab().markCutoverUnresolved(projectId);
    expect(
      await codeOf(
        createEncryptedDocumentsApi(desktopFetch).create(
          { projectId } as Parameters<
            ReturnType<typeof createEncryptedDocumentsApi>['create']
          >[0],
          new Uint8Array([1])
        )
      )
    ).toBe(E2EE_CUTOVER_UNRESOLVED_CODE);
    expect(nativeCommands()).toEqual([]);
  });

  it('leaves other requests to Rust as before', async () => {
    desktop([200]);
    await desktopFetch('/api/settings', { method: 'PATCH', body: '{}' });
    expect(nativeCommands()).toEqual(['desktop_api_request']);
  });
});

describe('a migration run’s exemption', () => {
  function desktop() {
    (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ =
      {};
    vi.mocked(invoke).mockResolvedValue({
      status: 200,
      body: Array.from(new TextEncoder().encode('{}')),
      contentType: 'application/json'
    });
  }

  const nativePaths = () =>
    vi
      .mocked(invoke)
      .mock.calls.filter(([command]) => command === 'desktop_api_request')
      .map(([, args]) => (args as { request: { path: string } }).request.path);

  it('covers the encrypt run’s own project, through its encrypted routes, while it works on it', async () => {
    desktop();
    const projectId = 'proj_run_encrypting';
    const other = 'proj_run_other';
    for (const id of [projectId, other]) {
      otherTab().pin(id);
      otherTab().markCutoverUnresolved(id);
    }
    const run = migrationRun('encrypt');
    const fetcher = run.fetch(desktopFetch);
    const post = (path: string) =>
      fetcher(path, { method: 'POST', body: '{}' });
    await run.during(projectId, async () => {
      expect(
        (await post(`/api/e2ee/projects/${projectId}/migration/cutover`)).status
      ).toBe(200);
      // Another project, while this one runs.
      expect(
        await codeOf(post(`/api/e2ee/projects/${other}/migration/cutover`))
      ).toBe(E2EE_CUTOVER_UNRESOLVED_CODE);
      // A plaintext route of the run's own project.
      expect(
        await codeOf(
          fetcher(
            `/api/projects/${projectId}/document`,
            projectRequest(
              { projectId, payload: 'plaintext' },
              { method: 'PUT', body: '{}' }
            )
          )
        )
      ).toBe(E2EE_CUTOVER_UNRESOLVED_CODE);
    });
    // Once the run's work on it is over.
    expect(
      await codeOf(post(`/api/e2ee/projects/${projectId}/migration/cutover`))
    ).toBe(E2EE_CUTOVER_UNRESOLVED_CODE);
    expect(nativePaths()).toEqual([
      `/api/e2ee/projects/${projectId}/migration/cutover`
    ]);
  });

  it('lets the decrypt run stage only its own project’s plaintext, through its staging routes', async () => {
    desktop();
    const projectId = 'proj_run_decrypting';
    const other = 'proj_run_decrypt_other';
    otherTab().pin(projectId);
    otherTab().pin(other);
    const run = migrationRun('decrypt');
    const fetcher = run.fetch(desktopFetch);
    const put = (path: string, init: RequestInit = {}) =>
      fetcher(path, { ...init, method: 'PUT', body: '{}' });
    await run.during(projectId, async () => {
      expect((await put(`/api/projects/${projectId}/document`)).status).toBe(
        200
      );
      expect(
        (
          await put(
            `/api/e2ee/projects/${projectId}/migration/plaintext/details`
          )
        ).status
      ).toBe(200);
      expect(
        await codeOf(
          put(
            `/api/projects/${other}/document`,
            projectRequest({ projectId: other, payload: 'plaintext' })
          )
        )
      ).toBe(E2EE_PLAINTEXT_REFUSED_CODE);
      // Not a route the run stages through.
      await expect(
        put(`/api/projects/${projectId}/measurements`)
      ).rejects.toBeInstanceOf(UndeclaredProjectRequestError);
    });
    expect(nativePaths()).toEqual([
      `/api/projects/${projectId}/document`,
      `/api/e2ee/projects/${projectId}/migration/plaintext/details`
    ]);
  });

  // Review round 10, finding 4: the exemption was checked for liveness
  // only when it was attached, so a request of the run that left after
  // the run's window closed still passed.
  it('checks an encrypt run’s request like any other once its window closed before the send', async () => {
    desktop();
    const projectId = 'proj_run_closed_encrypt';
    otherTab().pin(projectId);
    otherTab().markCutoverUnresolved(projectId);
    const run = migrationRun('encrypt');
    const fetcher = run.fetch(desktopFetch);
    let pending!: Promise<Response>;
    await run.during(projectId, async () => {
      // Attached while the run works on it; sent after it stopped.
      pending = fetcher(`/api/e2ee/projects/${projectId}/migration/cutover`, {
        method: 'POST',
        body: '{}'
      });
    });
    expect(await codeOf(pending)).toBe(E2EE_CUTOVER_UNRESOLVED_CODE);
    expect(nativePaths()).toEqual([]);
  });

  it('refuses a decrypt run’s plaintext once its window closed before the send', async () => {
    desktop();
    const projectId = 'proj_run_closed_decrypt';
    otherTab().pin(projectId);
    const run = migrationRun('decrypt');
    const fetcher = run.fetch(desktopFetch);
    let pending!: Promise<Response>;
    await run.during(projectId, async () => {
      pending = fetcher(`/api/projects/${projectId}/document`, {
        method: 'PUT',
        body: '{}'
      });
    });
    expect(await codeOf(pending)).toBe(E2EE_PLAINTEXT_REFUSED_CODE);
    expect(nativePaths()).toEqual([]);
  });
});
