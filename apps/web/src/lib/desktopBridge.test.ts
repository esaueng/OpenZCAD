import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import {
  createNativeDeviceKeys,
  desktopCollaborationUrl,
  desktopFetch,
  isDesktopApp,
  NativeDeviceKeysError,
  nativeCadFile,
  openExternalUrl,
  protectDesktopClose,
  saveCadBinaryFile
} from './desktopBridge';
import {
  CLOUD_FUNCTIONS_STORAGE_KEY,
  setCloudFunctionsEnabled
} from './cloudMode';
import { readSharedSourceBytes } from './sharedSourceDownload';
import { sharedBlobUrl } from './e2ee/sharedSnapshotLoader';
import { createContentBlobsApi } from './e2ee/encryptedContentBlobs';
import { LEGACY_PROJECT_FRAME_CONTENT_TYPE } from '@openzcad/shared';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: vi.fn() }));

const BLOB_ID = '0123456789abcdef0123456789abcdef';

type NativePiece = Uint8Array | Error | 'stall';

/**
 * Rust's blob stream as the WebView sees it: `desktop_blob_stream_open`
 * answers `start`, and each `desktop_blob_stream_read` takes the next piece
 * (an `ArrayBuffer`, a rejection, or a read that never answers), then the
 * empty end.
 */
function mockNativeBlobStream(
  pieces: NativePiece[],
  start: Record<string, unknown> = {}
) {
  const queue = [...pieces];
  vi.mocked(invoke).mockImplementation(async (command: string) => {
    if (command === 'desktop_blob_stream_open') {
      return {
        status: 200,
        contentType: 'application/octet-stream',
        contentLength: null,
        streamId: 'stream-1',
        body: [],
        ...start
      };
    }
    if (command === 'desktop_blob_stream_read') {
      const piece = queue.shift() ?? new Uint8Array();
      if (piece === 'stall') return new Promise<never>(() => undefined);
      if (piece instanceof Error) throw piece;
      return piece.slice().buffer;
    }
    if (command === 'desktop_blob_stream_cancel') return undefined;
    throw new Error(`Unexpected native command ${command}`);
  });
}

function nativeCommands(): string[] {
  return vi.mocked(invoke).mock.calls.map(([command]) => command);
}

function markDesktopRuntime() {
  (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ =
    {};
}

function mockDesktopWindow() {
  let closeHandler:
    ((event: { preventDefault(): void }) => Promise<void>) | undefined;
  const unlisten = vi.fn();
  const destroy = vi.fn().mockResolvedValue(undefined);
  const onCloseRequested = vi.fn(
    (handler: (event: { preventDefault(): void }) => Promise<void>) => {
      closeHandler = handler;
      return Promise.resolve(unlisten);
    }
  );
  vi.mocked(getCurrentWindow).mockReturnValue({
    destroy,
    onCloseRequested
  } as unknown as ReturnType<typeof getCurrentWindow>);
  return {
    destroy,
    handler: () => {
      if (!closeHandler) {
        throw new Error('The desktop close handler was not registered.');
      }
      return closeHandler;
    },
    onCloseRequested,
    unlisten
  };
}

afterEach(() => {
  setCloudFunctionsEnabled(true);
  globalThis.localStorage.removeItem(CLOUD_FUNCTIONS_STORAGE_KEY);
  delete (window as Window & { __TAURI_INTERNALS__?: unknown })
    .__TAURI_INTERNALS__;
  vi.mocked(invoke).mockReset();
  vi.mocked(getCurrentWindow).mockReset();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('desktop bridge', () => {
  it('does not start browser or native cloud requests in offline mode', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    setCloudFunctionsEnabled(false);

    await expect(desktopFetch('/api/session')).rejects.toThrow(
      'Cloud features are disabled on this device.'
    );
    expect(fetch).not.toHaveBeenCalled();

    markDesktopRuntime();
    await expect(desktopFetch('/api/session')).rejects.toThrow(
      'Cloud features are disabled on this device.'
    );
    expect(invoke).not.toHaveBeenCalled();
  });

  it('opens external pages natively only in the desktop app', async () => {
    await expect(openExternalUrl('https://zcad.app/privacy')).resolves.toBe(
      false
    );
    expect(invoke).not.toHaveBeenCalled();

    markDesktopRuntime();
    vi.mocked(invoke).mockResolvedValue(undefined);
    await expect(openExternalUrl('https://zcad.app/privacy')).resolves.toBe(
      true
    );
    expect(invoke).toHaveBeenCalledWith('open_external_url', {
      url: 'https://zcad.app/privacy'
    });

    // The native allowlist refusal reaches the caller.
    vi.mocked(invoke).mockRejectedValue(
      'That link is not an approved OpenZCAD link.'
    );
    await expect(openExternalUrl('https://evil.example/')).rejects.toBe(
      'That link is not an approved OpenZCAD link.'
    );
  });

  it('detects the Tauri runtime without changing browser behavior', () => {
    expect(isDesktopApp()).toBe(false);
    markDesktopRuntime();
    expect(isDesktopApp()).toBe(true);
  });

  it('grants the native destroy permission required to finish a close request', () => {
    const capability = JSON.parse(
      readFileSync(
        resolve(
          process.cwd(),
          '../desktop/src-tauri/capabilities/default.json'
        ),
        'utf8'
      )
    ) as { permissions: string[] };

    expect(capability.permissions).toContain('core:window:allow-destroy');
  });

  it('allows an idle desktop close request to finish normally', async () => {
    markDesktopRuntime();
    const appWindow = mockDesktopWindow();
    const preventDefault = vi.fn();

    const unlisten = await protectDesktopClose(() => false);
    await appWindow.handler()({ preventDefault });

    expect(preventDefault).not.toHaveBeenCalled();
    expect(appWindow.destroy).not.toHaveBeenCalled();
    unlisten();
    expect(appWindow.unlisten).toHaveBeenCalledOnce();
  });

  it('destroys the window when a saving close is confirmed', async () => {
    markDesktopRuntime();
    const appWindow = mockDesktopWindow();
    const preventDefault = vi.fn();
    const confirm = vi.fn(() => true);
    vi.stubGlobal('confirm', confirm);

    await protectDesktopClose(() => true);
    await appWindow.handler()({ preventDefault });

    expect(preventDefault).toHaveBeenCalledOnce();
    expect(confirm).toHaveBeenCalledOnce();
    expect(appWindow.destroy).toHaveBeenCalledOnce();
  });

  it('routes binary exports to Rust as plain byte arrays', async () => {
    markDesktopRuntime();
    vi.mocked(invoke).mockResolvedValue(true);

    const saved = await saveCadBinaryFile(
      'bracket.3mf',
      '3mf',
      new Uint8Array([0x50, 0x4b, 0x03, 0x04])
    );

    expect(saved).toBe(true);
    expect(invoke).toHaveBeenCalledWith('save_cad_binary_file', {
      suggestedName: 'bracket.3mf',
      format: '3mf',
      contents: [0x50, 0x4b, 0x03, 0x04]
    });
  });

  it('downloads binary exports through a blob anchor in the browser', async () => {
    const createObjectURL = vi.fn<(blob: Blob) => string>(() => 'blob:mesh');
    const revokeObjectURL = vi.fn();
    vi.stubGlobal('URL', {
      ...URL,
      createObjectURL,
      revokeObjectURL
    });
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(() => undefined);

    const saved = await saveCadBinaryFile(
      'bracket.stl',
      'stl',
      new Uint8Array([1, 2, 3])
    );

    expect(saved).toBe(true);
    expect(createObjectURL).toHaveBeenCalledOnce();
    const blob = createObjectURL.mock.calls[0]![0];
    expect(blob.type).toBe('model/stl');
    expect(blob.size).toBe(3);
    expect(click).toHaveBeenCalledOnce();
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:mesh');
    expect(invoke).not.toHaveBeenCalled();
  });

  it('downloads PLY exports with the generic mesh content type', async () => {
    const createObjectURL = vi.fn<(blob: Blob) => string>(() => 'blob:ply');
    const revokeObjectURL = vi.fn();
    vi.stubGlobal('URL', {
      ...URL,
      createObjectURL,
      revokeObjectURL
    });
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(() => undefined);

    // PLY has no registered media type, so it keeps the generic one — the
    // same mapping `inferContentType` uses for `.ply` files.
    const saved = await saveCadBinaryFile(
      'bracket.ply',
      'ply',
      new Uint8Array([0x70, 0x6c, 0x79, 0x0a])
    );

    expect(saved).toBe(true);
    const blob = createObjectURL.mock.calls[0]![0];
    expect(blob.type).toBe('application/octet-stream');
    expect(blob.size).toBe(4);
    expect(click).toHaveBeenCalledOnce();
    expect(invoke).not.toHaveBeenCalled();
  });

  it('converts native bytes into a browser File with CAD content type', async () => {
    const file = nativeCadFile({
      name: 'bracket.STEP',
      bytes: [73, 83, 79]
    });
    expect(file.name).toBe('bracket.STEP');
    expect(file.type).toBe('model/step');
    expect(await file.text()).toBe('ISO');
  });

  it('types a native DXF pick as a DXF drawing', () => {
    const file = nativeCadFile({ name: 'plate.DXF', bytes: [48] });
    expect(file.type).toBe('image/vnd.dxf');
  });

  it('keeps cloud credentials in Rust while returning a fetch response', async () => {
    markDesktopRuntime();
    vi.mocked(invoke).mockResolvedValue({
      status: 200,
      contentType: 'application/json',
      body: Array.from(new TextEncoder().encode('{"ok":true}'))
    });

    const response = await desktopFetch('/api/settings', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: '{"theme":"dark"}'
    });

    expect(await response.json()).toEqual({ ok: true });
    expect(invoke).toHaveBeenCalledWith('desktop_api_request', {
      request: {
        method: 'PATCH',
        path: '/api/settings',
        contentType: 'application/json',
        body: Array.from(new TextEncoder().encode('{"theme":"dark"}'))
      }
    });
    expect(JSON.stringify(vi.mocked(invoke).mock.calls)).not.toContain(
      'Bearer'
    );
  });

  it('does not invoke Rust when an upload is aborted while its body is read', async () => {
    markDesktopRuntime();
    const controller = new AbortController();
    const body = new Blob(['queued upload']);
    vi.spyOn(body, 'arrayBuffer').mockImplementation(async () => {
      controller.abort();
      return new TextEncoder().encode('queued upload').buffer;
    });

    await expect(
      desktopFetch('/api/uploads', {
        method: 'POST',
        body,
        signal: controller.signal
      })
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(invoke).not.toHaveBeenCalled();
  });

  it.each([
    '/api/projects/proj_legacy',
    '/api/projects/proj_legacy/revisions/rev_legacy?existing=kept'
  ])(
    'negotiates raw legacy storage through older native hosts: %s',
    async (path) => {
      markDesktopRuntime();
      vi.mocked(invoke).mockResolvedValue({ status: 200, body: [] });
      await desktopFetch(path, {
        headers: { accept: LEGACY_PROJECT_FRAME_CONTENT_TYPE }
      });
      const expected = new URL(path, 'https://zcad.app');
      expected.searchParams.set('storage', 'raw');
      expect(invoke).toHaveBeenLastCalledWith('desktop_api_request', {
        request: {
          method: 'GET',
          path: expected.pathname + expected.search,
          contentType: undefined,
          body: undefined
        }
      });
      await desktopFetch(path);
      expect(invoke).toHaveBeenLastCalledWith('desktop_api_request', {
        request: {
          method: 'GET',
          path,
          contentType: undefined,
          body: undefined
        }
      });
    }
  );

  it('accepts only a ticketed fixed-origin collaboration URL from Rust', async () => {
    (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ =
      {};
    vi.mocked(invoke).mockResolvedValue(
      `wss://zcad.app/api/projects/proj_native/collaboration?ticket=${'t'.repeat(43)}`
    );

    await expect(desktopCollaborationUrl('proj_native')).resolves.toBe(
      `wss://zcad.app/api/projects/proj_native/collaboration?ticket=${'t'.repeat(43)}`
    );
    expect(invoke).toHaveBeenCalledWith('desktop_collaboration_url', {
      projectId: 'proj_native'
    });
    expect(JSON.stringify(vi.mocked(invoke).mock.calls)).not.toContain(
      'Bearer'
    );

    vi.mocked(invoke).mockResolvedValue(
      `wss://attacker.example/api/projects/proj_native/collaboration?ticket=${'t'.repeat(43)}`
    );
    await expect(desktopCollaborationUrl('proj_native')).rejects.toThrow(
      /not allowed/i
    );
  });

  it('keeps the key id a failed Keychain creation could not remove', async () => {
    markDesktopRuntime();
    const keyId = 'dk_' + 'a'.repeat(32);
    vi.mocked(invoke).mockRejectedValue({
      message: 'OpenZCAD could not save its device key to the Keychain.',
      keyId
    });
    const failed = await createNativeDeviceKeys().catch(
      (error: unknown) => error
    );
    expect(failed).toBeInstanceOf(NativeDeviceKeysError);
    expect(failed).toMatchObject({
      message: 'OpenZCAD could not save its device key to the Keychain.',
      keyId
    });
    expect(invoke).toHaveBeenCalledWith('create_device_keys', undefined);

    // A failure that left nothing behind names no key.
    vi.mocked(invoke).mockRejectedValue({
      message: 'No entropy.',
      keyId: null
    });
    await expect(createNativeDeviceKeys()).rejects.toMatchObject({
      name: 'NativeDeviceKeysError',
      keyId: null
    });
  });

  it('streams a share link blob from Rust piece by piece, only as it is read', async () => {
    markDesktopRuntime();
    mockNativeBlobStream([new Uint8Array([1, 2, 3]), new Uint8Array([4, 5])], {
      contentLength: 5
    });

    const response = await desktopFetch(sharedBlobUrl('AbC-12_x', BLOB_ID), {
      credentials: 'omit'
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('content-length')).toBe('5');
    expect(invoke).toHaveBeenCalledWith('desktop_blob_stream_open', {
      path: `/api/e2ee/share/AbC-12_x/blobs/${BLOB_ID}`
    });
    // Nothing is read from Rust before the caller reads the body.
    expect(nativeCommands()).toEqual(['desktop_blob_stream_open']);
    expect(Array.from(new Uint8Array(await response.arrayBuffer()))).toEqual([
      1, 2, 3, 4, 5
    ]);
    expect(nativeCommands()).not.toContain('desktop_api_request');
    expect(vi.mocked(invoke).mock.calls).toContainEqual([
      'desktop_blob_stream_read',
      { streamId: 'stream-1' }
    ]);
  });

  it('streams only blob and archived artifact reads; everything else stays buffered', async () => {
    markDesktopRuntime();
    mockNativeBlobStream([new Uint8Array([9])]);
    const streamed = await desktopFetch(
      `/api/e2ee/projects/proj_1/blobs/${BLOB_ID}`,
      { credentials: 'same-origin' }
    );
    await streamed.arrayBuffer();
    expect(invoke).toHaveBeenCalledWith('desktop_blob_stream_open', {
      path: `/api/e2ee/projects/proj_1/blobs/${BLOB_ID}`
    });

    for (const [path, init] of [
      ['/api/e2ee/share/AbC-12_x', {}],
      [`/api/e2ee/share/AbC-12_x/blobs/${BLOB_ID.toUpperCase()}`, {}],
      [`/api/e2ee/share/AbC-12_x/blobs/${BLOB_ID}?download=1`, {}],
      [`/api/e2ee/projects/proj_1/blobs?tag=${'a'.repeat(64)}`, {}],
      [
        '/api/e2ee/projects/proj_1/blobs/uploads',
        { method: 'POST', body: '{}' }
      ],
      [`/api/e2ee/projects/proj_1/blobs/${BLOB_ID}`, { method: 'DELETE' }],
      [`/api/projects/proj_1/assets/${BLOB_ID}`, {}],
      ['/api/artifacts/artifact_1/download?extra=1', {}],
      ['/api/artifacts/artifact_1/download', { method: 'DELETE' }],
      ['/api/artifacts/artifact_1/download', { method: 'POST', body: '{}' }]
    ] as const) {
      vi.mocked(invoke).mockReset();
      vi.mocked(invoke).mockResolvedValue({ status: 200, body: [] });
      await desktopFetch(path, init);
      expect(nativeCommands(), path).toEqual(['desktop_api_request']);
    }
  });

  it.each(['/api/artifacts/artifact_large/download', '/api/account/export'])(
    'streams an authenticated download above the buffered bridge limit: %s',
    async (path) => {
      markDesktopRuntime();
      const chunk = new Uint8Array(1024 * 1024).fill(17);
      const count = 51;
      mockNativeBlobStream(
        Array.from({ length: count }, () => chunk),
        {
          contentLength: count * chunk.byteLength
        }
      );
      const response = await desktopFetch(path);
      expect(invoke).toHaveBeenCalledWith('desktop_blob_stream_open', {
        path
      });
      const reader = response.body!.getReader();
      let total = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        expect(value[0]).toBe(17);
        total += value.byteLength;
      }
      expect(total).toBe(51 * 1024 * 1024);
      expect(nativeCommands()).not.toContain('desktop_api_request');
    }
  );

  it('carries a refused blob read back whole, with its status and words', async () => {
    markDesktopRuntime();
    mockNativeBlobStream([], {
      status: 404,
      contentType: 'application/json',
      streamId: null,
      body: Array.from(new TextEncoder().encode('{"error":"Not found."}'))
    });

    const response = await desktopFetch(sharedBlobUrl('AbC-12_x', BLOB_ID));

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'Not found.' });
    expect(nativeCommands()).toEqual(['desktop_blob_stream_open']);
  });

  it('ends the native download when the body is cancelled or the request aborted', async () => {
    markDesktopRuntime();
    mockNativeBlobStream([new Uint8Array([1]), new Uint8Array([2])]);
    const cancelled = await desktopFetch(sharedBlobUrl('AbC-12_x', BLOB_ID));
    const reader = cancelled.body!.getReader();
    await reader.read();
    await reader.cancel();
    expect(invoke).toHaveBeenCalledWith('desktop_blob_stream_cancel', {
      streamId: 'stream-1'
    });

    vi.mocked(invoke).mockClear();
    mockNativeBlobStream(['stall']);
    const controller = new AbortController();
    const aborted = await desktopFetch(sharedBlobUrl('AbC-12_x', BLOB_ID), {
      signal: controller.signal
    });
    const pending = aborted.body!.getReader().read();
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(invoke).toHaveBeenCalledWith('desktop_blob_stream_cancel', {
      streamId: 'stream-1'
    });
  });

  it('cancels a stream opened after its request was aborted', async () => {
    markDesktopRuntime();
    const controller = new AbortController();
    vi.mocked(invoke).mockImplementation(async (command: string) => {
      if (command === 'desktop_blob_stream_open') {
        controller.abort();
        return { status: 200, streamId: 'stream-1', body: [] };
      }
      return undefined;
    });

    await expect(
      desktopFetch(sharedBlobUrl('AbC-12_x', BLOB_ID), {
        signal: controller.signal
      })
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(invoke).toHaveBeenCalledWith('desktop_blob_stream_cancel', {
      streamId: 'stream-1'
    });
  });

  it('fails the body when Rust reports a broken download', async () => {
    markDesktopRuntime();
    mockNativeBlobStream([
      new Uint8Array([1]),
      new Error('The OpenZCAD cloud download stopped.')
    ]);
    const response = await desktopFetch(sharedBlobUrl('AbC-12_x', BLOB_ID));
    await expect(response.arrayBuffer()).rejects.toThrow(
      'The OpenZCAD cloud download stopped.'
    );
  });

  it('opens a share link blob larger than the buffered 50 MiB bridge cap', async () => {
    markDesktopRuntime();
    const MiB = 1024 * 1024;
    const pieces: Uint8Array[] = Array.from(
      { length: 60 },
      () => new Uint8Array(MiB)
    );
    pieces.push(new Uint8Array([7]));
    mockNativeBlobStream(pieces, { contentLength: 60 * MiB + 1 });

    const bytes = await readSharedSourceBytes(
      sharedBlobUrl('AbC-12_x', BLOB_ID),
      'bracket.step',
      desktopFetch,
      128 * MiB,
      30_000
    );

    expect(bytes?.byteLength).toBe(60 * MiB + 1);
    expect(bytes?.[60 * MiB]).toBe(7);
    expect(nativeCommands()).not.toContain('desktop_api_request');
  });

  it("keeps the share reader's size cap and idle budget over the native stream", async () => {
    markDesktopRuntime();
    // Past the cap: the reader stops, and so does the native download.
    mockNativeBlobStream([new Uint8Array(6), new Uint8Array(6)]);
    await expect(
      readSharedSourceBytes(
        sharedBlobUrl('AbC-12_x', BLOB_ID),
        'bracket.step',
        desktopFetch,
        10,
        30_000
      )
    ).resolves.toBeNull();
    expect(invoke).toHaveBeenCalledWith('desktop_blob_stream_cancel', {
      streamId: 'stream-1'
    });

    // A stalled native read fails within the idle budget and is cancelled.
    vi.mocked(invoke).mockClear();
    mockNativeBlobStream([new Uint8Array(1), 'stall']);
    await expect(
      readSharedSourceBytes(
        sharedBlobUrl('AbC-12_x', BLOB_ID),
        'bracket.step',
        desktopFetch,
        10,
        50
      )
    ).rejects.toThrow('stopped downloading');
    expect(invoke).toHaveBeenCalledWith('desktop_blob_stream_cancel', {
      streamId: 'stream-1'
    });
  });

  it("streams a member's encrypted project blob with its progress and cap", async () => {
    markDesktopRuntime();
    mockNativeBlobStream([new Uint8Array([1, 2]), new Uint8Array([3])]);
    const onProgress = vi.fn();
    const api = createContentBlobsApi(desktopFetch);

    const blob = await api.download(
      'proj_1',
      BLOB_ID,
      3,
      undefined,
      onProgress
    );

    expect(Array.from(new Uint8Array(await blob.arrayBuffer()))).toEqual([
      1, 2, 3
    ]);
    expect(onProgress).toHaveBeenCalledTimes(2);
    expect(invoke).toHaveBeenCalledWith('desktop_blob_stream_open', {
      path: `/api/e2ee/projects/proj_1/blobs/${BLOB_ID}`
    });

    vi.mocked(invoke).mockClear();
    mockNativeBlobStream([new Uint8Array([1, 2]), new Uint8Array([3, 4])]);
    await expect(api.download('proj_1', BLOB_ID, 3)).rejects.toMatchObject({
      code: 'limit-exceeded'
    });
    expect(invoke).toHaveBeenCalledWith('desktop_blob_stream_cancel', {
      streamId: 'stream-1'
    });
  });

  /** Each native stream answers its own number, then its end. */
  function mockNumberedNativeStreams() {
    let opened = 0;
    const served = new Set<string>();
    vi.mocked(invoke).mockImplementation(
      async (command: string, args?: unknown) => {
        if (command === 'desktop_blob_stream_open') {
          opened += 1;
          return { status: 200, streamId: `stream-${opened}`, body: [] };
        }
        const { streamId } = args as { streamId: string };
        if (command === 'desktop_blob_stream_read') {
          if (served.has(streamId)) return new ArrayBuffer(0);
          served.add(streamId);
          return new Uint8Array([Number(streamId.slice(7))]).buffer;
        }
        return undefined;
      }
    );
    return () => opened;
  }

  /** Lets queued native calls run (the bridge imports Tauri lazily). */
  async function settle() {
    for (let turn = 0; turn < 20; turn += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }

  it('queues blob reads past the native stream limit instead of failing them', async () => {
    markDesktopRuntime();
    const opened = mockNumberedNativeStreams();
    const fetches = Array.from({ length: 6 }, (_, index) =>
      desktopFetch(sharedBlobUrl(`token-${index}`, BLOB_ID))
    );
    await settle();
    // Four streams run; the rest wait for a slot rather than being refused.
    expect(opened()).toBe(4);

    const bodies: number[][] = [];
    for (const pending of fetches) {
      const response = await pending;
      bodies.push(Array.from(new Uint8Array(await response.arrayBuffer())));
    }
    expect(bodies).toHaveLength(6);
    expect(bodies.every((body) => body.length === 1)).toBe(true);
    expect(opened()).toBe(6);
  });

  it('rejects a request aborted during the Tauri await before queue registration', async () => {
    markDesktopRuntime();
    const opened = mockNumberedNativeStreams();
    const held = await Promise.all(
      Array.from({ length: 4 }, (_, index) =>
        desktopFetch(sharedBlobUrl(`token-held-${index}`, BLOB_ID))
      )
    );
    const controller = new AbortController();
    const outcome = desktopFetch(
      sharedBlobUrl('token-abort-before-queue', BLOB_ID),
      {
        signal: controller.signal
      }
    ).then(
      () => 'resolved',
      (error: unknown) => (error instanceof Error ? error.name : 'unknown')
    );
    // desktopFetch checked the signal, then yielded to tauriCore(). Abort
    // before nativeBlobStreamSlot registers its waiter, with all slots held.
    controller.abort();
    try {
      expect(
        await Promise.race([outcome, settle().then(() => 'pending')])
      ).toBe('AbortError');
      expect(opened()).toBe(4);
    } finally {
      await Promise.all(held.map((response) => response.body!.cancel()));
      await outcome;
    }
    // The rejected request neither opened a stream nor left a queue entry.
    const later = await desktopFetch(
      sharedBlobUrl('token-after-abort', BLOB_ID)
    );
    expect(opened()).toBe(5);
    await later.arrayBuffer();
  });

  it('drops a queued blob read whose request is aborted', async () => {
    markDesktopRuntime();
    const opened = mockNumberedNativeStreams();
    const held = await Promise.all(
      Array.from({ length: 4 }, (_, index) =>
        desktopFetch(sharedBlobUrl(`token-${index}`, BLOB_ID))
      )
    );
    const controller = new AbortController();
    const queued = desktopFetch(sharedBlobUrl('token-queued', BLOB_ID), {
      signal: controller.signal
    });
    await settle();
    controller.abort();
    await expect(queued).rejects.toMatchObject({ name: 'AbortError' });
    expect(opened()).toBe(4);

    // The aborted caller took no slot: the next one opens once a body ends.
    const next = desktopFetch(sharedBlobUrl('token-next', BLOB_ID));
    await settle();
    expect(opened()).toBe(4);
    await held[0]!.arrayBuffer();
    const response = await next;
    expect(opened()).toBe(5);
    expect(Array.from(new Uint8Array(await response.arrayBuffer()))).toEqual([
      5
    ]);

    // A cancelled body frees its slot too.
    await held[1]!.body!.cancel();
    await held[2]!.arrayBuffer();
    await held[3]!.arrayBuffer();
    const later = await Promise.all(
      Array.from({ length: 4 }, (_, index) =>
        desktopFetch(sharedBlobUrl(`token-later-${index}`, BLOB_ID))
      )
    );
    expect(opened()).toBe(9);
    await Promise.all(later.map((each) => each.arrayBuffer()));
  });
});
