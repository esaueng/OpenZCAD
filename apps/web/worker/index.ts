import {
  OpenZCADExportWorkflow,
  ProjectCollaborationRoom,
  createPersistenceService,
  type CloudflareEnv
} from '@openzcad/cloudflare-adapters';
import { ProjectNotFoundError } from '@openzcad/persistence';
import {
  HttpError,
  parseCreateProjectRequest,
  parseAssistantProposalRequest,
  parseCreateUploadSessionRequest,
  parseFinalizeImportRequest,
  parseRequestExportRequest,
  parseSaveRevisionRequest
} from './validation';
import { getAssistantStatus, streamAssistantProposal } from './assistant';
import { authenticateRequest, AuthenticationError } from './auth';

type Env = CloudflareEnv & {
  PROJECT_ROOM?: DurableObjectNamespace<ProjectCollaborationRoom>;
  EXPORT_WORKFLOW?: Workflow<{
    artifactId: string;
  }>;
};

/** Upper bound for JSON request bodies; protects against oversized payloads. */
const MAX_JSON_BODY_BYTES = 25 * 1024 * 1024;

const PROJECT_ROUTE = /^\/api\/projects\/([^/]+)$/;
const PROJECT_REVISIONS_ROUTE = /^\/api\/projects\/([^/]+)\/revisions$/;
const PROJECT_COLLABORATION_ROUTE = /^\/api\/projects\/([^/]+)\/collaboration$/;
const ARTIFACT_ROUTE = /^\/api\/artifacts\/([^/]+)$/;

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

  const session = await authenticateRequest(request, env);
  const userId = session.userId;

  if (request.method === 'GET' && pathname === '/api/session') {
    return json(session);
  }

  if (request.method === 'GET' && pathname === '/api/assistant/status') {
    return json(getAssistantStatus(env));
  }

  if (request.method === 'GET' && pathname === '/api/projects') {
    return json(await persistence.listProjects(userId));
  }

  if (request.method === 'POST' && pathname === '/api/assistant/proposals') {
    const payload = parseAssistantProposalRequest(await readJsonBody(request));
    return streamAssistantProposal(payload, env, userId);
  }

  if (request.method === 'POST' && pathname === '/api/projects') {
    const payload = parseCreateProjectRequest(await readJsonBody(request));
    return json(await persistence.createProject(userId, payload), 201);
  }

  const collaborationMatch = PROJECT_COLLABORATION_ROUTE.exec(pathname);
  if (request.method === 'GET' && collaborationMatch) {
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
      new Request(roomUrl, { method: 'GET', headers })
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

  if (request.method === 'POST' && pathname === '/api/imports/finalize') {
    const payload = parseFinalizeImportRequest(await readJsonBody(request));
    const artifact = await persistence.finalizeImport(userId, payload);
    if (!artifact) {
      return json(
        { error: 'Upload session not found, expired, or already used.' },
        404
      );
    }
    return json({ artifactId: artifact.artifactId });
  }

  if (request.method === 'POST' && pathname === '/api/exports') {
    const payload = parseRequestExportRequest(await readJsonBody(request));
    const response = await persistence.requestExport(userId, payload);
    if (env.EXPORT_WORKFLOW) {
      try {
        await env.EXPORT_WORKFLOW.create({
          params: { artifactId: response.artifact.artifactId }
        });
      } catch (error) {
        // The export artifact and job are already recorded; a workflow
        // kick-off failure should not fail the request.
        console.warn('Export workflow creation failed:', error);
      }
    }
    return json(response, 202);
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
      console.error('Unhandled API error:', error);
      return json({ error: 'Internal error' }, 500);
    }
  }
};

export { OpenZCADExportWorkflow, ProjectCollaborationRoom };
