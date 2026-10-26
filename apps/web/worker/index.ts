import { releaseDevelopmentE2eeWrite } from './e2eeWriteAuthorization';
import { accountConsent, publishCensus } from './glimpseCensus';
import { handleGlimpseUsage, countApi, type GlimpseEnv } from './glimpse';
import { handleE2eeRequest, projectBucket } from './e2ee';
import {
  handleEncryptedSharedBlob,
  handleEncryptedSharedSnapshot,
  isEncryptedSharedBlobPath,
  isEncryptedSharedSnapshotPath,
  type SharedBlobGuard
} from './e2eeShareLinks';
import { blobBucket } from './e2eeContentBlobs';
import type { E2eeInvitationHost } from './e2eeInvitations';
import { withEncryptedProjectInfo } from './e2eeProjectDocuments';
import { accountRequiresEncryptedProjects } from './e2eeProjectPreferences';
import {
  isE2eeAssistantConsentStorageReady,
  liveAssistantConsentRoute
} from './e2eeAssistantConsents';
import {
  assertProjectNotMigrating,
  assertProjectRouteFormat
} from './projectFormatGate';
import { sweepProjectMigrations } from './e2eeProjectMigrations';
import {
  decryptStagingFor,
  decryptStagingRouteProject,
  stageDecryptedHead,
  stageDecryptedRevision
} from './e2eeReverseStaging';
import { encryptedRoomHeaders, notifyEncryptedRoom } from './e2eeRoom';
import {
  enforceApiRateLimit,
  isApiRateLimitSpent,
  markApiRateLimitSpent,
  publicRequestBucket
} from './apiRateLimit';
import {
  FREECAD_WORKER_PATH,
  serveFreecadWorkerAsset
} from './freecadWorkerAsset';
import { JsonComplexityGuard } from '@openzcad/shared';
import { accountEntitlements } from '@openzcad/cloudflare-adapters';
import {
  loadWorkspaceSessions,
  parseWorkspaceSession,
  saveWorkspaceSession
} from './workspaceSessions';
import type { ProjectCollaborationRoom } from '@openzcad/cloudflare-adapters';
import {
  DecryptStagingLeaseError,
  EncryptedBlobError,
  ProjectObjectStorageError,
  createPersistenceService,
  isCloudflareFeatureEnabled,
  isE2eeKeysEnabled,
  isE2eeMigrationEnabled,
  isE2eeProjectsEnabled,
  isE2eeReverseEnabled,
  isProjectStorageFormatReady,
  projectCollaborationRollout,
  type ProjectCollaborationRollout,
  type CloudflareEnv
} from '@openzcad/cloudflare-adapters';
import {
  ArtifactQuotaError,
  ArtifactStorageError,
  assertPlaintextProject,
  assertShareableProject,
  DocumentTooLargeError,
  EncryptedProjectSharingError,
  EncryptedProjectsRequiredError,
  ProjectFormatUnsupportedError,
  ProjectMigratingError,
  ProjectAdoptionError,
  ProjectQuotaError,
  ProjectNotFoundError,
  ProjectSharingError,
  RevisionConflictError,
  RevisionIdCollisionError,
  SavePointRequestError,
  ProjectStorageUploadError,
  RevisionNotFoundError
} from '@openzcad/persistence';
import {
  HttpError,
  openProjectStorageRequest,
  parseCreateProjectRequest,
  parseAssistantProposalRequest,
  parseCompleteMultipartUploadRequest,
  parseCreateUploadSessionRequest,
  parseDuplicateProjectRequest,
  parseFinalizeImportRequest,
  parseDiscardMeshPayloadRequest,
  parseReorderProjectsRequest,
  parseSaveProjectDocumentRequest,
  parseSaveRevisionRequest,
  parseUpdateProjectRequest
} from './validation';
import {
  AccountDeletionError,
  accountDeletionPreview,
  assertAccountNotErasing,
  deleteAccountData
} from './accountDeletion';
import {
  assistantSafetyIdentifier,
  getAssistantStatus,
  HttpAssistantConfigurationError,
  maxOutputTokensFor,
  streamAssistantProposal,
  testAssistantConnection,
  timeoutFor
} from './assistant';
import {
  acquireAssistantPermit,
  assistantQuotaCost
} from './assistantRateLimit';
import {
  assistantProviderIdentity,
  authenticateBrowserSession,
  authenticateRequest,
  approveDesktopAuthorization,
  AuthFlowError,
  AuthenticationError,
  destroyDesktopAuthorization,
  destroyEmailSession,
  exchangeDesktopAuthorization,
  getAuthConfig,
  getDesktopAuthConfig,
  identifyAssistantIdentity,
  refreshDesktopAuthorization,
  startDesktopAuthorization,
  startEmailLogin,
  verifyEmailLogin
} from './auth';
import {
  clearAssistantCredentialValidation,
  deleteAssistantCredential,
  getAppSettings,
  isProjectSharingPreferenceEnabled,
  markAssistantCredentialValidated,
  parseAssistantCredential,
  parseUpdateAppSettingsRequest,
  settingsRequestOmitsKeymap,
  settingsRequestOmitsHiddenRelationGlyphs,
  settingsRequestOmitsRelationGlyphs,
  settingsRequestOmittedViewportFields,
  resolveUserAssistant,
  saveAssistantCredential,
  updateAppSettings
} from './settings';
import {
  acceptInvitation,
  createInvitation,
  createShareLink,
  hashProjectInvitationToken,
  parseCreateInvitation,
  parseProjectMemberRole,
  parseShareLinkToken,
  sendProjectInvitationEmail,
  SharingRequestError
} from './sharing';
import {
  isAccountErasureReady,
  isArtifactUploadAccountingReady,
  isDocumentStorageAccountingReady,
  isProjectMeasurementStorageReady,
  isProjectObjectStorageReady,
  isD1ProjectStorageReady
} from './readiness';
import {
  deleteProjectMeasurements,
  loadProjectMeasurements,
  MAX_PROJECT_MEASUREMENT_BYTES,
  parseDeleteProjectMeasurementsRequest,
  parseSaveProjectMeasurementsRequest,
  ProjectMeasurementRequestError,
  ProjectMeasurementRevisionConflictError,
  saveProjectMeasurements
} from './projectMeasurements';
import {
  assistantConsentRoute,
  E2EE_MIGRATION_CODES,
  ENCRYPTED_PROJECT_ASSISTANT_CONSENT_REQUIRED_CODE,
  ENCRYPTED_PROJECT_ASSISTANT_UNAVAILABLE_CODE,
  MAX_ARTIFACT_PART_BYTES,
  MAX_ARTIFACT_UPLOAD_PARTS,
  MAX_CLOUD_PROJECT_WRITE_BYTES,
  toUserId
} from '@openzcad/shared';

type Env = CloudflareEnv &
  GlimpseEnv & {
    ASSETS?: { fetch(request: Request): Promise<Response> };
    PROJECT_ROOM?: DurableObjectNamespace<ProjectCollaborationRoom>;
  };

/** Upper bound for JSON request bodies; protects against oversized payloads. */
const MAX_JSON_BODY_BYTES = 25 * 1024 * 1024;
const MAX_ARTIFACT_BODY_BYTES = 25 * 1024 * 1024;
/** Cache only a proven-ready schema; failures stay retryable without a deploy. */
const projectStorageReadyEnvironments = new WeakSet<Env>();
const d1ProjectStorageReadyEnvironments = new WeakSet<Env>();
const projectMeasurementStorageReadyEnvironments = new WeakSet<Env>();
const artifactUploadReadyEnvironments = new WeakSet<Env>();
const HEALTH_READINESS_TTL_MS = 60_000;
interface HealthReadiness {
  artifactUploadAccountingReady: boolean;
  documentStorageAccountingReady: boolean;
  projectObjectStorageReady: boolean;
  projectMeasurementStorageReady: boolean;
  accountErasureReady: boolean;
}
const healthReadinessCache = new WeakMap<
  Env,
  { expiresAt: number; value: Promise<HealthReadiness> }
>();

function healthReadiness(env: Env): Promise<HealthReadiness> {
  const now = Date.now();
  const cached = healthReadinessCache.get(env);
  if (cached && cached.expiresAt > now) {
    return cached.value;
  }
  const value = Promise.all([
    isArtifactUploadAccountingReady(env.DB),
    isDocumentStorageAccountingReady(env.DB),
    isProjectObjectStorageReady(env.DB, env.PROJECT_STORAGE ?? env.ARTIFACTS),
    isProjectMeasurementStorageReady(env.DB),
    isAccountErasureReady(env.DB)
  ]).then(
    ([
      artifactUploadAccountingReady,
      documentStorageAccountingReady,
      projectObjectStorageReady,
      projectMeasurementStorageReady,
      accountErasureReady
    ]) => ({
      artifactUploadAccountingReady,
      documentStorageAccountingReady,
      projectObjectStorageReady,
      projectMeasurementStorageReady,
      accountErasureReady
    })
  );
  healthReadinessCache.set(env, {
    expiresAt: now + HEALTH_READINESS_TTL_MS,
    value
  });
  return value;
}
const collaborationRolloutEnvironments = new WeakMap<Env, Map<string, Env>>();

function assertEditorLeaseEligible(
  env: Env,
  email: string | null | undefined,
  message: string
): void {
  if (
    !projectCollaborationRollout(env, email ?? undefined).editLeasesEnforced
  ) {
    throw new SharingRequestError(409, 'EDIT_LEASE_REQUIRED', message);
  }
}

const PROJECT_ROUTE = /^\/api\/projects\/([^/]+)$/;
const PROJECT_DUPLICATE_ROUTE = /^\/api\/projects\/([^/]+)\/duplicate$/;
const PROJECT_REVISIONS_ROUTE = /^\/api\/projects\/([^/]+)\/revisions$/;
const PROJECT_REVISION_ROUTE = /^\/api\/projects\/([^/]+)\/revisions\/([^/]+)$/;
const PROJECT_DOCUMENT_ROUTE = /^\/api\/projects\/([^/]+)\/document$/;
const WORKSPACE_SESSIONS_ROUTE =
  /^\/api\/projects\/([^/]+)\/workspace-sessions$/;
const PROJECT_MEASUREMENTS_ROUTE = /^\/api\/projects\/([^/]+)\/measurements$/;
const PROJECT_COLLABORATION_ROUTE = /^\/api\/projects\/([^/]+)\/collaboration$/;
const PROJECT_COLLABORATION_TICKET_ROUTE =
  /^\/api\/projects\/([^/]+)\/collaboration\/ticket$/;
const PROJECT_SHARING_ROUTE = /^\/api\/projects\/([^/]+)\/sharing$/;
const PROJECT_INVITATIONS_ROUTE = /^\/api\/projects\/([^/]+)\/invitations$/;
const PROJECT_INVITATION_ROUTE =
  /^\/api\/projects\/([^/]+)\/invitations\/([^/]+)$/;
const PROJECT_MEMBER_ROUTE = /^\/api\/projects\/([^/]+)\/members\/([^/]+)$/;
const PROJECT_SHARE_LINKS_ROUTE = /^\/api\/projects\/([^/]+)\/share-links$/;
const PROJECT_SHARE_LINK_ROUTE =
  /^\/api\/projects\/([^/]+)\/share-links\/([^/]+)$/;
const SHARED_PROJECT_ROUTE = /^\/api\/share\/([^/]+)$/;
const SHARED_PROJECT_ASSET_ROUTE = /^\/api\/share\/([^/]+)\/assets\/([^/]+)$/;
const SHARED_PROJECT_SOURCE_ROUTE = /^\/api\/share\/([^/]+)\/sources\/([^/]+)$/;
/**
 * Anonymous encrypted share-link reads per client address and minute
 * (ADR-024 slice 5-11; judgment): a visitor opens a snapshot once per load,
 * then fetches each content blob it names once.
 */
const ENCRYPTED_SHARED_SNAPSHOT_RATE_LIMIT = 60;
const ENCRYPTED_SHARED_BLOB_RATE_LIMIT = 300;
/**
 * Blob reads count per link load instead (slice 8-C1, #923 review): per
 * address, link and minute, twice the blobs the link's snapshot names plus
 * a few, so a model with more imports than the address budget loads at
 * once (and again on a reload). Past that, and for every request naming no
 * servable link, the address's own budget above applies.
 */
const ENCRYPTED_SHARED_LOAD_BLOB_FACTOR = 2;
const ENCRYPTED_SHARED_LOAD_BLOB_SLACK = 32;
const INVITATION_ACCEPT_ROUTE = '/api/project-invitations/accept';
const PROJECT_ARTIFACTS_ROUTE = /^\/api\/projects\/([^/]+)\/artifacts$/;
const UPLOAD_CONTENT_ROUTE = /^\/api\/uploads\/([^/]+)\/content$/;
const UPLOAD_MULTIPART_ROUTE = /^\/api\/uploads\/([^/]+)\/multipart$/;
const UPLOAD_MULTIPART_COMPLETE_ROUTE =
  /^\/api\/uploads\/([^/]+)\/multipart\/complete$/;
const UPLOAD_PART_ROUTE = /^\/api\/uploads\/([^/]+)\/parts\/([1-9]\d*)$/;
const ARTIFACT_DISCARD_ROUTE =
  /^\/api\/artifacts\/([^/]+)\/discard-unreferenced$/;
const ARTIFACT_ROUTE = /^\/api\/artifacts\/([^/]+)$/;
const ARTIFACT_DOWNLOAD_ROUTE = /^\/api\/artifacts\/([^/]+)\/download$/;

async function projectStorageIsReady(
  env: Env,
  bucket: R2Bucket
): Promise<boolean> {
  if (projectStorageReadyEnvironments.has(env)) {
    return true;
  }
  const ready = await isProjectObjectStorageReady(env.DB, bucket);
  if (ready) {
    projectStorageReadyEnvironments.add(env);
  }
  return ready;
}

async function d1ProjectStorageIsReady(env: Env): Promise<boolean> {
  if (d1ProjectStorageReadyEnvironments.has(env)) {
    return true;
  }
  const ready = await isD1ProjectStorageReady(env.DB);
  if (ready) {
    d1ProjectStorageReadyEnvironments.add(env);
  }
  return ready;
}

async function projectMeasurementStorageIsReady(env: Env): Promise<boolean> {
  if (projectMeasurementStorageReadyEnvironments.has(env)) {
    return true;
  }
  const ready = await isProjectMeasurementStorageReady(env.DB);
  if (ready) {
    projectMeasurementStorageReadyEnvironments.add(env);
  }
  return ready;
}

async function artifactUploadIsReady(env: Env): Promise<boolean> {
  if (artifactUploadReadyEnvironments.has(env)) return true;
  const ready = await isArtifactUploadAccountingReady(env.DB);
  if (ready) artifactUploadReadyEnvironments.add(env);
  return ready;
}

function envForCollaborationRollout(
  env: Env,
  rollout: ProjectCollaborationRollout
): Env {
  const key = [
    rollout.sharingEnabled,
    rollout.editLeasesEnforced,
    rollout.personalSyncEnabled
  ].join(':');
  let environments = collaborationRolloutEnvironments.get(env);
  if (!environments) {
    environments = new Map();
    collaborationRolloutEnvironments.set(env, environments);
  }
  const cached = environments.get(key);
  if (cached) {
    return cached;
  }
  const derived = {
    ...env,
    PROJECT_SHARING_ENABLED: String(rollout.sharingEnabled),
    PROJECT_EDIT_LEASES_ENFORCED: String(rollout.editLeasesEnforced),
    PROJECT_PERSONAL_SYNC_ENABLED: String(rollout.personalSyncEnabled)
  };
  environments.set(key, derived);
  return derived;
}

export function assertSafeRuntimeConfiguration(env: CloudflareEnv): void {
  if (
    (env.PRODUCTION_GUARD !== undefined ||
      env.ENVIRONMENT !== 'development' ||
      env.AUTH_MODE !== 'development') &&
    !env.DB
  ) {
    throw new Error(
      'Refusing to start without DB in a guarded or hosted environment.'
    );
  }
  if (
    env.AUTH_MODE === 'development' &&
    (env.ENVIRONMENT !== 'development' || env.PRODUCTION_GUARD !== undefined)
  ) {
    throw new Error(
      'Refusing to start with development authentication in a guarded or non-development environment.'
    );
  }
}

function assertSameOrigin(request: Request): void {
  const origin = request.headers.get('origin');
  if (
    (!origin && request.headers.get('sec-fetch-site') === 'cross-site') ||
    (origin && origin !== new URL(request.url).origin)
  ) {
    throw new HttpError(403, 'Cross-origin changes are not allowed.');
  }
}

function json(
  data: unknown,
  status = 200,
  responseHeaders?: HeadersInit
): Response {
  const headers = new Headers(responseHeaders);
  headers.set('content-type', 'application/json');
  return new Response(JSON.stringify(data), {
    status,
    headers
  });
}

async function readJsonBody(
  request: Request,
  maxBytes = MAX_JSON_BODY_BYTES,
  documentRequest = false
): Promise<unknown> {
  const contentLength = Number(request.headers.get('content-length') ?? '0');
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw new HttpError(
      413,
      'Request body is too large.',
      documentRequest ? maxBytes : undefined
    );
  }
  try {
    const reader = request.body?.getReader();
    if (!reader) {
      throw new Error('Request body is missing.');
    }
    const decoder = new TextDecoder();
    const chunks: string[] = [];
    const structure = new JsonComplexityGuard();
    let totalBytes = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        totalBytes += value.byteLength;
        if (totalBytes > maxBytes) {
          await reader.cancel().catch(() => undefined);
          throw new HttpError(
            413,
            'Request body is too large.',
            documentRequest ? maxBytes : undefined
          );
        }
        const chunk = decoder.decode(value, { stream: true });
        try {
          structure.consume(chunk);
        } catch {
          await reader.cancel().catch(() => undefined);
          throw new HttpError(
            413,
            'Request JSON is too complex.',
            undefined,
            documentRequest
          );
        }
        chunks.push(chunk);
      }
    } finally {
      reader.releaseLock();
    }
    chunks.push(decoder.decode());
    return JSON.parse(chunks.join('')) as unknown;
  } catch (error) {
    if (error instanceof HttpError) {
      throw error;
    }
    throw new HttpError(400, 'Request body must be valid JSON.');
  }
}

/**
 * Binary variant of readJsonBody for artifact uploads: enforces the byte cap
 * while streaming, so a missing or understated content-length cannot buffer an
 * oversized body into isolate memory before the size check runs.
 */
async function readBinaryBody(
  request: Request,
  maxBytes: number,
  labels: { empty: string; tooLarge: string }
): Promise<ArrayBuffer> {
  const contentLength = Number(request.headers.get('content-length') ?? '0');
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw new HttpError(413, labels.tooLarge);
  }
  const reader = request.body?.getReader();
  if (!reader) {
    throw new HttpError(400, labels.empty);
  }
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new HttpError(413, labels.tooLarge);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  if (totalBytes === 0) {
    throw new HttpError(400, labels.empty);
  }
  const body = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body.buffer;
}

async function notifyProjectRoleChange(
  env: Env,
  projectId: string,
  memberUserId: string,
  role: 'editor' | 'viewer' | null
): Promise<void> {
  if (!env.PROJECT_ROOM) {
    return;
  }
  const headers = new Headers({
    'x-openzcad-internal-role-update': 'v1',
    'x-openzcad-internal-user-id': memberUserId
  });
  if (role) {
    headers.set('x-openzcad-internal-project-role', role);
  }
  const response = await env.PROJECT_ROOM.getByName(projectId).fetch(
    new Request(
      `https://project-room.internal/?projectId=${encodeURIComponent(projectId)}`,
      {
        method: 'PATCH',
        headers
      }
    )
  );
  if (!response.ok) {
    throw new Error('Project room rejected an internal role update.');
  }
}

/**
 * Tells every owned room to drop its non-owner sockets now that the owner
 * turned sharing off.
 *
 * Best-effort by design: it runs after the settings write has committed, and
 * it is the eager half only. Rooms re-read the owner's preference from D1
 * whenever a member acts, so a room that misses this still refuses that member
 * on use — while throwing here turned an already-saved setting into a 500.
 */
async function notifyOwnedRoomsCollaborationDisabled(
  env: Env,
  ownerUserId: string
): Promise<void> {
  const rooms = env.PROJECT_ROOM;
  if (!env.DB || !rooms) {
    return;
  }
  const owned = await env.DB.prepare(
    'SELECT id FROM projects WHERE user_id = ?'
  )
    .bind(ownerUserId)
    .all<{ id: string }>()
    .catch(() => null);
  if (!owned) {
    console.error(
      JSON.stringify({ event: 'collaboration_disable_rooms_unlisted' })
    );
    return;
  }
  const notifications = await Promise.allSettled(
    (owned.results ?? []).map(async ({ id: projectId }) => {
      const response = await rooms.getByName(projectId).fetch(
        new Request(
          `https://project-room.internal/?projectId=${encodeURIComponent(projectId)}`,
          {
            method: 'PATCH',
            headers: {
              'x-openzcad-internal-role-update': 'v1',
              'x-openzcad-internal-owner-collaboration-disabled': 'v1'
            }
          }
        )
      );
      if (!response.ok) {
        throw new Error(
          'Project room rejected a collaboration disable update.'
        );
      }
    })
  );
  const failed = notifications.filter(
    (notification) => notification.status === 'rejected'
  ).length;
  if (failed > 0) {
    console.error(
      JSON.stringify({
        event: 'collaboration_disable_rooms_unnotified',
        failed,
        total: notifications.length
      })
    );
  }
}

function projectInvitationEmailConfig(env: Env): {
  email: SendEmail;
  sender: string;
  publicAppOrigin: string;
} {
  const sender = env.PROJECT_INVITATION_EMAIL_FROM?.trim();
  const publicAppOrigin = env.PUBLIC_APP_ORIGIN?.trim();
  if (!env.EMAIL || !sender || !publicAppOrigin) {
    throw new SharingRequestError(
      503,
      'INVITATION_EMAIL_UNAVAILABLE',
      'Project invitation email is temporarily unavailable.'
    );
  }
  return { email: env.EMAIL, sender, publicAppOrigin };
}

/**
 * What the encrypted invitation routes (ADR-024 slice 5-3a) need from this
 * Worker: the session's email, the sender's name, the sharing rollout and
 * the invitation email, which names the sender and never the project.
 */
function encryptedInvitationHost(
  env: Env,
  session: { email?: string | null; displayName?: string | null }
): E2eeInvitationHost {
  return {
    email: session.email ?? null,
    inviterLabel: session.email ?? session.displayName ?? 'Someone',
    sharingEnabled: projectCollaborationRollout(env, session.email ?? undefined)
      .sharingEnabled,
    // The plaintext invitation route's canary rule. Its edit-lease rule
    // does not apply (slice 5-4): it exists so a plaintext editor's writes
    // go through the lease-checked room instead of the account route, but an
    // encrypted project's editors write versions the account accepts only
    // on top of the head they read (compare-and-swap), and its room serves
    // only the owner until slice 5-6, which decides the room's leases.
    recipientRefusal: (email) => {
      if (
        projectCollaborationRollout(env, session.email ?? undefined).canary &&
        !isCloudflareFeatureEnabled(env, 'PROJECT_SHARING_ENABLED') &&
        !projectCollaborationRollout(env, email).canary
      ) {
        return {
          status: 403,
          code: 'CANARY_RECIPIENT_REQUIRED',
          message:
            'During the collaboration canary, invitations can be sent only to allowlisted accounts.'
        };
      }
      return null;
    },
    emailConfigured: Boolean(
      env.EMAIL &&
      env.PROJECT_INVITATION_EMAIL_FROM?.trim() &&
      env.PUBLIC_APP_ORIGIN?.trim()
    ),
    sendInvitationEmail: async (details) => {
      const config = projectInvitationEmailConfig(env);
      try {
        await sendProjectInvitationEmail(
          config.email,
          { sender: config.sender, publicAppOrigin: config.publicAppOrigin },
          { ...details, projectName: null }
        );
      } catch (error) {
        console.error(
          JSON.stringify({
            event: 'e2ee_invitation_email_failed',
            errorCode: emailDeliveryErrorCode(error)
          })
        );
        throw error;
      }
    }
  };
}

function emailDeliveryErrorCode(error: unknown): string {
  if (!error || typeof error !== 'object' || !('code' in error)) {
    return 'UNKNOWN';
  }
  const code = error.code;
  return typeof code === 'string' && /^[A-Z0-9_]+$/.test(code)
    ? code
    : 'UNKNOWN';
}

/**
 * Decision D2: once an account opts in to encrypting new projects, the
 * Worker stores no new plaintext project for it — create, adopt or copy.
 * Only while encrypted projects are open to the account.
 */
async function assertPlaintextCreationAllowed(
  env: Env,
  session: { userId: string; email?: string | null }
): Promise<void> {
  if (
    isE2eeProjectsEnabled(env, session.email ?? undefined) &&
    (await accountRequiresEncryptedProjects(env.DB, session.userId))
  ) {
    throw new EncryptedProjectsRequiredError();
  }
}

/**
 * Whether the assistant may see this project (decision D7, lifted per
 * project by ADR-024 Phase 6). A plaintext project passes as before and
 * answers null. An encrypted one passes only with this account's live
 * consent for it (migration 0041, behind E2EE_PROJECTS_ENABLED), and
 * answers the provider route that consent named, which the caller compares
 * with the route the request would take. Without the flag or the migration
 * every encrypted project is refused exactly as before. Only a project the
 * caller owns or is a member of is looked up, so the answer reveals nothing
 * about other accounts' projects.
 */
async function assertAssistantProjectAllowed(
  env: Env,
  identity: { userId: string; email?: string | null },
  projectId: string
): Promise<string | null> {
  const userId = identity.userId;
  // Before migration 0031 every project is plaintext.
  if (!(await isProjectStorageFormatReady(env.DB))) return null;
  const row = await env
    .DB!.prepare(
      `SELECT p.storage_format FROM projects p
     WHERE p.id = ? AND (
       p.user_id = ? OR EXISTS (
         SELECT 1 FROM project_members pm
         WHERE pm.project_id = p.id AND pm.user_id = ?
       )
     )`
    )
    .bind(projectId, userId, userId)
    .first<{ storage_format: number | null }>();
  if (row && row.storage_format !== null && row.storage_format !== 1) {
    if (
      isE2eeProjectsEnabled(env, identity.email ?? undefined) &&
      (await isE2eeAssistantConsentStorageReady(env.DB))
    ) {
      const route = await liveAssistantConsentRoute(env.DB!, userId, projectId);
      if (route !== null) return route;
      throw new SharingRequestError(
        409,
        ENCRYPTED_PROJECT_ASSISTANT_CONSENT_REQUIRED_CODE,
        'Allow the assistant for this end-to-end encrypted project first. Nothing was sent.'
      );
    }
    throw new SharingRequestError(
      409,
      ENCRYPTED_PROJECT_ASSISTANT_UNAVAILABLE_CODE,
      'The assistant is not available on end-to-end encrypted projects yet.'
    );
  }
  return null;
}

async function handleApiRequest(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const { pathname } = url;

  if (request.method === 'GET' && pathname === '/api/health') {
    if (env.ENVIRONMENT !== 'development') {
      await enforceApiRateLimit(
        env,
        await publicRequestBucket(request, env, 'health'),
        120
      );
    }
    const {
      artifactUploadAccountingReady,
      documentStorageAccountingReady,
      projectObjectStorageReady,
      projectMeasurementStorageReady,
      accountErasureReady
    } = await healthReadiness(env);
    return json({
      status: 'ok',
      environment: env.ENVIRONMENT ?? 'beta',
      time: new Date().toISOString(),
      artifactUploadAccountingReady,
      documentStorageAccountingReady,
      projectObjectStorageReady,
      projectMeasurementStorageReady,
      accountErasureReady,
      projectErasureReady:
        projectObjectStorageReady &&
        accountErasureReady &&
        Boolean(env.PROJECT_ROOM),
      projectSharingEnabled: isCloudflareFeatureEnabled(
        env,
        'PROJECT_SHARING_ENABLED'
      ),
      projectEditLeasesEnforced: isCloudflareFeatureEnabled(
        env,
        'PROJECT_EDIT_LEASES_ENFORCED'
      ),
      projectPersonalSyncEnabled:
        documentStorageAccountingReady &&
        projectObjectStorageReady &&
        isCloudflareFeatureEnabled(env, 'PROJECT_PERSONAL_SYNC_ENABLED'),
      projectMeasurementSyncEnabled:
        projectMeasurementStorageReady &&
        isCloudflareFeatureEnabled(env, 'PROJECT_PERSONAL_SYNC_ENABLED')
    });
  }

  if (request.method === 'GET' && pathname === '/api/auth/config') {
    return json(getAuthConfig(env));
  }

  if (request.method === 'GET' && pathname === '/api/auth/desktop/config') {
    return json(await getDesktopAuthConfig(env));
  }

  // Anonymous share-link reads, registered alongside the other public routes.
  // The capability token in the path is the entire authorization, so these
  // deliberately never touch authenticateRequest, and unknown, malformed, and
  // revoked or expired tokens all collapse into one opaque 404.
  const sharedProjectMatch = SHARED_PROJECT_ROUTE.exec(pathname);
  const sharedProjectAssetMatch = SHARED_PROJECT_ASSET_ROUTE.exec(pathname);
  const sharedProjectSourceMatch = SHARED_PROJECT_SOURCE_ROUTE.exec(pathname);
  if (
    request.method === 'GET' &&
    (sharedProjectMatch || sharedProjectAssetMatch || sharedProjectSourceMatch)
  ) {
    const sharedNotFound = () => json({ error: 'Share link not found.' }, 404);
    // The sharing flag has to reach this route too, or turning it off would
    // stop new links being minted while every link already out there kept
    // serving whole documents anonymously. Resolved without an email: an
    // anonymous caller has no account, so only the deployment-wide flag can
    // speak here. Answered as the same opaque 404 the rest of the route
    // uses, rather than telling an anonymous prober how this deployment is
    // configured.
    if (!projectCollaborationRollout(env).sharingEnabled) {
      return sharedNotFound();
    }
    const token = parseShareLinkToken(
      (sharedProjectSourceMatch ??
        sharedProjectAssetMatch ??
        sharedProjectMatch)![1]!
    );
    if (!token) {
      return sharedNotFound();
    }
    const sharedPersistence = createPersistenceService(env);
    const tokenHash = await hashProjectInvitationToken(token);
    if (sharedProjectSourceMatch) {
      const source = await sharedPersistence.loadSharedProjectImportSource(
        tokenHash,
        sharedProjectSourceMatch[2]!
      );
      if (!source) {
        return sharedNotFound();
      }
      return new Response(source.body, {
        headers: {
          'content-type': source.contentType,
          'content-disposition': 'attachment',
          ...(source.bytes !== undefined
            ? { 'content-length': String(source.bytes) }
            : {}),
          'cache-control': 'no-store',
          'x-content-type-options': 'nosniff'
        }
      });
    }
    if (sharedProjectAssetMatch) {
      const asset = await sharedPersistence.loadSharedProjectAsset(
        tokenHash,
        sharedProjectAssetMatch[2]!
      );
      if (!asset) {
        return sharedNotFound();
      }
      return new Response(asset.body, {
        headers: {
          'content-type': asset.contentType,
          'content-disposition': 'attachment',
          'content-length': String(asset.body.byteLength),
          'cache-control': 'no-store',
          'x-content-type-options': 'nosniff'
        }
      });
    }
    const shared =
      await sharedPersistence.loadSharedProjectByTokenHash(tokenHash);
    if (!shared) {
      return sharedNotFound();
    }
    // Already the share projection: the current model only, with no undo
    // history, command log, save-state names or owner id.
    return json(
      {
        project: {
          projectId: shared.projectId,
          name: shared.name,
          mode: shared.mode
        },
        document: shared.document
      },
      200,
      { 'cache-control': 'no-store' }
    );
  }

  // Anonymous reads of encrypted projects' share links (ADR-024 slice
  // 5-10): the token is the whole authorization, as above, and the route
  // serves only a signed share-snapshot envelope with what a visitor checks
  // it with, never a plaintext project. It needs the deployment-wide
  // E2EE_PROJECTS_ENABLED flag and sharing rollout (an anonymous caller has
  // no email for the canaries); everything else is one opaque 404.
  //
  // Its content blobs (slice 5-11) are served the same way, only those the
  // link's current snapshot names. Both are rate limited per client address
  // once the deployment serves them, like the other public routes; while
  // the flags are off they answer the opaque 404 without touching the
  // limiter's table.
  const encryptedSharedBlob =
    request.method === 'GET' && isEncryptedSharedBlobPath(pathname);
  if (
    encryptedSharedBlob ||
    (request.method === 'GET' && isEncryptedSharedSnapshotPath(pathname))
  ) {
    const open =
      isCloudflareFeatureEnabled(env, 'E2EE_PROJECTS_ENABLED') &&
      projectCollaborationRollout(env).sharingEnabled;
    const limited = open && env.ENVIRONMENT !== 'development';
    if (limited && !encryptedSharedBlob) {
      await enforceApiRateLimit(
        env,
        await publicRequestBucket(request, env, 'e2ee-share'),
        ENCRYPTED_SHARED_SNAPSHOT_RATE_LIMIT
      );
    }
    // A blob counts within a load of its link, or else per address (#923).
    const address = limited
      ? await publicRequestBucket(request, env, 'e2ee-share-blob')
      : null;
    const perAddress = () =>
      enforceApiRateLimit(env, address!, ENCRYPTED_SHARED_BLOB_RATE_LIMIT);
    // A load over its budget is marked so later requests skip the snapshot
    // read that sizes it (#935 review): they go to the address's budget.
    const spentMark = (linkKey: string) => `${address}:${linkKey}:spent`;
    const blobGuard: SharedBlobGuard | null = address
      ? {
          unbudgeted: perAddress,
          spent: async (linkKey) => {
            if (!(await isApiRateLimitSpent(env, spentMark(linkKey)))) {
              return false;
            }
            await perAddress();
            return true;
          },
          load: async (linkKey, blobs) => {
            try {
              await enforceApiRateLimit(
                env,
                `${address}:${linkKey}`,
                blobs * ENCRYPTED_SHARED_LOAD_BLOB_FACTOR +
                  ENCRYPTED_SHARED_LOAD_BLOB_SLACK
              );
            } catch (error) {
              if (!(error instanceof HttpError) || error.status !== 429) {
                throw error;
              }
              await markApiRateLimitSpent(env, spentMark(linkKey));
              await perAddress();
            }
          }
        }
      : null;
    return encryptedSharedBlob
      ? handleEncryptedSharedBlob(
          pathname,
          env.DB,
          projectBucket(env),
          blobBucket(env),
          open,
          blobGuard
        )
      : handleEncryptedSharedSnapshot(
          pathname,
          env.DB,
          projectBucket(env),
          open
        );
  }

  const collaborationMatch = PROJECT_COLLABORATION_ROUTE.exec(pathname);
  const workspaceSessionsMatch = WORKSPACE_SESSIONS_ROUTE.exec(pathname);
  const measurementsMatch = PROJECT_MEASUREMENTS_ROUTE.exec(pathname);
  const collaborationTicketMatch =
    PROJECT_COLLABORATION_TICKET_ROUTE.exec(pathname);
  const sharingMatch = PROJECT_SHARING_ROUTE.exec(pathname);
  const invitationsMatch = PROJECT_INVITATIONS_ROUTE.exec(pathname);
  const invitationMatch = PROJECT_INVITATION_ROUTE.exec(pathname);
  const memberMatch = PROJECT_MEMBER_ROUTE.exec(pathname);
  const shareLinksMatch = PROJECT_SHARE_LINKS_ROUTE.exec(pathname);
  const shareLinkMatch = PROJECT_SHARE_LINK_ROUTE.exec(pathname);
  const isSharingRoute =
    Boolean(
      sharingMatch ||
      invitationsMatch ||
      invitationMatch ||
      memberMatch ||
      shareLinksMatch ||
      shareLinkMatch
    ) || pathname === INVITATION_ACCEPT_ROUTE;
  if (
    (request.method === 'GET' || request.method === 'POST') &&
    (collaborationMatch || collaborationTicketMatch) &&
    !env.PROJECT_ROOM
  ) {
    // The beta deployment omits collaboration bindings pending a product decision.
    return json(
      {
        error: 'Collaboration is disabled for this deployment.',
        code: 'FEATURE_DISABLED'
      },
      501
    );
  }

  if (
    request.method === 'GET' &&
    collaborationMatch &&
    url.searchParams.has('ticket')
  ) {
    const ticketValues = url.searchParams.getAll('ticket');
    if (
      request.headers.get('upgrade')?.toLowerCase() !== 'websocket' ||
      ticketValues.length !== 1 ||
      !/^[A-Za-z0-9_-]{43}$/.test(ticketValues[0] ?? '') ||
      !/^proj_[A-Za-z0-9_-]{1,120}$/.test(collaborationMatch[1] ?? '')
    ) {
      return new Response('Collaboration ticket is invalid or expired.', {
        status: 401
      });
    }
    const projectId = collaborationMatch[1]!;
    if (env.ENVIRONMENT !== 'development') {
      await enforceApiRateLimit(
        env,
        await publicRequestBucket(request, env, 'socket'),
        60
      );
      // An encrypted project's room opens only while E2EE_PROJECTS_ENABLED
      // is on (ADR-024 slice 4-9); the ticket names the format it was
      // issued for, and the room checks the account's access again.
      const plaintextOnly = (await isProjectStorageFormatReady(env.DB))
        ? isCloudflareFeatureEnabled(env, 'E2EE_PROJECTS_ENABLED')
          ? ' AND storage_format IN (1, 2)'
          : ' AND storage_format = 1'
        : '';
      const exists = await env
        .DB!.prepare(
          `SELECT id FROM projects WHERE id = ? AND status != 'deleted'${plaintextOnly}`
        )
        .bind(projectId)
        .first<{ id: string }>();
      if (!exists)
        return new Response('Collaboration ticket is invalid or expired.', {
          status: 401
        });
    }
    const roomUrl = new URL('https://project-room.internal/');
    roomUrl.searchParams.set('projectId', projectId);
    roomUrl.searchParams.set('ticket', ticketValues[0]!);
    const headers = new Headers(request.headers);
    headers.delete('authorization');
    headers.delete('cookie');
    // Namespace-wide, not a hand-maintained list: the room trusts every
    // x-openzcad-* header it receives, so an addition to that namespace must
    // never require remembering to extend a delete list here.
    for (const name of [...headers.keys()]) {
      if (name.toLowerCase().startsWith('x-openzcad-')) {
        headers.delete(name);
      }
    }
    return env
      .PROJECT_ROOM!.getByName(projectId)
      .fetch(new Request(roomUrl, { method: 'GET', headers }));
  }

  const requiresArtifactStorage =
    (request.method === 'POST' && pathname === '/api/uploads') ||
    (request.method === 'PUT' && UPLOAD_CONTENT_ROUTE.test(pathname)) ||
    (request.method === 'POST' && UPLOAD_MULTIPART_ROUTE.test(pathname)) ||
    (request.method === 'DELETE' && UPLOAD_MULTIPART_ROUTE.test(pathname)) ||
    (request.method === 'POST' &&
      UPLOAD_MULTIPART_COMPLETE_ROUTE.test(pathname)) ||
    (request.method === 'PUT' && UPLOAD_PART_ROUTE.test(pathname)) ||
    (request.method === 'POST' &&
      (ARTIFACT_DISCARD_ROUTE.test(pathname) ||
        pathname === '/api/artifacts/finalize' ||
        pathname === '/api/imports/finalize')) ||
    (request.method === 'GET' &&
      (PROJECT_ARTIFACTS_ROUTE.test(pathname) ||
        ARTIFACT_ROUTE.test(pathname) ||
        ARTIFACT_DOWNLOAD_ROUTE.test(pathname)));
  if (requiresArtifactStorage && !env.ARTIFACTS) {
    // The beta deployment omits object storage pending a product decision.
    return json(
      {
        error: 'Artifact storage is disabled for this deployment.',
        code: 'FEATURE_DISABLED'
      },
      501
    );
  }
  if (
    requiresArtifactStorage &&
    request.method !== 'GET' &&
    env.DB &&
    !(await artifactUploadIsReady(env))
  ) {
    return json(
      { error: 'Artifact upload storage is temporarily unavailable.' },
      503
    );
  }

  if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method)) {
    assertSameOrigin(request);
  }

  const projectStorageBucket = env.PROJECT_STORAGE ?? env.ARTIFACTS;
  const requiresProjectStorage =
    pathname === '/api/account/storage' ||
    pathname === '/api/projects' ||
    pathname.startsWith('/api/projects/');
  if (
    requiresProjectStorage &&
    env.DB &&
    !(projectStorageBucket
      ? await projectStorageIsReady(env, projectStorageBucket)
      : await d1ProjectStorageIsReady(env))
  ) {
    return json(
      {
        error:
          'Cloud project storage is temporarily unavailable. Projects remain saved on this device.',
        code: 'PROJECT_STORAGE_UNAVAILABLE'
      },
      503
    );
  }

  if (request.method === 'POST' && pathname === '/api/auth/email/start') {
    const payload = await readJsonBody(request);
    const input =
      payload && typeof payload === 'object'
        ? (payload as Record<string, unknown>)
        : {};
    return json(
      await startEmailLogin(
        request,
        {
          email: input.email,
          turnstileToken: input.turnstileToken
        },
        env
      ),
      202
    );
  }

  if (request.method === 'POST' && pathname === '/api/auth/desktop/start') {
    const payload = await readJsonBody(request);
    const input =
      payload && typeof payload === 'object'
        ? (payload as Record<string, unknown>)
        : {};
    return json(
      await startDesktopAuthorization(
        request,
        {
          clientId: input.clientId,
          state: input.state,
          codeChallenge: input.codeChallenge
        },
        env
      ),
      201
    );
  }

  if (request.method === 'POST' && pathname === '/api/auth/desktop/approve') {
    const payload = await readJsonBody(request);
    const input =
      payload && typeof payload === 'object'
        ? (payload as Record<string, unknown>)
        : {};
    const session = await authenticateBrowserSession(request, env);
    return json(
      await approveDesktopAuthorization(
        { attemptId: input.attemptId, userCode: input.userCode },
        session,
        env
      )
    );
  }

  if (request.method === 'POST' && pathname === '/api/auth/desktop/exchange') {
    const payload = await readJsonBody(request);
    const input =
      payload && typeof payload === 'object'
        ? (payload as Record<string, unknown>)
        : {};
    const exchanged = await exchangeDesktopAuthorization(
      {
        attemptId: input.attemptId,
        clientId: input.clientId,
        state: input.state,
        verifier: input.verifier
      },
      env
    );
    return json(exchanged, exchanged.status === 'pending' ? 202 : 200);
  }

  if (request.method === 'POST' && pathname === '/api/auth/desktop/refresh') {
    const payload = await readJsonBody(request);
    const input =
      payload && typeof payload === 'object'
        ? (payload as Record<string, unknown>)
        : {};
    return json(
      await refreshDesktopAuthorization(
        {
          clientId: input.clientId,
          refreshToken: input.refreshToken
        },
        env
      )
    );
  }

  if (request.method === 'POST' && pathname === '/api/auth/desktop/logout') {
    await destroyDesktopAuthorization(request, env);
    return json({ ok: true });
  }

  if (request.method === 'POST' && pathname === '/api/auth/email/verify') {
    const payload = await readJsonBody(request);
    const input =
      payload && typeof payload === 'object'
        ? (payload as Record<string, unknown>)
        : {};
    const authenticated = await verifyEmailLogin(
      {
        challengeId: input.challengeId,
        code: input.code
      },
      env
    );
    return json(
      {
        ...authenticated.session,
        entitlements: accountEntitlements(env, authenticated.session.email)
      },
      200,
      {
        'set-cookie': authenticated.cookie
      }
    );
  }

  if (request.method === 'POST' && pathname === '/api/auth/logout') {
    return json({ ok: true }, 200, {
      'set-cookie': await destroyEmailSession(request, env)
    });
  }

  if (request.method === 'GET' && pathname === '/api/assistant/status') {
    try {
      const identity = await identifyAssistantIdentity(request, env);
      const settings = await getAppSettings(
        identity.userId,
        env,
        identity.email
      );
      return json({
        ...settings.effectiveAssistant,
        credential: settings.credential
      });
    } catch (error) {
      if (error instanceof AuthenticationError && error.failure === 'missing') {
        return json({
          ...getAssistantStatus(env),
          configured: false,
          source: 'deployment'
        });
      }
      throw error;
    }
  }

  if (request.method === 'POST' && pathname === '/api/assistant/proposals') {
    const identity = await identifyAssistantIdentity(request, env);
    const userId = identity.userId;
    await assertAccountNotErasing(env.DB, userId);
    const payload = parseAssistantProposalRequest(await readJsonBody(request));
    const consentedRoute = await assertAssistantProjectAllowed(
      env,
      identity,
      payload.digest.projectId
    );
    const assistant = await resolveUserAssistant(userId, env, identity.email);
    if (!assistant.effective.configured) {
      return json(
        {
          error: 'AI is disabled or not configured for this user.',
          code: 'AI_NOT_CONFIGURED'
        },
        503
      );
    }
    // An encrypted project's consent names who receives the data: another
    // key source, provider or model needs the user's consent again.
    if (
      consentedRoute !== null &&
      consentedRoute !== assistantConsentRoute(assistant.effective)
    ) {
      throw new SharingRequestError(
        409,
        ENCRYPTED_PROJECT_ASSISTANT_CONSENT_REQUIRED_CODE,
        'The assistant provider changed since you allowed it for this encrypted project. Allow it again. Nothing was sent.'
      );
    }
    const providerIdentity = await assistantProviderIdentity(userId, env);
    const maxOutputTokens =
      assistant.runtime?.maxOutputTokens ?? maxOutputTokensFor(env);
    const permit = await acquireAssistantPermit(request, userId, env, {
      cost: assistantQuotaCost(payload.attachments.length, maxOutputTokens),
      leaseMs: assistant.runtime?.timeoutMs ?? timeoutFor(env),
      deploymentFunded: assistant.effective.source === 'deployment',
      email: identity.email
    });
    if (!permit.allowed) {
      return permit.response;
    }
    let response: Response;
    try {
      response = await streamAssistantProposal(
        payload,
        env,
        assistantSafetyIdentifier(providerIdentity, payload.retryAttempt),
        assistant.runtime ?? undefined
      );
    } catch (error) {
      await permit.release();
      throw error;
    }
    if (!response.ok || !response.body) {
      await permit.release();
      return response;
    }
    return permit.track(response);
  }

  const session = await authenticateRequest(request, env);
  const userId = session.userId;
  if (pathname.startsWith('/api/e2ee/')) {
    try {
      if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method)) {
        await enforceApiRateLimit(env, `api:${userId}`, 120);
        await assertAccountNotErasing(env.DB, userId);
      }
      const response = await handleE2eeRequest(
        request,
        env,
        session,
        isE2eeKeysEnabled(env, session.email),
        isE2eeProjectsEnabled(env, session.email),
        encryptedInvitationHost(env, session),
        isE2eeMigrationEnabled(env, session.email),
        isE2eeReverseEnabled(env, session.email),
        // Slice 7-3: as for plaintext writes, the global flags decide.
        isCloudflareFeatureEnabled(env, 'E2EE_MIGRATION_ENABLED') &&
          isCloudflareFeatureEnabled(env, 'E2EE_REVERSE_ENABLED')
      );
      // A Commit or an account write the project's room should hear about.
      await notifyEncryptedRoom(env, request, response);
      return response;
    } finally {
      // Authentication may have admitted a development write before a
      // rate-limit/fence refusal; release it even without route dispatch.
      await releaseDevelopmentE2eeWrite(session);
    }
  }
  if (
    !['GET', 'HEAD', 'OPTIONS'].includes(request.method) &&
    pathname !== '/api/assistant'
  ) {
    await enforceApiRateLimit(env, `api:${userId}`, 120);
  }
  if (pathname === '/api/glimpse/account-consent') {
    await assertAccountNotErasing(env.DB, userId);
    return accountConsent(request, env, userId);
  }
  const collaborationRollout = projectCollaborationRollout(env, session.email);
  const persistence = createPersistenceService(
    envForCollaborationRollout(env, collaborationRollout)
  );
  const requiresActorSharingPreference =
    (request.method === 'POST' && Boolean(invitationsMatch)) ||
    (request.method === 'POST' && Boolean(shareLinksMatch)) ||
    (request.method === 'PATCH' && Boolean(memberMatch));

  if (
    requiresActorSharingPreference &&
    !(await isProjectSharingPreferenceEnabled(userId, env))
  ) {
    return json(
      {
        error: 'Project sharing is disabled for this account.',
        code: 'FEATURE_DISABLED'
      },
      403
    );
  }

  const isAccountDeletionRoute =
    pathname === '/api/account/deletion-preview' ||
    pathname === '/api/account/delete-data';
  if (
    !isAccountDeletionRoute &&
    !['GET', 'HEAD', 'OPTIONS'].includes(request.method)
  ) {
    await assertAccountNotErasing(env.DB, userId);
  }
  if (
    (request.method === 'GET' || request.method === 'POST') &&
    collaborationMatch
  ) {
    assertSameOrigin(request);
  }

  if (request.method === 'GET' && pathname === '/api/session') {
    return json({
      ...session,
      entitlements: accountEntitlements(env, session.email)
    });
  }

  if (request.method === 'GET' && pathname === '/api/collaboration/config') {
    return json(collaborationRollout);
  }

  if (isSharingRoute && !collaborationRollout.sharingEnabled) {
    return json(
      {
        error: 'Project sharing is disabled for this account.',
        code: 'FEATURE_DISABLED'
      },
      501
    );
  }
  if (
    (collaborationMatch || collaborationTicketMatch) &&
    !collaborationRollout.sharingEnabled &&
    !collaborationRollout.personalSyncEnabled
  ) {
    return json(
      {
        error: 'Collaboration is disabled for this account.',
        code: 'FEATURE_DISABLED'
      },
      501
    );
  }
  if (
    measurementsMatch &&
    (!collaborationRollout.personalSyncEnabled ||
      !(await projectMeasurementStorageIsReady(env)))
  ) {
    return json(
      {
        error:
          'Cloud measurement sync is unavailable. Measurements remain saved on this device.',
        code: 'MEASUREMENT_SYNC_UNAVAILABLE'
      },
      503
    );
  }

  // ADR-024 slice 7-3: a save state or the head of an encrypted project
  // its owner is turning back into plaintext, written under the decrypt
  // lease beside the ciphertext. Null for every other request (and while
  // the reverse path is closed), which meets the gate below as before.
  const reverseOpen = isE2eeReverseEnabled(env, session.email);
  const stagingProjectId = reverseOpen
    ? decryptStagingRouteProject(request.method, pathname)
    : null;
  const decryptStaging = stagingProjectId
    ? await decryptStagingFor(
        env.DB,
        request,
        userId,
        stagingProjectId,
        reverseOpen
      )
    : null;

  // ADR-024 Phase 4: every /api/projects/:id route meets the storage-format
  // gate before its handler parses a body or reads anything.
  if (!decryptStaging) {
    await assertProjectRouteFormat(
      env.DB,
      persistence,
      userId,
      request.method,
      pathname,
      isE2eeProjectsEnabled(env, session.email),
      // ADR-024 slice 7-1: every caller of a staged project (members too)
      // meets the refusal, so the global flag decides, not the account's.
      isCloudflareFeatureEnabled(env, 'E2EE_MIGRATION_ENABLED')
    );
  }

  if (request.method === 'GET' && pathname === '/api/settings') {
    return json(await getAppSettings(userId, env, session.email));
  }

  if (request.method === 'PATCH' && pathname === '/api/settings') {
    const body = await readJsonBody(request);
    const payload = parseUpdateAppSettingsRequest(
      body,
      env.ENVIRONMENT,
      env.AI_ALLOWED_BASE_URL_HOSTS
    );
    const { response: updated, previous } = await updateAppSettings(
      userId,
      payload,
      env,
      session.email,
      // A client from before remapping sends no keymap, one from before
      // relation glyphs (or their per-kind filter) no glyph preference, and
      // one from before the field of view or X-ray no value for them: keep
      // the stored ones.
      {
        keepStoredKeymap: settingsRequestOmitsKeymap(body),
        keepStoredRelationGlyphs: settingsRequestOmitsRelationGlyphs(body),
        keepStoredHiddenRelationGlyphs:
          settingsRequestOmitsHiddenRelationGlyphs(body),
        keepStoredViewportFields: settingsRequestOmittedViewportFields(body)
      }
    );
    // Only the switch turning off is news to the rooms. Settings save on every
    // cosmetic change, and each owned project costs a Durable Object call, so
    // re-announcing an already-off switch woke every room on a theme change.
    if (
      previous.collaboration.enabled &&
      !updated.settings.collaboration.enabled
    ) {
      await notifyOwnedRoomsCollaborationDisabled(env, userId);
    }
    return json(updated);
  }

  if (pathname === '/api/settings/assistant-credential') {
    if (request.method === 'PUT') {
      const token = parseAssistantCredential(await readJsonBody(request));
      return json(
        await saveAssistantCredential(userId, token, env, session.email)
      );
    }
    if (request.method === 'DELETE') {
      return json(await deleteAssistantCredential(userId, env, session.email));
    }
  }

  if (
    request.method === 'POST' &&
    pathname === '/api/settings/assistant/test'
  ) {
    const assistant = await resolveUserAssistant(userId, env, session.email);
    if (!assistant.runtime) {
      throw new HttpError(
        400,
        'Save and select a personal AI credential before testing it.'
      );
    }
    try {
      const result = await testAssistantConnection(assistant.runtime, env);
      await markAssistantCredentialValidated(userId, env);
      return json(result, 200, {
        'x-openzcad-request-id': result.requestId
      });
    } catch (error) {
      try {
        await clearAssistantCredentialValidation(userId, env);
      } catch {
        console.error('Assistant credential validation reset failed:', {
          requestId:
            error instanceof HttpAssistantConfigurationError
              ? error.requestId
              : null
        });
      }
      throw error;
    }
  }

  if (request.method === 'GET' && pathname === '/api/account/storage') {
    return json(await persistence.getStorageUsage(userId));
  }

  if (
    request.method === 'GET' &&
    pathname === '/api/account/deletion-preview'
  ) {
    return json(
      await accountDeletionPreview(
        session,
        url.searchParams.get('scope'),
        env,
        persistence
      )
    );
  }

  if (request.method === 'POST' && pathname === '/api/account/delete-data') {
    const deleted = await deleteAccountData(
      session,
      await readJsonBody(request),
      env,
      persistence
    );
    return json(
      deleted,
      200,
      deleted.signedOut
        ? { 'set-cookie': await destroyEmailSession(request, env) }
        : undefined
    );
  }

  if (request.method === 'GET' && pathname === '/api/projects') {
    // Listing is the one call every client makes on arrival, which makes it
    // the natural place to collect the bin: retention is measured in days, so
    // nothing needs a scheduled job to notice a window has closed.
    //
    // Collecting it is housekeeping, though, and must not cost the user their
    // project list. A purge that fails keeps its rows and is retried by the
    // next listing; letting it throw here answered every arrival with a 500
    // for as long as the failure lasted.
    try {
      await persistence.purgeExpiredProjects(userId);
    } catch (error) {
      console.error(
        JSON.stringify({
          event: 'trash_purge_failed',
          errorName: error instanceof Error ? error.name : 'UnknownError'
        })
      );
    }
    const listing = await persistence.listProjects(userId);
    // Encrypted projects' names travel as project-info envelopes (0033).
    return json(
      isE2eeProjectsEnabled(env, session.email)
        ? await withEncryptedProjectInfo(env.DB, userId, listing)
        : listing
    );
  }

  if (request.method === 'POST' && pathname === '/api/projects') {
    await assertPlaintextCreationAllowed(env, session);
    const opened = await openProjectStorageRequest(
      await readJsonBody(request, MAX_CLOUD_PROJECT_WRITE_BYTES)
    );
    const payload = parseCreateProjectRequest(opened.body);
    return json(
      await persistence.createProject(userId, payload, {
        storage: opened.storage
      }),
      201
    );
  }

  const now = Math.floor(Date.now() / 1000);
  if (request.method === 'GET' && sharingMatch) {
    return json(
      await persistence.listProjectSharing(userId, sharingMatch[1]!, now)
    );
  }

  if (request.method === 'POST' && invitationsMatch) {
    const payload = await readJsonBody(request);
    const invitation = parseCreateInvitation(payload);
    const role = invitation.role;
    if (role === 'editor') {
      assertEditorLeaseEligible(
        env,
        invitation.email,
        'Editor invitations require project edit lease enforcement for the invited account.'
      );
    }
    if (
      collaborationRollout.canary &&
      !isCloudflareFeatureEnabled(env, 'PROJECT_SHARING_ENABLED') &&
      !projectCollaborationRollout(env, invitation.email).canary
    ) {
      throw new SharingRequestError(
        403,
        'CANARY_RECIPIENT_REQUIRED',
        'During the collaboration canary, invitations can be sent only to allowlisted accounts.'
      );
    }
    const projectId = invitationsMatch[1]!;
    // Before the name lookup below, which would refuse an encrypted project
    // as unreadable rather than as unshareable.
    assertShareableProject(
      await persistence.requireProjectOwner(userId, projectId)
    );
    const project = await persistence.loadProject(userId, projectId);
    if (!project) {
      throw new ProjectNotFoundError(projectId);
    }
    const emailConfig = projectInvitationEmailConfig(env);
    const created = await createInvitation(
      persistence,
      userId,
      projectId,
      payload,
      now
    );
    try {
      await sendProjectInvitationEmail(
        emailConfig.email,
        {
          sender: emailConfig.sender,
          publicAppOrigin: emailConfig.publicAppOrigin
        },
        {
          recipientEmail: created.invitation.email,
          inviterLabel: session.email ?? session.displayName,
          projectName: project.name,
          role: created.invitation.role,
          expiresAt: created.invitation.expiresAt,
          token: created.token
        }
      );
    } catch (error) {
      try {
        await persistence.revokeProjectInvitation(
          userId,
          projectId,
          created.invitation.invitationId,
          now
        );
      } catch {
        console.error(
          JSON.stringify({
            event: 'project_invitation_email_revoke_failed',
            invitationId: created.invitation.invitationId
          })
        );
      }
      console.error(
        JSON.stringify({
          event: 'project_invitation_email_failed',
          invitationId: created.invitation.invitationId,
          errorCode: emailDeliveryErrorCode(error)
        })
      );
      throw new SharingRequestError(
        503,
        'INVITATION_EMAIL_UNAVAILABLE',
        'Project invitation email is temporarily unavailable. Try again.'
      );
    }
    return json(created, 201);
  }

  if (request.method === 'POST' && shareLinksMatch) {
    return json(
      await createShareLink(
        persistence,
        userId,
        shareLinksMatch[1]!,
        await readJsonBody(request),
        now
      ),
      201
    );
  }

  if (request.method === 'GET' && shareLinksMatch) {
    return json({
      shareLinks: await persistence.listProjectShareLinks(
        userId,
        shareLinksMatch[1]!
      )
    });
  }

  if (request.method === 'DELETE' && shareLinkMatch) {
    await persistence.revokeProjectShareLink(
      userId,
      shareLinkMatch[1]!,
      shareLinkMatch[2]!,
      now
    );
    return new Response(null, { status: 204 });
  }

  if (request.method === 'DELETE' && invitationMatch) {
    await persistence.revokeProjectInvitation(
      userId,
      invitationMatch[1]!,
      invitationMatch[2]!,
      now
    );
    return new Response(null, { status: 204 });
  }

  if (request.method === 'PATCH' && memberMatch) {
    const payload = await readJsonBody(request);
    const role = parseProjectMemberRole(
      payload && typeof payload === 'object'
        ? (payload as Record<string, unknown>).role
        : undefined
    );
    const memberUserId = toUserId(memberMatch[2]!);
    if (role === 'editor') {
      const sharing = await persistence.listProjectSharing(
        userId,
        memberMatch[1]!,
        now
      );
      const member = sharing.members.find(
        (candidate) => candidate.userId === memberUserId
      );
      if (member) {
        assertEditorLeaseEligible(
          env,
          member.email,
          'Editor access requires project edit lease enforcement for the member account.'
        );
      }
    }
    await persistence.updateProjectMemberRole(
      userId,
      memberMatch[1]!,
      memberUserId,
      role,
      now
    );
    await notifyProjectRoleChange(env, memberMatch[1]!, memberMatch[2]!, role);
    return json({ userId: memberMatch[2], role });
  }

  if (request.method === 'DELETE' && memberMatch) {
    await persistence.removeProjectMember(
      userId,
      memberMatch[1]!,
      toUserId(memberMatch[2]!),
      now
    );
    await notifyProjectRoleChange(env, memberMatch[1]!, memberMatch[2]!, null);
    return new Response(null, { status: 204 });
  }

  if (request.method === 'POST' && pathname === INVITATION_ACCEPT_ROUTE) {
    const accepted = await acceptInvitation(
      persistence,
      userId,
      session.email,
      await readJsonBody(request),
      now
    );
    return json(accepted);
  }

  // Matched before the single-project routes below, which would otherwise read
  // "reorder" as a project id.
  if (request.method === 'POST' && pathname === '/api/projects/reorder') {
    const payload = parseReorderProjectsRequest(await readJsonBody(request));
    return json(await persistence.reorderProjects(userId, payload));
  }

  if (request.method === 'POST' && pathname === '/api/projects/purge') {
    return json({
      purgedProjectIds: await persistence.purgeExpiredProjects(userId)
    });
  }

  if (request.method === 'POST' && collaborationTicketMatch) {
    const projectId = collaborationTicketMatch[1]!;
    const access = await persistence.requireProjectRead(userId, projectId);
    const encryptedRoom = await encryptedRoomHeaders(
      request,
      access,
      isE2eeProjectsEnabled(env, session.email)
    );
    if (!(await isProjectSharingPreferenceEnabled(access.ownerUserId, env))) {
      return json(
        {
          error: 'Project sharing is disabled for this account.',
          code: 'FEATURE_DISABLED'
        },
        403
      );
    }
    const headers = new Headers({
      'x-openzcad-internal-ticket-request': 'v1',
      'x-openzcad-user-id': userId,
      'x-openzcad-display-name': session.displayName,
      'x-openzcad-project-role': access.role,
      ...encryptedRoom
    });
    if (session.email) {
      headers.set('x-openzcad-user-email', session.email);
    }
    const roomUrl = new URL('https://project-room.internal/');
    roomUrl.searchParams.set('projectId', projectId);
    return env
      .PROJECT_ROOM!.getByName(projectId)
      .fetch(new Request(roomUrl, { method: 'PUT', headers }));
  }

  const duplicateMatch = PROJECT_DUPLICATE_ROUTE.exec(pathname);
  if (request.method === 'POST' && duplicateMatch) {
    await assertPlaintextCreationAllowed(env, session);
    const opened = await openProjectStorageRequest(
      await readJsonBody(request, MAX_CLOUD_PROJECT_WRITE_BYTES)
    );
    const payload = parseDuplicateProjectRequest(
      opened.body,
      duplicateMatch[1]!
    );
    return json(
      await persistence.duplicateProject(userId, payload, {
        storage: opened.storage
      }),
      201
    );
  }

  if (
    (request.method === 'GET' || request.method === 'POST') &&
    collaborationMatch
  ) {
    // WebSocket upgrades are GET requests, so they do not pass through the
    // mutation-only origin check above. Require a same-origin browser handshake
    // before forwarding an authenticated session cookie to the room.
    assertSameOrigin(request);
    const projectId = collaborationMatch[1]!;
    const access = await persistence.requireProjectRead(userId, projectId);
    const encryptedRoom = await encryptedRoomHeaders(
      request,
      access,
      isE2eeProjectsEnabled(env, session.email)
    );
    if (!(await isProjectSharingPreferenceEnabled(access.ownerUserId, env))) {
      return json(
        {
          error: 'Project sharing is disabled for this account.',
          code: 'FEATURE_DISABLED'
        },
        403
      );
    }
    const headers = new Headers(request.headers);
    // The room authenticates its privileged verbs purely by x-openzcad-*
    // headers, so no client-supplied value in that namespace may survive the
    // forward — not just the identity trio. Today only GET/POST reach the
    // room and the privileged headers gate other verbs, but a future
    // forwarded verb must not become an instant privilege hole because a
    // header slipped through here.
    for (const name of [...headers.keys()]) {
      if (name.toLowerCase().startsWith('x-openzcad-')) {
        headers.delete(name);
      }
    }
    headers.set('x-openzcad-user-id', userId);
    headers.set('x-openzcad-display-name', session.displayName);
    headers.set('x-openzcad-project-role', access.role);
    if (session.email) {
      headers.set('x-openzcad-user-email', session.email);
    }
    for (const [name, value] of Object.entries(encryptedRoom)) {
      headers.set(name, value);
    }
    const roomUrl = new URL(request.url);
    roomUrl.searchParams.set('projectId', projectId);
    const roomRequest =
      request.method === 'POST'
        ? new Request(roomUrl, {
            method: request.method,
            headers,
            // Preserve backpressure and let the room enforce its byte limit
            // before decoding. Buffering here would defeat that boundary.
            body: request.body,
            // Node's fetch implementation requires this for streamed request
            // bodies in the Worker route tests.
            duplex: 'half'
          } as RequestInit & { duplex: 'half' })
        : new Request(roomUrl, { method: request.method, headers });
    return env.PROJECT_ROOM!.getByName(projectId).fetch(roomRequest);
  }

  const projectMatch = PROJECT_ROUTE.exec(pathname);
  if (
    workspaceSessionsMatch &&
    (request.method === 'GET' || request.method === 'PUT')
  ) {
    const projectId = workspaceSessionsMatch[1]!;
    assertPlaintextProject(
      await persistence.requireProjectRead(userId, projectId)
    );
    if (!env.DB)
      return json({ error: 'Workspace session storage is unavailable.' }, 503);
    if (request.method === 'GET')
      return json({
        sessions: await loadWorkspaceSessions(env.DB, userId, projectId)
      });
    const input = parseWorkspaceSession(
      await readJsonBody(request, 32_768),
      projectId
    );
    await saveWorkspaceSession(env.DB, userId, input);
    return new Response(null, { status: 204 });
  }

  if (request.method === 'GET' && measurementsMatch) {
    const projectId = measurementsMatch[1]!;
    assertPlaintextProject(
      await persistence.requireProjectRead(userId, projectId)
    );
    return json(await loadProjectMeasurements(env.DB!, projectId, userId));
  }

  if (request.method === 'PUT' && measurementsMatch) {
    const projectId = measurementsMatch[1]!;
    assertPlaintextProject(
      await persistence.requireProjectEdit(userId, projectId)
    );
    const input = parseSaveProjectMeasurementsRequest(
      await readJsonBody(request, MAX_PROJECT_MEASUREMENT_BYTES + 16 * 1024),
      projectId
    );
    return json(
      await saveProjectMeasurements(env.DB!, projectId, userId, input)
    );
  }

  if (request.method === 'DELETE' && measurementsMatch) {
    const projectId = measurementsMatch[1]!;
    assertPlaintextProject(
      await persistence.requireProjectEdit(userId, projectId)
    );
    const expectedRevision = parseDeleteProjectMeasurementsRequest(
      await readJsonBody(request, 1024)
    );
    await deleteProjectMeasurements(
      env.DB!,
      projectId,
      userId,
      expectedRevision
    );
    return new Response(null, { status: 204 });
  }

  if (request.method === 'GET' && projectMatch) {
    const project = await persistence.loadProject(userId, projectMatch[1]!);
    return project ? json(project) : json({ error: 'Project not found.' }, 404);
  }

  if (request.method === 'PATCH' && projectMatch) {
    const payload = parseUpdateProjectRequest(
      await readJsonBody(request),
      projectMatch[1]!
    );
    return json({ project: await persistence.updateProject(userId, payload) });
  }

  // DELETE is the irreversible one. Moving a project to the recycle bin is a
  // PATCH to status='deleted'; this destroys it outright.
  if (request.method === 'DELETE' && projectMatch) {
    await persistence.deleteProject(userId, projectMatch[1]!);
    return new Response(null, { status: 204 });
  }

  const revisionsMatch = PROJECT_REVISIONS_ROUTE.exec(pathname);
  if (request.method === 'POST' && revisionsMatch) {
    const opened = await openProjectStorageRequest(
      await readJsonBody(request, MAX_CLOUD_PROJECT_WRITE_BYTES, true),
      revisionsMatch[1]
    );
    const payload = parseSaveRevisionRequest(opened.body, revisionsMatch[1]!);
    if (decryptStaging) {
      return json(
        await stageDecryptedRevision(
          persistence,
          userId,
          payload,
          opened.storage,
          decryptStaging
        )
      );
    }
    return json(
      await persistence.saveRevision(userId, payload, {
        storage: opened.storage
      })
    );
  }

  if (request.method === 'GET' && revisionsMatch) {
    return json(await persistence.listRevisions(userId, revisionsMatch[1]!));
  }

  const revisionMatch = PROJECT_REVISION_ROUTE.exec(pathname);
  if (request.method === 'GET' && revisionMatch) {
    const document = await persistence.loadRevision(
      userId,
      revisionMatch[1]!,
      revisionMatch[2]!
    );
    // Retention drops the oldest save states while the checkpoints naming them
    // live on inside documents, so a request for one that is gone is a plain
    // 404 rather than a fault.
    return document
      ? json(document)
      : json({ error: 'That save state is no longer stored.' }, 404);
  }

  const documentMatch = PROJECT_DOCUMENT_ROUTE.exec(pathname);
  if (request.method === 'PUT' && documentMatch) {
    const opened = await openProjectStorageRequest(
      await readJsonBody(request, MAX_CLOUD_PROJECT_WRITE_BYTES, true),
      documentMatch[1]
    );
    const payload = parseSaveProjectDocumentRequest(
      opened.body,
      documentMatch[1]!
    );
    if (decryptStaging) {
      return json(
        await stageDecryptedHead(
          persistence,
          env.DB!,
          userId,
          payload,
          opened.storage,
          decryptStaging
        )
      );
    }
    return json(
      await persistence.saveDocument(userId, payload, {
        storage: opened.storage
      })
    );
  }

  if (request.method === 'POST' && pathname === '/api/uploads') {
    const payload = parseCreateUploadSessionRequest(
      await readJsonBody(request)
    );
    // Slice 7-3: a decrypted file of an encrypted project its owner is
    // turning back into plaintext, under the decrypt lease.
    const uploadStaging = reverseOpen
      ? await decryptStagingFor(
          env.DB,
          request,
          userId,
          payload.projectId,
          reverseOpen
        )
      : null;
    if (uploadStaging) {
      return json(
        await persistence.createUploadSession(userId, payload, {
          decryptStaging: uploadStaging.fence
        }),
        201
      );
    }
    // A project staged for encryption takes no new plaintext files (7-1).
    await assertProjectNotMigrating(
      env.DB,
      persistence,
      userId,
      payload.projectId,
      isCloudflareFeatureEnabled(env, 'E2EE_MIGRATION_ENABLED')
    );
    return json(await persistence.createUploadSession(userId, payload), 201);
  }

  const uploadContentMatch = UPLOAD_CONTENT_ROUTE.exec(pathname);
  if (request.method === 'PUT' && uploadContentMatch) {
    const body = await readBinaryBody(request, MAX_ARTIFACT_BODY_BYTES, {
      empty: 'Artifact is empty.',
      tooLarge: 'Artifact is too large.'
    });
    await persistence.putUpload(userId, uploadContentMatch[1]!, body);
    return new Response(null, { status: 204 });
  }

  const multipartMatch = UPLOAD_MULTIPART_ROUTE.exec(pathname);
  if (request.method === 'POST' && multipartMatch) {
    return json(
      await persistence.createMultipartUpload(userId, multipartMatch[1]!),
      201
    );
  }
  if (request.method === 'DELETE' && multipartMatch) {
    const uploadId = new URL(request.url).searchParams.get('uploadId');
    if (!uploadId) {
      throw new HttpError(400, 'Missing uploadId.');
    }
    await persistence.abortMultipartUpload(
      userId,
      multipartMatch[1]!,
      uploadId
    );
    return new Response(null, { status: 204 });
  }

  const partMatch = UPLOAD_PART_ROUTE.exec(pathname);
  if (request.method === 'PUT' && partMatch) {
    const uploadId = new URL(request.url).searchParams.get('uploadId');
    if (!uploadId) {
      throw new HttpError(400, 'Missing uploadId.');
    }
    const partNumber = Number(partMatch[2]!);
    if (partNumber > MAX_ARTIFACT_UPLOAD_PARTS) {
      throw new HttpError(
        400,
        `Upload part number cannot exceed ${MAX_ARTIFACT_UPLOAD_PARTS}.`
      );
    }
    const body = await readBinaryBody(request, MAX_ARTIFACT_PART_BYTES, {
      empty: 'Upload part is empty.',
      tooLarge: 'Upload part is too large.'
    });
    return json(
      await persistence.putUploadPart(
        userId,
        partMatch[1]!,
        uploadId,
        partNumber,
        body
      )
    );
  }

  const multipartCompleteMatch = UPLOAD_MULTIPART_COMPLETE_ROUTE.exec(pathname);
  if (request.method === 'POST' && multipartCompleteMatch) {
    const payload = parseCompleteMultipartUploadRequest(
      await readJsonBody(request)
    );
    await persistence.completeMultipartUpload(
      userId,
      multipartCompleteMatch[1]!,
      payload
    );
    return new Response(null, { status: 204 });
  }

  if (
    request.method === 'POST' &&
    (pathname === '/api/artifacts/finalize' ||
      pathname === '/api/imports/finalize')
  ) {
    const payload = parseFinalizeImportRequest(await readJsonBody(request));
    const artifact = await persistence.finalizeArtifact(userId, payload);
    if (!artifact) {
      return json(
        { error: 'Upload session not found, expired, or already used.' },
        404
      );
    }
    return json({ artifactId: artifact.artifactId });
  }

  const artifactDiscardMatch = ARTIFACT_DISCARD_ROUTE.exec(pathname);
  if (request.method === 'POST' && artifactDiscardMatch) {
    const payload = parseDiscardMeshPayloadRequest(await readJsonBody(request));
    return json(
      await persistence.discardMeshPayload(
        userId,
        payload.projectId,
        artifactDiscardMatch[1]!,
        payload.kind
      )
    );
  }

  const projectArtifactsMatch = PROJECT_ARTIFACTS_ROUTE.exec(pathname);
  if (request.method === 'GET' && projectArtifactsMatch) {
    const result = await persistence.listArtifacts(
      userId,
      projectArtifactsMatch[1]!
    );
    return json({
      ...result,
      artifacts: result.artifacts.map((artifact) => ({
        ...artifact,
        objectKey: ''
      }))
    });
  }

  const artifactDownloadMatch = ARTIFACT_DOWNLOAD_ROUTE.exec(pathname);
  if (request.method === 'GET' && artifactDownloadMatch) {
    const download = await persistence.downloadArtifact(
      userId,
      artifactDownloadMatch[1]!
    );
    if (!download) {
      return json({ error: 'Artifact not found.' }, 404);
    }
    // Streamed bodies carry no byteLength; the recorded size stands in so the
    // client still gets a content-length for progress and integrity checks.
    const contentLength =
      download.body instanceof ArrayBuffer
        ? download.body.byteLength
        : download.artifact.bytes;
    return new Response(download.body, {
      headers: {
        'content-type': download.artifact.contentType,
        ...(contentLength !== undefined
          ? { 'content-length': String(contentLength) }
          : {}),
        'content-disposition': `attachment; filename="${download.artifact.name.replace(/["\\\r\n]/g, '_')}"`,
        'x-content-type-options': 'nosniff'
      }
    });
  }

  const artifactMatch = ARTIFACT_ROUTE.exec(pathname);
  if (request.method === 'GET' && artifactMatch) {
    const metadata = await persistence.getArtifactMetadata(
      userId,
      artifactMatch[1]!
    );
    return metadata.artifact
      ? json({ artifact: { ...metadata.artifact, objectKey: '' } })
      : json({ error: 'Artifact not found.' }, 404);
  }

  return json({ error: 'Not found' }, 404);
}

async function handleAppRequest(request: Request, env: Env): Promise<Response> {
  if (FREECAD_WORKER_PATH.test(new URL(request.url).pathname)) {
    if (!env.ASSETS)
      return new Response('Asset service unavailable.', { status: 503 });
    return serveFreecadWorkerAsset(request, env.ASSETS);
  }
  if (new URL(request.url).pathname === '/healthz') {
    const headers = {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
      'cross-origin-resource-policy': 'same-origin',
      'content-security-policy':
        "default-src 'none'; sandbox; frame-ancestors 'none'"
    };
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response(null, {
        status: 405,
        headers: { ...headers, allow: 'GET, HEAD' }
      });
    }
    return new Response(
      request.method === 'HEAD'
        ? null
        : JSON.stringify({ status: 'ok', service: 'openzcad' }),
      { headers }
    );
  }

  assertSafeRuntimeConfiguration(env);
  const response = await dispatchApiRequest(request, env);
  return withApiSecurityHeaders(response);
}

export default {
  async scheduled(_controller: unknown, env: Env): Promise<void> {
    assertSafeRuntimeConfiguration(env);
    await createPersistenceService(env).purgeExpiredUploadSessions();
    // Purges and abandons of project migrations a browser left behind, and
    // of stagings whose owner may no longer migrate (or, for a decrypt
    // staging, no longer use the reverse path, slice 7-3).
    await sweepProjectMigrations(
      env,
      isCloudflareFeatureEnabled(env, 'E2EE_MIGRATION_ENABLED'),
      (email, direction) =>
        direction === 'decrypt'
          ? isE2eeReverseEnabled(env, email)
          : isE2eeMigrationEnabled(env, email)
    );
    await publishCensus(env);
  },
  async fetch(
    request: Request,
    env: Env,
    ctx?: { waitUntil(promise: Promise<unknown>): void }
  ): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path === '/api/glimpse/usage') return handleGlimpseUsage(request, env);
    const started = performance.now();
    let status = 500;
    try {
      const response = await handleAppRequest(request, env);
      status = response.status;
      return response;
    } finally {
      if (path.startsWith('/api/') && !path.startsWith('/api/glimpse/')) {
        ctx?.waitUntil(countApi(env, status, performance.now() - started));
      }
    }
  }
};

/**
 * Defense-in-depth headers on every API response. The HTML/asset surface gets
 * its CSP and related headers from `apps/web/public/_headers`; these cover the
 * API half. A WebSocket upgrade response cannot be rebuilt without dropping
 * the socket, and it serves no document to sniff or frame, so it passes
 * through untouched.
 */
function withApiSecurityHeaders(response: Response): Response {
  if (response.webSocket) {
    return response;
  }
  const wrapped = new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers
  });
  wrapped.headers.set('x-content-type-options', 'nosniff');
  wrapped.headers.set('referrer-policy', 'no-referrer');
  wrapped.headers.set('cross-origin-resource-policy', 'same-origin');
  wrapped.headers.set(
    'content-security-policy',
    "default-src 'none'; sandbox; frame-ancestors 'none'"
  );
  wrapped.headers.set('x-frame-options', 'DENY');
  return wrapped;
}

async function dispatchApiRequest(
  request: Request,
  env: Env
): Promise<Response> {
  const { pathname } = new URL(request.url);
  try {
    return await handleApiRequest(request, env);
  } catch (error) {
    if (error instanceof HttpError) {
      return json(
        {
          error: error.message,
          ...(error.documentComplexity
            ? { code: 'DOCUMENT_TOO_COMPLEX' }
            : error.limitBytes === undefined
              ? {}
              : {
                  code: 'DOCUMENT_TOO_LARGE',
                  limitBytes: error.limitBytes
                })
        },
        error.status
      );
    }
    if (error instanceof AuthFlowError) {
      return json({ error: error.message, code: error.code }, error.status);
    }
    if (error instanceof AuthenticationError) {
      return json(
        { error: error.message, code: 'AUTH_REQUIRED' },
        401,
        error.failure === 'invalid'
          ? { 'set-cookie': await destroyEmailSession(request, env) }
          : undefined
      );
    }
    if (error instanceof AccountDeletionError) {
      return json({ error: error.message, code: error.code }, error.status);
    }
    if (error instanceof ProjectNotFoundError) {
      return json({ error: error.message }, 404);
    }
    if (
      error instanceof ProjectFormatUnsupportedError ||
      error instanceof EncryptedProjectSharingError ||
      error instanceof EncryptedProjectsRequiredError ||
      error instanceof ProjectMigratingError
    ) {
      return json({ error: error.message, code: error.code }, 409);
    }
    if (error instanceof DecryptStagingLeaseError) {
      // Slice 7-3: a decrypt staging's upload (create, parts, completion,
      // finalize) landed nothing; its lease lapsed or its staging ended.
      return json(
        { error: error.message, code: E2EE_MIGRATION_CODES.leaseLost },
        409
      );
    }
    // Slice 7-1: a staged encrypted-blob upload whose lease moved on.
    if (error instanceof EncryptedBlobError) {
      return json({ error: error.message, code: error.code }, error.status);
    }
    if (error instanceof RevisionNotFoundError) {
      return json({ error: error.message, code: 'REVISION_NOT_FOUND' }, 404);
    }
    if (error instanceof SharingRequestError) {
      return json({ error: error.message, code: error.code }, error.status);
    }
    if (error instanceof ProjectSharingError) {
      const status =
        error.code === 'INVITATION_RATE_LIMIT' ||
        error.code === 'SHARE_LINK_LIMIT'
          ? 429
          : error.code.endsWith('_NOT_FOUND')
            ? 404
            : 409;
      return json({ error: error.message, code: error.code }, status);
    }
    if (error instanceof ProjectAdoptionError) {
      return json(
        { error: error.message, code: error.code, projectId: error.projectId },
        409
      );
    }
    if (error instanceof ProjectQuotaError) {
      return json(
        {
          error: error.message,
          code:
            error.kind === 'count'
              ? 'PROJECT_COUNT_QUOTA'
              : 'PROJECT_STORAGE_QUOTA',
          ...(error.kind === 'count'
            ? { limitCount: error.limit }
            : { limitBytes: error.limit })
        },
        413
      );
    }
    if (error instanceof DocumentTooLargeError) {
      return json(
        {
          error: error.message,
          code: 'DOCUMENT_TOO_LARGE',
          limitBytes: error.limitBytes
        },
        413
      );
    }
    if (error instanceof RevisionConflictError) {
      return json(
        {
          error: error.message,
          code: 'REVISION_CONFLICT',
          currentVersion: error.currentVersion
        },
        409
      );
    }
    if (error instanceof RevisionIdCollisionError) {
      return json({ error: error.message, code: 'REVISION_ID_CONFLICT' }, 409);
    }
    if (error instanceof SavePointRequestError) {
      return json({ error: error.message, code: 'SAVE_POINT_INVALID' }, 400);
    }
    if (error instanceof ProjectStorageUploadError) {
      return json({ error: error.message, code: 'STORAGE_ASSET_INVALID' }, 400);
    }
    if (error instanceof ProjectMeasurementRequestError) {
      return json({ error: error.message }, error.status);
    }
    if (error instanceof ProjectMeasurementRevisionConflictError) {
      return json(
        {
          error: error.message,
          code: 'MEASUREMENT_REVISION_CONFLICT',
          currentRevision: error.currentRevision
        },
        409
      );
    }
    if (error instanceof HttpAssistantConfigurationError) {
      return json(
        {
          error: `${error.message} Reference: ${error.requestId}.`,
          code: error.code,
          requestId: error.requestId,
          ...(error.providerStatus !== undefined
            ? { providerStatus: error.providerStatus }
            : {}),
          ...(error.providerCode ? { providerCode: error.providerCode } : {}),
          ...(error.providerRequestId
            ? { providerRequestId: error.providerRequestId }
            : {})
        },
        502,
        { 'x-openzcad-request-id': error.requestId }
      );
    }
    if (error instanceof ArtifactQuotaError) {
      return json(
        {
          error: error.message,
          code: 'ARTIFACT_QUOTA_EXCEEDED',
          limitBytes: error.limitBytes
        },
        413
      );
    }
    if (error instanceof ArtifactStorageError) {
      return json({ error: error.message }, 503);
    }
    if (error instanceof ProjectObjectStorageError) {
      console.error(
        'Project document storage unavailable.',
        request.method,
        pathname,
        error
      );
      return json(
        {
          error:
            'The account copy of this project is temporarily unavailable. Your work remains saved on this device.',
          code: 'PROJECT_DOCUMENT_UNAVAILABLE'
        },
        503
      );
    }
    if (
      error instanceof Error &&
      error.message.includes('ACCOUNT_ERASURE_IN_PROGRESS')
    ) {
      return json(
        {
          error: 'Cloud data deletion is already in progress.',
          code: 'ACCOUNT_ERASURE_IN_PROGRESS'
        },
        409
      );
    }
    console.error('Unhandled API error.', {
      method: request.method,
      pathname,
      errorName: error instanceof Error ? error.name : 'UnknownError'
    });
    return json({ error: 'Internal error' }, 500);
  }
}

// The adapters' room, given the encrypted account seam (ADR-024 slice 4-9).
export { ProjectCollaborationRoom } from './e2eeRoom';
