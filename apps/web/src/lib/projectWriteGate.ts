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

/** Upload session id → the project it was opened for. */
const uploadSessions = new Map<string, string>();
const MAX_UPLOAD_SESSIONS = 512;

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

/** The project a request writes, if it writes one. */
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
  if (path) {
    const project = PROJECT_ROUTE.exec(path);
    if (project?.[1] && !UNSCOPED.has(project[1])) return decode(project[1]);
    const upload = UPLOAD_ROUTE.exec(path);
    if (upload?.[1]) {
      const owner = uploadSessions.get(decode(upload[1]));
      if (owner) return owner;
    }
  }
  return bodyProject(init.body);
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
 * Notes which project an upload session belongs to, from the answer that
 * opened it, so its part uploads are checked against that project too.
 */
export function noteOutboundResponse(
  input: RequestInfo | URL,
  init: RequestInit,
  response: Response
): void {
  if (!response.ok || (init.method ?? 'GET').toUpperCase() !== 'POST') return;
  const path = pathOf(input);
  if (!path) return;
  let projectId: string | null = null;
  if (path === '/api/uploads') projectId = bodyProject(init.body);
  else if (/^\/api\/e2ee\/projects\/[^/]+\/blobs\/uploads$/.test(path)) {
    projectId = writtenProject(input, init);
  }
  if (!projectId) return;
  const owner = projectId;
  void response
    .clone()
    .json()
    .then((body: unknown) => {
      const session = (body as { session?: { uploadSessionId?: unknown } })
        ?.session;
      if (typeof session?.uploadSessionId !== 'string') return;
      if (uploadSessions.size >= MAX_UPLOAD_SESSIONS) {
        const oldest = uploadSessions.keys().next().value;
        if (oldest !== undefined) uploadSessions.delete(oldest);
      }
      uploadSessions.set(session.uploadSessionId, owner);
    })
    .catch(() => undefined);
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
