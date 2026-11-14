/**
 * The one check every outbound project write passes (PR #1418): before
 * `desktopFetch` sends a request that changes a project, it asks the gate
 * `api.ts` installs whether that project may be written from this tab. A
 * project whose switch to end-to-end encryption this device has not seen
 * finish, or whose pin another tab reset, is refused here, before any
 * request leaves: saves, revisions, uploads, thumbnails, measurements,
 * view states, room submissions over HTTP and copies alike, whichever
 * module sends them.
 *
 * Upload-session routes name no project, so their senders name it
 * (`writingProject`), from the caller that opened the session, never from
 * the account's answers; an upload-session request nobody named is
 * refused. Room frames that carry the project's content go through
 * `sendProjectFrame`, which asks the same check just before the socket
 * sends.
 *
 * The only requests that pass unchecked are this device's own encrypt
 * migration's (`ungatedFetch`): the run that resolves the switch.
 *
 * Free of imports, so `desktopBridge.ts` can call it and tests that mock
 * that bridge lose nothing else.
 */

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

/** Throws to refuse a write of the project. */
export type ProjectWriteCheck = (projectId: string) => void;

let check: ProjectWriteCheck | null = null;
let ungated = 0;
/** The project the request being sent now writes, as its sender named it. */
let declared: string | null = null;

/**
 * Refuses a request into an upload session whose sender did not name the
 * project it writes, or named another project than the request does.
 * Session ids are the account's, so nothing in the request itself says
 * whose they are: an unnamed one is refused, never let through.
 */
export class UnownedProjectWriteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnownedProjectWriteError';
  }
}

export function installProjectWriteGate(gate: ProjectWriteCheck | null): void {
  check = gate;
}
const READS = new Set(['GET', 'HEAD', 'OPTIONS']);
/** `/api/projects/<word>` routes that name no project. */
const UNSCOPED = new Set(['reorder', 'purge']);
const PROJECT_ROUTE = /^\/api\/(?:e2ee\/)?projects\/([^/?#]+)/;
const UPLOAD_ROUTE = /^\/api\/uploads\/([^/?#]+)/;
/** Bodies larger than this name their project in their path. */
const MAX_PARSED_BODY = 64 * 1024;

function pathOf(input: RequestInfo | URL): string | null {
  const raw =
    typeof input === 'string'
      ? input
      : input instanceof URL
        ? input.href
        : input.url;
  try {
    return new URL(raw, 'http://local.invalid').pathname;
  } catch {
    return null;
  }
}

function decode(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/** The project a JSON body names, as a create, copy or finalize does. */
function bodyProject(body: unknown): string | null {
  if (typeof body !== 'string' || body.length > MAX_PARSED_BODY) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const record = parsed as Record<string, unknown>;
  for (const key of ['projectId', 'sourceProjectId']) {
    if (typeof record[key] === 'string') return record[key];
  }
  return null;
}

/**
 * The project a request writes, if it writes one. A request into an upload
 * session writes the project its sender declared (`writingProject`), and
 * is refused without one.
 */
export function writtenProject(
  input: RequestInfo | URL,
  init: RequestInit = {}
): string | null {
  const method = (
    init.method ??
    (typeof input === 'object' && 'method' in input ? input.method : 'GET')
  ).toUpperCase();
  if (READS.has(method)) return null;
  const path = pathOf(input);
  let named: string | null = null;
  if (path) {
    const project = PROJECT_ROUTE.exec(path);
    if (project?.[1] && !UNSCOPED.has(project[1])) named = decode(project[1]);
    else if (UPLOAD_ROUTE.test(path)) {
      if (!declared) {
        throw new UnownedProjectWriteError(
          'An upload did not say which project it belongs to. Nothing was sent.'
        );
      }
      return declared;
    }
  }
  named ??= bodyProject(init.body);
  if (declared && named && named !== declared) {
    throw new UnownedProjectWriteError(
      'A write named another project than the one it was sent for. Nothing was sent.'
    );
  }
  return declared ?? named;
}

/**
 * Refuses (throws) before a request that writes a project this tab may
 * not write. Called first thing in `desktopFetch`, synchronously.
 */
export function checkOutboundRequest(
  input: RequestInfo | URL,
  init: RequestInit = {}
): void {
  if (!check || ungated > 0) return;
  const projectId = writtenProject(input, init);
  if (projectId) check(projectId);
}

/**
 * Whether the gate refuses writes of the project now: for senders that
 * do not go through `desktopFetch` (the room's socket), checked before
 * they send.
 */
export function projectWriteBlocked(projectId: string): boolean {
  if (!check) return false;
  try {
    check(projectId);
    return false;
  } catch {
    return true;
  }
}

/**
 * Sends a frame that carries the project's content over its room socket,
 * asking the gate in the same synchronous step, immediately before the
 * send: whatever was awaited before (sealing, a lazy import, a lease),
 * a refusal made meanwhile sends nothing. Throws the gate's refusal.
 */
export function sendProjectFrame(
  projectId: string,
  socket: Pick<WebSocket, 'send'>,
  frame: string
): void {
  check?.(projectId);
  socket.send(frame);
}

/**
 * Sends `send` as a write of `projectId`: every request it makes
 * synchronously (as `desktopFetch` checks, before its first await) is
 * checked against that project. Upload-session requests name no project
 * in their path, so their senders declare it here; the project comes from
 * the caller that opened the session, never from the account's answers.
 */
export function writingProject<T>(projectId: string, send: () => T): T {
  const outer = declared;
  declared = projectId;
  try {
    return send();
  } finally {
    declared = outer;
  }
}

/**
 * The fetcher for this device's own encrypt migration: its staging,
 * cutover, purge and cancel are what resolve an unfinished switch, so the
 * gate does not refuse them. Nothing else uses it.
 */
export function ungatedFetch(fetcher: Fetch): Fetch {
  return (input, init) => {
    ungated += 1;
    try {
      // `desktopFetch` checks synchronously before its first await.
      return fetcher(input, init);
    } finally {
      ungated -= 1;
    }
  };
}
