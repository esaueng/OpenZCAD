/**
 * The iPhone and iPad app's native session (ADR-026). The app serves this
 * web app from its private origin, `zcad-ipad://app`, and its Swift side
 * holds the cloud session: it proxies `/api/*` on that origin with a bearer
 * credential the WebView never sees, and answers session operations over one
 * message handler, `openzcadNative`.
 */

export const IOS_SHELL_PROTOCOL = 'zcad-ipad:';
/**
 * The single-send credential handle a project request carries to the
 * native proxy (`ApiProxy.preparedHeader`). Native strips it before
 * forwarding.
 */
export const NATIVE_PREPARED_HEADER = 'x-openzcad-prepared';

type NativeOperation =
  | 'capabilities'
  | 'session.status'
  | 'session.signIn'
  | 'session.signOut'
  | 'session.prepare';

interface NativeHandler {
  postMessage(message: { v: 1; op: NativeOperation }): Promise<unknown>;
}

interface WebKitWindow {
  webkit?: { messageHandlers?: { openzcadNative?: NativeHandler } };
}

/** Whether this page runs inside the iPhone and iPad app. */
export function isIosShell(): boolean {
  return (
    typeof globalThis.location !== 'undefined' &&
    globalThis.location.protocol === IOS_SHELL_PROTOCOL
  );
}

function handler(): NativeHandler | null {
  if (!isIosShell()) return null;
  return (
    (globalThis as WebKitWindow).webkit?.messageHandlers?.openzcadNative ?? null
  );
}

/**
 * Whether the app offers a native cloud session. An app without the
 * handler (an older build) stays offline; it never falls back to the web
 * sign-in or to cookies.
 */
export function nativeSessionAvailable(): boolean {
  return handler() !== null;
}

/** A failed native operation, named as the matching DOMException. */
export class NativeShellError extends Error {
  constructor(
    readonly errorName: string,
    message: string
  ) {
    super(message);
    this.name = errorName;
  }
}

async function call(op: NativeOperation): Promise<Record<string, unknown>> {
  const native = handler();
  if (!native) {
    throw new NativeShellError(
      'NotSupportedError',
      'Sign-in needs a newer version of the OpenZCAD app.'
    );
  }
  const reply = await native.postMessage({ v: 1, op });
  if (!reply || typeof reply !== 'object') {
    throw new NativeShellError('NotSupportedError', 'The app gave no answer.');
  }
  const { ok, result, error } = reply as {
    ok?: unknown;
    result?: unknown;
    error?: { name?: unknown; message?: unknown };
  };
  if (ok === true && result && typeof result === 'object') {
    return result as Record<string, unknown>;
  }
  throw new NativeShellError(
    typeof error?.name === 'string' ? error.name : 'NotSupportedError',
    typeof error?.message === 'string'
      ? error.message
      : 'The app refused the request.'
  );
}

let bridgeChecked: Promise<boolean> | undefined;

/** Whether the app answers bridge version 1. Asked once per page. */
export function nativeBridgeReady(): Promise<boolean> {
  return (bridgeChecked ??= nativeSessionAvailable()
    ? call('capabilities')
        .then((result) => result.bridge === 1)
        .catch(() => false)
    : Promise.resolve(false));
}

async function signedIn(op: NativeOperation): Promise<boolean> {
  if (!(await nativeBridgeReady())) {
    throw new NativeShellError(
      'NotSupportedError',
      'Sign-in needs a newer version of the OpenZCAD app.'
    );
  }
  const result = await call(op);
  if (typeof result.signedIn !== 'boolean') {
    throw new NativeShellError('NotSupportedError', 'The app gave no answer.');
  }
  return result.signedIn;
}

/**
 * Runs the app's sign-in: a code, the approval page in a private browser
 * sheet, and the PKCE exchange. Resolves true once a session is installed.
 * A cancelled sign-in rejects with `NotAllowedError`.
 */
export function nativeSignIn(): Promise<boolean> {
  return signedIn('session.signIn');
}

/** Ends the app's session, on the server and in the Keychain. */
export function nativeSignOut(): Promise<boolean> {
  return signedIn('session.signOut');
}

/**
 * Readies the credential one project request is sent with: an opaque,
 * single-use handle, never a token. Null when signed out.
 */
export async function nativePrepare(): Promise<string | null> {
  const result = await call('session.prepare');
  const handle = result.handle;
  if (handle === null) return null;
  if (typeof handle !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(handle)) {
    throw new NativeShellError('NotSupportedError', 'The app gave no answer.');
  }
  return handle;
}

/**
 * A request body the native proxy receives whole. WebKit hands a scheme
 * task no body at all for a Blob (`NativeTransportProbeTests`), so a Blob
 * is read into bytes first.
 */
export async function shellRequestBody(
  body: BodyInit | null | undefined
): Promise<string | ArrayBuffer | ArrayBufferView | undefined> {
  if (body === undefined || body === null) return undefined;
  if (typeof body === 'string') return body;
  if (body instanceof Blob) return body.arrayBuffer();
  if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) return body;
  throw new Error('This request body is not supported by the OpenZCAD app.');
}
