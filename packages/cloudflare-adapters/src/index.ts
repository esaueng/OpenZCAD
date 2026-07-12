import { AwsClient } from 'aws4fetch';
import {
  DurableObject,
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep
} from 'cloudflare:workers';
import {
  getInMemoryPersistence,
  ProjectNotFoundError,
  UPLOAD_SESSION_TTL_MS,
  type PersistenceService
} from '@openzcad/persistence';
import { InMemoryJobRunner } from '@openzcad/jobs';
import {
  nowIso,
  sanitizeFileName,
  toArtifactId,
  toUploadSessionId,
  type ArtifactMetadataResponse,
  type ArtifactRecord,
  type CreateProjectRequest,
  type CreateProjectResponse,
  type CreateUploadSessionRequest,
  type CreateUploadSessionResponse,
  type FinalizeImportRequest,
  type JobRecord,
  type ListProjectsResponse,
  type ProjectDocument,
  type RequestExportRequest,
  type RequestExportResponse,
  type SaveRevisionRequest,
  type UploadSessionRecord,
  type UserId
} from '@openzcad/shared';
import {
  createCheckpoint,
  createProjectDocument,
  normalizeDocument
} from '@openzcad/document-core';

export interface CloudflareEnv {
  ENVIRONMENT?: 'beta';
  OPENAI_API_KEY?: string;
  AI_MODEL?: string;
  AI_REASONING_EFFORT?: 'low' | 'medium' | 'high' | 'xhigh';
  DB?: D1Database;
  ARTIFACTS?: R2Bucket;
  JOB_QUEUE?: Queue<unknown>;
  R2_PUBLIC_URL?: string;
  R2_ACCESS_KEY_ID?: string;
  R2_SECRET_ACCESS_KEY?: string;
  R2_ACCOUNT_ID?: string;
  R2_BUCKET_NAME?: string;
}

export class D1R2PersistenceService implements PersistenceService {
  private readonly jobRunner = new InMemoryJobRunner();
  private schemaReady: Promise<void> | undefined;

  constructor(private readonly env: CloudflareEnv) {}

  /**
   * Creates tables on first use. Memoized per service instance so the DDL
   * batch runs once per isolate instead of once per request; a failed attempt
   * clears the memo so the next request retries.
   */
  ensureSchema(): Promise<void> {
    if (!this.env.DB) {
      return Promise.resolve();
    }
    if (!this.schemaReady) {
      this.schemaReady = this.createSchema().catch((error: unknown) => {
        this.schemaReady = undefined;
        throw error;
      });
    }
    return this.schemaReady;
  }

  private async createSchema(): Promise<void> {
    const statements = [
      `CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, email TEXT, created_at TEXT);`,
      `CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, name TEXT NOT NULL, document_json TEXT NOT NULL, updated_at TEXT NOT NULL);`,
      `CREATE TABLE IF NOT EXISTS revisions (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, reason TEXT NOT NULL, document_json TEXT NOT NULL, created_at TEXT NOT NULL);`,
      `CREATE TABLE IF NOT EXISTS artifacts (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, kind TEXT NOT NULL, name TEXT NOT NULL, object_key TEXT NOT NULL, content_type TEXT NOT NULL, metadata_json TEXT NOT NULL, created_at TEXT NOT NULL);`,
      `CREATE TABLE IF NOT EXISTS upload_sessions (id TEXT PRIMARY KEY, artifact_id TEXT NOT NULL, project_id TEXT NOT NULL, object_key TEXT NOT NULL, file_name TEXT NOT NULL, content_type TEXT NOT NULL, expires_at TEXT NOT NULL);`
    ];
    await this.env.DB!.batch(
      statements.map((sql) => this.env.DB!.prepare(sql))
    );
  }

  async listProjects(userId: UserId): Promise<ListProjectsResponse> {
    if (!this.env.DB) {
      return getInMemoryPersistence().listProjects(userId);
    }
    await this.ensureSchema();
    const rows = await this.env.DB.prepare(
      `SELECT id, name, updated_at, document_json FROM projects WHERE user_id = ? ORDER BY updated_at DESC`
    )
      .bind(userId)
      .all<{
        id: string;
        name: string;
        updated_at: string;
        document_json: string;
      }>();

    return {
      projects: (rows.results ?? []).map(
        (row: {
          id: string;
          name: string;
          updated_at: string;
          document_json: string;
        }) => {
          const document = normalizeDocument(
            JSON.parse(row.document_json) as ProjectDocument
          );
          return {
            projectId: document.projectId,
            name: row.name,
            lastRevisionId: document.revisions.at(-1)?.revisionId,
            revisionCount: document.revisions.length,
            updatedAt: row.updated_at
          };
        }
      )
    };
  }

  async createProject(
    userId: UserId,
    request: CreateProjectRequest
  ): Promise<CreateProjectResponse> {
    if (!this.env.DB) {
      return getInMemoryPersistence().createProject(userId, request);
    }
    await this.ensureSchema();
    const document = createProjectDocument(request.name, userId, request.units);
    await this.env.DB.prepare(
      `INSERT INTO projects (id, user_id, name, document_json, updated_at) VALUES (?, ?, ?, ?, ?)`
    )
      .bind(
        document.projectId,
        userId,
        document.name,
        JSON.stringify(document),
        nowIso()
      )
      .run();

    return {
      project: {
        projectId: document.projectId,
        name: document.name,
        lastRevisionId: document.revisions.at(-1)?.revisionId,
        revisionCount: document.revisions.length,
        updatedAt: nowIso()
      },
      document
    };
  }

  async loadProject(projectId: string): Promise<ProjectDocument | null> {
    if (!this.env.DB) {
      return getInMemoryPersistence().loadProject(projectId);
    }
    await this.ensureSchema();
    const row = await this.env.DB.prepare(
      `SELECT document_json FROM projects WHERE id = ?`
    )
      .bind(projectId)
      .first<{ document_json: string }>();
    return row
      ? normalizeDocument(JSON.parse(row.document_json) as ProjectDocument)
      : null;
  }

  async saveRevision(request: SaveRevisionRequest): Promise<ProjectDocument> {
    if (!this.env.DB) {
      return getInMemoryPersistence().saveRevision(request);
    }
    await this.ensureSchema();
    const document = createCheckpoint(
      normalizeDocument(request.document),
      request.reason
    );
    const documentJson = JSON.stringify(document);
    const result = await this.env.DB.prepare(
      `UPDATE projects SET document_json = ?, updated_at = ?, name = ? WHERE id = ?`
    )
      .bind(documentJson, nowIso(), document.name, request.projectId)
      .run();
    if (result.meta?.changes === 0) {
      throw new ProjectNotFoundError(request.projectId);
    }

    const latestRevision = document.revisions.at(-1);
    if (latestRevision) {
      await this.env.DB.prepare(
        `INSERT OR REPLACE INTO revisions (id, project_id, reason, document_json, created_at) VALUES (?, ?, ?, ?, ?)`
      )
        .bind(
          latestRevision.revisionId,
          request.projectId,
          request.reason,
          documentJson,
          latestRevision.createdAt
        )
        .run();
    }
    return document;
  }

  async createUploadSession(
    userId: UserId,
    request: CreateUploadSessionRequest
  ): Promise<CreateUploadSessionResponse> {
    if (!this.env.DB) {
      return getInMemoryPersistence().createUploadSession(userId, request);
    }
    await this.ensureSchema();
    const session = await createSignedUploadSession(this.env, request);
    await this.env.DB.prepare(
      `INSERT INTO upload_sessions (id, artifact_id, project_id, object_key, file_name, content_type, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(
        session.uploadSessionId,
        session.artifactId,
        request.projectId,
        session.objectKey,
        session.fileName,
        session.contentType,
        session.expiresAt
      )
      .run();
    return { session };
  }

  async finalizeImport(
    userId: UserId,
    request: FinalizeImportRequest
  ): Promise<ArtifactRecord | null> {
    if (!this.env.DB) {
      return getInMemoryPersistence().finalizeImport(userId, request);
    }
    await this.ensureSchema();
    const upload = await this.env.DB.prepare(
      `SELECT object_key, project_id, expires_at FROM upload_sessions WHERE id = ?`
    )
      .bind(request.uploadSessionId)
      .first<{ object_key: string; project_id: string; expires_at: string }>();
    if (
      !upload ||
      upload.project_id !== request.projectId ||
      Date.parse(upload.expires_at) < Date.now()
    ) {
      return null;
    }
    await this.env.DB.prepare(`DELETE FROM upload_sessions WHERE id = ?`)
      .bind(request.uploadSessionId)
      .run();

    const artifact: ArtifactRecord = {
      artifactId: request.artifactId,
      projectId: request.projectId,
      kind: request.contentType.includes('step') ? 'step-import' : 'stl-import',
      name: request.fileName,
      objectKey: upload.object_key,
      contentType: request.contentType,
      createdAt: nowIso(),
      metadata: {
        source: 'direct-upload'
      }
    };

    await this.env.DB.prepare(
      `INSERT OR REPLACE INTO artifacts (id, project_id, kind, name, object_key, content_type, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(
        artifact.artifactId,
        artifact.projectId,
        artifact.kind,
        artifact.name,
        artifact.objectKey,
        artifact.contentType,
        JSON.stringify(artifact.metadata),
        artifact.createdAt
      )
      .run();

    return artifact;
  }

  async requestExport(
    userId: UserId,
    request: RequestExportRequest
  ): Promise<RequestExportResponse> {
    if (!this.env.DB) {
      return getInMemoryPersistence().requestExport(userId, request);
    }
    await this.ensureSchema();
    const artifact: ArtifactRecord = {
      artifactId: toArtifactId(`artifact_${crypto.randomUUID()}`),
      projectId: request.projectId,
      kind: request.format === 'step' ? 'step-export' : 'stl-export',
      name: `export.${request.format}`,
      objectKey: `${request.projectId}/exports/${crypto.randomUUID()}.${request.format}`,
      contentType: request.format === 'step' ? 'model/step' : 'model/stl',
      createdAt: nowIso(),
      metadata: {
        bodyIds: request.bodyIds.join(',')
      }
    };

    await this.env.DB.prepare(
      `INSERT OR REPLACE INTO artifacts (id, project_id, kind, name, object_key, content_type, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(
        artifact.artifactId,
        artifact.projectId,
        artifact.kind,
        artifact.name,
        artifact.objectKey,
        artifact.contentType,
        JSON.stringify(artifact.metadata),
        artifact.createdAt
      )
      .run();

    const job = await this.jobRunner.enqueue({
      kind: 'export',
      projectId: request.projectId,
      artifactId: artifact.artifactId
    });

    return { artifact, job };
  }

  async getArtifactMetadata(
    artifactId: string
  ): Promise<ArtifactMetadataResponse> {
    if (!this.env.DB) {
      return getInMemoryPersistence().getArtifactMetadata(artifactId);
    }
    await this.ensureSchema();
    const row = await this.env.DB.prepare(
      `SELECT id, project_id, kind, name, object_key, content_type, metadata_json, created_at FROM artifacts WHERE id = ?`
    )
      .bind(artifactId)
      .first<{
        id: string;
        project_id: string;
        kind: ArtifactRecord['kind'];
        name: string;
        object_key: string;
        content_type: string;
        metadata_json: string;
        created_at: string;
      }>();

    return {
      artifact: row
        ? {
            artifactId: row.id as ArtifactRecord['artifactId'],
            projectId: row.project_id as ArtifactRecord['projectId'],
            kind: row.kind,
            name: row.name,
            objectKey: row.object_key,
            contentType: row.content_type,
            createdAt: row.created_at,
            metadata: JSON.parse(
              row.metadata_json
            ) as ArtifactRecord['metadata']
          }
        : null
    };
  }
}

async function createSignedUploadSession(
  env: CloudflareEnv,
  request: CreateUploadSessionRequest
): Promise<UploadSessionRecord> {
  const session: UploadSessionRecord = {
    uploadSessionId: toUploadSessionId(`upload_${crypto.randomUUID()}`),
    artifactId: toArtifactId(`artifact_${crypto.randomUUID()}`),
    objectKey: `${request.projectId}/uploads/${crypto.randomUUID()}-${sanitizeFileName(request.fileName)}`,
    fileName: request.fileName,
    contentType: request.contentType,
    expiresAt: new Date(Date.now() + UPLOAD_SESSION_TTL_MS).toISOString()
  };

  if (
    env.R2_PUBLIC_URL &&
    env.R2_ACCESS_KEY_ID &&
    env.R2_SECRET_ACCESS_KEY &&
    env.R2_ACCOUNT_ID &&
    env.R2_BUCKET_NAME
  ) {
    const client = new AwsClient({
      accessKeyId: env.R2_ACCESS_KEY_ID,
      secretAccessKey: env.R2_SECRET_ACCESS_KEY,
      service: 's3',
      region: 'auto'
    });
    const signedRequest = await client.sign(
      new Request(
        `${env.R2_PUBLIC_URL}/${env.R2_BUCKET_NAME}/${session.objectKey}`,
        {
          method: 'PUT',
          headers: {
            'content-type': request.contentType
          }
        }
      ),
      {
        aws: {
          signQuery: true
        }
      }
    );
    session.uploadUrl = signedRequest.url;
  }

  return session;
}

// Cache one service per env object (envs are stable per isolate) so schema
// setup memoization survives across requests without pinning a stale env.
const servicesByEnv = new WeakMap<CloudflareEnv, PersistenceService>();

export function createPersistenceService(
  env: CloudflareEnv
): PersistenceService {
  if (!env.DB) {
    return getInMemoryPersistence();
  }

  let service = servicesByEnv.get(env);
  if (!service) {
    service = new D1R2PersistenceService(env);
    servicesByEnv.set(env, service);
  }
  return service;
}

export class ProjectCollaborationRoom extends DurableObject {
  private presence = new Map<string, string>();
  private locks = new Map<string, string>();

  async joinSession(userId: string, status: string) {
    this.presence.set(userId, status);
    return { members: Array.from(this.presence.entries()) };
  }

  async setLock(path: string, userId: string | null) {
    if (userId) {
      this.locks.set(path, userId);
    } else {
      this.locks.delete(path);
    }
    return { locks: Array.from(this.locks.entries()) };
  }

  async snapshot() {
    return {
      members: Array.from(this.presence.entries()),
      locks: Array.from(this.locks.entries())
    };
  }
}

export class OpenZCADExportWorkflow extends WorkflowEntrypoint<
  CloudflareEnv,
  { artifactId: string }
> {
  override async run(
    event: WorkflowEvent<{ artifactId: string }>,
    step: WorkflowStep
  ): Promise<{ artifactId: string; status: JobRecord['status'] }> {
    const result = await step.do('record export request', async () => ({
      artifactId: event.payload.artifactId,
      status: 'completed' as const
    }));
    return result;
  }
}
