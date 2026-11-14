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
 *   its own (loading Tauri, reading the body, and for a project request
 *   readying the native credential, which may refresh it). Rust sends a
 *   project request with that credential only, and hands a 401 back
 *   rather than refreshing and replaying it, so any retry is checked
 *   again here first;
 * - room frames go through `sendProjectFrame`, which checks immediately
 *   before `socket.send`.
 *
 * A request's context says which project it writes, whether its payload
 * is the project's content in plaintext or encrypted (`projectRequest`),
 * whether it is an assistant request about that project
 * (`assistantProjectRequest`), and whether it is one of this device's own
 * migration requests, bound to the run's project and routes and to the run
 * still working on that project when the request leaves (`migrationRun`).
 * It is attached to the request itself, never kept in module state that
 * an await could unwind or another request could see.
 * Any new sender of project content must declare it the same way;
 * `projectRequestContext.test.ts` asserts every content path does, and
 * `projectRouteInventory.test.ts` that every Worker route is classified.
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
 *
 * Either exemption is bound to the project the run is working on and to
 * the routes that run writes (`migrationRun`): a request of the run for
 * another project, or to another route, is checked like any other.
 */
export type MigrationKind = 'encrypt' | 'decrypt';

/**
 * A migration run's exemption, bound to the project it is working on and
 * to the run itself: `live` answers, at the send, whether the run is still
 * working on that project. Once its window closes, a request still
 * carrying the exemption is checked like any other.
 */
interface MigrationContext {
  readonly kind: MigrationKind;
  readonly projectId: string;
  readonly live: () => boolean;
}

interface RequestContext {
  readonly project?: ProjectRequestContext;
  readonly migration?: MigrationContext;
  /** A create whose body carries no project's content (`contentFreeCreate`). */
  readonly contentFree?: true;
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
  /** This device's own migration run, bound to this project and route. */
  readonly migration: MigrationKind | null;
  /**
   * Whether that run is still working on the project: asked again by every
   * check, so a request resolved during the run and sent after it is
   * checked like any other.
   */
  readonly migrationLive?: () => boolean;
  /**
   * An assistant request about the project: refused for any project this
   * device holds as encrypted, whatever consent exists (PR #1418).
   */
  readonly assistant: boolean;
}

/**
 * Throws to refuse a request. Installed by `api.ts`, which knows the
 * project's pins.
 */
export type ProjectWriteCheck = (request: {
  readonly projectId: string;
  readonly payload: ProjectPayload;
  readonly migration: MigrationKind | null;
  readonly assistant: boolean;
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

function withContext(
  init: RequestInit,
  context: RequestContext
): ProjectRequestInit {
  return { ...init, [CONTEXT]: { ...contextOf(init), ...context } };
}

/** `init` (copied) declared as a request carrying `context`'s project. */
export function projectRequest(
  context: ProjectRequestContext,
  init: RequestInit = {}
): ProjectRequestInit {
  return withContext(init, { project: context });
}

/**
 * `init` (copied) declared as an assistant request about `projectId`,
 * whose model digest, conversation and attachments are that project's
 * content in plaintext. Refused at the send for any project this device
 * holds as encrypted (pinned, switch unresolved, or carrying an encryption
 * requirement), with no consent exception: the assistant is off for
 * end-to-end encrypted projects on this device for now.
 */
export function assistantProjectRequest(
  projectId: string,
  init: RequestInit = {}
): ProjectRequestInit {
  return withContext(init, {
    project: { projectId, payload: 'plaintext' }
  });
}

/**
 * `init` (copied) declared as a create that carries no project's content:
 * the account builds the new project itself (the pre-Phase 1 contract).
 * A create or adoption that sends a document declares its project instead.
 */
export function contentFreeCreate(init: RequestInit = {}): ProjectRequestInit {
  return withContext(init, { contentFree: true });
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
  return contextOf(init)?.migration?.kind;
}

const READS = new Set(['GET', 'HEAD', 'OPTIONS']);
/** `/api/projects/<word>` routes that name no project. */
const UNSCOPED = new Set(['reorder', 'purge']);
const PROJECT_ROUTE = /^\/api\/(e2ee\/)?projects\/([^/?#]+)(\/[^?#]*)?/;
const UPLOAD_ROUTE = /^\/api\/uploads(?:\/|$)/;
/** Creates and adoptions: the document they send is its project's content. */
const CREATE_ROUTE = /^\/api\/projects\/?$/;
/**
 * Encrypted creates, copies and adoptions: the frame is the new project's
 * content, encrypted, and names that project only inside it, so the sender
 * declares the project id it chose (`encryptedDocumentsApi.ts`).
 */
const ENCRYPTED_CREATE_ROUTE = /^\/api\/e2ee\/projects\/?$/;
/** Finalizing an upload sends the file's name and kind in plaintext. */
const FINALIZE_ROUTE = /^\/api\/(?:artifacts|imports)\/finalize$/;
/** The model digest, conversation and attachments of one project. */
const ASSISTANT_ROUTE = /^\/api\/assistant\/proposals$/;
/** Project subroutes whose writes are the project's content. */
const CONTENT_SUBROUTES =
  /^\/(?:document|revisions|duplicate|measurements|workspace-sessions|collaboration)(?:\/|$)/;
/** Of those, the ones that only ever carry plaintext. */
const PLAINTEXT_SUBROUTES =
  /^\/(?:document|revisions|duplicate|measurements|workspace-sessions)(?:\/|$)/;
/**
 * The one encrypted-route write that carries plaintext: the decrypt run's
 * decrypted measurements and view state.
 */
const ENCRYPTED_ROUTE_PLAINTEXT = /^\/migration\/plaintext\/details$/;
/** Bodies larger than this name their project in their path. */
const MAX_PARSED_BODY = 64 * 1024;

/**
 * The writes each migration run sends, and so the only ones its exemption
 * covers (for the run's own project only): the encrypt run writes the
 * encrypted routes; the decrypt run stages plaintext through these.
 */
const MIGRATION_ROUTES: Readonly<
  Record<MigrationKind, ReadonlyArray<{ method: string; path: RegExp }>>
> = {
  // Its project's writes to the encrypted routes (by path, or by body for
  // the account-wide ones such as invitations), but for the decrypt run's
  // plaintext details.
  encrypt: ['POST', 'PUT', 'PATCH', 'DELETE'].map((method) => ({
    method,
    path: /^\/api\/e2ee\/(?!projects\/[^/]+\/migration\/plaintext\/details$)./
  })),
  decrypt: [
    { method: 'POST', path: /^\/api\/projects\/[^/]+\/revisions$/ },
    { method: 'PUT', path: /^\/api\/projects\/[^/]+\/document$/ },
    {
      method: 'PUT',
      path: /^\/api\/e2ee\/projects\/[^/]+\/migration\/plaintext\/details$/
    },
    { method: 'POST', path: /^\/api\/uploads\/?$/ },
    { method: 'PUT', path: /^\/api\/uploads\/[^/]+\/content$/ },
    { method: 'POST', path: /^\/api\/uploads\/[^/]+\/multipart$/ },
    { method: 'DELETE', path: /^\/api\/uploads\/[^/]+\/multipart$/ },
    { method: 'PUT', path: /^\/api\/uploads\/[^/]+\/parts\/[1-9]\d*$/ },
    { method: 'POST', path: /^\/api\/uploads\/[^/]+\/multipart\/complete$/ },
    { method: 'POST', path: /^\/api\/artifacts\/finalize$/ }
  ]
};

function migrationRoute(
  kind: MigrationKind,
  method: string,
  path: string | null
): boolean {
  return (
    path !== null &&
    MIGRATION_ROUTES[kind].some(
      (route) => route.method === method && route.path.test(path)
    )
  );
}

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

function methodOf(input: RequestInfo | URL, init: RequestInit): string {
  return (
    init.method ??
    (typeof input === 'object' && 'method' in input ? input.method : 'GET')
  ).toUpperCase();
}

function decode(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/**
 * The project a JSON body names, as a create, copy, adoption or finalize
 * does (an adoption by the device id it comes from).
 */
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
  for (const key of ['projectId', 'sourceProjectId', 'localProjectId']) {
    if (typeof record[key] === 'string') return record[key];
  }
  return null;
}

/** What a write's route says of it. */
interface RouteClass {
  readonly project: string | null;
  /** Its writes are the project's content: a context must be declared. */
  readonly content: boolean;
  /** Its content is plaintext whatever is declared. */
  readonly plaintext: boolean;
  /** An upload-session route: names no project of its own. */
  readonly upload: boolean;
  /** A create or adoption (`contentFreeCreate`). */
  readonly create: boolean;
  /** An assistant request (`assistantProjectRequest`). */
  readonly assistant: boolean;
}

const NO_CONTENT: RouteClass = {
  project: null,
  content: false,
  plaintext: false,
  upload: false,
  create: false,
  assistant: false
};

function routeOf(path: string | null): RouteClass {
  if (!path) return NO_CONTENT;
  if (UPLOAD_ROUTE.test(path)) {
    // Opening a session sends the file's name and kind in plaintext.
    const opening = path === '/api/uploads' || path === '/api/uploads/';
    return {
      ...NO_CONTENT,
      content: true,
      plaintext: opening,
      upload: !opening
    };
  }
  if (FINALIZE_ROUTE.test(path)) {
    return { ...NO_CONTENT, content: true, plaintext: true };
  }
  if (CREATE_ROUTE.test(path)) {
    return { ...NO_CONTENT, content: true, plaintext: true, create: true };
  }
  if (ENCRYPTED_CREATE_ROUTE.test(path)) {
    return { ...NO_CONTENT, content: true };
  }
  if (ASSISTANT_ROUTE.test(path)) {
    return { ...NO_CONTENT, content: true, plaintext: true, assistant: true };
  }
  const project = PROJECT_ROUTE.exec(path);
  if (!project?.[2] || UNSCOPED.has(project[2])) return NO_CONTENT;
  const encryptedRoute = project[1] !== undefined;
  const rest = project[3] ?? '';
  // An encrypted route's writes are encrypted by the route itself, but
  // for the decrypt run's plaintext details.
  const plaintext = encryptedRoute
    ? ENCRYPTED_ROUTE_PLAINTEXT.test(rest)
    : PLAINTEXT_SUBROUTES.test(rest);
  return {
    ...NO_CONTENT,
    project: decode(project[2]),
    content: plaintext || (!encryptedRoute && CONTENT_SUBROUTES.test(rest)),
    plaintext
  };
}

/**
 * Whether a request writes a project's content, so it must declare its
 * context: a write to a plaintext project content route, a create or
 * adoption, an upload session, an upload's finalize, or an assistant
 * request. (An encrypted route's writes are encrypted by the route
 * itself.)
 */
export function carriesProjectContent(
  input: RequestInfo | URL,
  init: RequestInit = {}
): boolean {
  return !READS.has(methodOf(input, init)) && routeOf(pathOf(input)).content;
}

/**
 * Whether a request carries plaintext whatever its sender declared: a
 * write to a route that only ever stores plaintext.
 */
export function carriesPlaintextContent(
  input: RequestInfo | URL,
  init: RequestInit = {}
): boolean {
  return !READS.has(methodOf(input, init)) && routeOf(pathOf(input)).plaintext;
}

/** The project a request names: its declared context, route or body. */
function requestProject(
  route: RouteClass,
  init: RequestInit
): { declared: ProjectRequestContext | undefined; named: string | null } {
  return {
    declared: contextOf(init)?.project,
    named: route.project ?? bodyProject(init.body)
  };
}

/**
 * The migration exemption a request carries, if it still applies: the
 * run's project is the one the request writes, the route is one that run
 * writes, and the run is still working on that project now. Otherwise
 * null, and the request is checked like any other.
 */
function boundMigration(
  migration: MigrationContext | undefined,
  method: string,
  path: string | null,
  projectId: string | null
): MigrationKind | null {
  if (!migration || projectId === null) return null;
  if (migration.projectId !== projectId) return null;
  if (!migrationRoute(migration.kind, method, path)) return null;
  return migration.live() ? migration.kind : null;
}

/**
 * Resolves what a request writes, from its declared context and its
 * route, before it is sent. A migration exemption is resolved against its
 * run's liveness here, so resolve immediately before the send
 * (`checkOutboundRequest`). Throws for a content request that declared no
 * context, or declared another project than its route or body names.
 * Synchronous, and reads no state but the request.
 */
export function resolveProjectRequest(
  input: RequestInfo | URL,
  init: RequestInit = {}
): ResolvedProjectRequest {
  const context = contextOf(init);
  const method = methodOf(input, init);
  if (READS.has(method)) {
    return {
      projectId: null,
      payload: 'none',
      migration: null,
      assistant: false
    };
  }
  const path = pathOf(input);
  const route = routeOf(path);
  const { declared, named } = requestProject(route, init);
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
  const projectId = declared?.projectId ?? named;
  const migration = boundMigration(context?.migration, method, path, projectId);
  const migrationLive = migration ? context?.migration?.live : undefined;
  // This device's decrypt run declares, for each request, that it stages
  // the plaintext of the project its route or body names.
  if (migration === 'decrypt' && !declared) {
    return {
      projectId,
      payload: 'plaintext',
      migration,
      ...(migrationLive ? { migrationLive } : {}),
      assistant: false
    };
  }
  if (route.content && !declared && migration !== 'encrypt') {
    // A create the account builds carries no project's content.
    if (route.create && context?.contentFree === true) {
      return {
        projectId: null,
        payload: 'none',
        migration: null,
        assistant: false
      };
    }
    throw new UndeclaredProjectRequestError(
      'A write of a project’s content did not say whose content it carries, or whether it is encrypted. Nothing was sent.'
    );
  }
  return {
    projectId,
    payload: route.plaintext ? 'plaintext' : (declared?.payload ?? 'none'),
    migration,
    ...(migrationLive ? { migrationLive } : {}),
    assistant: route.assistant
  };
}

/**
 * Refuses (throws) a resolved request this tab may not send now. Call it
 * synchronously immediately before the send, with nothing awaited in
 * between.
 */
export function checkProjectRequest(request: ResolvedProjectRequest): void {
  // The run's exemption holds only while the run still works on the
  // project, asked again now: once its window closes, its requests are
  // checked like any other (an encrypt run's too).
  const migration =
    request.migration !== null && request.migrationLive?.() === true
      ? request.migration
      : null;
  if (!check || migration === 'encrypt' || !request.projectId) return;
  check({
    projectId: request.projectId,
    payload: request.payload,
    migration,
    assistant: request.assistant
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
    check({ projectId, payload, migration: null, assistant: false });
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
    migration: null,
    assistant: false
  });
  socket.send(frame);
}

/**
 * One of this device's own migration controllers (`MigrationKind`). Its
 * exemption is bound twice over: a request carries it only for a project
 * the run is working on now (`during`), and only through a route that
 * run writes (`MIGRATION_ROUTES`); the gate checks both again at the
 * send. A request of the run for any other project or route is checked
 * like every other request. Nothing else uses it.
 */
export interface MigrationRun {
  readonly kind: MigrationKind;
  /** Runs `work` as the run's work on `projectId`. */
  during<T>(projectId: string, work: () => Promise<T>): Promise<T>;
  /** `fetcher`, adding the exemption to the requests it covers. */
  fetch(fetcher: Fetch): Fetch;
}

export function migrationRun(kind: MigrationKind): MigrationRun {
  const working = new Map<string, number>();
  return {
    kind,
    async during(projectId, work) {
      working.set(projectId, (working.get(projectId) ?? 0) + 1);
      try {
        return await work();
      } finally {
        const left = (working.get(projectId) ?? 1) - 1;
        if (left > 0) working.set(projectId, left);
        else working.delete(projectId);
      }
    },
    fetch:
      (fetcher) =>
      (input, init = {}) => {
        const path = pathOf(input);
        const { declared, named } = requestProject(routeOf(path), init);
        const projectId = named ?? declared?.projectId ?? null;
        const covered =
          projectId !== null &&
          working.has(projectId) &&
          migrationRoute(kind, methodOf(input, init), path);
        // Bound to this run: the gate asks, at the send, whether the run is
        // still working on the project, and checks the request like any
        // other once it is not.
        const live = () => working.has(projectId!);
        return fetcher(
          input,
          covered
            ? withContext(init, { migration: { kind, projectId, live } })
            : init
        );
      }
  };
}
