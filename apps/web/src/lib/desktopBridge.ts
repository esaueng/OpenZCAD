import { assertCloudFunctionsEnabled, cloudRequestSignal } from './cloudMode';

export type DesktopMenuCommand =
  | 'open-model'
  | 'save-project'
  | 'export-step'
  | 'export-stl'
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
  const { invoke } = await import('@tauri-apps/api/core');
  const result = await invoke<NativeApiResponse>('desktop_api_request', {
    request: {
      method: init.method ?? 'GET',
      path: apiPath(input),
      contentType: headers.get('content-type') ?? undefined,
      body: await requestBodyBytes(init.body)
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
  return name.toLowerCase().endsWith('.stl') ? 'model/stl' : 'model/step';
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

function downloadTextFile(
  fileName: string,
  contents: string,
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
  format: 'step' | 'stl',
  contents: string
): Promise<boolean> {
  if (!isDesktopApp()) {
    downloadTextFile(
      suggestedName,
      contents,
      format === 'step' ? 'model/step' : 'model/stl'
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
