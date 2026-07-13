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
  type ListProjectsResponse,
  type ProjectDocument,
  type ProjectSummary,
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
import { InMemoryJobRunner } from '@openzcad/jobs';

export const UPLOAD_SESSION_TTL_MS = 15 * 60 * 1000;

/** Thrown by saveRevision when the target project does not exist. */
export class ProjectNotFoundError extends Error {
  constructor(projectId: string) {
    super(`Project ${projectId} not found.`);
    this.name = 'ProjectNotFoundError';
  }
}

export interface PersistenceService {
  listProjects(userId: UserId): Promise<ListProjectsResponse>;
  createProject(
    userId: UserId,
    request: CreateProjectRequest
  ): Promise<CreateProjectResponse>;
  loadProject(
    userId: UserId,
    projectId: string
  ): Promise<ProjectDocument | null>;
  /** @throws ProjectNotFoundError when the project does not exist. */
  saveRevision(
    userId: UserId,
    request: SaveRevisionRequest
  ): Promise<ProjectDocument>;
  createUploadSession(
    userId: UserId,
    request: CreateUploadSessionRequest
  ): Promise<CreateUploadSessionResponse>;
  finalizeImport(
    userId: UserId,
    request: FinalizeImportRequest
  ): Promise<ArtifactRecord | null>;
  requestExport(
    userId: UserId,
    request: RequestExportRequest
  ): Promise<RequestExportResponse>;
  getArtifactMetadata(
    userId: UserId,
    artifactId: string
  ): Promise<ArtifactMetadataResponse>;
}

export class InMemoryPersistenceService implements PersistenceService {
  private readonly projects = new Map<string, ProjectDocument>();
  private readonly artifacts = new Map<string, ArtifactRecord>();
  private readonly uploads = new Map<string, UploadSessionRecord>();
  private readonly jobRunner = new InMemoryJobRunner();

  async listProjects(userId: UserId): Promise<ListProjectsResponse> {
    return {
      projects: Array.from(this.projects.values())
        .filter((document) => document.ownerUserId === userId)
        .map((document) => summarizeDocument(document))
    };
  }

  async createProject(
    userId: UserId,
    request: CreateProjectRequest
  ): Promise<CreateProjectResponse> {
    const document = createProjectDocument(request.name, userId, request.units);
    this.projects.set(document.projectId, document);
    return {
      project: summarizeDocument(document),
      document
    };
  }

  async loadProject(
    userId: UserId,
    projectId: string
  ): Promise<ProjectDocument | null> {
    const document = this.projects.get(projectId);
    return document?.ownerUserId === userId
      ? normalizeDocument(document)
      : null;
  }

  async saveRevision(
    userId: UserId,
    request: SaveRevisionRequest
  ): Promise<ProjectDocument> {
    const existing = this.projects.get(request.projectId);
    if (!existing || existing.ownerUserId !== userId) {
      throw new ProjectNotFoundError(request.projectId);
    }
    const normalized = normalizeDocument(request.document);
    if (normalized.ownerUserId !== userId) {
      throw new ProjectNotFoundError(request.projectId);
    }
    const document = createCheckpoint(normalized, request.reason);
    this.projects.set(request.projectId, document);
    return document;
  }

  async createUploadSession(
    userId: UserId,
    request: CreateUploadSessionRequest
  ): Promise<CreateUploadSessionResponse> {
    this.assertProjectOwner(userId, request.projectId);
    this.pruneExpiredUploads();
    const session: UploadSessionRecord = {
      uploadSessionId: toUploadSessionId(`upload_${crypto.randomUUID()}`),
      artifactId: toArtifactId(`artifact_${crypto.randomUUID()}`),
      objectKey: `${request.projectId}/uploads/${crypto.randomUUID()}-${sanitizeFileName(request.fileName)}`,
      expiresAt: new Date(Date.now() + UPLOAD_SESSION_TTL_MS).toISOString(),
      fileName: request.fileName,
      contentType: request.contentType
    };
    this.uploads.set(session.uploadSessionId, session);
    return { session };
  }

  async finalizeImport(
    userId: UserId,
    request: FinalizeImportRequest
  ): Promise<ArtifactRecord | null> {
    this.assertProjectOwner(userId, request.projectId);
    const upload = this.uploads.get(request.uploadSessionId);
    if (!upload || Date.parse(upload.expiresAt) < Date.now()) {
      return null;
    }
    this.uploads.delete(request.uploadSessionId);

    const artifact: ArtifactRecord = {
      artifactId: request.artifactId,
      projectId: request.projectId,
      kind: request.contentType.includes('step') ? 'step-import' : 'stl-import',
      name: request.fileName,
      objectKey: upload.objectKey,
      contentType: request.contentType,
      createdAt: nowIso(),
      metadata: {
        finalized: true
      }
    };
    this.artifacts.set(artifact.artifactId, artifact);
    return artifact;
  }

  async requestExport(
    userId: UserId,
    request: RequestExportRequest
  ): Promise<RequestExportResponse> {
    this.assertProjectOwner(userId, request.projectId);
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
    this.artifacts.set(artifact.artifactId, artifact);

    const job = await this.jobRunner.enqueue({
      kind: 'export',
      projectId: request.projectId,
      artifactId: artifact.artifactId
    });

    return { artifact, job };
  }

  async getArtifactMetadata(
    userId: UserId,
    artifactId: string
  ): Promise<ArtifactMetadataResponse> {
    const artifact = this.artifacts.get(artifactId);
    return {
      artifact:
        artifact &&
        this.projects.get(artifact.projectId)?.ownerUserId === userId
          ? artifact
          : null
    };
  }

  private assertProjectOwner(userId: UserId, projectId: string): void {
    if (this.projects.get(projectId)?.ownerUserId !== userId) {
      throw new ProjectNotFoundError(projectId);
    }
  }

  private pruneExpiredUploads(): void {
    const now = Date.now();
    for (const [sessionId, session] of this.uploads) {
      if (Date.parse(session.expiresAt) < now) {
        this.uploads.delete(sessionId);
      }
    }
  }
}

function summarizeDocument(document: ProjectDocument): ProjectSummary {
  const latestRevision = document.revisions.at(-1);
  return {
    projectId: document.projectId,
    name: document.name,
    lastRevisionId: latestRevision?.revisionId,
    revisionCount: document.revisions.length,
    updatedAt: latestRevision?.createdAt ?? nowIso()
  };
}

let singleton: InMemoryPersistenceService | undefined;

export function getInMemoryPersistence(): InMemoryPersistenceService {
  if (!singleton) {
    singleton = new InMemoryPersistenceService();
  }

  return singleton;
}
