import {
  ProjectCollaborationRoom,
  ProjectObjectStorageError,
  createPersistenceService,
  isCloudflareFeatureEnabled,
  projectCollaborationRollout,
  type ProjectCollaborationRollout,
  type CloudflareEnv
} from '@openzcad/cloudflare-adapters';
import {
  ArtifactQuotaError,
  ArtifactStorageError,
  DocumentTooLargeError,
  ProjectAdoptionError,
  ProjectNotFoundError,
  ProjectSharingError,
  RevisionConflictError,
  RevisionNotFoundError
} from '@openzcad/persistence';
import {
  HttpError,
  parseCreateProjectRequest,
  parseAssistantProposalRequest,
  parseCompleteMultipartUploadRequest,
  parseCreateUploadSessionRequest,
  parseDuplicateProjectRequest,
  parseFinalizeImportRequest,
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
  deleteAssistantCredential,
  getAppSettings,
  isProjectSharingPreferenceEnabled,
  markAssistantCredentialValidated,
  parseAssistantCredential,
  parseUpdateAppSettingsRequest,
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
  isDocumentStorageAccountingReady,
  isProjectMeasurementStorageReady,
  isProjectObjectStorageReady
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
  MAX_ARTIFACT_PART_BYTES,
  MAX_ARTIFACT_UPLOAD_PARTS,
  toUserId
} from '@openzcad/shared';

type Env = CloudflareEnv & {
  PROJECT_ROOM?: DurableObjectNamespace<ProjectCollaborationRoom>;
};

/** Upper bound for JSON request bodies; protects against oversized payloads. */
const MAX_JSON_BODY_BYTES = 25 * 1024 * 1024;
const MAX_ARTIFACT_BODY_BYTES = 25 * 1024 * 1024;
/** Cache only a proven-ready schema; failures stay retryable without a deploy. */
const projectStorageReadyEnvironments = new WeakSet<Env>();
const projectMeasurementStorageReadyEnvironments = new WeakSet<Env>();
const HEALTH_READINESS_TTL_MS = 60_000;
interface HealthReadiness {
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
    isDocumentStorageAccountingReady(env.DB),
    isProjectObjectStorageReady(env.DB, env.PROJECT_STORAGE ?? env.ARTIFACTS),
    isProjectMeasurementStorageReady(env.DB),
    isAccountErasureReady(env.DB)
  ]).then(
    ([
      documentStorageAccountingReady,
      projectObjectStorageReady,
      projectMeasurementStorageReady,
      accountErasureReady
    ]) => ({
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
const INVITATION_ACCEPT_ROUTE = '/api/project-invitations/accept';
const PROJECT_ARTIFACTS_ROUTE = /^\/api\/projects\/([^/]+)\/artifacts$/;
const UPLOAD_CONTENT_ROUTE = /^\/api\/uploads\/([^/]+)\/content$/;
const UPLOAD_MULTIPART_ROUTE = /^\/api\/uploads\/([^/]+)\/multipart$/;
const UPLOAD_MULTIPART_COMPLETE_ROUTE =
  /^\/api\/uploads\/([^/]+)\/multipart\/complete$/;
const UPLOAD_PART_ROUTE = /^\/api\/uploads\/([^/]+)\/parts\/([1-9]\d*)$/;
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
  if (origin && origin !== new URL(request.url).origin) {
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
  maxBytes = MAX_JSON_BODY_BYTES
): Promise<unknown> {
  const contentLength = Number(request.headers.get('content-length') ?? '0');
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw new HttpError(413, 'Request body is too large.');
  }
  try {
    const reader = request.body?.getReader();
    if (!reader) {
      throw new Error('Request body is missing.');
    }
    const decoder = new TextDecoder();
    const chunks: string[] = [];
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
          throw new HttpError(413, 'Request body is too large.');
        }
        chunks.push(decoder.decode(value, { stream: true }));
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
    'x-openzcad-internal-user-id': memberUserId
  });
  if (role) {
    headers.set('x-openzcad-internal-project-role', role);
  }
  const response = await env.PROJECT_ROOM.getByName(projectId).fetch(
    new Request(`https://project-room.internal/?projectId=${projectId}`, {
      method: 'PATCH',
      headers
    })
  );
  if (!response.ok) {
    throw new Error('Project room rejected an internal role update.');
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

function emailDeliveryErrorCode(error: unknown): string {
  if (!error || typeof error !== 'object' || !('code' in error)) {
    return 'UNKNOWN';
  }
  const code = error.code;
  return typeof code === 'string' && /^[A-Z0-9_]+$/.test(code)
    ? code
    : 'UNKNOWN';
}

async function handleApiRequest(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const { pathname } = url;

  if (request.method === 'GET' && pathname === '/api/health') {
    const {
      documentStorageAccountingReady,
      projectObjectStorageReady,
      projectMeasurementStorageReady,
      accountErasureReady
    } = await healthReadiness(env);
    return json({
      status: 'ok',
      environment: env.ENVIRONMENT ?? 'beta',
      time: new Date().toISOString(),
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
  // revoked tokens all collapse into one opaque 404.
  const sharedProjectMatch = SHARED_PROJECT_ROUTE.exec(pathname);
  const sharedProjectAssetMatch = SHARED_PROJECT_ASSET_ROUTE.exec(pathname);
  if (
    request.method === 'GET' &&
    (sharedProjectMatch || sharedProjectAssetMatch)
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
      (sharedProjectAssetMatch ?? sharedProjectMatch)![1]!
    );
    if (!token) {
      return sharedNotFound();
    }
    const sharedPersistence = createPersistenceService(env);
    const tokenHash = await hashProjectInvitationToken(token);
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
          'content-length': String(asset.body.byteLength),
          'cache-control': 'no-store',
          'x-content-type-options': 'nosniff'
        }
      });
    }
    const shared = await sharedPersistence.loadSharedProjectByTokenHash(
      tokenHash
    );
    if (!shared) {
      return sharedNotFound();
    }
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

  const collaborationMatch = PROJECT_COLLABORATION_ROUTE.exec(pathname);
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
      ticketValues.length !== 1
    ) {
      return new Response('Collaboration ticket is invalid or expired.', {
        status: 401
      });
    }
    const projectId = collaborationMatch[1]!;
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
      (pathname === '/api/artifacts/finalize' ||
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
    projectStorageBucket &&
    !(await projectStorageIsReady(env, projectStorageBucket))
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
    const session = await authenticateRequest(request, env);
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
    return json(authenticated.session, 200, {
      'set-cookie': authenticated.cookie
    });
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
    const maxOutputTokens =
      assistant.runtime?.maxOutputTokens ?? maxOutputTokensFor(env);
    const permit = await acquireAssistantPermit(request, userId, env, {
      cost: assistantQuotaCost(payload.attachments.length, maxOutputTokens),
      leaseMs: assistant.runtime?.timeoutMs ?? timeoutFor(env),
      deploymentFunded: assistant.effective.source === 'deployment'
    });
    if (!permit.allowed) {
      return permit.response;
    }
    let response: Response;
    try {
      response = await streamAssistantProposal(
        payload,
        env,
        userId,
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
    return json(session);
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

  if (request.method === 'GET' && pathname === '/api/settings') {
    return json(await getAppSettings(userId, env, session.email));
  }

  if (request.method === 'PATCH' && pathname === '/api/settings') {
    const payload = parseUpdateAppSettingsRequest(
      await readJsonBody(request),
      env.ENVIRONMENT,
      env.AI_ALLOWED_BASE_URL_HOSTS
    );
    return json(await updateAppSettings(userId, payload, env, session.email));
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
    const result = await testAssistantConnection(assistant.runtime, env);
    await markAssistantCredentialValidated(userId, env);
    return json(result);
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
    await persistence.purgeExpiredProjects(userId);
    return json(await persistence.listProjects(userId));
  }

  if (request.method === 'POST' && pathname === '/api/projects') {
    const payload = parseCreateProjectRequest(await readJsonBody(request));
    return json(await persistence.createProject(userId, payload), 201);
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
    await persistence.requireProjectOwner(userId, projectId);
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
      'x-openzcad-project-role': access.role
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
    const payload = parseDuplicateProjectRequest(
      await readJsonBody(request),
      duplicateMatch[1]!
    );
    return json(await persistence.duplicateProject(userId, payload), 201);
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
  if (request.method === 'GET' && measurementsMatch) {
    const projectId = measurementsMatch[1]!;
    await persistence.requireProjectRead(userId, projectId);
    return json(await loadProjectMeasurements(env.DB!, projectId));
  }

  if (request.method === 'PUT' && measurementsMatch) {
    const projectId = measurementsMatch[1]!;
    await persistence.requireProjectEdit(userId, projectId);
    const input = parseSaveProjectMeasurementsRequest(
      await readJsonBody(request, MAX_PROJECT_MEASUREMENT_BYTES + 16 * 1024),
      projectId
    );
    return json(await saveProjectMeasurements(env.DB!, projectId, input));
  }

  if (request.method === 'DELETE' && measurementsMatch) {
    const projectId = measurementsMatch[1]!;
    await persistence.requireProjectEdit(userId, projectId);
    const expectedRevision = parseDeleteProjectMeasurementsRequest(
      await readJsonBody(request, 1024)
    );
    await deleteProjectMeasurements(env.DB!, projectId, expectedRevision);
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
    const payload = parseSaveRevisionRequest(
      await readJsonBody(request),
      revisionsMatch[1]!
    );
    return json(await persistence.saveRevision(userId, payload));
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
    const payload = parseSaveProjectDocumentRequest(
      await readJsonBody(request),
      documentMatch[1]!
    );
    return json(await persistence.saveDocument(userId, payload));
  }

  if (request.method === 'POST' && pathname === '/api/uploads') {
    const payload = parseCreateUploadSessionRequest(
      await readJsonBody(request)
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

  const projectArtifactsMatch = PROJECT_ARTIFACTS_ROUTE.exec(pathname);
  if (request.method === 'GET' && projectArtifactsMatch) {
    return json(
      await persistence.listArtifacts(userId, projectArtifactsMatch[1]!)
    );
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
      ? json(metadata)
      : json({ error: 'Artifact not found.' }, 404);
  }

  return json({ error: 'Not found' }, 404);
}

export default {
  async scheduled(_controller: unknown, env: Env): Promise<void> {
    assertSafeRuntimeConfiguration(env);
    await createPersistenceService(env).purgeExpiredUploadSessions();
  },
  async fetch(request: Request, env: Env): Promise<Response> {
    assertSafeRuntimeConfiguration(env);
    const response = await dispatchApiRequest(request, env);
    return withApiSecurityHeaders(response);
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
      return json({ error: error.message }, error.status);
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
    if (error instanceof RevisionNotFoundError) {
      return json({ error: error.message, code: 'REVISION_NOT_FOUND' }, 404);
    }
    if (error instanceof SharingRequestError) {
      return json({ error: error.message, code: error.code }, error.status);
    }
    if (error instanceof ProjectSharingError) {
      const status =
        error.code === 'INVITATION_RATE_LIMIT'
          ? 429
          : error.code.endsWith('_NOT_FOUND')
            ? 404
            : 409;
      return json({ error: error.message, code: error.code }, status);
    }
    if (error instanceof ProjectAdoptionError) {
      return json({ error: error.message, code: error.code }, 409);
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
      return json({ error: error.message }, 502);
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

export { ProjectCollaborationRoom };
