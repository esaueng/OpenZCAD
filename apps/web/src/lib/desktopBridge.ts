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
  if (
    url.origin !== 'https://zcad.esau.app' ||
    !url.pathname.startsWith('/api/')
  ) {
    throw new Error('The desktop API destination is not allowed.');
  }
  return `${url.pathname}${url.search}`;
}

/**
 * Routes cloud requests through Rust so bearer credentials never enter the
 * WebView, localStorage, URLs, logs, or frontend bundles.
 */
export async function desktopFetch(
  input: RequestInfo | URL,
  init: RequestInit = {}
): Promise<Response> {
  if (!isDesktopApp()) {
    return fetch(input, init);
  }
  if (init.signal?.aborted) {
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
  if (init.signal?.aborted) {
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
}> {
  if (!isDesktopApp()) {
    throw new Error('Desktop sign-in is only available in the macOS app.');
  }
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke('start_desktop_sign_in');
}

export async function pollDesktopSignIn(): Promise<DesktopAuthPollResult> {
  if (!isDesktopApp()) {
    throw new Error('Desktop sign-in is only available in the macOS app.');
  }
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<DesktopAuthPollResult>('poll_desktop_sign_in');
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
