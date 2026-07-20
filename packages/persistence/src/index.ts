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
  type FinalizeArtifactRequest,
  type ListArtifactsResponse,
  type ListProjectsResponse,
  type ProjectDocument,
  type ProjectSummary,
  type SaveRevisionRequest,
  type UploadSessionRecord,
  type UserId
} from '@openzcad/shared';
import {
  createCheckpoint,
  createProjectDocument,
  normalizeDocument
} from '@openzcad/document-core';

export const UPLOAD_SESSION_TTL_MS = 15 * 60 * 1000;

/** Thrown by saveRevision when the target project does not exist. */
export class ProjectNotFoundError extends Error {
  constructor(projectId: string) {
    super(`Project ${projectId} not found.`);
    this.name = 'ProjectNotFoundError';
  }
}

export class ArtifactStorageError extends Error {
  constructor(message = 'Artifact storage is unavailable.') {
    super(message);
    this.name = 'ArtifactStorageError';
  }
}

export class RevisionConflictError extends Error {
  constructor(
    readonly projectId: string,
    readonly currentVersion: number
  ) {
    super(`Project ${projectId} has a newer remote revision.`);
    this.name = 'RevisionConflictError';
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
  putUpload(
    userId: UserId,
    uploadSessionId: string,
    body: ArrayBuffer
  ): Promise<void>;
  finalizeArtifact(
    userId: UserId,
    request: FinalizeArtifactRequest
  ): Promise<ArtifactRecord | null>;
  listArtifacts(
    userId: UserId,
    projectId: string
  ): Promise<ListArtifactsResponse>;
  getArtifactMetadata(
    userId: UserId,
    artifactId: string
  ): Promise<ArtifactMetadataResponse>;
  downloadArtifact(
    userId: UserId,
    artifactId: string
  ): Promise<{ artifact: ArtifactRecord; body: ArrayBuffer } | null>;
}

export class InMemoryPersistenceService implements PersistenceService {
  private readonly projects = new Map<string, ProjectDocument>();
  private readonly artifacts = new Map<string, ArtifactRecord>();
  private readonly uploads = new Map<string, UploadSessionRecord>();
  private readonly uploadBodies = new Map<string, ArrayBuffer>();

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
    if (existing.version !== request.expectedVersion) {
      throw new RevisionConflictError(request.projectId, existing.version);
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
      projectId: request.projectId,
      objectKey: `${request.projectId}/uploads/${crypto.randomUUID()}-${sanitizeFileName(request.fileName)}`,
      expiresAt: new Date(Date.now() + UPLOAD_SESSION_TTL_MS).toISOString(),
      fileName: request.fileName,
      contentType: request.contentType,
      kind: request.kind,
      metadata: request.metadata ?? {}
    };
    this.uploads.set(session.uploadSessionId, session);
    return { session };
  }

  async putUpload(
    userId: UserId,
    uploadSessionId: string,
    body: ArrayBuffer
  ): Promise<void> {
    const upload = this.uploads.get(uploadSessionId);
    if (!upload) {
      throw new ArtifactStorageError('Upload session was not found.');
    }
    this.assertProjectOwner(userId, upload.projectId);
    this.uploadBodies.set(upload.objectKey, body);
  }

  async finalizeArtifact(
    userId: UserId,
    request: FinalizeArtifactRequest
  ): Promise<ArtifactRecord | null> {
    this.assertProjectOwner(userId, request.projectId);
    const upload = this.uploads.get(request.uploadSessionId);
    const body = upload ? this.uploadBodies.get(upload.objectKey) : undefined;
    if (
      !upload ||
      !body ||
      upload.projectId !== request.projectId ||
      upload.artifactId !== request.artifactId ||
      Date.parse(upload.expiresAt) < Date.now()
    ) {
      return null;
    }
    this.uploads.delete(request.uploadSessionId);

    const artifact: ArtifactRecord = {
      artifactId: request.artifactId,
      projectId: request.projectId,
      kind: upload.kind,
      name: upload.fileName,
      objectKey: upload.objectKey,
      contentType: upload.contentType,
      bytes: body.byteLength,
      createdAt: nowIso(),
      metadata: upload.metadata
    };
    this.artifacts.set(artifact.artifactId, artifact);
    return artifact;
  }

  async listArtifacts(
    userId: UserId,
    projectId: string
  ): Promise<ListArtifactsResponse> {
    this.assertProjectOwner(userId, projectId);
    return {
      artifacts: Array.from(this.artifacts.values())
        .filter((artifact) => artifact.projectId === projectId)
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
    };
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

  async downloadArtifact(
    userId: UserId,
    artifactId: string
  ): Promise<{ artifact: ArtifactRecord; body: ArrayBuffer } | null> {
    const { artifact } = await this.getArtifactMetadata(userId, artifactId);
    if (!artifact) {
      return null;
    }
    const body = this.uploadBodies.get(artifact.objectKey);
    return body ? { artifact, body } : null;
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
