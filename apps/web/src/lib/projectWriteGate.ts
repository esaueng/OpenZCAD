/**
 * The one check every outbound project write passes (PR #1418).
 *
 * INVARIANT: the check runs synchronously immediately before every send,
 * using request-local context. Whatever a sender decided earlier (that a
 * project is not encrypted, that it may be written) may be out of date by
 * the time its request leaves: a listing or another tab can pin the
 * project, mark its switch to encryption unresolved, or reset it during
 * any await. So the decision travels with the request, as its context,
 * and is checked again at the last synchronous step before the bytes
 * leave, with no await between that check and the send:
 *
 * - `desktopFetch` checks immediately before `fetch` and immediately
 *   before the native `desktop_api_request` invoke, after every await of
 *   its own (loading Tauri, reading the body);
 * - room frames go through `sendProjectFrame`, which checks immediately
 *   before `socket.send`.
 *
 * A request's context says which project it writes, whether its payload
 * is the project's content in plaintext or encrypted (`projectRequest`),
 * and whether it is one of this device's own migration requests
 * (`migrationFetch`). It is attached to the request itself, never kept in
 * module state that an await could unwind or another request could see.
 * Any new sender of project content must declare it the same way;
 * `projectRequestContext.test.ts` asserts every content path does.
 *
 * Refused at send time: any write of a project this tab may not write (a
 * switch to encryption this device has not seen finish, or a reset made in
 * another tab), and any plaintext content of a project this device holds
 * as encrypted now (`ProjectWriteCheck`). A request to a route that
 * carries project content without a declared context, or into an upload
 * session without a declared project, is refused outright.
 *
 * Free of imports, so `desktopBridge.ts` can call it and tests that mock
 * that bridge lose nothing else.
 */

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

/** What a request carries of its project. */
export type ProjectPayload = 'plaintext' | 'encrypted' | 'none';

/** The project a request writes, as its sender declared it. */
export interface ProjectRequestContext {
  readonly projectId: string;
  readonly payload: ProjectPayload;
}

/**
 * This device's own migration runs. `encrypt`: staging, cutover, purge
 * and cancel are what resolve an unfinished switch, so they pass
 * unchecked. `decrypt`: the reverse run stages the project's plaintext
 * beside its ciphertext before its cutover, so its plaintext passes, but
 * it is refused like any write while the project may not be written.
 */
export type MigrationKind = 'encrypt' | 'decrypt';

interface RequestContext {
  readonly project?: ProjectRequestContext;
  readonly migration?: MigrationKind;
}

const CONTEXT: unique symbol = Symbol('openzcad.projectRequest');

/** A `RequestInit` that carries its request's context. */
export type ProjectRequestInit = RequestInit & {
  readonly [CONTEXT]?: RequestContext;
};

/** A request as the gate resolved it, before it is sent. */
export interface ResolvedProjectRequest {
  /** The project the request writes; null for none (or a read). */
  readonly projectId: string | null;
  readonly payload: ProjectPayload;
  readonly migration: MigrationKind | null;
}

/**
 * Throws to refuse a request. Installed by `api.ts`, which knows the
 * project's pins.
 */
export type ProjectWriteCheck = (request: {
  readonly projectId: string;
  readonly payload: ProjectPayload;
  readonly migration: MigrationKind | null;
}) => void;

let check: ProjectWriteCheck | null = null;

export function installProjectWriteGate(gate: ProjectWriteCheck | null): void {
  check = gate;
}

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

/** Refuses a request to a content route that declared no context. */
export class UndeclaredProjectRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UndeclaredProjectRequestError';
  }
}

function contextOf(
  init: ProjectRequestInit | undefined
): RequestContext | undefined {
  return init?.[CONTEXT];
}

/** `init` (copied) declared as a request carrying `context`'s project. */
export function projectRequest(
  context: ProjectRequestContext,
  init: RequestInit = {}
): ProjectRequestInit {
  return { ...init, [CONTEXT]: { ...contextOf(init), project: context } };
}

/** The project context `init` declares, if it declares one. */
export function declaredProjectContext(
  init: RequestInit | undefined
): ProjectRequestContext | undefined {
  return contextOf(init)?.project;
}

/** The migration `init` belongs to, if any. */
export function declaredMigration(
  init: RequestInit | undefined
): MigrationKind | undefined {
  return contextOf(init)?.migration;
}

const READS = new Set(['GET', 'HEAD', 'OPTIONS']);
/** `/api/projects/<word>` routes that name no project. */
const UNSCOPED = new Set(['reorder', 'purge']);
const PROJECT_ROUTE = /^\/api\/(e2ee\/)?projects\/([^/?#]+)(\/[^?#]*)?/;
const UPLOAD_ROUTE = /^\/api\/uploads(?:\/|$)/;
/** Project subroutes whose writes are the project's content. */
const CONTENT_SUBROUTES =
  /^\/(?:document|revisions|duplicate|measurements|workspace-sessions|collaboration)(?:\/|$)/;
/** Of those, the ones that only ever carry plaintext. */
const PLAINTEXT_SUBROUTES =
  /^\/(?:document|revisions|duplicate|measurements|workspace-sessions)(?:\/|$)/;
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

/** What a write's route says of it. */
function routeOf(path: string | null): {
  project: string | null;
  /** Its writes are the project's content: a context must be declared. */
  content: boolean;
  /** Its content is plaintext whatever is declared. */
  plaintext: boolean;
  /** An upload-session route: names no project of its own. */
  upload: boolean;
} {
  const none = { project: null, content: false, plaintext: false };
  if (!path) return { ...none, upload: false };
  if (UPLOAD_ROUTE.test(path)) {
    // Opening a session sends the file's name and kind in plaintext.
    const opening = path === '/api/uploads' || path === '/api/uploads/';
    return { ...none, content: true, plaintext: opening, upload: !opening };
  }
  if (path === '/api/artifacts/finalize') {
    return { ...none, content: true, plaintext: true, upload: false };
  }
  const project = PROJECT_ROUTE.exec(path);
  if (!project?.[2] || UNSCOPED.has(project[2])) {
    return { ...none, upload: false };
  }
  const encryptedRoute = project[1] !== undefined;
  const rest = project[3] ?? '';
  return {
    project: decode(project[2]),
    // An encrypted route's writes are encrypted by the route itself.
    content: !encryptedRoute && CONTENT_SUBROUTES.test(rest),
    plaintext: !encryptedRoute && PLAINTEXT_SUBROUTES.test(rest),
    upload: false
  };
}

/**
 * Whether a request writes a project's content, so it must declare its
 * context: a write to a plaintext project content route, to an upload
 * session, or to finalize an upload. (An encrypted route's writes are
 * encrypted by the route itself.)
 */
export function carriesProjectContent(
  input: RequestInfo | URL,
  init: RequestInit = {}
): boolean {
  const method = (
    init.method ??
    (typeof input === 'object' && 'method' in input ? input.method : 'GET')
  ).toUpperCase();
  return !READS.has(method) && routeOf(pathOf(input)).content;
}

/**
 * Resolves what a request writes, from its declared context and its
 * route, before it is sent. Throws for a content request that declared no
 * context, or declared another project than its route or body names.
 * Synchronous, and reads no state but the request.
 */
export function resolveProjectRequest(
  input: RequestInfo | URL,
  init: RequestInit = {}
): ResolvedProjectRequest {
  const context = contextOf(init);
  const migration = context?.migration ?? null;
  const method = (
    init.method ??
    (typeof input === 'object' && 'method' in input ? input.method : 'GET')
  ).toUpperCase();
  if (READS.has(method)) return { projectId: null, payload: 'none', migration };
  if (migration === 'encrypt') {
    return { projectId: null, payload: 'none', migration };
  }
  const route = routeOf(pathOf(input));
  const declared = context?.project;
  const named = route.project ?? bodyProject(init.body);
  if (declared && named && named !== declared.projectId) {
    throw new UnownedProjectWriteError(
      'A write named another project than the one it was sent for. Nothing was sent.'
    );
  }
  if (route.upload && !declared) {
    throw new UnownedProjectWriteError(
      'An upload did not say which project it belongs to. Nothing was sent.'
    );
  }
  // This device's decrypt run declares, for each request, that it stages
  // the plaintext of the project its route or body names.
  if (migration === 'decrypt' && !declared) {
    return { projectId: named, payload: 'plaintext', migration };
  }
  if (route.content && !declared) {
    throw new UndeclaredProjectRequestError(
      'A write of a project’s content did not say whose content it carries, or whether it is encrypted. Nothing was sent.'
    );
  }
  return {
    projectId: declared?.projectId ?? named,
    payload: route.plaintext ? 'plaintext' : (declared?.payload ?? 'none'),
    migration
  };
}

/**
 * Refuses (throws) a resolved request this tab may not send now. Call it
 * synchronously immediately before the send, with nothing awaited in
 * between.
 */
export function checkProjectRequest(request: ResolvedProjectRequest): void {
  if (!check || request.migration === 'encrypt' || !request.projectId) return;
  check({
    projectId: request.projectId,
    payload: request.payload,
    migration: request.migration
  });
}

/** Resolves and checks a request in one synchronous step. */
export function checkOutboundRequest(
  input: RequestInfo | URL,
  init: RequestInit = {}
): ResolvedProjectRequest {
  const request = resolveProjectRequest(input, init);
  checkProjectRequest(request);
  return request;
}

/**
 * Whether the gate refuses `payload` writes of the project now: for
 * senders that decide before they send (the room's socket). Not a
 * substitute for the check at the send itself.
 */
export function projectWriteBlocked(
  projectId: string,
  payload: ProjectPayload = 'none'
): boolean {
  if (!check) return false;
  try {
    check({ projectId, payload, migration: null });
    return false;
  } catch {
    return true;
  }
}

/**
 * Sends a frame that carries the project's content over its room socket,
 * checking it in the same synchronous step, immediately before the send:
 * whatever was awaited before (sealing, a lazy import, a lease), a pin,
 * an unresolved switch or a reset noted meanwhile sends nothing. A
 * plaintext frame of a project this device holds as encrypted now is
 * refused. Throws the gate's refusal.
 */
export function sendProjectFrame(
  context: ProjectRequestContext,
  socket: Pick<WebSocket, 'send'>,
  frame: string
): void {
  check?.({
    projectId: context.projectId,
    payload: context.payload,
    migration: null
  });
  socket.send(frame);
}

/**
 * The fetcher for this device's own migration runs: every request it
 * sends carries the run's kind in its context (`MigrationKind`). Nothing
 * else uses it.
 */
export function migrationFetch(kind: MigrationKind, fetcher: Fetch): Fetch {
  return (input, init = {}) =>
    fetcher(input, {
      ...init,
      [CONTEXT]: { ...contextOf(init), migration: kind }
    } as ProjectRequestInit);
}

/** This device's own encrypt run's fetcher (`migrationFetch('encrypt')`). */
export function ungatedFetch(fetcher: Fetch): Fetch {
  return migrationFetch('encrypt', fetcher);
}
