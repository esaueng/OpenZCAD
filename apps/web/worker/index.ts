import {
  OpenZCADExportWorkflow,
  ProjectCollaborationRoom,
  createPersistenceService,
  type CloudflareEnv
} from '@openzcad/cloudflare-adapters';
import { toUserId, type CreateProjectRequest, type CreateUploadSessionRequest, type FinalizeImportRequest, type RequestExportRequest, type SaveRevisionRequest } from '@openzcad/shared';

type Env = CloudflareEnv & {
  PROJECT_ROOM?: DurableObjectNamespace<ProjectCollaborationRoom>;
  EXPORT_WORKFLOW?: Workflow<{
    artifactId: string;
  }>;
};

const devUserId = toUserId('user_beta_dev');

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json'
    }
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const persistence = createPersistenceService(env);

    if (request.method === 'GET' && url.pathname === '/api/health') {
      return json({
        status: 'ok',
        environment: 'beta',
        time: new Date().toISOString()
      });
    }

    if (request.method === 'GET' && url.pathname === '/api/projects') {
      return json(await persistence.listProjects(devUserId));
    }

    if (request.method === 'POST' && url.pathname === '/api/projects') {
      const payload = (await request.json()) as CreateProjectRequest;
      return json(await persistence.createProject(devUserId, payload), 201);
    }

    if (request.method === 'GET' && url.pathname.startsWith('/api/projects/')) {
      const projectId = url.pathname.split('/')[3];
      if (!projectId || url.pathname.endsWith('/revisions')) {
        return json({ error: 'Not found' }, 404);
      }
      const project = await persistence.loadProject(projectId);
      return project ? json(project) : json({ error: 'Not found' }, 404);
    }

    if (
      request.method === 'POST' &&
      /^\/api\/projects\/[^/]+\/revisions$/.test(url.pathname)
    ) {
      const payload = (await request.json()) as SaveRevisionRequest;
      return json(await persistence.saveRevision(payload));
    }

    if (request.method === 'POST' && url.pathname === '/api/uploads') {
      const payload = (await request.json()) as CreateUploadSessionRequest;
      return json(await persistence.createUploadSession(devUserId, payload), 201);
    }

    if (request.method === 'POST' && url.pathname === '/api/imports/finalize') {
      const payload = (await request.json()) as FinalizeImportRequest;
      const artifact = await persistence.finalizeImport(devUserId, payload);
      return json({ artifactId: artifact?.artifactId ?? null });
    }

    if (request.method === 'POST' && url.pathname === '/api/exports') {
      const payload = (await request.json()) as RequestExportRequest;
      const response = await persistence.requestExport(devUserId, payload);
      if (env.EXPORT_WORKFLOW) {
        await env.EXPORT_WORKFLOW.create({
          params: { artifactId: response.artifact.artifactId }
        });
      }
      return json(response, 202);
    }

    if (request.method === 'GET' && url.pathname.startsWith('/api/artifacts/')) {
      const artifactId = url.pathname.split('/').at(-1);
      return json(await persistence.getArtifactMetadata(artifactId ?? ''));
    }

    return json({ error: 'Not found' }, 404);
  }
};

export { OpenZCADExportWorkflow, ProjectCollaborationRoom };
