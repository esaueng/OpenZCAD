import {
  ProjectCollaborationRoom,
  createPersistenceService,
  type CloudflareEnv
} from '@openzcad/cloudflare-adapters';
import {
  ArtifactStorageError,
  ProjectNotFoundError,
  RevisionConflictError
} from '@openzcad/persistence';
import {
  HttpError,
  parseCreateProjectRequest,
  parseAssistantProposalRequest,
  parseCreateUploadSessionRequest,
  parseFinalizeImportRequest,
  parseSaveRevisionRequest
} from './validation';
import {
  getAssistantStatus,
  HttpAssistantConfigurationError,
  streamAssistantProposal,
  testAssistantConnection
} from './assistant';
import {
  authenticateRequest,
  AuthFlowError,
  AuthenticationError,
  destroyEmailSession,
  getAuthConfig,
  identifyAssistantRequest,
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

type Env = CloudflareEnv & {
  PROJECT_ROOM?: DurableObjectNamespace<ProjectCollaborationRoom>;
};

/** Upper bound for JSON request bodies; protects against oversized payloads. */
const MAX_JSON_BODY_BYTES = 25 * 1024 * 1024;
const MAX_ARTIFACT_BODY_BYTES = 25 * 1024 * 1024;

const PROJECT_ROUTE = /^\/api\/projects\/([^/]+)$/;
const PROJECT_REVISIONS_ROUTE = /^\/api\/projects\/([^/]+)\/revisions$/;
const PROJECT_COLLABORATION_ROUTE = /^\/api\/projects\/([^/]+)\/collaboration$/;
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
    return await request.json();
  } catch {
    throw new HttpError(400, 'Request body must be valid JSON.');
  }
}

async function handleApiRequest(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const { pathname } = url;

  if (request.method === 'GET' && pathname === '/api/health') {
    return json({
      status: 'ok',
      environment: env.ENVIRONMENT ?? 'beta',
      time: new Date().toISOString()
    });
  }

  if (request.method === 'GET' && pathname === '/api/auth/config') {
    return json(getAuthConfig(env));
  }

  const collaborationMatch = PROJECT_COLLABORATION_ROUTE.exec(pathname);
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
      const userId = await identifyAssistantRequest(request, env);
      const settings = await getAppSettings(userId, env);
      return json({
        ...settings.effectiveAssistant,
        credential: settings.credential
      });
    } catch (error) {
      if (error instanceof AuthenticationError && error.failure === 'missing') {
        return json({ ...getAssistantStatus(env), source: 'deployment' });
      }
      throw error;
    }
  }

  if (request.method === 'POST' && pathname === '/api/assistant/proposals') {
    const userId = await identifyAssistantRequest(request, env);
    const payload = parseAssistantProposalRequest(await readJsonBody(request));
    const assistant = await resolveUserAssistant(userId, env);
    if (!assistant.effective.configured) {
      return json(
        {
          error: 'AI is disabled or not configured for this user.',
          code: 'AI_NOT_CONFIGURED'
        },
        503
      );
    }
    return streamAssistantProposal(
      payload,
      env,
      userId,
      assistant.runtime ?? undefined
    );
  }

  const session = await authenticateRequest(request, env);
  const userId = session.userId;

  if (request.method === 'GET' && pathname === '/api/session') {
    return json(session);
  }

  if (request.method === 'GET' && pathname === '/api/settings') {
    return json(await getAppSettings(userId, env));
  }

  if (request.method === 'PATCH' && pathname === '/api/settings') {
    const payload = parseUpdateAppSettingsRequest(
      await readJsonBody(request),
      env.ENVIRONMENT
    );
    return json(await updateAppSettings(userId, payload, env));
  }

  if (pathname === '/api/settings/assistant-credential') {
    if (request.method === 'PUT') {
      const token = parseAssistantCredential(await readJsonBody(request));
      return json(await saveAssistantCredential(userId, token, env));
    }
    if (request.method === 'DELETE') {
      return json(await deleteAssistantCredential(userId, env));
    }
  }

  if (
    request.method === 'POST' &&
    pathname === '/api/settings/assistant/test'
  ) {
    const assistant = await resolveUserAssistant(userId, env);
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

  if (request.method === 'GET' && pathname === '/api/projects') {
    return json(await persistence.listProjects(userId));
  }

  if (request.method === 'POST' && pathname === '/api/projects') {
    const payload = parseCreateProjectRequest(await readJsonBody(request));
    return json(await persistence.createProject(userId, payload), 201);
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
    const project = await persistence.loadProject(userId, projectId);
    if (!project) {
      return json({ error: 'Project not found.' }, 404);
    }
    const headers = new Headers(request.headers);
    headers.set('x-openzcad-user-id', userId);
    headers.set('x-openzcad-display-name', session.displayName);
    const roomUrl = new URL(request.url);
    roomUrl.searchParams.set('projectId', projectId);
    return env.PROJECT_ROOM!.getByName(projectId).fetch(
      new Request(roomUrl, {
        method: request.method,
        headers,
        ...(request.method === 'POST'
          ? { body: await request.arrayBuffer() }
          : {})
      })
    );
  }

  const projectMatch = PROJECT_ROUTE.exec(pathname);
  if (request.method === 'GET' && projectMatch) {
    const project = await persistence.loadProject(userId, projectMatch[1]!);
    return project ? json(project) : json({ error: 'Project not found.' }, 404);
  }

  const revisionsMatch = PROJECT_REVISIONS_ROUTE.exec(pathname);
  if (request.method === 'POST' && revisionsMatch) {
    const payload = parseSaveRevisionRequest(
      await readJsonBody(request),
      revisionsMatch[1]!
    );
    return json(await persistence.saveRevision(userId, payload));
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
    return json(
      await persistence.getArtifactMetadata(userId, artifactMatch[1]!)
    );
  }

  return json({ error: 'Not found' }, 404);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    assertSafeRuntimeConfiguration(env);
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
      console.error('Unhandled API error.');
      return json({ error: 'Internal error' }, 500);
    }
  }
};

export { ProjectCollaborationRoom };
