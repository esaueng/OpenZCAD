import {
  nowIso,
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
import { createProjectDocument } from '@openzcad/document-core';
import { InMemoryJobRunner } from '@openzcad/jobs';

export interface PersistenceService {
  listProjects(userId: UserId): Promise<ListProjectsResponse>;
  createProject(userId: UserId, request: CreateProjectRequest): Promise<CreateProjectResponse>;
  loadProject(projectId: string): Promise<ProjectDocument | null>;
  saveRevision(request: SaveRevisionRequest): Promise<ProjectDocument>;
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
  getArtifactMetadata(artifactId: string): Promise<ArtifactMetadataResponse>;
}

export class InMemoryPersistenceService implements PersistenceService {
  private readonly projects = new Map<string, ProjectDocument>();
  private readonly artifacts = new Map<string, ArtifactRecord>();
  private readonly uploads = new Map<string, UploadSessionRecord>();
  private readonly jobRunner = new InMemoryJobRunner();

  async listProjects(_userId: UserId): Promise<ListProjectsResponse> {
    return {
      projects: Array.from(this.projects.values()).map((document) =>
        summarizeDocument(document)
      )
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

  async loadProject(projectId: string): Promise<ProjectDocument | null> {
    return this.projects.get(projectId) ?? null;
  }

  async saveRevision(request: SaveRevisionRequest): Promise<ProjectDocument> {
    this.projects.set(request.projectId, request.document);
    return request.document;
  }

  async createUploadSession(
    _userId: UserId,
    request: CreateUploadSessionRequest
  ): Promise<CreateUploadSessionResponse> {
    const session: UploadSessionRecord = {
      uploadSessionId: toUploadSessionId(`upload_${crypto.randomUUID()}`),
      artifactId: toArtifactId(`artifact_${crypto.randomUUID()}`),
      objectKey: `${request.projectId}/uploads/${crypto.randomUUID()}-${request.fileName}`,
      expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
      fileName: request.fileName,
      contentType: request.contentType
    };
    this.uploads.set(session.uploadSessionId, session);
    return { session };
  }

  async finalizeImport(
    _userId: UserId,
    request: FinalizeImportRequest
  ): Promise<ArtifactRecord | null> {
    const upload = this.uploads.get(request.uploadSessionId);
    if (!upload) {
      return null;
    }

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
    _userId: UserId,
    request: RequestExportRequest
  ): Promise<RequestExportResponse> {
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

  async getArtifactMetadata(artifactId: string): Promise<ArtifactMetadataResponse> {
    return {
      artifact: this.artifacts.get(artifactId) ?? null
    };
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

