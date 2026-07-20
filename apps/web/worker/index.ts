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
import { getAssistantStatus, streamAssistantProposal } from './assistant';
import { consumeAssistantQuota } from './assistantRateLimit';
import {
  authenticateRequest,
  AuthenticationError,
  identifyAssistantRequest
} from './auth';

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

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json'
    }
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
  const persistence = createPersistenceService(env);

  if (request.method === 'GET' && pathname === '/api/health') {
    return json({
      status: 'ok',
      environment: env.ENVIRONMENT ?? 'beta',
      time: new Date().toISOString()
    });
  }

  if (request.method === 'GET' && pathname === '/api/assistant/status') {
    return json(getAssistantStatus(env));
  }

  if (request.method === 'POST' && pathname === '/api/assistant/proposals') {
    const userId = await identifyAssistantRequest(request, env);
    const payload = parseAssistantProposalRequest(await readJsonBody(request));
    const quota = await consumeAssistantQuota(userId, env);
    if (!quota.allowed) {
      return new Response(
        JSON.stringify({
          error: 'The modeling assistant request limit has been reached.',
          code: 'AI_RATE_LIMITED',
          retryAfterSeconds: quota.retryAfterSeconds
        }),
        {
          status: 429,
          headers: {
            'content-type': 'application/json',
            'retry-after': String(quota.retryAfterSeconds),
            'x-ratelimit-limit': String(quota.limit),
            'x-ratelimit-remaining': String(quota.remaining)
          }
        }
      );
    }
    return streamAssistantProposal(payload, env, userId);
  }

  const session = await authenticateRequest(request, env);
  const userId = session.userId;

  if (request.method === 'GET' && pathname === '/api/session') {
    return json(session);
  }

  if (request.method === 'GET' && pathname === '/api/projects') {
    return json(await persistence.listProjects(userId));
  }

  if (request.method === 'POST' && pathname === '/api/projects') {
    const payload = parseCreateProjectRequest(await readJsonBody(request));
    return json(await persistence.createProject(userId, payload), 201);
  }

  const collaborationMatch = PROJECT_COLLABORATION_ROUTE.exec(pathname);
  if (
    (request.method === 'GET' || request.method === 'POST') &&
    collaborationMatch
  ) {
    const projectId = collaborationMatch[1]!;
    const project = await persistence.loadProject(userId, projectId);
    if (!project) {
      return json({ error: 'Project not found.' }, 404);
    }
    if (!env.PROJECT_ROOM) {
      return json({ error: 'Collaboration is unavailable.' }, 503);
    }
    const headers = new Headers(request.headers);
    headers.set('x-openzcad-user-id', userId);
    headers.set('x-openzcad-display-name', session.displayName);
    const roomUrl = new URL(request.url);
    roomUrl.searchParams.set('projectId', projectId);
    return env.PROJECT_ROOM.getByName(projectId).fetch(
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
    try {
      return await handleApiRequest(request, env);
    } catch (error) {
      if (error instanceof HttpError) {
        return json({ error: error.message }, error.status);
      }
      if (error instanceof AuthenticationError) {
        return json({ error: error.message }, 401);
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
      if (error instanceof ArtifactStorageError) {
        return json({ error: error.message }, 503);
      }
      console.error('Unhandled API error:', error);
      return json({ error: 'Internal error' }, 500);
    }
  }
};

export { ProjectCollaborationRoom };
