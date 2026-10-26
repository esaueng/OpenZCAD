import type { invoke as tauriInvoke } from '@tauri-apps/api/core';
import { assertCloudFunctionsEnabled, cloudRequestSignal } from './cloudMode';

export type DesktopMenuCommand =
  | 'open-model'
  | 'save-project'
  | 'export-step'
  | 'export-mesh'
  | 'undo'
  | 'redo'
  | 'settings';

interface NativeCadFile {
  name: string;
  bytes: number[];
}

interface TauriWindow extends Window {
  __TAURI_INTERNALS__?: unknown;
}

interface NativeApiResponse {
  status: number;
  contentType?: string;
  body: number[];
}

const CLOUD_API_ORIGIN = 'https://zcad.app';
const CLOUD_SOCKET_ORIGIN = 'wss://zcad.app';

export interface DesktopAuthPollResult {
  status: 'pending' | 'authorized';
  session?: {
    userId: string;
    displayName: string;
    email?: string;
    mode: 'email-code';
  };
}

export function isDesktopApp(): boolean {
  return (
    typeof window !== 'undefined' &&
    '__TAURI_INTERNALS__' in (window as TauriWindow)
  );
}

async function requestBodyBytes(body: BodyInit | null | undefined) {
  if (body === undefined || body === null) {
    return undefined;
  }
  if (typeof body === 'string') {
    return Array.from(new TextEncoder().encode(body));
  }
  if (body instanceof Blob) {
    return Array.from(new Uint8Array(await body.arrayBuffer()));
  }
  if (body instanceof ArrayBuffer) {
    return Array.from(new Uint8Array(body));
  }
  if (ArrayBuffer.isView(body)) {
    return Array.from(
      new Uint8Array(body.buffer, body.byteOffset, body.byteLength)
    );
  }
  throw new Error('This request body is not supported by the desktop client.');
}

function apiPath(input: RequestInfo | URL): string {
  if (typeof input !== 'string' && !(input instanceof URL)) {
    throw new Error('Desktop API requests must use a URL or path.');
  }
  const value = String(input);
  if (value.startsWith('/api/')) {
    return value;
  }
  const url = new URL(value);
  if (url.origin !== CLOUD_API_ORIGIN || !url.pathname.startsWith('/api/')) {
    throw new Error('The desktop API destination is not allowed.');
  }
  return `${url.pathname}${url.search}`;
}

/**
 * Asks Rust to exchange its in-memory bearer credential for a one-use room
 * ticket. Only the fixed-origin WebSocket URL crosses back into the WebView.
 */
export async function desktopCollaborationUrl(
  projectId: string
): Promise<string> {
  assertCloudFunctionsEnabled();
  if (!isDesktopApp()) {
    throw new Error(
      'Desktop collaboration is only available in the macOS app.'
    );
  }
  const { invoke } = await import('@tauri-apps/api/core');
  const value = await invoke<string>('desktop_collaboration_url', {
    projectId
  });
  assertCloudFunctionsEnabled();
  const url = new URL(value);
  const expectedPath = `/api/projects/${encodeURIComponent(projectId)}/collaboration`;
  const tickets = url.searchParams.getAll('ticket');
  if (
    url.origin !== CLOUD_SOCKET_ORIGIN ||
    url.pathname !== expectedPath ||
    url.hash !== '' ||
    Array.from(url.searchParams.keys()).some((key) => key !== 'ticket') ||
    tickets.length !== 1 ||
    !/^[A-Za-z0-9_-]{43}$/.test(tickets[0]!)
  ) {
    throw new Error('The native collaboration URL is not allowed.');
  }
  return url.toString();
}

interface NativeBlobStreamStart {
  status: number;
  contentType?: string | null;
  contentLength?: number | null;
  /** Set for a 200 body, which stays in Rust until read. */
  streamId?: string | null;
  body: number[];
}

type NativeInvoke = typeof tauriInvoke;

/**
 * The encrypted content blob reads Rust streams instead of buffering
 * (`blob_stream_destination` in `desktop_auth.rs`, which has the final say):
 * a share link's anonymous read and a member's read of a project's blob. A
 * 128 MiB import source or mesh payload is larger than the buffered bridge's
 * 50 MiB response cap.
 */
const NATIVE_BLOB_STREAM_PATH =
  /^\/api\/e2ee\/(?:share|projects)\/[A-Za-z0-9_-]{1,256}\/blobs\/[0-9a-f]{32}$/;

function isNativeBlobStreamPath(path: string): boolean {
  return NATIVE_BLOB_STREAM_PATH.test(path);
}

function abortError(): DOMException {
  return new DOMException('The operation was aborted.', 'AbortError');
}

function nativeChunk(value: unknown): Uint8Array<ArrayBuffer> {
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(
      value.buffer,
      value.byteOffset,
      value.byteLength
    ).slice();
  }
  if (Array.isArray(value)) return Uint8Array.from(value as number[]);
  throw new Error('The OpenZCAD cloud download returned invalid data.');
}

function nativeError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

/**
 * Native blob streams open at once: Rust's own limit
 * (`MAX_NATIVE_BLOB_STREAMS`), which refuses a fifth outright. Callers past it
 * wait here for a slot instead, so a shelf of encrypted thumbnails, each its
 * own download, all load (#938 review).
 */
const NATIVE_BLOB_STREAM_SLOTS = 4;
/**
 * A body nobody has read for this long is let go, as Rust lets go of an unread
 * stream (`NATIVE_BLOB_STREAM_UNREAD`), so an abandoned response cannot hold a
 * slot for good.
 */
const NATIVE_BLOB_STREAM_UNREAD_MS = 60_000;
let nativeBlobStreamsOpen = 0;
const nativeBlobStreamWaiters: (() => void)[] = [];

function releaseNativeBlobStreamSlot(): void {
  // A waiting caller takes the slot over; otherwise it is free again.
  const next = nativeBlobStreamWaiters.shift();
  if (next) next();
  else nativeBlobStreamsOpen -= 1;
}

/**
 * A slot for one native stream, now or once one frees up; its release runs
 * once. A caller whose signal aborts while waiting leaves the queue.
 */
function nativeBlobStreamSlot(signal: AbortSignal): Promise<() => void> {
  const held = (): (() => void) => {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      releaseNativeBlobStreamSlot();
    };
  };
  if (nativeBlobStreamsOpen < NATIVE_BLOB_STREAM_SLOTS) {
    nativeBlobStreamsOpen += 1;
    return Promise.resolve(held());
  }
  return new Promise((resolve, reject) => {
    function granted(): void {
      signal.removeEventListener('abort', aborted);
      resolve(held());
    }
    function aborted(): void {
      const index = nativeBlobStreamWaiters.indexOf(granted);
      if (index >= 0) nativeBlobStreamWaiters.splice(index, 1);
      reject(abortError());
    }
    nativeBlobStreamWaiters.push(granted);
    signal.addEventListener('abort', aborted, { once: true });
  });
}

/**
 * A blob download whose body Rust holds and hands over one bounded piece per
 * read of this response, keeping only a few network chunks ahead of the
 * reader, so the caller's own size cap bounds what the WebView buffers and
 * every piece is progress for its idle budget. Cancelling the body or
 * aborting `signal` ends the native download. At most
 * `NATIVE_BLOB_STREAM_SLOTS` run at once; later ones wait their turn.
 */
async function nativeBlobStream(
  invoke: NativeInvoke,
  path: string,
  signal: AbortSignal
): Promise<Response> {
  const releaseSlot = await nativeBlobStreamSlot(signal);
  let started: NativeBlobStreamStart;
  try {
    assertCloudFunctionsEnabled();
    if (signal.aborted) throw abortError();
    started = await invoke<NativeBlobStreamStart>('desktop_blob_stream_open', {
      path
    });
  } catch (error) {
    releaseSlot();
    throw error;
  }
  const streamId = started.streamId ?? null;
  let finished = false;
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  let unread: ReturnType<typeof setTimeout> | undefined;
  function release(): boolean {
    if (finished) return false;
    finished = true;
    clearTimeout(unread);
    signal.removeEventListener('abort', aborted);
    return true;
  }
  function cancelNative(): void {
    if (streamId === null) {
      releaseSlot();
      return;
    }
    // The slot frees only once Rust has let go, so the next open fits.
    void Promise.resolve()
      .then(() => invoke('desktop_blob_stream_cancel', { streamId }))
      .catch(() => undefined)
      .finally(releaseSlot);
  }
  function aborted(): void {
    if (!release()) return;
    cancelNative();
    controller?.error(abortError());
  }
  function watchUnread(): void {
    clearTimeout(unread);
    unread = setTimeout(() => {
      if (!release()) return;
      cancelNative();
      controller?.error(
        new Error('The OpenZCAD cloud download was abandoned unread.')
      );
    }, NATIVE_BLOB_STREAM_UNREAD_MS);
  }
  try {
    assertCloudFunctionsEnabled();
  } catch (error) {
    release();
    cancelNative();
    throw error;
  }
  if (signal.aborted) {
    release();
    cancelNative();
    throw abortError();
  }
  const headers = new Headers();
  if (started.contentType) headers.set('content-type', started.contentType);
  if (streamId === null) {
    finished = true;
    releaseSlot();
    return new Response(new Uint8Array(started.body), {
      status: started.status,
      headers
    });
  }
  if (typeof started.contentLength === 'number') {
    headers.set('content-length', String(started.contentLength));
  }
  signal.addEventListener('abort', aborted, { once: true });
  watchUnread();
  const body = new ReadableStream<Uint8Array>(
    {
      start(streamController) {
        controller = streamController;
      },
      async pull(streamController) {
        // A read in flight is not unread; Rust's idle timeout bounds it.
        clearTimeout(unread);
        let chunk: Uint8Array<ArrayBuffer>;
        try {
          chunk = nativeChunk(
            await invoke<unknown>('desktop_blob_stream_read', { streamId })
          );
        } catch (error) {
          // Rust has released a stream whose read failed.
          if (release()) {
            releaseSlot();
            streamController.error(nativeError(error));
          }
          return;
        }
        if (finished) return;
        if (chunk.byteLength === 0) {
          // Rust has released a stream at its end.
          release();
          releaseSlot();
          streamController.close();
          return;
        }
        streamController.enqueue(chunk);
        watchUnread();
      },
      cancel() {
        if (release()) cancelNative();
      }
    },
    // Read only when the caller asks: Rust holds the rest of the body.
    { highWaterMark: 0 }
  );
  return new Response(body, { status: started.status, headers });
}

function importTauriCore() {
  return import('@tauri-apps/api/core');
}
let tauriCoreModule: ReturnType<typeof importTauriCore> | undefined;

/** One import shared by concurrent requests (a shelf of blob reads). */
function tauriCore(): ReturnType<typeof importTauriCore> {
  return (tauriCoreModule ??= importTauriCore());
}

/**
 * Routes cloud requests through Rust so bearer credentials never enter the
 * WebView, localStorage, URLs, logs, or frontend bundles.
 */
export async function desktopFetch(
  input: RequestInfo | URL,
  init: RequestInit = {}
): Promise<Response> {
  const signal = cloudRequestSignal(init.signal);
  if (!isDesktopApp()) {
    return fetch(input, { ...init, signal });
  }
  if (signal.aborted) {
    throw new DOMException('The operation was aborted.', 'AbortError');
  }
  const headers = new Headers(init.headers);
  const { invoke } = await tauriCore();
  const path = apiPath(input);
  if (
    (init.method ?? 'GET').toUpperCase() === 'GET' &&
    (init.body === undefined || init.body === null) &&
    isNativeBlobStreamPath(path)
  ) {
    return nativeBlobStream(invoke, path, signal);
  }
  const body = await requestBodyBytes(init.body);
  if (signal.aborted) {
    throw new DOMException('The operation was aborted.', 'AbortError');
  }
  const result = await invoke<NativeApiResponse>('desktop_api_request', {
    request: {
      method: init.method ?? 'GET',
      path,
      contentType: headers.get('content-type') ?? undefined,
      body
    }
  });
  assertCloudFunctionsEnabled();
  if (signal.aborted) {
    throw new DOMException('The operation was aborted.', 'AbortError');
  }
  return new Response(new Uint8Array(result.body), {
    status: result.status,
    headers: result.contentType
      ? { 'content-type': result.contentType }
      : undefined
  });
}

export async function startDesktopSignIn(): Promise<{
  expiresInSeconds: number;
  userCode: string;
}> {
  assertCloudFunctionsEnabled();
  if (!isDesktopApp()) {
    throw new Error('Desktop sign-in is only available in the macOS app.');
  }
  const { invoke } = await import('@tauri-apps/api/core');
  const result = await invoke<{
    expiresInSeconds: number;
    userCode: string;
  }>('start_desktop_sign_in');
  assertCloudFunctionsEnabled();
  return result;
}

export async function pollDesktopSignIn(): Promise<DesktopAuthPollResult> {
  assertCloudFunctionsEnabled();
  if (!isDesktopApp()) {
    throw new Error('Desktop sign-in is only available in the macOS app.');
  }
  const { invoke } = await import('@tauri-apps/api/core');
  const result = await invoke<DesktopAuthPollResult>('poll_desktop_sign_in');
  assertCloudFunctionsEnabled();
  return result;
}

export async function cancelDesktopSignIn(): Promise<void> {
  if (!isDesktopApp()) {
    return;
  }
  const { invoke } = await import('@tauri-apps/api/core');
  await invoke('cancel_desktop_sign_in');
}

function contentTypeFor(name: string): string {
  const lower = name.toLowerCase();
  if (lower.endsWith('.stl')) return 'model/stl';
  if (lower.endsWith('.dxf')) return 'image/vnd.dxf';
  return 'model/step';
}

export function nativeCadFile(value: NativeCadFile): File {
  return new File([Uint8Array.from(value.bytes)], value.name, {
    type: contentTypeFor(value.name)
  });
}

export async function openDesktopCadFile(): Promise<File | null> {
  if (!isDesktopApp()) {
    return null;
  }
  const { invoke } = await import('@tauri-apps/api/core');
  const selected = await invoke<NativeCadFile | null>('open_cad_file');
  return selected ? nativeCadFile(selected) : null;
}

function downloadBlobFile(
  fileName: string,
  contents: BlobPart,
  contentType: string
): void {
  const href = URL.createObjectURL(new Blob([contents], { type: contentType }));
  const anchor = document.createElement('a');
  anchor.href = href;
  anchor.download = fileName;
  anchor.click();
  URL.revokeObjectURL(href);
}

export async function saveCadTextFile(
  suggestedName: string,
  format: 'step' | 'stl' | 'dxf' | 'svg',
  contents: string
): Promise<boolean> {
  if (!isDesktopApp()) {
    downloadBlobFile(
      suggestedName,
      contents,
      format === 'step'
        ? 'model/step'
        : format === 'dxf'
          ? 'image/vnd.dxf'
          : format === 'svg'
            ? 'image/svg+xml'
            : 'model/stl'
    );
    return true;
  }
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<boolean>('save_cad_file', {
    suggestedName,
    format,
    contents
  });
}

const BINARY_EXPORT_CONTENT_TYPES = {
  stl: 'model/stl',
  '3mf': 'model/3mf',
  obj: 'model/obj',
  glb: 'model/gltf-binary',
  // PLY has no registered media type, so it keeps the generic one — the
  // same mapping `inferContentType` in model.ts uses for `.ply` files.
  ply: 'application/octet-stream',
  png: 'image/png',
  pdf: 'application/pdf'
} as const;

export type CadBinaryExportFormat = keyof typeof BINARY_EXPORT_CONTENT_TYPES;

/**
 * Binary twin of `saveCadTextFile` for mesh exports. Bytes cross into Rust
 * as a plain array, the same shape `open_cad_file` already uses in the
 * other direction.
 */
export async function saveCadBinaryFile(
  suggestedName: string,
  format: CadBinaryExportFormat,
  contents: Uint8Array<ArrayBuffer>
): Promise<boolean> {
  if (!isDesktopApp()) {
    downloadBlobFile(
      suggestedName,
      contents,
      BINARY_EXPORT_CONTENT_TYPES[format]
    );
    return true;
  }
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<boolean>('save_cad_binary_file', {
    suggestedName,
    format,
    contents: Array.from(contents)
  });
}

export async function listenForDesktopMenu(
  handler: (command: DesktopMenuCommand) => void
): Promise<() => void> {
  if (!isDesktopApp()) {
    return () => undefined;
  }
  const { listen } = await import('@tauri-apps/api/event');
  return listen<DesktopMenuCommand>('openzcad://menu', (event) => {
    handler(event.payload);
  });
}

export async function protectDesktopClose(
  shouldConfirm: () => boolean
): Promise<() => void> {
  if (!isDesktopApp()) {
    return () => undefined;
  }
  const { getCurrentWindow } = await import('@tauri-apps/api/window');
  const appWindow = getCurrentWindow();
  return appWindow.onCloseRequested(async (event) => {
    if (!shouldConfirm()) {
      return;
    }
    event.preventDefault();
    if (
      window.confirm(
        'OpenZCAD is still saving this project on this device. Close anyway?'
      )
    ) {
      await appWindow.destroy();
    }
  });
}

/** A device key pair the macOS Keychain holds; only public halves cross. */
export interface NativeDeviceKeys {
  keyId: string;
  signingPublicKey: Uint8Array;
  unlockPublicKey: Uint8Array;
}

async function invokeDeviceKeys<T>(
  command: string,
  args?: Record<string, unknown>
): Promise<T> {
  if (!isDesktopApp()) {
    throw new Error(
      'Keychain device keys are only available in the macOS app.'
    );
  }
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<T>(command, args);
}

/**
 * A failed Keychain key creation. `keyId` names keys the host stored but
 * could not remove again; they stay in the Keychain until a later
 * `deleteNativeDeviceKeys(keyId)` succeeds, and this is their only name.
 */
export class NativeDeviceKeysError extends Error {
  constructor(
    message: string,
    readonly keyId: string | null
  ) {
    super(message);
    this.name = 'NativeDeviceKeysError';
  }
}

function nativeCreateError(error: unknown): unknown {
  if (typeof error !== 'object' || error === null) return error;
  const { message, keyId } = error as { message?: unknown; keyId?: unknown };
  if (typeof message !== 'string') return error;
  return new NativeDeviceKeysError(
    message,
    typeof keyId === 'string' ? keyId : null
  );
}

/**
 * Creates this desktop's device signing and unlock keys in the Keychain
 * (ADR-024, Unlock and devices). The private halves never enter the WebView.
 */
export async function createNativeDeviceKeys(): Promise<NativeDeviceKeys> {
  const created = await invokeDeviceKeys<{
    keyId: string;
    signingPublicKey: number[];
    unlockPublicKey: number[];
  }>('create_device_keys').catch((error: unknown) => {
    throw nativeCreateError(error);
  });
  return {
    keyId: created.keyId,
    signingPublicKey: Uint8Array.from(created.signingPublicKey),
    unlockPublicKey: Uint8Array.from(created.unlockPublicKey)
  };
}

/** ECDSA P-256/SHA-256 with the Keychain signing key: the 64-byte r || s. */
export async function signWithNativeDeviceKey(
  keyId: string,
  message: Uint8Array
): Promise<Uint8Array> {
  return Uint8Array.from(
    await invokeDeviceKeys<number[]>('sign_with_device_key', {
      keyId,
      message: Array.from(message)
    })
  );
}

/** The 32-byte ECDH secret between the Keychain unlock key and `peer`. */
export async function deriveWithNativeDeviceKey(
  keyId: string,
  peer: Uint8Array
): Promise<Uint8Array> {
  return Uint8Array.from(
    await invokeDeviceKeys<number[]>('derive_with_device_key', {
      keyId,
      peer: Array.from(peer)
    })
  );
}

export async function deleteNativeDeviceKeys(keyId: string): Promise<void> {
  await invokeDeviceKeys<void>('delete_device_keys', { keyId });
}
