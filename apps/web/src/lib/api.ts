import {
  isAnalyticsEnabled,
  trackDetail,
  trackSize,
  durationBucket
} from './analytics';
import type {
  LibraryFolderSnapshot,
  SaveLibraryFolderRequest
} from './libraryFolderCloudSync';
import type {
  AccountStorageUsage,
  AccountDeletionPreview,
  AccountDeletionScope,
  AppSettingsResponse,
  AuthConfigResponse,
  AuthSession,
  ArtifactMetadataResponse,
  CompleteMultipartUploadRequest,
  CreateMultipartUploadResponse,
  CreateProjectRequest,
  CreateProjectResponse,
  CreateUploadSessionRequest,
  CreateUploadSessionResponse,
  UploadedArtifactPart,
  DeleteAccountDataResponse,
  DuplicateProjectRequest,
  DuplicateProjectResponse,
  FinalizeArtifactRequest,
  HealthResponse,
  ListProjectsResponse,
  ListRevisionsResponse,
  ProjectCollaborationCapabilitiesResponse,
  ProjectDocument,
  ListArtifactsResponse,
  PurgeProjectsResponse,
  ReorderProjectsRequest,
  ReorderProjectsResponse,
  SaveAssistantCredentialRequest,
  SaveProjectDocumentRequest,
  SaveProjectDocumentResponse,
  SaveRevisionRequest,
  UserId,
  StartEmailLoginRequest,
  StartEmailLoginResponse,
  UpdateAppSettingsRequest,
  UpdateProjectRequest,
  UpdateProjectResponse,
  VerifyEmailLoginRequest
} from '@openzcad/shared';
import {
  adoptProjectDocument,
  createSavedRevision,
  normalizeDocument,
  normalizeDocumentHistory,
  reidentifyProjectDocument,
  assertStorableDocument,
  withoutDerivedProjection
} from '@openzcad/document-core';
import {
  createId,
  compareProjectSummaries,
  ENCRYPTED_PROJECTS_REQUIRED_CODE,
  PROJECT_FORMAT_UNSUPPORTED_CODE,
  PROJECT_FORMAT_UNSUPPORTED_MESSAGE,
  PROJECT_STORAGE_FORMAT_E2EE_V1,
  LEGACY_PROJECT_FRAME_CONTENT_TYPE,
  toProjectId,
  type E2eeListProjectsExtension,
  type ProjectSummary
} from '@openzcad/shared';
import { splitProjectStorageUpload } from '@openzcad/persistence';
import { desktopFetch, isDesktopApp } from './desktopBridge';
import type * as EncryptedProjectsModule from './e2ee/encryptedProjects';
import { localStoragePreferencePins } from './e2ee/preferencePins';
import { unlockedAccount } from './e2ee/unlockedKeys';
import type { EncryptedProjectStore } from './e2ee/encryptedProjectStore';
import { getKeySessionRevision, isCurrentKeySession } from './e2ee/keySession';
import { prioritizeShelfEntries } from './projectShelf';

/** Optional presentation updates; document opens still perform full verification. */
export interface ProjectListingProgress {
  isCurrent(): boolean;
  priorityProjectIds?(projects: readonly ProjectSummary[]): readonly string[];
  onVerified(project: ProjectSummary): void;
}

/** Client-only presentation state; never part of the server/storage contract. */
interface ShelfListingResponse extends ListProjectsResponse {
  pendingEncryptedProjectIds?: ReadonlySet<string>;
}

/**
 * An API call that reached the server and came back refused. Callers need the
 * status to tell a rejected request apart from an unreachable backend: the
 * former is the user's problem to fix, the latter is what offline mode is for.
 */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    /**
     * The machine-readable `code` the API sends alongside a refusal, when it
     * sends one. Statuses are too coarse for the sync paths: a 409 can mean
     * "already in your account" or "someone else edited this", and those want
     * opposite responses from the client.
     */
    readonly code?: string,
    /**
     * The rest of the refusal body. A fenced write reports the version the
     * account actually holds, and a size refusal reports the ceiling; both let
     * the client explain itself without a second round trip.
     */
    readonly details?: Record<string, unknown>
  ) {
    super(message);
    this.name = 'ApiError';
  }

  /** True when the server rejected the request itself, e.g. failed validation. */
  get isClientError(): boolean {
    return this.status >= 400 && this.status < 500;
  }
}

export const PROJECT_DOCUMENT_UNAVAILABLE_CODE = 'PROJECT_DOCUMENT_UNAVAILABLE';

export function isProjectDocumentUnavailableError(
  error: unknown
): error is ApiError {
  return (
    error instanceof ApiError &&
    error.status === 503 &&
    error.code === PROJECT_DOCUMENT_UNAVAILABLE_CODE
  );
}

/**
 * The account holds this project in a storage format this build cannot open
 * (end-to-end encrypted, ADR-024 Phase 4). Not an outage and not a repair:
 * the only remedy is a newer OpenZCAD, so callers neither retry nor fall back
 * to a device copy that the account would refuse to save.
 */
export function isProjectFormatUnsupportedError(
  error: unknown
): error is ApiError {
  return (
    error instanceof ApiError && error.code === PROJECT_FORMAT_UNSUPPORTED_CODE
  );
}

/** The refusal with this build's own wording, whatever the Worker said. */
function withProjectFormatMessage(error: unknown): unknown {
  return isProjectFormatUnsupportedError(error)
    ? new ApiError(
        409,
        PROJECT_FORMAT_UNSUPPORTED_MESSAGE,
        PROJECT_FORMAT_UNSUPPORTED_CODE,
        error.details
      )
    : error;
}

/**
 * The account stores documents without reading them (ADR-024 Phase 1), so the
 * browser checks every one it loads, as it checks every one it writes. A
 * version this browser cannot open is reported like an unreadable account
 * copy: the device copy stays open, and autosave waits for an explicit retry
 * rather than overwriting either copy.
 */
function openableAccountDocument(
  document: ProjectDocument,
  projectId: string
): ProjectDocument {
  try {
    const opened = assertStorableDocument(document);
    // The account names the copy by its route; a stored document that claims
    // another project is not this project's copy.
    if (opened.projectId !== projectId)
      throw new Error('It belongs to a different project.');
    return opened;
  } catch (error) {
    throw new ApiError(
      503,
      `The account copy of this project cannot be opened here: ${
        error instanceof Error ? error.message : String(error)
      }`,
      PROJECT_DOCUMENT_UNAVAILABLE_CODE
    );
  }
}

function cloudStatus(status: number): string {
  return status === 401
    ? 'unauthorized'
    : status === 403
      ? 'forbidden'
      : status === 409
        ? 'conflict'
        : status === 413
          ? 'too_large'
          : status === 429
            ? 'rate_limited'
            : status >= 500
              ? 'server'
              : 'other';
}

async function requestJson<T>(
  input: RequestInfo,
  init?: RequestInit,
  observations: {
    documentDownload?: boolean;
    expectedMissing?: boolean;
    projectId?: string;
  } = {}
): Promise<T> {
  const collect = isAnalyticsEnabled();
  const started = performance.now();
  // Use only a fixed operation class; never send the URL or embedded IDs.
  const projectCall =
    typeof input === 'string' && input.startsWith('/api/projects');
  const writing = !['GET', 'HEAD', 'OPTIONS'].includes(init?.method ?? 'GET');
  let response: Response;
  try {
    response = await desktopFetch(input, {
      ...init,
      credentials: 'same-origin',
      headers: {
        'content-type': 'application/json',
        ...(observations.documentDownload
          ? { accept: LEGACY_PROJECT_FRAME_CONTENT_TYPE }
          : {}),
        ...(init?.headers ?? {})
      }
    });
  } catch (error) {
    if (collect && projectCall) {
      trackDetail(writing ? 'error_cloud_save' : 'error_cloud_load');
      trackDetail('cloud_status', 'network');
    }
    throw error;
  }
  if (collect && projectCall) {
    if (!response.ok) {
      // Revision retention's documented null result is not a load failure.
      if (!(observations.expectedMissing && response.status === 404)) {
        trackDetail(writing ? 'error_cloud_save' : 'error_cloud_load');
        trackDetail('cloud_status', cloudStatus(response.status));
      }
    } else if (writing && typeof init?.body === 'string') {
      trackSize('transfer_upload', new Blob([init.body]).size);
      const bucket = durationBucket(performance.now() - started);
      if (bucket) trackDetail('save_latency', bucket);
    }
  }

  if (!response.ok) {
    const text = await response.text();
    let message = text;
    let code: string | undefined;
    let details: Record<string, unknown> | undefined;
    try {
      const payload = JSON.parse(text) as Record<string, unknown>;
      if (typeof payload.error === 'string') {
        message = payload.error;
      }
      if (typeof payload.code === 'string') {
        code = payload.code;
      }
      details = payload;
    } catch {
      // Plain-text responses remain useful as-is.
    }
    throw new ApiError(
      response.status,
      message || `${response.status} ${response.statusText}`,
      code,
      details
    );
  }

  if (
    observations.projectId &&
    response.headers.get('content-type')?.split(';')[0] ===
      LEGACY_PROJECT_FRAME_CONTENT_TYPE
  ) {
    const { readLegacyProjectFrame, LegacyProjectTransportError } =
      await import('./legacyProjectReader');
    try {
      return (await readLegacyProjectFrame(
        response,
        observations.projectId,
        desktopFetch,
        collect ? (bytes) => trackSize('transfer_download', bytes) : undefined
      )) as T;
    } catch (error) {
      if (collect && projectCall) {
        trackDetail('error_cloud_load');
        trackDetail(
          'cloud_status',
          error instanceof LegacyProjectTransportError
            ? error.status
              ? cloudStatus(error.status)
              : 'network'
            : 'server'
        );
      }
      if (error instanceof LegacyProjectTransportError) {
        if (error.status)
          throw new ApiError(
            error.status,
            error.cause instanceof Error ? error.cause.message : error.message,
            error.code,
            error.details
          );
        throw error.cause;
      }
      throw new ApiError(
        503,
        `The account copy of this project cannot be opened here: ${error instanceof Error ? error.message : String(error)}`,
        PROJECT_DOCUMENT_UNAVAILABLE_CODE
      );
    }
  }
  if (collect && observations.documentDownload && !writing) {
    // Read once and measure the successfully parsed UTF-8 JSON body. Content-
    // Length may describe compressed bytes or be absent; names/IDs stay local.
    const text = await response.text();
    const value = JSON.parse(text) as T;
    trackSize('transfer_download', new TextEncoder().encode(text).byteLength);
    return value;
  }
  return (await response.json()) as T;
}

// --- Encrypted projects (ADR-024 Phase 4) ---------------------------------

/** Projects the account stores end-to-end encrypted (format 2), by id. */
const encryptedProjectIds = new Set<string>();

/**
 * The encrypted-project module, loaded the first time a format-2 project is
 * listed, created, opened or saved, so no crypto reaches the entry chunk.
 */
let encryptedModule: Promise<typeof EncryptedProjectsModule> | null = null;
const encryptedProjects = () =>
  (encryptedModule ??= import('./e2ee/encryptedProjects'));

/** Records which listed projects are encrypted, for the dispatch below. */
export function rememberProjectFormats(
  projects: readonly Pick<ProjectSummary, 'projectId' | 'storageFormat'>[]
): void {
  for (const project of projects) {
    if (project.storageFormat === PROJECT_STORAGE_FORMAT_E2EE_V1) {
      encryptedProjectIds.add(project.projectId);
    } else {
      encryptedProjectIds.delete(project.projectId);
    }
  }
}

/**
 * What encrypted projects keep on this device: anything the encrypted
 * routes do not store. Their files, thumbnails, exports, measurements and
 * view state (4-6, 4-7), copies, branches and adoption (4-8) go through the
 * encrypted routes, never the plaintext ones, which refuse here before
 * anything is sent: the Worker would refuse a format-2 project too, but
 * only after receiving its data.
 */
export const E2EE_LOCAL_ONLY_CODE = 'E2EE_LOCAL_ONLY';

export function encryptedLocalOnly(what: string): ApiError {
  return new ApiError(
    409,
    `${what} of end-to-end encrypted projects stay on this device for now.`,
    E2EE_LOCAL_ONLY_CODE
  );
}

/** Whether this page knows the project is stored encrypted (format 2). */
export function isEncryptedProject(projectId: string | null | undefined) {
  return projectId ? encryptedProjectIds.has(projectId) : false;
}

export const E2EE_PREFERENCE_UNVERIFIED_CODE = 'E2EE_PREFERENCE_UNVERIFIED';

function preferenceUnverified(): ApiError {
  return new ApiError(
    409,
    'This account’s “Encrypt new projects” setting could not be checked, so nothing was sent. Unlock encryption in Settings › Encryption, or try again.',
    E2EE_PREFERENCE_UNVERIFIED_CODE
  );
}

/** A route's JSON body, or undefined when it is unreachable or not JSON. */
async function readOptionalJson(
  path: string
): Promise<Record<string, unknown> | undefined> {
  try {
    const response = await desktopFetch(path, { credentials: 'same-origin' });
    if (!response.ok) return undefined;
    const body: unknown = await response.json();
    return body !== null && typeof body === 'object'
      ? (body as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Whether new projects of this account are created encrypted (decision
 * D2). A plaintext create or adoption sends the whole document, and the
 * Worker's later refusal cannot take that back, so the answer fails closed
 * against the service that stores the opt-in:
 * - a page holding the account key trusts only the record whose MAC and
 *   sequence pin verify, and refuses to answer when it does not;
 * - an opt-in this device verified earlier holds even when the account
 *   omits it, reports encrypted projects closed or cannot be reached;
 * - otherwise the account's unverified copy can only turn encryption on,
 *   and a copy that cannot be read while encrypted projects are open
 *   refuses rather than reading as no.
 * Throws `E2EE_PREFERENCE_UNVERIFIED` when it cannot tell. A device that
 * never verified the opt-in and holds no account key still follows the
 * account's copy; an older Worker or a static host reads as no.
 */
export async function encryptsNewProjects(): Promise<boolean> {
  const session = await readOptionalJson('/api/session');
  const userId = typeof session?.userId === 'string' ? session.userId : null;
  const pins = localStoragePreferencePins();
  const pinnedOptIn = userId !== null && (await pins.optedIn(userId));
  const config = await readOptionalJson('/api/e2ee/config');
  // A deployment-wide requirement overrides the beta opt-in. Choose the
  // encrypted path before any plaintext request; locked keys or inconsistent
  // availability must fail there instead of sending a document first.
  if (config?.defaultOn === true) return true;
  if (config?.enabled !== true || config.projectsEnabled !== true) {
    if (pinnedOptIn) throw preferenceUnverified();
    return false;
  }
  const account = userId === null ? undefined : unlockedAccount(userId);
  if (userId !== null && account) {
    let verified: boolean | null = null;
    try {
      const preferences = await import('./e2ee/projectPreferences');
      const currentAccount = unlockedAccount(userId);
      if (!currentAccount) throw preferenceUnverified();
      const state = await preferences.loadProjectPreference({
        userId,
        accountKey: currentAccount.accountKey,
        api: preferences.createProjectPreferenceApi(),
        pins
      });
      if (state.kind === 'verified') verified = state.encryptNewProjects;
      // No record anywhere, and none pinned (that would be a rollback).
      else if (state.kind === 'unset') verified = false;
    } catch {
      // Unreachable or unreadable: not an answer.
    }
    if (verified === null) throw preferenceUnverified();
    return verified;
  }
  if (pinnedOptIn) return true;
  const stored = await readOptionalJson('/api/e2ee/project-preferences');
  if (!stored) throw preferenceUnverified();
  const preference = stored.preference as
    { encryptNewProjects?: unknown } | null | undefined;
  return preference?.encryptNewProjects === true;
}

/**
 * Runs `plaintext` unless the project is known to be encrypted; a
 * plaintext route that answers PROJECT_FORMAT_UNSUPPORTED marks it and the
 * call moves to the encrypted store. Writes never fall back: a write sends
 * the document, so it goes to the encrypted store only when the project is
 * already known to be encrypted.
 */
async function byFormat<T>(
  projectId: string,
  plaintext: () => Promise<T>,
  encrypted: (store: EncryptedProjectStore) => Promise<T>,
  options: { fallback: boolean }
): Promise<T> {
  const viaStore = async () =>
    encrypted(await (await encryptedProjects()).encryptedProjectStore());
  if (encryptedProjectIds.has(projectId)) return viaStore();
  try {
    return await plaintext();
  } catch (error) {
    if (options.fallback && isProjectFormatUnsupportedError(error)) {
      encryptedProjectIds.add(projectId);
      return viaStore();
    }
    throw error;
  }
}

/**
 * The request with `field`'s embedded import payloads split out into
 * `storageAssets` (ADR-024 Phase 1): the account stores the payloads under
 * their content-addressed keys and the projection as sent, without splitting
 * the document itself.
 */
async function withSplitStorage<T extends object, K extends keyof T & string>(
  request: T,
  field: K
): Promise<
  Omit<T, K> & Record<K, unknown> & Pick<SaveRevisionRequest, 'storageAssets'>
> {
  const split = await splitProjectStorageUpload(
    request[field] as ProjectDocument
  );
  return {
    ...request,
    [field]: split.document,
    storageAssets: split.storageAssets
  };
}

/** One save state's document from the plaintext route; null once pruned. */
async function loadPlaintextRevision(
  projectId: string,
  revisionId: string
): Promise<ProjectDocument | null> {
  let document: ProjectDocument;
  try {
    document = await requestJson<ProjectDocument>(
      `/api/projects/${encodeURIComponent(projectId)}/revisions/${encodeURIComponent(revisionId)}`,
      undefined,
      { documentDownload: true, expectedMissing: true, projectId }
    );
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) {
      return null;
    }
    throw withProjectFormatMessage(error);
  }
  return openableAccountDocument(document, projectId);
}

export const api = {
  health: () => requestJson<HealthResponse>('/api/health'),
  authConfig: () => requestJson<AuthConfigResponse>('/api/auth/config'),
  session: () => requestJson<AuthSession>('/api/session'),
  collaborationCapabilities: () =>
    requestJson<ProjectCollaborationCapabilitiesResponse>(
      '/api/collaboration/config'
    ),
  startEmailLogin: (payload: StartEmailLoginRequest) =>
    requestJson<StartEmailLoginResponse>('/api/auth/email/start', {
      method: 'POST',
      body: JSON.stringify(payload)
    }),
  verifyEmailLogin: (payload: VerifyEmailLoginRequest) =>
    requestJson<AuthSession>('/api/auth/email/verify', {
      method: 'POST',
      body: JSON.stringify(payload)
    }),
  approveDesktopLogin: (attemptId: string, userCode: string) =>
    requestJson<{ ok: true }>('/api/auth/desktop/approve', {
      method: 'POST',
      body: JSON.stringify({ attemptId, userCode })
    }),
  logout: () =>
    requestJson<{ ok: true }>('/api/auth/logout', {
      method: 'POST',
      body: '{}'
    }),
  getSettings: () => requestJson<AppSettingsResponse>('/api/settings'),
  getLibraryFolders: () =>
    requestJson<LibraryFolderSnapshot>('/api/library-folders'),
  saveLibraryFolders: (payload: SaveLibraryFolderRequest) =>
    requestJson<LibraryFolderSnapshot>('/api/library-folders', {
      method: 'PUT',
      body: JSON.stringify(payload)
    }),
  updateSettings: (payload: UpdateAppSettingsRequest) =>
    requestJson<AppSettingsResponse>('/api/settings', {
      method: 'PATCH',
      body: JSON.stringify(payload)
    }),
  saveAssistantCredential: (payload: SaveAssistantCredentialRequest) =>
    requestJson<AppSettingsResponse>('/api/settings/assistant-credential', {
      method: 'PUT',
      body: JSON.stringify(payload)
    }),
  deleteAssistantCredential: () =>
    requestJson<AppSettingsResponse>('/api/settings/assistant-credential', {
      method: 'DELETE'
    }),
  testAssistantConnection: () =>
    requestJson<{ ok: true; latencyMs: number; requestId: string }>(
      '/api/settings/assistant/test',
      { method: 'POST', body: '{}' }
    ),
  storageUsage: () => requestJson<AccountStorageUsage>('/api/account/storage'),
  exportAccountData: () =>
    requestJson<Record<string, unknown>>('/api/account/export'),
  accountDeletionPreview: (scope: AccountDeletionScope) =>
    requestJson<AccountDeletionPreview>(
      `/api/account/deletion-preview?scope=${encodeURIComponent(scope)}`
    ),
  deleteAccountData: (scope: AccountDeletionScope, confirmation: string) =>
    requestJson<DeleteAccountDataResponse>('/api/account/delete-data', {
      method: 'POST',
      body: JSON.stringify({ scope, confirmation })
    }),
  /**
   * The shelf. Encrypted projects arrive with a placeholder name and their
   * project-info envelope; their names and thumbnails are decrypted here
   * when this device holds the account's keys, and stay the placeholder
   * otherwise. A thumbnail is named by its blob id, whose reference this
   * page then holds, so the shelf reads it through the decode worker.
   */
  listProjects: async (
    progress?: ProjectListingProgress
  ): Promise<ShelfListingResponse> => {
    const revision = getKeySessionRevision();
    const isCurrent = () =>
      isCurrentKeySession(revision) && (progress?.isCurrent() ?? true);
    const { encryptedProjectInfo, ...listing } = await requestJson<
      ListProjectsResponse & E2eeListProjectsExtension
    >('/api/projects');
    const pending = new Set<string>(
      Array.isArray(listing.projects)
        ? listing.projects
            .filter((project) => project.storageFormat === 2)
            .map((project) => project.projectId)
        : []
    );
    const unverified = (): ShelfListingResponse =>
      pending.size
        ? { ...listing, pendingEncryptedProjectIds: pending }
        : listing;
    if (progress && !isCurrent()) return unverified();
    if (Array.isArray(listing.projects))
      rememberProjectFormats(listing.projects);
    if (!encryptedProjectInfo?.length) return unverified();
    if (progress) {
      const projects = new Map<string, ProjectSummary>(
        listing.projects.map((p) => [p.projectId, p])
      );
      // The HTTP listing is enough to draw cards and establish storage formats.
      // Names and thumbnail references arrive only after the existing verifier.
      void encryptedProjects()
        .then((module) =>
          module.encryptedProjectShelf(
            prioritizeShelfEntries(encryptedProjectInfo, [
              ...(progress.priorityProjectIds?.(listing.projects) ?? []),
              ...[...listing.projects]
                .sort(compareProjectSummaries)
                .map((project) => project.projectId)
            ]),
            {
              isCurrent,
              onEntry(projectId, entry) {
                const project = projects.get(projectId);
                if (!project || !isCurrent()) return;
                progress.onVerified({
                  ...project,
                  name: entry.name,
                  ...(entry.thumbnailBlobId
                    ? {
                        thumbnailArtifactId:
                          entry.thumbnailBlobId as ProjectSummary['thumbnailArtifactId']
                      }
                    : {})
                });
              }
            }
          )
        )
        .catch(() => undefined);
      return unverified();
    }
    try {
      const shelf = await (
        await encryptedProjects()
      ).encryptedProjectShelf(encryptedProjectInfo);
      if (!isCurrent()) return unverified();
      for (const id of shelf.keys()) pending.delete(id);
      return {
        ...unverified(),
        projects: listing.projects.map((project) => {
          const entry = shelf.get(project.projectId);
          return entry === undefined
            ? project
            : {
                ...project,
                name: entry.name,
                ...(entry.thumbnailBlobId
                  ? {
                      thumbnailArtifactId:
                        entry.thumbnailBlobId as ProjectSummary['thumbnailArtifactId']
                    }
                  : {})
              };
        })
      };
    } catch {
      return unverified();
    }
  },
  /**
   * A new project. An account that encrypts new projects (decision D2)
   * creates it through the encrypted route, which never sees the document;
   * a plaintext create the Worker refuses for that reason moves there too.
   */
  createProject: async (payload: CreateProjectRequest) => {
    const encrypted = async () => {
      const created = await (
        await encryptedProjects()
      ).createEncryptedProject(payload);
      rememberProjectFormats([created.project]);
      return created;
    };
    // A device document too: the encrypted store refuses it without sending.
    if (await encryptsNewProjects()) {
      return encrypted();
    }
    try {
      return await requestJson<CreateProjectResponse>('/api/projects', {
        method: 'POST',
        body: JSON.stringify(
          payload.initialDocument
            ? await withSplitStorage(payload, 'initialDocument')
            : payload
        )
      });
    } catch (error) {
      if (
        !payload.document &&
        error instanceof ApiError &&
        error.code === ENCRYPTED_PROJECTS_REQUIRED_CODE
      ) {
        return encrypted();
      }
      throw error;
    }
  },
  /**
   * Gives an existing device-local project an account record and its cloud identity.
   * The derived projection is dropped on the way out: it is rebuilt from
   * canonical history on load, and for a dense import it is most of the bytes.
   *
   * The browser re-homes the document itself (ADR-024 Phase 1): a fresh
   * `proj_<uuid>` id, the account as owner and the closing "Saved to account"
   * checkpoint. The device id travels beside it as the account's retry key,
   * with the archived import ids localization removed, so a discarded mesh
   * upload still refuses the adoption.
   */
  adoptProject: (
    document: ProjectDocument,
    ownerUserId: UserId,
    options: { sourceArtifactIds?: readonly string[] } = {}
  ) => {
    // Shelf saves read IndexedDB without opening the project. Upgrade that
    // snapshot before the Worker checks its schema, keeping undo/redo endpoints
    // consistent with any migrated nodes. Reloading alone never rewrites it.
    // An unreadable history is dropped by normalization; never re-attach it.
    const normalized = normalizeDocument(document);
    const prepared = normalized.editHistory
      ? normalizeDocumentHistory(document, normalized)
      : normalized;
    const send = async (): Promise<CreateProjectResponse> => {
      const adopted = adoptProjectDocument(
        reidentifyProjectDocument(prepared, toProjectId(createId('proj'))),
        ownerUserId,
        prepared.name
      );
      return requestJson<CreateProjectResponse>('/api/projects', {
        method: 'POST',
        body: JSON.stringify(
          await withSplitStorage(
            {
              name: prepared.name,
              adoptionProtocolVersion: 2,
              localProjectId: prepared.projectId,
              ...(options.sourceArtifactIds?.length
                ? { sourceArtifactIds: options.sourceArtifactIds }
                : {}),
              document: withoutDerivedProjection(adopted)
            },
            'document'
          )
        )
      });
    };
    // An account that encrypts new projects (decision D2) is never sent
    // the plaintext document: the project is created encrypted (slice 4-8),
    // and its device-only files follow as encrypted blobs once it exists.
    const sendEncrypted = async (): Promise<CreateProjectResponse> => {
      const adopted = adoptProjectDocument(
        reidentifyProjectDocument(prepared, toProjectId(createId('proj'))),
        ownerUserId,
        prepared.name
      );
      const created = await (
        await encryptedProjects()
      ).createEncryptedProject({
        name: prepared.name,
        adoptionProtocolVersion: 2,
        localProjectId: prepared.projectId,
        document: withoutDerivedProjection(adopted)
      });
      rememberProjectFormats([created.project]);
      return created;
    };
    // A minted id that already names a project is a one-in-2^122 collision:
    // mint another once rather than failing the save.
    const adopt = async (
      encrypted: boolean,
      retried = false
    ): Promise<CreateProjectResponse> => {
      try {
        return encrypted ? await sendEncrypted() : await send();
      } catch (error) {
        if (!(error instanceof ApiError)) throw error;
        if (!encrypted && error.code === ENCRYPTED_PROJECTS_REQUIRED_CODE) {
          return adopt(true, retried);
        }
        if (error.code === 'PROJECT_ID_TAKEN' && !retried) {
          return adopt(encrypted, true);
        }
        throw error;
      }
    };
    return encryptsNewProjects().then((encrypts) => adopt(encrypts));
  },
  loadProject: (projectId: string) =>
    byFormat(
      projectId,
      async () =>
        openableAccountDocument(
          await requestJson<ProjectDocument>(
            `/api/projects/${encodeURIComponent(projectId)}`,
            undefined,
            { documentDownload: true, projectId }
          ),
          projectId
        ),
      (store) => store.loadProject(projectId),
      { fallback: true }
    ).catch((error: unknown) => {
      throw withProjectFormatMessage(error);
    }),
  /**
   * Stores a copy of a project. With `revisionId`, the copy starts from that
   * stored save state and records where it came from; the source project is
   * untouched either way. With `document`, the browser built the copy (ADR-024
   * Phase 1) and lists the archived imports the account copies for it;
   * without, the account builds it (the pre-Phase 1 contract).
   */
  duplicateProject: async (
    projectId: string,
    options: Omit<DuplicateProjectRequest, 'projectId'> = {}
  ) => {
    if (isEncryptedProject(projectId)) {
      // The page decrypted the source and built the copy; the account
      // copies its files byte for byte (slice 4-8). It cannot build one.
      if (!options.document) {
        throw new ApiError(
          400,
          'An end-to-end encrypted project is copied in the browser.'
        );
      }
      const created = await (
        await encryptedProjects()
      ).copyEncryptedProject({
        sourceProjectId: projectId,
        document: withoutDerivedProjection(options.document),
        ...(options.revisionId === undefined
          ? {}
          : { revisionId: options.revisionId })
      });
      rememberProjectFormats([created.project]);
      return created;
    }
    if (await encryptsNewProjects()) {
      throw new ApiError(
        409,
        'This account requires encrypted copies. Encrypt the source project first, or save a device copy to your account.',
        ENCRYPTED_PROJECTS_REQUIRED_CODE
      );
    }
    const request = {
      ...(options.name === undefined ? {} : { name: options.name }),
      ...(options.revisionId === undefined
        ? {}
        : { revisionId: options.revisionId }),
      ...(options.document === undefined
        ? {}
        : {
            document: withoutDerivedProjection(options.document),
            documentDigest: options.documentDigest,
            importSources: options.importSources ?? []
          })
    };
    return requestJson<DuplicateProjectResponse>(
      `/api/projects/${encodeURIComponent(projectId)}/duplicate`,
      {
        method: 'POST',
        body: JSON.stringify(
          request.document
            ? await withSplitStorage(request, 'document')
            : request
        )
      }
    );
  },
  /** The project's retained save states, newest first, without documents. */
  listRevisions: (projectId: string) =>
    byFormat(
      projectId,
      () =>
        requestJson<ListRevisionsResponse>(
          `/api/projects/${encodeURIComponent(projectId)}/revisions`
        ),
      (store) => store.listRevisions(projectId),
      { fallback: true }
    ),
  /**
   * One save state's document. Resolves to null when the account no longer
   * stores it, which retention makes an ordinary outcome rather than a fault.
   */
  loadRevision: (projectId: string, revisionId: string) =>
    byFormat(
      projectId,
      () => loadPlaintextRevision(projectId, revisionId),
      (store) => store.loadRevision(projectId, revisionId),
      { fallback: true }
    ),
  updateProject: (payload: UpdateProjectRequest, signal?: AbortSignal) =>
    requestJson<UpdateProjectResponse>(
      `/api/projects/${encodeURIComponent(payload.projectId)}`,
      {
        method: 'PATCH',
        ...(signal ? { signal } : {}),
        body: JSON.stringify(payload)
      }
    ),
  reorderProjects: (payload: ReorderProjectsRequest, signal?: AbortSignal) =>
    requestJson<ReorderProjectsResponse>('/api/projects/reorder', {
      method: 'POST',
      ...(signal ? { signal } : {}),
      body: JSON.stringify(payload)
    }),
  /** Irreversible. Use `updateProject` with status 'deleted' for the bin. */
  deleteProject: async (projectId: string) => {
    const response = await desktopFetch(
      `/api/projects/${encodeURIComponent(projectId)}`,
      {
        method: 'DELETE',
        credentials: 'same-origin'
      }
    );
    if (!response.ok) {
      throw new ApiError(
        response.status,
        (await response.text()) || `Delete failed (${response.status}).`
      );
    }
  },
  purgeExpiredProjects: () =>
    requestJson<PurgeProjectsResponse>('/api/projects/purge', {
      method: 'POST',
      body: '{}'
    }),
  /**
   * A named save. The browser appends the save point — revision, checkpoint,
   * ids and times — and the account checks and stores the document as sent
   * (ADR-024 Phase 1). The reason is trimmed first because the server compares
   * the minted records with the trimmed reason it receives.
   */
  saveRevision: async (payload: SaveRevisionRequest) => {
    if (encryptedProjectIds.has(payload.projectId)) {
      return (
        await (await encryptedProjects()).encryptedProjectStore()
      ).saveRevision(payload);
    }
    const reason = payload.reason.trim();
    const document =
      payload.savedRevisionId === undefined
        ? createSavedRevision(payload.document, reason)
        : payload.document;
    return requestJson<ProjectDocument>(
      `/api/projects/${encodeURIComponent(payload.projectId)}/revisions`,
      {
        method: 'POST',
        body: JSON.stringify(
          await withSplitStorage(
            {
              ...payload,
              reason,
              document,
              savedRevisionId:
                payload.savedRevisionId ?? document.revisions.at(-1)!.revisionId
            } satisfies SaveRevisionRequest,
            'document'
          )
        )
      }
    );
  },
  /**
   * The continuous-sync write. Same fencing as `saveRevision`, no history
   * entry, and only an acknowledgement comes back.
   *
   * `keepalive` is best-effort: browsers cap keepalive request bodies at
   * 64 KiB and reject larger ones outright, so it is applied only when the
   * body fits. An oversized document falls back to a plain fetch, which is
   * exactly the pre-keepalive behaviour.
   */
  saveProjectDocument: async (
    payload: SaveProjectDocumentRequest,
    options?: { keepalive?: boolean }
  ) => {
    if (encryptedProjectIds.has(payload.projectId)) {
      return (
        await (await encryptedProjects()).encryptedProjectStore()
      ).saveProjectDocument(payload);
    }
    const body = JSON.stringify(await withSplitStorage(payload, 'document'));
    return requestJson<SaveProjectDocumentResponse>(
      `/api/projects/${encodeURIComponent(payload.projectId)}/document`,
      {
        method: 'PUT',
        body,
        keepalive:
          options?.keepalive === true && new Blob([body]).size <= 60_000
      }
    );
  },
  createUploadSession: async (payload: CreateUploadSessionRequest) => {
    if (isEncryptedProject(payload.projectId)) {
      throw encryptedLocalOnly('Files');
    }
    return requestJson<CreateUploadSessionResponse>('/api/uploads', {
      method: 'POST',
      body: JSON.stringify(payload)
    });
  },
  uploadArtifact: async (uploadUrl: string, body: Blob) => {
    if (
      !isDesktopApp() &&
      new URL(uploadUrl, window.location.href).origin !== window.location.origin
    ) {
      throw new Error('Artifact upload URL must use the application origin.');
    }
    const response = await desktopFetch(uploadUrl, {
      method: 'PUT',
      headers: { 'content-type': body.type || 'application/octet-stream' },
      body
    });
    if (!response.ok) {
      throw new Error(
        (await response.text()) || `Upload failed (${response.status}).`
      );
    }
  },
  createMultipartUpload: (uploadSessionId: string) =>
    requestJson<CreateMultipartUploadResponse>(
      `/api/uploads/${encodeURIComponent(uploadSessionId)}/multipart`,
      { method: 'POST' }
    ),
  uploadArtifactPart: async (
    uploadSessionId: string,
    uploadId: string,
    partNumber: number,
    body: Blob
  ): Promise<UploadedArtifactPart> => {
    const response = await desktopFetch(
      `/api/uploads/${encodeURIComponent(uploadSessionId)}/parts/${partNumber}?uploadId=${encodeURIComponent(uploadId)}`,
      {
        method: 'PUT',
        headers: { 'content-type': 'application/octet-stream' },
        body
      }
    );
    if (!response.ok) {
      throw new Error(
        (await response.text()) ||
          `Upload part ${partNumber} failed (${response.status}).`
      );
    }
    return (await response.json()) as UploadedArtifactPart;
  },
  completeMultipartUpload: async (
    uploadSessionId: string,
    payload: CompleteMultipartUploadRequest
  ) => {
    const response = await desktopFetch(
      `/api/uploads/${encodeURIComponent(uploadSessionId)}/multipart/complete`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload)
      }
    );
    if (!response.ok) {
      throw new Error(
        (await response.text()) ||
          `Completing the upload failed (${response.status}).`
      );
    }
  },
  abortMultipartUpload: async (uploadSessionId: string, uploadId: string) => {
    const response = await desktopFetch(
      `/api/uploads/${encodeURIComponent(uploadSessionId)}/multipart?uploadId=${encodeURIComponent(uploadId)}`,
      { method: 'DELETE' }
    );
    if (!response.ok) {
      throw new Error(
        (await response.text()) ||
          `Aborting the upload failed (${response.status}).`
      );
    }
  },
  finalizeArtifact: (payload: FinalizeArtifactRequest) =>
    requestJson<{ artifactId: string | null }>('/api/artifacts/finalize', {
      method: 'POST',
      body: JSON.stringify(payload)
    }),
  discardMeshPayload: async (
    projectId: string,
    artifactId: string,
    kind?: 'stl-import' | 'mesh-import' | 'reference-image'
  ) => {
    // An encrypted project's unreferenced blob is garbage-collected once no
    // retained version names it (ADR-024 Phase 4, content blobs).
    if (isEncryptedProject(projectId)) return { deleted: true };
    return requestJson<{ deleted: boolean }>(
      `/api/artifacts/${encodeURIComponent(artifactId)}/discard-unreferenced`,
      { method: 'POST', body: JSON.stringify({ projectId, kind }) }
    );
  },
  /**
   * The project's stored files. An encrypted project's archived exports are
   * listed in its verified project info (ADR-024 Phase 4, slice 4-7).
   */
  listArtifacts: async (projectId: string): Promise<ListArtifactsResponse> => {
    if (isEncryptedProject(projectId)) {
      return {
        artifacts: await (
          await encryptedProjects()
        ).listEncryptedArtifacts(projectId)
      };
    }
    return requestJson<ListArtifactsResponse>(
      `/api/projects/${encodeURIComponent(projectId)}/artifacts`
    );
  },
  getArtifactMetadata: (artifactId: string) =>
    requestJson<ArtifactMetadataResponse>(
      `/api/artifacts/${encodeURIComponent(artifactId)}`
    )
};
