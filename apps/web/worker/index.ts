import {
  ProjectCollaborationRoom,
  createPersistenceService,
  isCloudflareFeatureEnabled,
  type CloudflareEnv
} from '@openzcad/cloudflare-adapters';
import {
  ArtifactStorageError,
  DocumentTooLargeError,
  ProjectAdoptionError,
  ProjectNotFoundError,
  ProjectSharingError,
  RevisionConflictError
} from '@openzcad/persistence';
import {
  HttpError,
  parseCreateProjectRequest,
  parseAssistantProposalRequest,
  parseCreateUploadSessionRequest,
  parseDuplicateProjectRequest,
  parseFinalizeImportRequest,
  parseReorderProjectsRequest,
  parseSaveProjectDocumentRequest,
  parseSaveRevisionRequest,
  parseUpdateProjectRequest
} from './validation';
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
  AuthFlowError,
  AuthenticationError,
  destroyEmailSession,
  getAuthConfig,
  identifyAssistantIdentity,
  startEmailLogin,
  verifyEmailLogin
} from './auth';
import {
  deleteAssistantCredential,
  getAppSettings,
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
  parseProjectMemberRole,
  SharingRequestError
} from './sharing';
import {
  isDocumentStorageAccountingReady,
  isProjectObjectStorageReady
} from './readiness';
import { toUserId } from '@openzcad/shared';

type Env = CloudflareEnv & {
  PROJECT_ROOM?: DurableObjectNamespace<ProjectCollaborationRoom>;
};

/** Upper bound for JSON request bodies; protects against oversized payloads. */
const MAX_JSON_BODY_BYTES = 25 * 1024 * 1024;
const MAX_ARTIFACT_BODY_BYTES = 25 * 1024 * 1024;

const PROJECT_ROUTE = /^\/api\/projects\/([^/]+)$/;
const PROJECT_DUPLICATE_ROUTE = /^\/api\/projects\/([^/]+)\/duplicate$/;
const PROJECT_REVISIONS_ROUTE = /^\/api\/projects\/([^/]+)\/revisions$/;
const PROJECT_DOCUMENT_ROUTE = /^\/api\/projects\/([^/]+)\/document$/;
const PROJECT_COLLABORATION_ROUTE = /^\/api\/projects\/([^/]+)\/collaboration$/;
const PROJECT_SHARING_ROUTE = /^\/api\/projects\/([^/]+)\/sharing$/;
const PROJECT_INVITATIONS_ROUTE = /^\/api\/projects\/([^/]+)\/invitations$/;
const PROJECT_INVITATION_ROUTE =
  /^\/api\/projects\/([^/]+)\/invitations\/([^/]+)$/;
const PROJECT_MEMBER_ROUTE = /^\/api\/projects\/([^/]+)\/members\/([^/]+)$/;
const INVITATION_ACCEPT_ROUTE = '/api/project-invitations/accept';
const PROJECT_ARTIFACTS_ROUTE = /^\/api\/projects\/([^/]+)\/artifacts$/;
const UPLOAD_CONTENT_ROUTE = /^\/api\/uploads\/([^/]+)\/content$/;
const ARTIFACT_ROUTE = /^\/api\/artifacts\/([^/]+)$/;
const ARTIFACT_DOWNLOAD_ROUTE = /^\/api\/artifacts\/([^/]+)\/download$/;

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

async function readJsonBody(request: Request): Promise<unknown> {
  const contentLength = Number(request.headers.get('content-length') ?? '0');
  if (Number.isFinite(contentLength) && contentLength > MAX_JSON_BODY_BYTES) {
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
        if (totalBytes > MAX_JSON_BODY_BYTES) {
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

async function handleApiRequest(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const { pathname } = url;

  if (request.method === 'GET' && pathname === '/api/health') {
    const documentStorageAccountingReady =
      await isDocumentStorageAccountingReady(env.DB);
    const projectObjectStorageReady = await isProjectObjectStorageReady(
      env.DB,
      env.PROJECT_STORAGE ?? env.ARTIFACTS
    );
    return json({
      status: 'ok',
      environment: env.ENVIRONMENT ?? 'beta',
      time: new Date().toISOString(),
      documentStorageAccountingReady,
      projectObjectStorageReady,
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
        isCloudflareFeatureEnabled(env, 'PROJECT_PERSONAL_SYNC_ENABLED')
    });
  }

  if (request.method === 'GET' && pathname === '/api/auth/config') {
    return json(getAuthConfig(env));
  }

  const collaborationMatch = PROJECT_COLLABORATION_ROUTE.exec(pathname);
  const sharingMatch = PROJECT_SHARING_ROUTE.exec(pathname);
  const invitationsMatch = PROJECT_INVITATIONS_ROUTE.exec(pathname);
  const invitationMatch = PROJECT_INVITATION_ROUTE.exec(pathname);
  const memberMatch = PROJECT_MEMBER_ROUTE.exec(pathname);
  const isSharingRoute =
    Boolean(
      sharingMatch || invitationsMatch || invitationMatch || memberMatch
    ) || pathname === INVITATION_ACCEPT_ROUTE;
  if (
    isSharingRoute &&
    !isCloudflareFeatureEnabled(env, 'PROJECT_SHARING_ENABLED')
  ) {
    return json(
      {
        error: 'Project sharing is disabled for this deployment.',
        code: 'FEATURE_DISABLED'
      },
      501
    );
  }
  if (
    (request.method === 'GET' || request.method === 'POST') &&
    collaborationMatch &&
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

  const requiresArtifactStorage =
    (request.method === 'POST' && pathname === '/api/uploads') ||
    (request.method === 'PUT' && UPLOAD_CONTENT_ROUTE.test(pathname)) ||
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

  const persistence = createPersistenceService(env);

  if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method)) {
    assertSameOrigin(request);
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

  if (request.method === 'GET' && pathname === '/api/session') {
    return json(session);
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
    const role = parseProjectMemberRole(
      payload && typeof payload === 'object'
        ? (payload as Record<string, unknown>).role
        : undefined
    );
    if (
      role === 'editor' &&
      !isCloudflareFeatureEnabled(env, 'PROJECT_EDIT_LEASES_ENFORCED')
    ) {
      throw new SharingRequestError(
        409,
        'EDIT_LEASE_REQUIRED',
        'Editor invitations require project edit lease enforcement.'
      );
    }
    return json(
      await createInvitation(
        persistence,
        userId,
        invitationsMatch[1]!,
        payload,
        now
      ),
      201
    );
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
    if (
      role === 'editor' &&
      !isCloudflareFeatureEnabled(env, 'PROJECT_EDIT_LEASES_ENFORCED')
    ) {
      throw new SharingRequestError(
        409,
        'EDIT_LEASE_REQUIRED',
        'Editor access requires project edit lease enforcement.'
      );
    }
    await persistence.updateProjectMemberRole(
      userId,
      memberMatch[1]!,
      toUserId(memberMatch[2]!),
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
    const headers = new Headers(request.headers);
    headers.set('x-openzcad-user-id', userId);
    headers.set('x-openzcad-display-name', session.displayName);
    headers.set('x-openzcad-project-role', access.role);
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
    const contentLength = Number(request.headers.get('content-length') ?? '0');
    if (
      Number.isFinite(contentLength) &&
      contentLength > MAX_ARTIFACT_BODY_BYTES
    ) {
      throw new HttpError(413, 'Artifact is too large.');
    }
    const body = await request.arrayBuffer();
    if (body.byteLength === 0 || body.byteLength > MAX_ARTIFACT_BODY_BYTES) {
      throw new HttpError(
        body.byteLength === 0 ? 400 : 413,
        body.byteLength === 0 ? 'Artifact is empty.' : 'Artifact is too large.'
      );
    }
    await persistence.putUpload(userId, uploadContentMatch[1]!, body);
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
    return new Response(download.body, {
      headers: {
        'content-type': download.artifact.contentType,
        'content-length': String(download.body.byteLength),
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
      if (error instanceof ProjectNotFoundError) {
        return json({ error: error.message }, 404);
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
      if (error instanceof HttpAssistantConfigurationError) {
        return json({ error: error.message }, 502);
      }
      if (error instanceof ArtifactStorageError) {
        return json({ error: error.message }, 503);
      }
      console.error('Unhandled API error.', request.method, pathname, error);
      return json({ error: 'Internal error' }, 500);
    }
  }
};

export { ProjectCollaborationRoom };
