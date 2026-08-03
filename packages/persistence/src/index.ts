import {
  applyOrganizationUpdate,
  compareProjectSummaries,
  DEFAULT_PROJECT_ORGANIZATION,
  duplicateProjectName,
  isPurgeDue,
  MAX_PERSISTED_DOCUMENT_BYTES,
  nowIso,
  persistedDocumentBytes,
  sanitizeFileName,
  toArtifactId,
  toUploadSessionId,
  type ArtifactMetadataResponse,
  type ArtifactRecord,
  type CreateProjectRequest,
  type CreateProjectResponse,
  type CreateUploadSessionRequest,
  type CreateUploadSessionResponse,
  type DuplicateProjectRequest,
  type FinalizeArtifactRequest,
  type ListArtifactsResponse,
  type ListProjectsResponse,
  type ProjectDocument,
  type ProjectInvitationSummary,
  type ProjectMemberRole as SharedProjectMemberRole,
  type ProjectSharingResponse,
  type ProjectId,
  type ProjectOrganization,
  type ProjectSummary,
  type ReorderProjectsRequest,
  type SaveRevisionRequest,
  type UpdateProjectRequest,
  type UploadSessionRecord,
  type UserId
} from '@openzcad/shared';
import {
  adoptProjectDocument,
  createCheckpoint,
  createProjectDocument,
  duplicateProjectDocument,
  normalizeDocument,
  withoutDerivedProjection
} from '@openzcad/document-core';

export const UPLOAD_SESSION_TTL_MS = 15 * 60 * 1000;

export const PROJECT_ACCESS_ROLES = ['owner', 'editor', 'viewer'] as const;
export type ProjectAccessRole = (typeof PROJECT_ACCESS_ROLES)[number];
export type ProjectMemberRole = SharedProjectMemberRole;

export const PROJECT_MEMBER_CAP = 50;
export const PROJECT_ACTIVE_INVITATION_CAP = 25;
export const PROJECT_INVITATION_RATE_LIMIT = 10;
export const PROJECT_INVITATION_RATE_WINDOW_SECONDS = 60 * 60;

export type ProjectSharingErrorCode =
  | 'INVITATION_NOT_FOUND'
  | 'INVITATION_EXISTS'
  | 'INVITATION_LIMIT'
  | 'INVITATION_RATE_LIMIT'
  | 'MEMBER_NOT_FOUND'
  | 'MEMBER_LIMIT'
  | 'OWNER_IMMUTABLE';

export class ProjectSharingError extends Error {
  constructor(
    readonly code: ProjectSharingErrorCode,
    message: string
  ) {
    super(message);
    this.name = 'ProjectSharingError';
  }
}

export interface CreateProjectInvitationInput {
  invitationId: string;
  email: string;
  role: ProjectMemberRole;
  tokenHash: string;
  createdAt: number;
  expiresAt: number;
}

/**
 * Authorization resolved from the immutable project owner plus any explicit
 * membership. Callers may forward `role`, but must not accept it from clients.
 */
export interface ProjectAccess {
  projectId: string;
  ownerUserId: UserId;
  role: ProjectAccessRole;
}

/**
 * Deliberately covers both missing and unauthorized projects so callers can
 * preserve indistinguishable 404 behavior.
 */
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

/**
 * Adoption refused. The two codes are kept apart because they mean opposite
 * things to the device holding the document: `ALREADY_ADOPTED` says the account
 * already has this project and the device should sync rather than upload, while
 * `PROJECT_ID_TAKEN` says the id belongs to someone else and the document can
 * only enter the account as a new project.
 */
export class ProjectAdoptionError extends Error {
  constructor(
    readonly code: 'ALREADY_ADOPTED' | 'PROJECT_ID_TAKEN',
    message: string
  ) {
    super(message);
    this.name = 'ProjectAdoptionError';
  }
}

/**
 * A document too big for the store to hold. Distinct from a transport failure
 * on purpose: retrying will never help, and the client has to say so instead of
 * leaving the user waiting for a sync that cannot happen.
 */
export class DocumentTooLargeError extends Error {
  constructor(
    readonly bytes: number,
    readonly limitBytes: number
  ) {
    super(
      `Document is ${bytes} bytes; the account stores at most ${limitBytes}.`
    );
    this.name = 'DocumentTooLargeError';
  }
}

/** @throws DocumentTooLargeError when the serialized document exceeds the cap. */
export function assertPersistableDocument(document: ProjectDocument): void {
  const bytes = persistedDocumentBytes(document);
  if (bytes > MAX_PERSISTED_DOCUMENT_BYTES) {
    throw new DocumentTooLargeError(bytes, MAX_PERSISTED_DOCUMENT_BYTES);
  }
}

export interface PersistenceService {
  requireProjectRead(userId: UserId, projectId: string): Promise<ProjectAccess>;
  requireProjectEdit(userId: UserId, projectId: string): Promise<ProjectAccess>;
  requireProjectOwner(
    userId: UserId,
    projectId: string
  ): Promise<ProjectAccess>;
  listProjectSharing(
    ownerUserId: UserId,
    projectId: string,
    now: number
  ): Promise<ProjectSharingResponse>;
  createProjectInvitation(
    ownerUserId: UserId,
    projectId: string,
    input: CreateProjectInvitationInput
  ): Promise<ProjectInvitationSummary>;
  revokeProjectInvitation(
    ownerUserId: UserId,
    projectId: string,
    invitationId: string,
    revokedAt: number
  ): Promise<void>;
  updateProjectMemberRole(
    ownerUserId: UserId,
    projectId: string,
    memberUserId: UserId,
    role: ProjectMemberRole,
    updatedAt: number
  ): Promise<void>;
  removeProjectMember(
    ownerUserId: UserId,
    projectId: string,
    memberUserId: UserId,
    removedAt: number
  ): Promise<void>;
  acceptProjectInvitation(
    userId: UserId,
    email: string,
    tokenHash: string,
    acceptedAt: number
  ): Promise<{ projectId: string; role: ProjectMemberRole }>;
  listProjects(userId: UserId): Promise<ListProjectsResponse>;
  createProject(
    userId: UserId,
    request: CreateProjectRequest
  ): Promise<CreateProjectResponse>;
  /**
   * Copies a project, including its feature history, into a new one.
   * @throws ProjectNotFoundError when the source does not exist.
   */
  duplicateProject(
    userId: UserId,
    request: DuplicateProjectRequest
  ): Promise<CreateProjectResponse>;
  /**
   * Moves a project between shelves, pins it, or repositions it.
   * @throws ProjectNotFoundError when the project does not exist.
   */
  updateProject(
    userId: UserId,
    request: UpdateProjectRequest
  ): Promise<ProjectSummary>;
  /** Renumbers the listed projects into the order they are given. */
  reorderProjects(
    userId: UserId,
    request: ReorderProjectsRequest
  ): Promise<ListProjectsResponse>;
  /**
   * Destroys a project and everything hanging off it, with no recycle bin.
   * @throws ProjectNotFoundError when the project does not exist.
   */
  deleteProject(userId: UserId, projectId: string): Promise<void>;
  /** Destroys deleted projects whose retention window has run out. */
  purgeExpiredProjects(userId: UserId): Promise<ProjectId[]>;
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
  private readonly projectMembers = new Map<
    string,
    Map<
      UserId,
      { role: ProjectMemberRole; createdAt: number; updatedAt: number }
    >
  >();
  private readonly projectInvitations = new Map<
    string,
    CreateProjectInvitationInput & {
      projectId: string;
      invitedByUserId: UserId;
      acceptedAt: number | null;
      acceptedByUserId: UserId | null;
      revokedAt: number | null;
    }
  >();
  private readonly invitationRateEvents = new Map<string, number[]>();
  private readonly organization = new Map<string, ProjectOrganization>();
  private readonly artifacts = new Map<string, ArtifactRecord>();
  private readonly uploads = new Map<string, UploadSessionRecord>();
  private readonly uploadBodies = new Map<string, ArrayBuffer>();

  async requireProjectRead(
    userId: UserId,
    projectId: string
  ): Promise<ProjectAccess> {
    return this.resolveProjectAccess(userId, projectId);
  }

  async requireProjectEdit(
    userId: UserId,
    projectId: string
  ): Promise<ProjectAccess> {
    const access = this.resolveProjectAccess(userId, projectId);
    if (access.role === 'viewer') {
      throw new ProjectNotFoundError(projectId);
    }
    return access;
  }

  async requireProjectOwner(
    userId: UserId,
    projectId: string
  ): Promise<ProjectAccess> {
    const access = this.resolveProjectAccess(userId, projectId);
    if (access.role !== 'owner') {
      throw new ProjectNotFoundError(projectId);
    }
    return access;
  }

  /**
   * Additive primitive for invitation/member route work. The immutable owner
   * is deliberately not represented in the membership map.
   */
  async setProjectMemberRole(
    ownerUserId: UserId,
    projectId: string,
    memberUserId: UserId,
    role: ProjectMemberRole | null
  ): Promise<void> {
    const access = await this.requireProjectOwner(ownerUserId, projectId);
    if (memberUserId === access.ownerUserId) {
      throw new Error('The project owner cannot be stored as a member.');
    }
    let members = this.projectMembers.get(projectId);
    if (!members) {
      members = new Map();
      this.projectMembers.set(projectId, members);
    }
    const timestamp = Math.floor(Date.now() / 1000);
    if (role === null) {
      members.delete(memberUserId);
    } else {
      const existing = members.get(memberUserId);
      members.set(memberUserId, {
        role,
        createdAt: existing?.createdAt ?? timestamp,
        updatedAt: timestamp
      });
    }
  }

  async listProjectSharing(
    ownerUserId: UserId,
    projectId: string,
    now: number
  ): Promise<ProjectSharingResponse> {
    const access = await this.requireProjectOwner(ownerUserId, projectId);
    const members = Array.from(
      this.projectMembers.get(projectId)?.entries() ?? []
    ).map(([userId, member]) => ({
      userId,
      email: null,
      role: member.role,
      createdAt: member.createdAt,
      updatedAt: member.updatedAt
    }));
    const invitations = Array.from(this.projectInvitations.values())
      .filter(
        (invitation) =>
          invitation.projectId === projectId &&
          invitation.acceptedAt === null &&
          invitation.revokedAt === null &&
          invitation.expiresAt >= now
      )
      .map(toInvitationSummary);
    return {
      projectId,
      ownerUserId: access.ownerUserId,
      members,
      invitations
    };
  }

  async createProjectInvitation(
    ownerUserId: UserId,
    projectId: string,
    input: CreateProjectInvitationInput
  ): Promise<ProjectInvitationSummary> {
    await this.requireProjectOwner(ownerUserId, projectId);
    const rateKey = `${projectId}:${ownerUserId}`;
    const windowStart =
      input.createdAt - PROJECT_INVITATION_RATE_WINDOW_SECONDS;
    const recent = (this.invitationRateEvents.get(rateKey) ?? []).filter(
      (timestamp) => timestamp >= windowStart
    );
    if (recent.length >= PROJECT_INVITATION_RATE_LIMIT) {
      throw new ProjectSharingError(
        'INVITATION_RATE_LIMIT',
        'Too many project invitations were created recently.'
      );
    }
    const active = Array.from(this.projectInvitations.values()).filter(
      (invitation) =>
        invitation.projectId === projectId &&
        invitation.acceptedAt === null &&
        invitation.revokedAt === null &&
        invitation.expiresAt >= input.createdAt
    );
    if (active.length >= PROJECT_ACTIVE_INVITATION_CAP) {
      throw new ProjectSharingError(
        'INVITATION_LIMIT',
        'This project has too many active invitations.'
      );
    }
    if (active.some((invitation) => invitation.email === input.email)) {
      throw new ProjectSharingError(
        'INVITATION_EXISTS',
        'An active invitation already exists for that email.'
      );
    }
    const invitation = {
      ...input,
      projectId,
      invitedByUserId: ownerUserId,
      acceptedAt: null,
      acceptedByUserId: null,
      revokedAt: null
    };
    this.projectInvitations.set(input.invitationId, invitation);
    recent.push(input.createdAt);
    this.invitationRateEvents.set(rateKey, recent);
    return toInvitationSummary(invitation);
  }

  async revokeProjectInvitation(
    ownerUserId: UserId,
    projectId: string,
    invitationId: string,
    revokedAt: number
  ): Promise<void> {
    await this.requireProjectOwner(ownerUserId, projectId);
    const invitation = this.projectInvitations.get(invitationId);
    if (
      !invitation ||
      invitation.projectId !== projectId ||
      invitation.acceptedAt !== null ||
      invitation.revokedAt !== null
    ) {
      throw new ProjectSharingError(
        'INVITATION_NOT_FOUND',
        'Project invitation not found.'
      );
    }
    invitation.revokedAt = revokedAt;
  }

  async updateProjectMemberRole(
    ownerUserId: UserId,
    projectId: string,
    memberUserId: UserId,
    role: ProjectMemberRole,
    updatedAt: number
  ): Promise<void> {
    const access = await this.requireProjectOwner(ownerUserId, projectId);
    if (memberUserId === access.ownerUserId) {
      throw new ProjectSharingError(
        'OWNER_IMMUTABLE',
        'Project ownership cannot be changed.'
      );
    }
    const member = this.projectMembers.get(projectId)?.get(memberUserId);
    if (!member) {
      throw new ProjectSharingError('MEMBER_NOT_FOUND', 'Member not found.');
    }
    member.role = role;
    member.updatedAt = updatedAt;
  }

  async removeProjectMember(
    ownerUserId: UserId,
    projectId: string,
    memberUserId: UserId,
    _removedAt: number
  ): Promise<void> {
    const access = await this.requireProjectOwner(ownerUserId, projectId);
    if (memberUserId === access.ownerUserId) {
      throw new ProjectSharingError(
        'OWNER_IMMUTABLE',
        'Project ownership cannot be changed.'
      );
    }
    if (!this.projectMembers.get(projectId)?.delete(memberUserId)) {
      throw new ProjectSharingError('MEMBER_NOT_FOUND', 'Member not found.');
    }
  }

  async acceptProjectInvitation(
    userId: UserId,
    email: string,
    tokenHash: string,
    acceptedAt: number
  ): Promise<{ projectId: string; role: ProjectMemberRole }> {
    const invitation = Array.from(this.projectInvitations.values()).find(
      (candidate) =>
        candidate.tokenHash === tokenHash &&
        candidate.email === email &&
        candidate.acceptedAt === null &&
        candidate.revokedAt === null &&
        candidate.expiresAt >= acceptedAt
    );
    if (!invitation) {
      throw new ProjectSharingError(
        'INVITATION_NOT_FOUND',
        'Project invitation is invalid or expired.'
      );
    }
    const access = this.resolveProjectAccess(
      invitation.invitedByUserId,
      invitation.projectId
    );
    if (access.ownerUserId === userId) {
      throw new ProjectSharingError(
        'OWNER_IMMUTABLE',
        'The project owner cannot accept a membership invitation.'
      );
    }
    let members = this.projectMembers.get(invitation.projectId);
    if (!members) {
      members = new Map();
      this.projectMembers.set(invitation.projectId, members);
    }
    const existing = members.get(userId);
    if (!existing && members.size >= PROJECT_MEMBER_CAP) {
      throw new ProjectSharingError(
        'MEMBER_LIMIT',
        'This project has too many members.'
      );
    }
    invitation.acceptedAt = acceptedAt;
    invitation.acceptedByUserId = userId;
    members.set(userId, {
      role: invitation.role,
      createdAt: existing?.createdAt ?? acceptedAt,
      updatedAt: acceptedAt
    });
    return { projectId: invitation.projectId, role: invitation.role };
  }

  async listProjects(userId: UserId): Promise<ListProjectsResponse> {
    return {
      projects: Array.from(this.projects.values())
        .filter(
          (document) =>
            document.ownerUserId === userId ||
            this.projectMembers.get(document.projectId)?.has(userId) === true
        )
        .map((document) => this.summarize(document))
        .sort(compareProjectSummaries)
    };
  }

  async createProject(
    userId: UserId,
    request: CreateProjectRequest
  ): Promise<CreateProjectResponse> {
    const document = request.document
      ? this.prepareAdoption(userId, request.document, request.name)
      : createProjectDocument(request.name, userId, request.units);
    this.projects.set(document.projectId, document);
    return {
      project: this.summarize(document),
      document
    };
  }

  private prepareAdoption(
    userId: UserId,
    source: ProjectDocument,
    name: string
  ): ProjectDocument {
    const existing = this.projects.get(source.projectId);
    if (existing) {
      throw existing.ownerUserId === userId
        ? new ProjectAdoptionError(
            'ALREADY_ADOPTED',
            'This project is already saved to your account.'
          )
        : new ProjectAdoptionError(
            'PROJECT_ID_TAKEN',
            'That project id is already in use.'
          );
    }
    const document = withoutDerivedProjection(
      adoptProjectDocument(source, userId, name)
    );
    assertPersistableDocument(document);
    return document;
  }

  async duplicateProject(
    userId: UserId,
    request: DuplicateProjectRequest
  ): Promise<CreateProjectResponse> {
    const source = this.projects.get(request.projectId);
    if (!source || source.ownerUserId !== userId) {
      throw new ProjectNotFoundError(request.projectId);
    }
    const owned = this.ownedProjects(userId);
    const name =
      request.name ??
      duplicateProjectName(
        source.name,
        owned.map((document) => document.name)
      );
    const document = duplicateProjectDocument(source, name, userId);
    this.projects.set(document.projectId, document);
    // A copy lands next to its original rather than at the top of the shelf,
    // which is where you go looking for it. It starts unpinned and active: the
    // point of a duplicate is to diverge from the original, not to inherit its
    // place on the desk.
    this.organization.set(document.projectId, {
      ...DEFAULT_PROJECT_ORGANIZATION,
      sortOrder: this.organizationOf(request.projectId).sortOrder
    });
    return { project: this.summarize(document), document };
  }

  async updateProject(
    userId: UserId,
    request: UpdateProjectRequest
  ): Promise<ProjectSummary> {
    const document = this.projects.get(request.projectId);
    if (!document || document.ownerUserId !== userId) {
      throw new ProjectNotFoundError(request.projectId);
    }
    this.organization.set(
      request.projectId,
      applyOrganizationUpdate(this.organizationOf(request.projectId), request)
    );
    return this.summarize(document);
  }

  async reorderProjects(
    userId: UserId,
    request: ReorderProjectsRequest
  ): Promise<ListProjectsResponse> {
    request.projectIds.forEach((projectId, index) => {
      const document = this.projects.get(projectId);
      if (document?.ownerUserId !== userId) {
        return;
      }
      this.organization.set(projectId, {
        ...this.organizationOf(projectId),
        sortOrder: index
      });
    });
    return this.listProjects(userId);
  }

  async deleteProject(userId: UserId, projectId: string): Promise<void> {
    const document = this.projects.get(projectId);
    if (!document || document.ownerUserId !== userId) {
      throw new ProjectNotFoundError(projectId);
    }
    this.destroyProject(projectId);
  }

  async purgeExpiredProjects(userId: UserId): Promise<ProjectId[]> {
    const purged: ProjectId[] = [];
    for (const document of this.ownedProjects(userId)) {
      const organization = this.organizationOf(document.projectId);
      if (
        organization.status === 'deleted' &&
        isPurgeDue(organization.deletedAt)
      ) {
        this.destroyProject(document.projectId);
        purged.push(document.projectId);
      }
    }
    return purged;
  }

  async loadProject(
    userId: UserId,
    projectId: string
  ): Promise<ProjectDocument | null> {
    const document = this.projects.get(projectId);
    if (!document) {
      return null;
    }
    try {
      await this.requireProjectRead(userId, projectId);
      return normalizeDocument(document);
    } catch (error) {
      if (error instanceof ProjectNotFoundError) {
        return null;
      }
      throw error;
    }
  }

  async saveRevision(
    userId: UserId,
    request: SaveRevisionRequest
  ): Promise<ProjectDocument> {
    const existing = this.projects.get(request.projectId);
    if (!existing) {
      throw new ProjectNotFoundError(request.projectId);
    }
    const access = await this.requireProjectEdit(userId, request.projectId);
    if (existing.version !== request.expectedVersion) {
      throw new RevisionConflictError(request.projectId, existing.version);
    }
    const normalized = normalizeDocument(request.document);
    if (
      normalized.projectId !== request.projectId ||
      normalized.ownerUserId !== access.ownerUserId
    ) {
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
    await this.requireProjectEdit(userId, request.projectId);
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
    await this.requireProjectEdit(userId, upload.projectId);
    this.uploadBodies.set(upload.objectKey, body);
  }

  async finalizeArtifact(
    userId: UserId,
    request: FinalizeArtifactRequest
  ): Promise<ArtifactRecord | null> {
    await this.requireProjectEdit(userId, request.projectId);
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
    await this.requireProjectRead(userId, projectId);
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
    if (!artifact) {
      return { artifact: null };
    }
    await this.requireProjectRead(userId, artifact.projectId);
    return { artifact };
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

  private ownedProjects(userId: UserId): ProjectDocument[] {
    return Array.from(this.projects.values()).filter(
      (document) => document.ownerUserId === userId
    );
  }

  private organizationOf(projectId: string): ProjectOrganization {
    return this.organization.get(projectId) ?? DEFAULT_PROJECT_ORGANIZATION;
  }

  private summarize(document: ProjectDocument): ProjectSummary {
    return {
      ...summarizeDocument(document),
      organization: this.organizationOf(document.projectId)
    };
  }

  private destroyProject(projectId: string): void {
    this.projects.delete(projectId);
    this.organization.delete(projectId);
    for (const [artifactId, artifact] of this.artifacts) {
      if (artifact.projectId === projectId) {
        this.artifacts.delete(artifactId);
        this.uploadBodies.delete(artifact.objectKey);
      }
    }
    for (const [sessionId, session] of this.uploads) {
      if (session.projectId === projectId) {
        this.uploads.delete(sessionId);
        this.uploadBodies.delete(session.objectKey);
      }
    }
  }

  private resolveProjectAccess(
    userId: UserId,
    projectId: string
  ): ProjectAccess {
    const document = this.projects.get(projectId);
    if (!document) {
      throw new ProjectNotFoundError(projectId);
    }
    if (document.ownerUserId === userId) {
      return {
        projectId,
        ownerUserId: document.ownerUserId,
        role: 'owner'
      };
    }
    const member = this.projectMembers.get(projectId)?.get(userId);
    if (!member) {
      throw new ProjectNotFoundError(projectId);
    }
    return {
      projectId,
      ownerUserId: document.ownerUserId,
      role: member.role
    };
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

function toInvitationSummary(
  invitation: CreateProjectInvitationInput & { projectId: string }
): ProjectInvitationSummary {
  return {
    invitationId: invitation.invitationId,
    projectId: invitation.projectId,
    email: invitation.email,
    role: invitation.role,
    createdAt: invitation.createdAt,
    expiresAt: invitation.expiresAt
  };
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
