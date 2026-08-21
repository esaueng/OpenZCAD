import { DurableObject } from 'cloudflare:workers';
import {
  ArtifactQuotaError,
  ArtifactStorageError,
  assertPersistableDocument,
  DocumentTooLargeError,
  getInMemoryPersistence,
  ProjectAdoptionError,
  PROJECT_ACTIVE_INVITATION_CAP,
  PROJECT_INVITATION_RATE_LIMIT,
  PROJECT_INVITATION_RATE_WINDOW_SECONDS,
  PROJECT_MEMBER_CAP,
  ProjectNotFoundError,
  ProjectSharingError,
  RevisionConflictError,
  UPLOAD_SESSION_TTL_MS,
  type CreateProjectInvitationInput,
  type CreateProjectShareLinkInput,
  type ProjectAccess,
  type ProjectMemberRole,
  type PersistenceService,
  type SharedProjectAssetDownload,
  type SharedProjectSnapshot
} from '@openzcad/persistence';
import {
  applyOrganizationUpdate,
  DEFAULT_PROJECT_ORGANIZATION,
  duplicateProjectName,
  MAX_CLOUD_PROJECT_DOCUMENT_BYTES,
  MAX_ACCOUNT_ARTIFACT_BYTES,
  MAX_ARTIFACT_UPLOAD_PARTS,
  MAX_THUMBNAIL_BYTES,
  MAX_PERSISTED_DOCUMENT_BYTES,
  MAX_PROJECT_REVISIONS,
  MAX_PROJECT_CHECKPOINTS,
  THUMBNAIL_CONTENT_TYPE,
  nowIso,
  isProjectCheckpoint,
  isRevisionRecord,
  persistedDocumentBytes,
  projectOrganization,
  PROJECT_DOCUMENT_SCHEMA_VERSION,
  PROJECT_STATUSES,
  sanitizeFileName,
  toArtifactId,
  toProjectId,
  toRevisionId,
  toUploadSessionId,
  TRASH_RETENTION_MS,
  type AccountStorageUsage,
  type ArtifactMetadataResponse,
  type ArtifactRecord,
  type CompleteMultipartUploadRequest,
  type CreateMultipartUploadResponse,
  type UploadedArtifactPart,
  type CreateProjectRequest,
  type CreateProjectResponse,
  type CreateUploadSessionRequest,
  type CreateUploadSessionResponse,
  type CollaborationClientMessage,
  type CollaborationErrorCode,
  type CollaborationMember,
  type CollaborationServerMessage,
  type DuplicateProjectRequest,
  type FinalizeArtifactRequest,
  type ListArtifactsResponse,
  type ListProjectsResponse,
  type ProjectDocument,
  type ProjectAccessRole as SharedProjectAccessRole,
  type ProjectEditLease,
  type ProjectInvitationSummary,
  type ProjectSharingResponse,
  type ProjectShareLinkMode,
  type ProjectShareLinkSummary,
  type ProjectId,
  type ProjectOrganization,
  type ProjectStatus,
  type ProjectSummary,
  type ReorderProjectsRequest,
  type SaveProjectDocumentRequest,
  type SaveProjectDocumentResponse,
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
import {
  decodeProjectStorageBody,
  hydrateProjectStorageSnapshot,
  prepareProjectStorageSnapshot,
  PROJECT_OBJECT_STORAGE_PREFIX,
  ProjectObjectStorageError,
  sha256Hex,
  type PreparedProjectStorageSnapshot,
  type ProjectStorageAssetObject,
  type ProjectStorageAssetReference,
  type ProjectStorageSnapshot
} from './project-object-storage';

export {
  decodeProjectStorageBody,
  hydrateProjectStorageSnapshot,
  prepareProjectStorageSnapshot,
  PROJECT_OBJECT_STORAGE_FORMAT,
  PROJECT_OBJECT_STORAGE_PREFIX,
  PROJECT_OBJECT_STORAGE_VERSION,
  ProjectObjectStorageError,
  sha256Hex
} from './project-object-storage';

export interface CloudflareEnv {
  ENVIRONMENT?: 'development' | 'beta';
  AUTH_MODE?: 'development' | 'email-code';
  PROJECT_SHARING_ENABLED?: string;
  PROJECT_EDIT_LEASES_ENFORCED?: string;
  /**
   * Lets the project owner's own devices join a live room, independent of
   * sharing. Deliberately a separate flag: sharing carries invitations, roles,
   * and lease enforcement, and turning on device sync must not turn any of
   * those on with it.
   */
  PROJECT_PERSONAL_SYNC_ENABLED?: string;
  /**
   * Comma-separated authenticated email allowlist for the collaboration
   * canary. Missing or empty stays closed; keep this in Worker secrets.
   */
  PROJECT_COLLABORATION_CANARY_EMAILS?: string;
  AI_PATCH_DIRECT_EDIT_ENABLED?: string;
  AI_PATCH_FACE_SKETCH_ENABLED?: string;
  AI_PATCH_MULTI_PROFILE_EXTRUDE_ENABLED?: string;
  AI_PATCH_MIRROR_ENABLED?: string;
  AI_PATCH_SHELL_ENABLED?: string;
  AI_PATCH_SOLID_OFFSET_ENABLED?: string;
  AI_PATCH_PARTIAL_REVOLVE_ENABLED?: string;
  PRODUCTION_GUARD?: string;
  AUTH_LEGACY_OWNER_EMAIL?: string;
  AUTH_OTP_PEPPER?: string;
  AUTH_EMAIL_FROM?: string;
  /** Sender reserved for transactional project invitation links. */
  PROJECT_INVITATION_EMAIL_FROM?: string;
  /** Canonical browser origin used to build invitation links. */
  PUBLIC_APP_ORIGIN?: string;
  AUTH_SESSION_DAYS?: string;
  /** Fail-closed rollout gate for the native PKCE/device authorization flow. */
  DESKTOP_AUTH_ENABLED?: string;
  TURNSTILE_SITE_KEY?: string;
  TURNSTILE_SECRET_KEY?: string;
  EMAIL?: SendEmail;
  AI_PROVIDER?: 'openai' | 'openrouter' | 'responses-compatible';
  AI_BASE_URL?: string;
  AI_API_KEY?: string;
  /** Backward-compatible OpenAI-specific secret name. */
  OPENAI_API_KEY?: string;
  /** OpenRouter-specific secret used when AI_PROVIDER=openrouter. */
  OPENROUTER_API_KEY?: string;
  /** Optional public app URL sent to OpenRouter for attribution. */
  AI_SITE_URL?: string;
  /** Optional app name sent to OpenRouter; defaults to OpenZCAD. */
  AI_APP_NAME?: string;
  AI_MODEL?: string;
  AI_REASONING_EFFORT?: 'low' | 'medium' | 'high' | 'xhigh';
  /**
   * Output ceiling for one proposal. Reasoning tokens count against this, so it
   * must stay well clear of a full multi-part patch or the model truncates.
   */
  AI_MAX_OUTPUT_TOKENS?: string;
  AI_TIMEOUT_MS?: string;
  /** Secret used to HMAC public assistant identities and IP quota buckets. */
  AI_IDENTITY_PEPPER?: string;
  /** Comma-separated authenticated emails allowed to use deployment AI spend. */
  AI_DEPLOYMENT_ALLOWED_EMAILS?: string;
  /** Comma-separated exact hostnames allowed for custom Responses endpoints. */
  AI_ALLOWED_BASE_URL_HOSTS?: string;
  AI_GLOBAL_DAILY_REQUEST_LIMIT?: string;
  AI_GLOBAL_DAILY_COST_LIMIT_UNITS?: string;
  AI_ACCOUNT_RATE_LIMIT_REQUESTS?: string;
  AI_IP_RATE_LIMIT_REQUESTS?: string;
  AI_ACCOUNT_COST_LIMIT_UNITS?: string;
  AI_IP_COST_LIMIT_UNITS?: string;
  AI_RATE_LIMIT_WINDOW_SECONDS?: string;
  AI_ACCOUNT_CONCURRENCY_LIMIT?: string;
  AI_IP_CONCURRENCY_LIMIT?: string;
  /** Base64-encoded 32-byte AES key for owner-scoped AI credentials. */
  SETTINGS_ENCRYPTION_KEY?: string;
  DB?: D1Database;
  /** Optional dedicated bucket; ARTIFACTS remains the rollout fallback. */
  PROJECT_STORAGE?: R2Bucket;
  ARTIFACTS?: R2Bucket;
  /**
   * Per-project collaboration rooms. When bound, hard project deletion also
   * erases each project's Durable Object storage — the room holds the latest
   * document and bounded snapshot history, which the D1/R2 sweeps never reach.
   */
  PROJECT_ROOM?: DurableObjectNamespace<ProjectCollaborationRoom>;
}

export const CLOUDFLARE_BOOLEAN_FLAGS = [
  'DESKTOP_AUTH_ENABLED',
  'PROJECT_SHARING_ENABLED',
  'PROJECT_EDIT_LEASES_ENFORCED',
  'PROJECT_PERSONAL_SYNC_ENABLED',
  'AI_PATCH_DIRECT_EDIT_ENABLED',
  'AI_PATCH_FACE_SKETCH_ENABLED',
  'AI_PATCH_MULTI_PROFILE_EXTRUDE_ENABLED',
  'AI_PATCH_MIRROR_ENABLED',
  'AI_PATCH_SHELL_ENABLED',
  'AI_PATCH_SOLID_OFFSET_ENABLED',
  'AI_PATCH_PARTIAL_REVOLVE_ENABLED'
] as const;

export type CloudflareBooleanFlag = (typeof CLOUDFLARE_BOOLEAN_FLAGS)[number];

const ENABLED_BOOLEAN_ENV_VALUES = new Set(['1', 'true', 'yes', 'on']);

/**
 * Feature flags default closed and opt in only through a recognized true
 * value. Misspellings and empty bindings therefore cannot accidentally expose
 * an unfinished route or command path.
 */
export function isCloudflareFeatureEnabled(
  env: CloudflareEnv,
  flag: CloudflareBooleanFlag
): boolean {
  const value = env[flag];
  return (
    typeof value === 'string' &&
    ENABLED_BOOLEAN_ENV_VALUES.has(value.trim().toLowerCase())
  );
}

export interface ProjectCollaborationRollout {
  sharingEnabled: boolean;
  editLeasesEnforced: boolean;
  personalSyncEnabled: boolean;
  canary: boolean;
}

/**
 * Resolves the collaboration gates for one authenticated account. Global
 * flags remain available for later rollout, while the secret email allowlist
 * opens the complete viewer/editor/lease canary only for named accounts.
 */
export function projectCollaborationRollout(
  env: CloudflareEnv,
  email?: string
): ProjectCollaborationRollout {
  const normalizedEmail = email?.trim().toLowerCase();
  const canary = Boolean(
    normalizedEmail &&
    env.PROJECT_COLLABORATION_CANARY_EMAILS?.split(',').some(
      (candidate) => candidate.trim().toLowerCase() === normalizedEmail
    )
  );
  const sharingEnabled =
    isCloudflareFeatureEnabled(env, 'PROJECT_SHARING_ENABLED') || canary;
  return {
    sharingEnabled,
    editLeasesEnforced:
      isCloudflareFeatureEnabled(env, 'PROJECT_EDIT_LEASES_ENFORCED') || canary,
    personalSyncEnabled:
      isCloudflareFeatureEnabled(env, 'PROJECT_PERSONAL_SYNC_ENABLED') ||
      canary,
    canary
  };
}

export class D1R2PersistenceService implements PersistenceService {
  constructor(private readonly env: CloudflareEnv) {}

  async requireProjectRead(
    userId: UserId,
    projectId: string
  ): Promise<ProjectAccess> {
    if (!this.env.DB) {
      return getInMemoryPersistence().requireProjectRead(userId, projectId);
    }
    return this.resolveProjectAccess(userId, projectId);
  }

  async requireProjectEdit(
    userId: UserId,
    projectId: string
  ): Promise<ProjectAccess> {
    if (!this.env.DB) {
      return getInMemoryPersistence().requireProjectEdit(userId, projectId);
    }
    const access = await this.resolveProjectAccess(userId, projectId);
    if (access.role === 'viewer') {
      throw new ProjectNotFoundError(projectId);
    }
    return access;
  }

  private async requireRestProjectWrite(
    userId: UserId,
    projectId: string
  ): Promise<ProjectAccess> {
    const access = await this.requireProjectEdit(userId, projectId);
    if (
      access.role === 'editor' &&
      projectCollaborationRollout(this.env).editLeasesEnforced
    ) {
      throw new ProjectNotFoundError(projectId);
    }
    return access;
  }

  async requireProjectOwner(
    userId: UserId,
    projectId: string
  ): Promise<ProjectAccess> {
    if (!this.env.DB) {
      return getInMemoryPersistence().requireProjectOwner(userId, projectId);
    }
    const access = await this.resolveProjectAccess(userId, projectId);
    if (access.role !== 'owner') {
      throw new ProjectNotFoundError(projectId);
    }
    return access;
  }

  async listProjectSharing(
    ownerUserId: UserId,
    projectId: string,
    now: number
  ): Promise<ProjectSharingResponse> {
    if (!this.env.DB) {
      return getInMemoryPersistence().listProjectSharing(
        ownerUserId,
        projectId,
        now
      );
    }
    const access = await this.requireProjectOwner(ownerUserId, projectId);
    const [members, invitations] = await Promise.all([
      this.env.DB.prepare(
        `SELECT pm.user_id, u.email, pm.role, pm.created_at, pm.updated_at
         FROM project_members pm
         LEFT JOIN users u ON u.id = pm.user_id
         WHERE pm.project_id = ?
         ORDER BY pm.created_at ASC`
      )
        .bind(projectId)
        .all<{
          user_id: UserId;
          email: string | null;
          role: ProjectMemberRole;
          created_at: number;
          updated_at: number;
        }>(),
      this.env.DB.prepare(
        `SELECT id, project_id, email, role, created_at, expires_at
         FROM project_invitations
         WHERE project_id = ?
           AND accepted_at IS NULL
           AND revoked_at IS NULL
           AND expires_at >= ?
         ORDER BY created_at DESC`
      )
        .bind(projectId, now)
        .all<ProjectInvitationRow>()
    ]);
    return {
      projectId,
      ownerUserId: access.ownerUserId,
      members: (members.results ?? []).map((member) => ({
        userId: member.user_id,
        email: member.email,
        role: member.role,
        createdAt: member.created_at,
        updatedAt: member.updated_at
      })),
      invitations: (invitations.results ?? []).map(invitationFromRow)
    };
  }

  async createProjectInvitation(
    ownerUserId: UserId,
    projectId: string,
    input: CreateProjectInvitationInput
  ): Promise<ProjectInvitationSummary> {
    if (!this.env.DB) {
      return getInMemoryPersistence().createProjectInvitation(
        ownerUserId,
        projectId,
        input
      );
    }
    await this.requireProjectOwner(ownerUserId, projectId);
    const windowStart =
      Math.floor(input.createdAt / PROJECT_INVITATION_RATE_WINDOW_SECONDS) *
      PROJECT_INVITATION_RATE_WINDOW_SECONDS;
    const rate = await this.env.DB.prepare(
      `INSERT INTO auth_rate_limits (bucket, window_start, request_count)
       VALUES (?, ?, 1)
       ON CONFLICT(bucket) DO UPDATE SET
         request_count = CASE
           WHEN auth_rate_limits.window_start = excluded.window_start
             THEN auth_rate_limits.request_count + 1
           ELSE 1
         END,
         window_start = excluded.window_start
       RETURNING request_count`
    )
      .bind(`project-invite-account:${ownerUserId}`, windowStart)
      .first<{ request_count: number }>();
    if (!rate || rate.request_count > PROJECT_INVITATION_RATE_LIMIT) {
      throw new ProjectSharingError(
        'INVITATION_RATE_LIMIT',
        'Too many project invitations were created recently.'
      );
    }
    const inserted = await this.env.DB.prepare(
      `INSERT INTO project_invitations
         (id, project_id, email, role, token_hash, invited_by_user_id,
          created_at, expires_at)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?
       WHERE NOT EXISTS (
         SELECT 1 FROM project_invitations
         WHERE project_id = ? AND email = ?
           AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at >= ?
       )
       AND (
         SELECT COUNT(*) FROM project_invitations
         WHERE project_id = ?
           AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at >= ?
       ) < ?`
    )
      .bind(
        input.invitationId,
        projectId,
        input.email,
        input.role,
        input.tokenHash,
        ownerUserId,
        input.createdAt,
        input.expiresAt,
        projectId,
        input.email,
        input.createdAt,
        projectId,
        input.createdAt,
        PROJECT_ACTIVE_INVITATION_CAP
      )
      .run();
    if (inserted.meta?.changes !== 1) {
      const duplicate = await this.env.DB.prepare(
        `SELECT id FROM project_invitations
         WHERE project_id = ? AND email = ?
           AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at >= ?`
      )
        .bind(projectId, input.email, input.createdAt)
        .first<{ id: string }>();
      throw new ProjectSharingError(
        duplicate ? 'INVITATION_EXISTS' : 'INVITATION_LIMIT',
        duplicate
          ? 'An active invitation already exists for that email.'
          : 'This project has too many active invitations.'
      );
    }
    await this.env.DB.prepare(
      `INSERT INTO project_access_events
         (project_id, actor_user_id, invitation_id, event_type, next_role, created_at)
       VALUES (?, ?, ?, 'invitation-created', ?, ?)`
    )
      .bind(
        projectId,
        ownerUserId,
        input.invitationId,
        input.role,
        input.createdAt
      )
      .run();
    return {
      invitationId: input.invitationId,
      projectId,
      email: input.email,
      role: input.role,
      createdAt: input.createdAt,
      expiresAt: input.expiresAt
    };
  }

  async revokeProjectInvitation(
    ownerUserId: UserId,
    projectId: string,
    invitationId: string,
    revokedAt: number
  ): Promise<void> {
    if (!this.env.DB) {
      return getInMemoryPersistence().revokeProjectInvitation(
        ownerUserId,
        projectId,
        invitationId,
        revokedAt
      );
    }
    await this.requireProjectOwner(ownerUserId, projectId);
    const result = await this.env.DB.prepare(
      `UPDATE project_invitations SET revoked_at = ?
       WHERE id = ? AND project_id = ?
         AND accepted_at IS NULL AND revoked_at IS NULL`
    )
      .bind(revokedAt, invitationId, projectId)
      .run();
    if (result.meta?.changes !== 1) {
      throw new ProjectSharingError(
        'INVITATION_NOT_FOUND',
        'Project invitation not found.'
      );
    }
    await this.env.DB.prepare(
      `INSERT INTO project_access_events
         (project_id, actor_user_id, invitation_id, event_type, created_at)
       VALUES (?, ?, ?, 'invitation-revoked', ?)`
    )
      .bind(projectId, ownerUserId, invitationId, revokedAt)
      .run();
  }

  async updateProjectMemberRole(
    ownerUserId: UserId,
    projectId: string,
    memberUserId: UserId,
    role: ProjectMemberRole,
    updatedAt: number
  ): Promise<void> {
    if (!this.env.DB) {
      return getInMemoryPersistence().updateProjectMemberRole(
        ownerUserId,
        projectId,
        memberUserId,
        role,
        updatedAt
      );
    }
    const access = await this.requireProjectOwner(ownerUserId, projectId);
    if (memberUserId === access.ownerUserId) {
      throw new ProjectSharingError(
        'OWNER_IMMUTABLE',
        'Project ownership cannot be changed.'
      );
    }
    const existing = await this.env.DB.prepare(
      `SELECT role FROM project_members WHERE project_id = ? AND user_id = ?`
    )
      .bind(projectId, memberUserId)
      .first<{ role: ProjectMemberRole }>();
    if (!existing) {
      throw new ProjectSharingError('MEMBER_NOT_FOUND', 'Member not found.');
    }
    await this.env.DB.batch([
      this.env.DB.prepare(
        `UPDATE project_members SET role = ?, updated_at = ?
         WHERE project_id = ? AND user_id = ?`
      ).bind(role, updatedAt, projectId, memberUserId),
      this.env.DB.prepare(
        `INSERT INTO project_access_events
           (project_id, actor_user_id, subject_user_id, event_type,
            previous_role, next_role, created_at)
         VALUES (?, ?, ?, 'member-role-changed', ?, ?, ?)`
      ).bind(
        projectId,
        ownerUserId,
        memberUserId,
        existing.role,
        role,
        updatedAt
      )
    ]);
  }

  async removeProjectMember(
    ownerUserId: UserId,
    projectId: string,
    memberUserId: UserId,
    removedAt: number
  ): Promise<void> {
    if (!this.env.DB) {
      return getInMemoryPersistence().removeProjectMember(
        ownerUserId,
        projectId,
        memberUserId,
        removedAt
      );
    }
    const access = await this.requireProjectOwner(ownerUserId, projectId);
    if (memberUserId === access.ownerUserId) {
      throw new ProjectSharingError(
        'OWNER_IMMUTABLE',
        'Project ownership cannot be changed.'
      );
    }
    const existing = await this.env.DB.prepare(
      `SELECT role FROM project_members WHERE project_id = ? AND user_id = ?`
    )
      .bind(projectId, memberUserId)
      .first<{ role: ProjectMemberRole }>();
    if (!existing) {
      throw new ProjectSharingError('MEMBER_NOT_FOUND', 'Member not found.');
    }
    await this.env.DB.batch([
      this.env.DB.prepare(
        `DELETE FROM project_members WHERE project_id = ? AND user_id = ?`
      ).bind(projectId, memberUserId),
      this.env.DB.prepare(
        `INSERT INTO project_access_events
           (project_id, actor_user_id, subject_user_id, event_type,
            previous_role, created_at)
         VALUES (?, ?, ?, 'member-removed', ?, ?)`
      ).bind(projectId, ownerUserId, memberUserId, existing.role, removedAt)
    ]);
  }

  async acceptProjectInvitation(
    userId: UserId,
    email: string,
    tokenHash: string,
    acceptedAt: number
  ): Promise<{ projectId: string; role: ProjectMemberRole }> {
    if (!this.env.DB) {
      return getInMemoryPersistence().acceptProjectInvitation(
        userId,
        email,
        tokenHash,
        acceptedAt
      );
    }
    const invitation = await this.env.DB.prepare(
      `SELECT i.id, i.project_id, i.role, p.user_id AS owner_user_id
       FROM project_invitations i
       INNER JOIN projects p ON p.id = i.project_id
       LEFT JOIN user_settings owner_settings
         ON owner_settings.user_id = p.user_id
       WHERE i.token_hash = ? AND i.email = ?
         AND i.accepted_at IS NULL AND i.revoked_at IS NULL
         AND i.expires_at >= ?
         AND COALESCE(
           CASE WHEN json_valid(owner_settings.settings_json)
             THEN json_extract(
               owner_settings.settings_json,
               '$.collaboration.enabled'
             )
           END,
           1
         ) = 1`
    )
      .bind(tokenHash, email, acceptedAt)
      .first<{
        id: string;
        project_id: string;
        role: ProjectMemberRole;
        owner_user_id: UserId;
      }>();
    if (!invitation) {
      throw new ProjectSharingError(
        'INVITATION_NOT_FOUND',
        'Project invitation is invalid or expired.'
      );
    }
    if (invitation.owner_user_id === userId) {
      throw new ProjectSharingError(
        'OWNER_IMMUTABLE',
        'The project owner cannot accept a membership invitation.'
      );
    }
    const results = await this.env.DB.batch([
      this.env.DB.prepare(
        `UPDATE project_invitations
         SET accepted_at = ?, accepted_by_user_id = ?
         WHERE id = ? AND token_hash = ? AND email = ?
           AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at >= ?
           AND EXISTS (
             SELECT 1
             FROM projects p
             LEFT JOIN user_settings owner_settings
               ON owner_settings.user_id = p.user_id
             WHERE p.id = project_invitations.project_id
               AND COALESCE(
                 CASE WHEN json_valid(owner_settings.settings_json)
                   THEN json_extract(
                     owner_settings.settings_json,
                     '$.collaboration.enabled'
                   )
                 END,
                 1
               ) = 1
           )
           AND (
             EXISTS (
               SELECT 1 FROM project_members
               WHERE project_id = ? AND user_id = ?
             ) OR (
               SELECT COUNT(*) FROM project_members WHERE project_id = ?
             ) < ?
           )`
      ).bind(
        acceptedAt,
        userId,
        invitation.id,
        tokenHash,
        email,
        acceptedAt,
        invitation.project_id,
        userId,
        invitation.project_id,
        PROJECT_MEMBER_CAP
      ),
      this.env.DB.prepare(
        `INSERT INTO project_members
           (project_id, user_id, role, added_by_user_id, created_at, updated_at)
         SELECT project_id, ?, role, invited_by_user_id, ?, ?
         FROM project_invitations
         WHERE id = ? AND accepted_by_user_id = ? AND accepted_at = ?
           AND changes() > 0
         ON CONFLICT(project_id, user_id) DO UPDATE SET
           role = excluded.role, updated_at = excluded.updated_at`
      ).bind(userId, acceptedAt, acceptedAt, invitation.id, userId, acceptedAt),
      this.env.DB.prepare(
        `INSERT INTO project_access_events
           (project_id, actor_user_id, subject_user_id, invitation_id,
            event_type, next_role, created_at)
         SELECT project_id, ?, ?, id, 'invitation-accepted', role, ?
         FROM project_invitations
         WHERE id = ? AND accepted_by_user_id = ? AND accepted_at = ?
           AND changes() > 0`
      ).bind(userId, userId, acceptedAt, invitation.id, userId, acceptedAt)
    ]);
    if (results[0]?.meta?.changes !== 1) {
      const members = await this.env.DB.prepare(
        `SELECT COUNT(*) AS count FROM project_members WHERE project_id = ?`
      )
        .bind(invitation.project_id)
        .first<{ count: number }>();
      throw new ProjectSharingError(
        (members?.count ?? 0) >= PROJECT_MEMBER_CAP
          ? 'MEMBER_LIMIT'
          : 'INVITATION_NOT_FOUND',
        (members?.count ?? 0) >= PROJECT_MEMBER_CAP
          ? 'This project has too many members.'
          : 'Project invitation is invalid or expired.'
      );
    }
    return { projectId: invitation.project_id, role: invitation.role };
  }

  async createProjectShareLink(
    ownerUserId: UserId,
    projectId: string,
    input: CreateProjectShareLinkInput
  ): Promise<ProjectShareLinkSummary> {
    if (!this.env.DB) {
      return getInMemoryPersistence().createProjectShareLink(
        ownerUserId,
        projectId,
        input
      );
    }
    await this.requireProjectOwner(ownerUserId, projectId);
    await this.env.DB.prepare(
      `INSERT INTO project_share_links
         (id, project_id, mode, token_hash, created_by_user_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
      .bind(
        input.shareLinkId,
        projectId,
        input.mode,
        input.tokenHash,
        ownerUserId,
        input.createdAt
      )
      .run();
    await this.env.DB.prepare(
      `INSERT INTO project_access_events
         (project_id, actor_user_id, share_link_id, event_type, created_at,
          metadata_json)
       VALUES (?, ?, ?, 'share-link-created', ?, ?)`
    )
      .bind(
        projectId,
        ownerUserId,
        input.shareLinkId,
        input.createdAt,
        JSON.stringify({ mode: input.mode })
      )
      .run();
    return {
      shareLinkId: input.shareLinkId,
      projectId,
      mode: input.mode,
      createdAt: input.createdAt,
      revokedAt: null
    };
  }

  async listProjectShareLinks(
    ownerUserId: UserId,
    projectId: string
  ): Promise<ProjectShareLinkSummary[]> {
    if (!this.env.DB) {
      return getInMemoryPersistence().listProjectShareLinks(
        ownerUserId,
        projectId
      );
    }
    await this.requireProjectOwner(ownerUserId, projectId);
    const rows = await this.env.DB.prepare(
      `SELECT id, project_id, mode, created_at
       FROM project_share_links
       WHERE project_id = ? AND revoked_at IS NULL
       ORDER BY created_at DESC`
    )
      .bind(projectId)
      .all<ProjectShareLinkRow>();
    return (rows.results ?? []).map(shareLinkFromRow);
  }

  async revokeProjectShareLink(
    ownerUserId: UserId,
    projectId: string,
    shareLinkId: string,
    revokedAt: number
  ): Promise<void> {
    if (!this.env.DB) {
      return getInMemoryPersistence().revokeProjectShareLink(
        ownerUserId,
        projectId,
        shareLinkId,
        revokedAt
      );
    }
    await this.requireProjectOwner(ownerUserId, projectId);
    const result = await this.env.DB.prepare(
      `UPDATE project_share_links SET revoked_at = ?
       WHERE id = ? AND project_id = ? AND revoked_at IS NULL`
    )
      .bind(revokedAt, shareLinkId, projectId)
      .run();
    if (result.meta?.changes !== 1) {
      throw new ProjectSharingError(
        'SHARE_LINK_NOT_FOUND',
        'Project share link not found.'
      );
    }
    await this.env.DB.prepare(
      `INSERT INTO project_access_events
         (project_id, actor_user_id, share_link_id, event_type, created_at)
       VALUES (?, ?, ?, 'share-link-revoked', ?)`
    )
      .bind(projectId, ownerUserId, shareLinkId, revokedAt)
      .run();
  }

  async loadSharedProjectByTokenHash(
    tokenHash: string
  ): Promise<SharedProjectSnapshot | null> {
    if (!this.env.DB) {
      return getInMemoryPersistence().loadSharedProjectByTokenHash(tokenHash);
    }
    // The token hash is the entire authorization: no user access check runs
    // here on purpose, and unknown stays indistinguishable from revoked.
    const row = await this.env.DB.prepare(
      `SELECT l.mode, p.id AS project_id, p.name, p.document_json,
              p.document_object_id
       FROM project_share_links l
       INNER JOIN projects p ON p.id = l.project_id
       WHERE l.token_hash = ? AND l.revoked_at IS NULL`
    )
      .bind(tokenHash)
      .first<{
        mode: ProjectShareLinkMode;
        project_id: string;
        name: string;
        document_json: string;
        document_object_id: string | null;
      }>();
    if (!row) {
      return null;
    }
    const document = row.document_object_id
      ? await this.loadProjectObject(row.project_id, row.document_object_id)
      : normalizeDocument(JSON.parse(row.document_json) as ProjectDocument);
    return {
      projectId: row.project_id,
      name: row.name,
      mode: row.mode,
      document: withoutDerivedProjection(document)
    };
  }

  async loadSharedProjectAsset(
    tokenHash: string,
    assetId: string
  ): Promise<SharedProjectAssetDownload | null> {
    if (!this.env.DB) {
      return getInMemoryPersistence().loadSharedProjectAsset(
        tokenHash,
        assetId
      );
    }
    // The join is the authorization: the asset is served only when it belongs
    // to the unrevoked link's own project.
    const row = await this.env.DB.prepare(
      `SELECT a.id, a.project_id, a.kind, a.object_key, a.checksum_sha256,
              a.logical_bytes, a.content_encoding
       FROM project_storage_assets a
       INNER JOIN project_share_links l ON l.project_id = a.project_id
       WHERE l.token_hash = ? AND l.revoked_at IS NULL AND a.id = ?`
    )
      .bind(tokenHash, assetId)
      .first<SharedProjectAssetRow>();
    if (!row) {
      return null;
    }
    if (row.content_encoding !== 'gzip') {
      throw new ProjectObjectStorageError(
        'Project asset metadata is missing or invalid.'
      );
    }
    const bucket = this.projectStorageBucket();
    if (!bucket) {
      throw new ProjectObjectStorageError(
        'Project object storage is not configured.'
      );
    }
    const stored = await bucket.get(row.object_key);
    if (!stored) {
      throw new ProjectObjectStorageError(
        `Project asset ${row.object_key} is missing from storage.`
      );
    }
    const body = await decodeProjectStorageBody(
      await stored.arrayBuffer(),
      'gzip'
    );
    if (
      body.byteLength !== row.logical_bytes ||
      (await sha256Hex(body)) !== row.checksum_sha256
    ) {
      throw new ProjectObjectStorageError(
        'Project asset failed its integrity check.'
      );
    }
    return {
      assetId: row.id,
      projectId: row.project_id,
      kind: row.kind,
      contentType:
        row.kind === 'step-source' ? 'application/step' : 'application/json',
      body: Uint8Array.from(body).buffer
    };
  }

  async listProjects(userId: UserId): Promise<ListProjectsResponse> {
    if (!this.env.DB) {
      return getInMemoryPersistence().listProjects(userId);
    }
    const statement = isCloudflareFeatureEnabled(
      this.env,
      'PROJECT_SHARING_ENABLED'
    )
      ? this.env.DB.prepare(
          `SELECT p.id, p.name, p.updated_at, p.document_json,
                  p.document_version, p.last_revision_id, p.revision_count,
                  p.status, p.pinned, p.sort_order, p.deleted_at, p.archived_at,
                  (SELECT a.id FROM artifacts a
                    WHERE a.project_id = p.id AND a.kind = 'thumbnail'
                    ORDER BY a.created_at DESC LIMIT 1) AS thumbnail_artifact_id
           FROM projects p
           LEFT JOIN project_members pm
             ON pm.project_id = p.id
            AND pm.user_id = ?
            AND pm.role IN ('editor', 'viewer')
           LEFT JOIN user_settings owner_settings
             ON owner_settings.user_id = p.user_id
           WHERE p.user_id = ? OR (
             pm.user_id IS NOT NULL
             AND COALESCE(
               CASE WHEN json_valid(owner_settings.settings_json)
                 THEN json_extract(
                   owner_settings.settings_json,
                   '$.collaboration.enabled'
                 )
               END,
               1
             ) = 1
           )
           ORDER BY p.pinned DESC, p.sort_order ASC, p.updated_at DESC`
        ).bind(userId, userId)
      : this.env.DB.prepare(
          `SELECT p.id, p.name, p.updated_at, p.document_json,
                  p.document_version, p.last_revision_id, p.revision_count,
                  p.status, p.pinned, p.sort_order, p.deleted_at, p.archived_at,
                  (SELECT a.id FROM artifacts a
                    WHERE a.project_id = p.id AND a.kind = 'thumbnail'
                    ORDER BY a.created_at DESC LIMIT 1) AS thumbnail_artifact_id
           FROM projects p
           WHERE p.user_id = ?
           ORDER BY p.pinned DESC, p.sort_order ASC, p.updated_at DESC`
        ).bind(userId);
    const rows = await statement.all<ProjectRow>();

    return {
      projects: (rows.results ?? []).flatMap((row: ProjectRow) => {
        const summary = summaryFromRow(row);
        if (!summary) {
          console.error('Skipping corrupt project row.');
        }
        return summary ? [summary] : [];
      })
    };
  }

  async createProject(
    userId: UserId,
    request: CreateProjectRequest
  ): Promise<CreateProjectResponse> {
    if (!this.env.DB) {
      return getInMemoryPersistence().createProject(userId, request);
    }
    const document = request.document
      ? await this.prepareAdoption(userId, request.document, request.name)
      : createProjectDocument(request.name, userId, request.units);
    return {
      project: await this.insertProject(userId, document),
      document
    };
  }

  /**
   * Validates a device-local document on its way into the account. The id check
   * is a pre-flight rather than the guard: the primary key would refuse a
   * duplicate anyway, but a bare constraint violation cannot tell the device
   * whether it should sync this project or upload it as a new one.
   */
  private async prepareAdoption(
    userId: UserId,
    source: ProjectDocument,
    name: string
  ): Promise<ProjectDocument> {
    const existing = await this.env
      .DB!.prepare(`SELECT user_id FROM projects WHERE id = ?`)
      .bind(source.projectId)
      .first<{ user_id: string }>();
    if (existing) {
      throw existing.user_id === userId
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
    this.assertDocumentCanBeStored(document);
    return document;
  }

  async duplicateProject(
    userId: UserId,
    request: DuplicateProjectRequest
  ): Promise<CreateProjectResponse> {
    if (!this.env.DB) {
      return getInMemoryPersistence().duplicateProject(userId, request);
    }
    const source = await this.loadProject(userId, request.projectId);
    if (!source) {
      throw new ProjectNotFoundError(request.projectId);
    }
    const name = request.name ?? (await this.copyNameFor(userId, source.name));
    const document = duplicateProjectDocument(source, name, userId);
    // A copy lands next to its original rather than at the top of the shelf,
    // which is where you go looking for it. It starts unpinned and active: the
    // point of a duplicate is to diverge from the original, not to inherit its
    // place on the desk.
    const sortOrder = await this.env.DB.prepare(
      `SELECT sort_order FROM projects WHERE id = ? AND user_id = ?`
    )
      .bind(request.projectId, userId)
      .first<{ sort_order: number }>();
    return {
      project: await this.insertProject(userId, document, {
        status: 'active',
        pinned: false,
        sortOrder: sortOrder?.sort_order ?? 0
      }),
      document
    };
  }

  async updateProject(
    userId: UserId,
    request: UpdateProjectRequest
  ): Promise<ProjectSummary> {
    if (!this.env.DB) {
      return getInMemoryPersistence().updateProject(userId, request);
    }
    const row = await this.env.DB.prepare(
      `${PROJECT_SUMMARY_COLUMNS} FROM projects WHERE id = ? AND user_id = ?`
    )
      .bind(request.projectId, userId)
      .first<ProjectRow>();
    const current = row ? summaryFromRow(row) : null;
    if (!current) {
      throw new ProjectNotFoundError(request.projectId);
    }
    const organization = applyOrganizationUpdate(
      projectOrganization(current),
      request
    );
    await this.env.DB.prepare(
      `UPDATE projects SET status = ?, pinned = ?, sort_order = ?, deleted_at = ?, archived_at = ? WHERE id = ? AND user_id = ?`
    )
      .bind(
        organization.status,
        organization.pinned ? 1 : 0,
        organization.sortOrder,
        organization.deletedAt ?? null,
        organization.archivedAt ?? null,
        request.projectId,
        userId
      )
      .run();
    return { ...current, organization };
  }

  async reorderProjects(
    userId: UserId,
    request: ReorderProjectsRequest
  ): Promise<ListProjectsResponse> {
    if (!this.env.DB) {
      return getInMemoryPersistence().reorderProjects(userId, request);
    }
    if (request.projectIds.length > 0) {
      await this.env.DB.batch(
        request.projectIds.map((projectId, index) =>
          this.env
            .DB!.prepare(
              `UPDATE projects SET sort_order = ? WHERE id = ? AND user_id = ?`
            )
            .bind(index, projectId, userId)
        )
      );
    }
    return this.listProjects(userId);
  }

  async deleteProject(userId: UserId, projectId: string): Promise<void> {
    if (!this.env.DB) {
      return getInMemoryPersistence().deleteProject(userId, projectId);
    }
    await this.assertProjectOwner(userId, projectId);
    await this.destroyProjects([projectId]);
  }

  async deleteOwnedProjects(userId: UserId): Promise<ProjectId[]> {
    if (!this.env.DB) {
      return getInMemoryPersistence().deleteOwnedProjects(userId);
    }
    const rows = await this.env.DB.prepare(
      `SELECT id FROM projects WHERE user_id = ? ORDER BY id`
    )
      .bind(userId)
      .all<{ id: string }>();
    const projectIds = (rows.results ?? []).map((row) => row.id);
    // Keep statement sizes, bound parameters, and object-deletion fanout small.
    for (let start = 0; start < projectIds.length; start += 50) {
      await this.destroyProjects(projectIds.slice(start, start + 50));
    }
    return projectIds.map(toProjectId);
  }

  async purgeExpiredProjects(userId: UserId): Promise<ProjectId[]> {
    if (!this.env.DB) {
      return getInMemoryPersistence().purgeExpiredProjects(userId);
    }
    const cutoff = new Date(Date.now() - TRASH_RETENTION_MS).toISOString();
    const expired = await this.env.DB.prepare(
      `SELECT id FROM projects WHERE user_id = ? AND status = 'deleted' AND deleted_at IS NOT NULL AND deleted_at <= ? LIMIT 100`
    )
      .bind(userId, cutoff)
      .all<{ id: string }>();
    const projectIds = (expired.results ?? []).map((row) => row.id);
    await this.destroyProjects(projectIds);
    return projectIds.map(toProjectId);
  }

  async loadProject(
    userId: UserId,
    projectId: string
  ): Promise<ProjectDocument | null> {
    if (!this.env.DB) {
      return getInMemoryPersistence().loadProject(userId, projectId);
    }
    try {
      await this.requireProjectRead(userId, projectId);
    } catch (error) {
      if (error instanceof ProjectNotFoundError) {
        return null;
      }
      throw error;
    }
    const row = await this.env.DB.prepare(
      `SELECT document_json, document_object_id FROM projects WHERE id = ?`
    )
      .bind(projectId)
      .first<{ document_json: string; document_object_id: string | null }>();
    if (!row) {
      return null;
    }
    return row.document_object_id
      ? this.loadProjectObject(projectId, row.document_object_id)
      : normalizeDocument(JSON.parse(row.document_json) as ProjectDocument);
  }

  async saveRevision(
    userId: UserId,
    request: SaveRevisionRequest
  ): Promise<ProjectDocument> {
    if (!this.env.DB) {
      return getInMemoryPersistence().saveRevision(userId, request);
    }
    const access = await this.requireRestProjectWrite(
      userId,
      request.projectId
    );
    const normalized = withoutDerivedProjection(
      normalizeDocument(request.document)
    );
    if (
      normalized.projectId !== request.projectId ||
      normalized.ownerUserId !== access.ownerUserId
    ) {
      throw new ProjectNotFoundError(request.projectId);
    }
    const document = createCheckpoint(normalized, request.reason);
    this.assertDocumentCanBeStored(document);
    const documentJson = JSON.stringify(document);
    const documentBytes = persistedDocumentBytes(document);
    const latestRevision = document.revisions.at(-1);
    if (!latestRevision) {
      throw new Error('Checkpoint creation did not produce a revision.');
    }
    if (this.projectStorageBucket()) {
      await this.assertProjectVersion(
        request.projectId,
        access.ownerUserId,
        request.expectedVersion
      );
      const write = await this.putProjectStorageObjects(document);
      const updatedAt = nowIso();
      const envelope = projectObjectEnvelope(document, write.objectId);
      const assetStatements = this.projectAssetStatements(
        request.projectId,
        write
      );
      const statements = [
        this.documentObjectInsert(request.projectId, write, 'pending'),
        this.env.DB.prepare(
          `UPDATE projects
           SET document_json = ?, document_object_id = ?, document_version = ?,
               document_bytes = ?, updated_at = ?, name = ?,
               last_revision_id = ?, revision_count = ?
           WHERE id = ? AND user_id = ? AND document_version = ?`
        ).bind(
          envelope,
          write.objectId,
          document.version,
          documentBytes,
          updatedAt,
          document.name,
          latestRevision.revisionId,
          document.revisions.length,
          request.projectId,
          access.ownerUserId,
          request.expectedVersion
        ),
        this.env.DB.prepare(
          `UPDATE project_document_objects
           SET state = 'committed'
           WHERE id = ? AND EXISTS (
             SELECT 1 FROM projects
             WHERE id = ? AND document_object_id = ?
           )`
        ).bind(write.objectId, request.projectId, write.objectId),
        this.env.DB.prepare(
          `INSERT OR REPLACE INTO revisions
             (id, project_id, reason, document_json, document_object_id,
              document_bytes, created_at, author_user_id)
           SELECT ?, ?, ?, ?, ?, ?, ?, ?
           WHERE EXISTS (
             SELECT 1 FROM projects
             WHERE id = ? AND document_object_id = ?
           )`
        ).bind(
          latestRevision.revisionId,
          request.projectId,
          request.reason,
          envelope,
          write.objectId,
          documentBytes,
          latestRevision.createdAt,
          userId,
          request.projectId,
          write.objectId
        ),
        ...assetStatements
      ];
      let results: Array<{ meta?: { changes?: number } }> | null = null;
      try {
        results = await this.env.DB.batch(statements);
      } catch (error) {
        const resolution = await this.reconcileProjectStorageWrite(
          request.projectId,
          access.ownerUserId,
          write
        );
        if (resolution.state !== 'committed') {
          if (resolution.state === 'unknown') {
            throw new ProjectObjectStorageError(
              'Cloud project save outcome could not be verified.'
            );
          }
          if (resolution.state === 'superseded') {
            if (resolution.currentVersion === null) {
              throw new ProjectNotFoundError(request.projectId);
            }
            throw new RevisionConflictError(
              request.projectId,
              resolution.currentVersion
            );
          }
          throw error;
        }
      }
      const projectUpdate = results?.[1];
      if (results && projectUpdate?.meta?.changes !== 1) {
        const resolution = await this.reconcileProjectStorageWrite(
          request.projectId,
          access.ownerUserId,
          write
        );
        if (resolution.state === 'committed') {
          await this.pruneRevisions(request.projectId);
          await this.pruneUnreferencedProjectObjects(request.projectId);
          return document;
        }
        if (resolution.state === 'unknown') {
          throw new ProjectObjectStorageError(
            'Cloud project save outcome could not be verified.'
          );
        }
        if (resolution.currentVersion === null) {
          throw new ProjectNotFoundError(request.projectId);
        }
        throw new RevisionConflictError(
          request.projectId,
          resolution.currentVersion
        );
      }
      await this.pruneRevisions(request.projectId);
      await this.pruneUnreferencedProjectObjects(request.projectId);
      return document;
    }
    const results = await this.env.DB.batch([
      this.env.DB.prepare(
        `UPDATE projects SET document_json = ?, document_version = ?, document_bytes = ?, updated_at = ?, name = ? WHERE id = ? AND user_id = ? AND document_version = ?`
      ).bind(
        documentJson,
        document.version,
        documentBytes,
        nowIso(),
        document.name,
        request.projectId,
        access.ownerUserId,
        request.expectedVersion
      ),
      this.env.DB.prepare(
        `INSERT OR REPLACE INTO revisions (id, project_id, reason, document_json, document_bytes, created_at, author_user_id) SELECT ?, ?, ?, ?, ?, ?, ? WHERE changes() > 0`
      ).bind(
        latestRevision.revisionId,
        request.projectId,
        request.reason,
        documentJson,
        documentBytes,
        latestRevision.createdAt,
        userId
      )
    ]);
    if (results[0]?.meta?.changes === 0) {
      const current = await this.env.DB.prepare(
        `SELECT document_version FROM projects WHERE id = ? AND user_id = ?`
      )
        .bind(request.projectId, access.ownerUserId)
        .first<{ document_version: number }>();
      if (!current) {
        throw new ProjectNotFoundError(request.projectId);
      }
      throw new RevisionConflictError(
        request.projectId,
        current.document_version
      );
    }
    await this.pruneRevisions(request.projectId);
    return document;
  }

  /**
   * Drops a project's oldest revisions once it holds more than
   * {@link MAX_PROJECT_REVISIONS}.
   *
   * Runs after the insert rather than before, so the save that would exceed the
   * limit is never the one refused — history is a convenience and must never
   * cost somebody a save. A failure here is swallowed for the same reason: the
   * document is already stored, and the next save prunes again.
   */
  private async pruneRevisions(projectId: string): Promise<void> {
    try {
      await this.env
        .DB!.prepare(
          `DELETE FROM revisions WHERE project_id = ? AND (
             id IS NULL OR id NOT IN (
             SELECT id FROM revisions WHERE project_id = ? AND id IS NOT NULL
             ORDER BY created_at DESC, id DESC LIMIT ?
           ))`
        )
        .bind(projectId, projectId, MAX_PROJECT_REVISIONS)
        .run();
    } catch {
      // Retention is housekeeping. It does not get to fail a save.
    }
  }

  /**
   * Finalized artifact usage attributed to the account owning the projects —
   * the owner bears the R2 storage regardless of which editor uploaded.
   * Legacy rows with NULL bytes predate accounting and count as zero.
   */
  private async accountArtifactUsage(
    ownerUserId: UserId
  ): Promise<{ bytes: number; count: number }> {
    const row = await this.env
      .DB!.prepare(
        `SELECT COALESCE(SUM(a.bytes), 0) AS total, COUNT(*) AS count
         FROM artifacts a
         JOIN projects p ON p.id = a.project_id
         WHERE p.user_id = ?`
      )
      .bind(ownerUserId)
      .first<{ total: number; count: number }>();
    return { bytes: row?.total ?? 0, count: row?.count ?? 0 };
  }

  private async assertArtifactQuota(
    ownerUserId: UserId,
    incomingBytes: number
  ): Promise<void> {
    const { bytes } = await this.accountArtifactUsage(ownerUserId);
    if (bytes + incomingBytes > MAX_ACCOUNT_ARTIFACT_BYTES) {
      throw new ArtifactQuotaError(MAX_ACCOUNT_ARTIFACT_BYTES);
    }
  }

  async getStorageUsage(userId: UserId): Promise<AccountStorageUsage> {
    if (!this.env.DB) {
      return getInMemoryPersistence().getStorageUsage(userId);
    }
    const totals = await this.env.DB.prepare(
      `SELECT COUNT(*) AS project_count, COALESCE(SUM(document_bytes), 0) AS document_bytes
       FROM projects WHERE user_id = ?`
    )
      .bind(userId)
      .first<{ project_count: number; document_bytes: number }>();
    const revisions = await this.env.DB.prepare(
      `SELECT COUNT(*) AS revision_count, COALESCE(SUM(revisions.document_bytes), 0) AS revision_bytes
       FROM revisions
       JOIN projects ON projects.id = revisions.project_id
       WHERE projects.user_id = ?`
    )
      .bind(userId)
      .first<{ revision_count: number; revision_bytes: number }>();
    const artifacts = await this.accountArtifactUsage(userId);
    return {
      projectCount: totals?.project_count ?? 0,
      documentBytes: totals?.document_bytes ?? 0,
      revisionBytes: revisions?.revision_bytes ?? 0,
      revisionCount: revisions?.revision_count ?? 0,
      documentLimitBytes: this.projectStorageBucket()
        ? MAX_CLOUD_PROJECT_DOCUMENT_BYTES
        : MAX_PERSISTED_DOCUMENT_BYTES,
      maxRevisionsPerProject: MAX_PROJECT_REVISIONS,
      artifactBytes: artifacts.bytes,
      artifactCount: artifacts.count,
      artifactLimitBytes: MAX_ACCOUNT_ARTIFACT_BYTES
    };
  }

  /**
   * The continuous-sync write: the same fenced update as `saveRevision`,
   * without the `revisions` insert. Splitting them is what makes autosave
   * affordable — a revision row is a whole extra copy of the document, and
   * writing one per autosave would make stored bytes a function of how fast
   * somebody types rather than of how much work they did.
   */
  async saveDocument(
    userId: UserId,
    request: SaveProjectDocumentRequest
  ): Promise<SaveProjectDocumentResponse> {
    if (!this.env.DB) {
      return getInMemoryPersistence().saveDocument(userId, request);
    }
    const access = await this.requireRestProjectWrite(
      userId,
      request.projectId
    );
    const normalized = withoutDerivedProjection(
      normalizeDocument(request.document)
    );
    if (
      normalized.projectId !== request.projectId ||
      normalized.ownerUserId !== access.ownerUserId
    ) {
      throw new ProjectNotFoundError(request.projectId);
    }
    this.assertDocumentCanBeStored(normalized);
    const updatedAt = nowIso();
    if (this.projectStorageBucket()) {
      await this.assertProjectVersion(
        request.projectId,
        access.ownerUserId,
        request.expectedVersion
      );
      const write = await this.putProjectStorageObjects(normalized);
      const envelope = projectObjectEnvelope(normalized, write.objectId);
      const assetStatements = this.projectAssetStatements(
        request.projectId,
        write
      );
      const statements = [
        this.documentObjectInsert(request.projectId, write, 'pending'),
        this.env.DB.prepare(
          `UPDATE projects
           SET document_json = ?, document_object_id = ?, document_version = ?,
               document_bytes = ?, updated_at = ?, name = ?,
               last_revision_id = ?, revision_count = ?
           WHERE id = ? AND user_id = ? AND document_version = ?`
        ).bind(
          envelope,
          write.objectId,
          normalized.version,
          persistedDocumentBytes(normalized),
          updatedAt,
          normalized.name,
          normalized.revisions.at(-1)?.revisionId ?? null,
          normalized.revisions.length,
          request.projectId,
          access.ownerUserId,
          request.expectedVersion
        ),
        this.env.DB.prepare(
          `UPDATE project_document_objects
           SET state = 'committed'
           WHERE id = ? AND EXISTS (
             SELECT 1 FROM projects
             WHERE id = ? AND document_object_id = ?
           )`
        ).bind(write.objectId, request.projectId, write.objectId),
        ...assetStatements
      ];
      let results: Array<{ meta?: { changes?: number } }> | null = null;
      try {
        results = await this.env.DB.batch(statements);
      } catch (error) {
        const resolution = await this.reconcileProjectStorageWrite(
          request.projectId,
          access.ownerUserId,
          write
        );
        if (resolution.state !== 'committed') {
          if (resolution.state === 'unknown') {
            throw new ProjectObjectStorageError(
              'Cloud project save outcome could not be verified.'
            );
          }
          if (resolution.state === 'superseded') {
            if (resolution.currentVersion === null) {
              throw new ProjectNotFoundError(request.projectId);
            }
            throw new RevisionConflictError(
              request.projectId,
              resolution.currentVersion
            );
          }
          throw error;
        }
      }
      const projectUpdate = results?.[1];
      if (results && projectUpdate?.meta?.changes !== 1) {
        const resolution = await this.reconcileProjectStorageWrite(
          request.projectId,
          access.ownerUserId,
          write
        );
        if (resolution.state === 'committed') {
          await this.pruneUnreferencedProjectObjects(request.projectId);
          return {
            projectId: request.projectId,
            version: normalized.version,
            updatedAt
          };
        }
        if (resolution.state === 'unknown') {
          throw new ProjectObjectStorageError(
            'Cloud project save outcome could not be verified.'
          );
        }
        if (resolution.currentVersion === null) {
          throw new ProjectNotFoundError(request.projectId);
        }
        throw new RevisionConflictError(
          request.projectId,
          resolution.currentVersion
        );
      }
      await this.pruneUnreferencedProjectObjects(request.projectId);
      return {
        projectId: request.projectId,
        version: normalized.version,
        updatedAt
      };
    }
    const result = await this.env.DB.prepare(
      `UPDATE projects SET document_json = ?, document_version = ?, document_bytes = ?, updated_at = ?, name = ? WHERE id = ? AND user_id = ? AND document_version = ?`
    )
      .bind(
        JSON.stringify(normalized),
        normalized.version,
        persistedDocumentBytes(normalized),
        updatedAt,
        normalized.name,
        request.projectId,
        access.ownerUserId,
        request.expectedVersion
      )
      .run();
    if (result.meta?.changes === 0) {
      const current = await this.env.DB.prepare(
        `SELECT document_version FROM projects WHERE id = ? AND user_id = ?`
      )
        .bind(request.projectId, access.ownerUserId)
        .first<{ document_version: number }>();
      if (!current) {
        throw new ProjectNotFoundError(request.projectId);
      }
      throw new RevisionConflictError(
        request.projectId,
        current.document_version
      );
    }
    return {
      projectId: request.projectId,
      version: normalized.version,
      updatedAt
    };
  }

  async createUploadSession(
    userId: UserId,
    request: CreateUploadSessionRequest
  ): Promise<CreateUploadSessionResponse> {
    if (!this.env.DB) {
      return getInMemoryPersistence().createUploadSession(userId, request);
    }
    const access = await this.requireProjectEdit(userId, request.projectId);
    if (!this.env.ARTIFACTS) {
      throw new ArtifactStorageError();
    }
    await this.assertArtifactQuota(access.ownerUserId, 1);
    await this.purgeExpiredUploadSessions();
    const session = createUploadSessionRecord(request);
    await this.env.DB.prepare(
      `INSERT INTO upload_sessions (id, artifact_id, project_id, object_key, file_name, content_type, kind, metadata_json, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(
        session.uploadSessionId,
        session.artifactId,
        request.projectId,
        session.objectKey,
        session.fileName,
        session.contentType,
        session.kind,
        JSON.stringify(session.metadata),
        session.expiresAt
      )
      .run();
    return { session };
  }

  async putUpload(
    userId: UserId,
    uploadSessionId: string,
    body: ArrayBuffer
  ): Promise<void> {
    if (!this.env.DB) {
      return getInMemoryPersistence().putUpload(userId, uploadSessionId, body);
    }
    const upload = await this.env.DB.prepare(
      `SELECT project_id, object_key, content_type, expires_at FROM upload_sessions WHERE id = ?`
    )
      .bind(uploadSessionId)
      .first<{
        project_id: string;
        object_key: string;
        content_type: string;
        expires_at: string;
      }>();
    if (!upload) {
      throw new ArtifactStorageError(
        'Upload session was not found or expired.'
      );
    }
    const access = await this.requireProjectEdit(userId, upload.project_id);
    if (Date.parse(upload.expires_at) < Date.now()) {
      throw new ArtifactStorageError(
        'Upload session was not found or expired.'
      );
    }
    await this.assertArtifactQuota(access.ownerUserId, body.byteLength);
    if (!this.env.ARTIFACTS) {
      throw new ArtifactStorageError();
    }
    await this.env.ARTIFACTS.put(upload.object_key, body, {
      httpMetadata: { contentType: upload.content_type }
    });
  }

  /**
   * Loads and authorizes an upload session for a chunked-upload call. Every
   * part call re-validates: sessions expire mid-upload, and project access
   * can be revoked between parts.
   */
  private async requireUploadSession(
    userId: UserId,
    uploadSessionId: string
  ): Promise<{
    objectKey: string;
    contentType: string;
    kind: ArtifactRecord['kind'];
    metadata: Record<string, unknown>;
    metadataJson: string;
    ownerUserId: UserId;
  }> {
    const upload = await this.env
      .DB!.prepare(
        `SELECT project_id, object_key, content_type, kind, metadata_json, expires_at FROM upload_sessions WHERE id = ?`
      )
      .bind(uploadSessionId)
      .first<{
        project_id: string;
        object_key: string;
        content_type: string;
        kind: ArtifactRecord['kind'];
        metadata_json: string;
        expires_at: string;
      }>();
    if (!upload || Date.parse(upload.expires_at) < Date.now()) {
      throw new ArtifactStorageError(
        'Upload session was not found or expired.'
      );
    }
    const access = await this.requireProjectEdit(userId, upload.project_id);
    if (!this.env.ARTIFACTS) {
      throw new ArtifactStorageError();
    }
    return {
      objectKey: upload.object_key,
      contentType: upload.content_type,
      kind: upload.kind,
      metadata: JSON.parse(upload.metadata_json) as Record<string, unknown>,
      metadataJson: upload.metadata_json,
      ownerUserId: access.ownerUserId
    };
  }

  async createMultipartUpload(
    userId: UserId,
    uploadSessionId: string
  ): Promise<CreateMultipartUploadResponse> {
    if (!this.env.DB) {
      return getInMemoryPersistence().createMultipartUpload(
        userId,
        uploadSessionId
      );
    }
    const session = await this.requireUploadSession(userId, uploadSessionId);
    if (session.kind === 'thumbnail') {
      throw new ArtifactStorageError(
        'Thumbnail artifacts must use single uploads.'
      );
    }
    const activeUploadId = session.metadata[MULTIPART_UPLOAD_METADATA_KEY];
    if (typeof activeUploadId === 'string') {
      return { uploadId: activeUploadId };
    }
    const upload = await this.env.ARTIFACTS!.createMultipartUpload(
      session.objectKey,
      { httpMetadata: { contentType: session.contentType } }
    );
    // Recorded so purgeExpiredUploadSessions can abort an abandoned upload;
    // R2 keeps incomplete multipart state until an explicit abort.
    let changes: number | undefined;
    try {
      const result = await this.env.DB.prepare(
        `UPDATE upload_sessions SET metadata_json = ? WHERE id = ? AND metadata_json = ?`
      )
        .bind(
          JSON.stringify({
            ...session.metadata,
            [MULTIPART_UPLOAD_METADATA_KEY]: upload.uploadId
          }),
          uploadSessionId,
          session.metadataJson
        )
        .run();
      changes = result.meta?.changes;
    } catch (error) {
      await upload.abort().catch(() => undefined);
      throw error;
    }
    if (changes === 0) {
      await upload.abort().catch(() => undefined);
      const current = await this.requireUploadSession(userId, uploadSessionId);
      const winner = current.metadata[MULTIPART_UPLOAD_METADATA_KEY];
      if (typeof winner === 'string') {
        return { uploadId: winner };
      }
      throw new ArtifactStorageError('Multipart upload could not be created.');
    }
    return { uploadId: upload.uploadId };
  }

  async putUploadPart(
    userId: UserId,
    uploadSessionId: string,
    uploadId: string,
    partNumber: number,
    body: ArrayBuffer
  ): Promise<UploadedArtifactPart> {
    if (!this.env.DB) {
      return getInMemoryPersistence().putUploadPart(
        userId,
        uploadSessionId,
        uploadId,
        partNumber,
        body
      );
    }
    const session = await this.requireUploadSession(userId, uploadSessionId);
    if (session.metadata[MULTIPART_UPLOAD_METADATA_KEY] !== uploadId) {
      throw new ArtifactStorageError('Multipart upload was not found.');
    }
    if (
      !Number.isInteger(partNumber) ||
      partNumber < 1 ||
      partNumber > MAX_ARTIFACT_UPLOAD_PARTS
    ) {
      throw new ArtifactStorageError('Upload part number is out of range.');
    }
    // Approximate: earlier parts of this session are not summed (that would
    // need per-session accounting); the authoritative check runs against the
    // assembled object size at finalize, which also deletes the overage.
    await this.assertArtifactQuota(session.ownerUserId, body.byteLength);
    const upload = this.env.ARTIFACTS!.resumeMultipartUpload(
      session.objectKey,
      uploadId
    );
    const part = await upload.uploadPart(partNumber, body);
    return { partNumber: part.partNumber, etag: part.etag };
  }

  async completeMultipartUpload(
    userId: UserId,
    uploadSessionId: string,
    request: CompleteMultipartUploadRequest
  ): Promise<void> {
    if (!this.env.DB) {
      return getInMemoryPersistence().completeMultipartUpload(
        userId,
        uploadSessionId,
        request
      );
    }
    const session = await this.requireUploadSession(userId, uploadSessionId);
    if (session.metadata[MULTIPART_UPLOAD_METADATA_KEY] !== request.uploadId) {
      throw new ArtifactStorageError('Multipart upload was not found.');
    }
    const upload = this.env.ARTIFACTS!.resumeMultipartUpload(
      session.objectKey,
      request.uploadId
    );
    await upload.complete(
      [...request.parts].sort((a, b) => a.partNumber - b.partNumber)
    );
    // The upload is now a plain object; drop the abort marker so purge
    // treats the session like a completed single PUT.
    const { [MULTIPART_UPLOAD_METADATA_KEY]: _done, ...metadata } =
      session.metadata;
    await this.env.DB.prepare(
      `UPDATE upload_sessions SET metadata_json = ? WHERE id = ?`
    )
      .bind(JSON.stringify(metadata), uploadSessionId)
      .run();
  }

  async abortMultipartUpload(
    userId: UserId,
    uploadSessionId: string,
    uploadId: string
  ): Promise<void> {
    if (!this.env.DB) {
      return getInMemoryPersistence().abortMultipartUpload(
        userId,
        uploadSessionId,
        uploadId
      );
    }
    const session = await this.requireUploadSession(userId, uploadSessionId);
    if (session.metadata[MULTIPART_UPLOAD_METADATA_KEY] !== uploadId) {
      // Unknown or already completed/aborted: nothing to clean up.
      return;
    }
    await this.env
      .ARTIFACTS!.resumeMultipartUpload(session.objectKey, uploadId)
      .abort()
      .catch(() => undefined);
    const { [MULTIPART_UPLOAD_METADATA_KEY]: _gone, ...metadata } =
      session.metadata;
    await this.env.DB.prepare(
      `UPDATE upload_sessions SET metadata_json = ? WHERE id = ?`
    )
      .bind(JSON.stringify(metadata), uploadSessionId)
      .run();
  }

  async finalizeArtifact(
    userId: UserId,
    request: FinalizeArtifactRequest
  ): Promise<ArtifactRecord | null> {
    if (!this.env.DB) {
      return getInMemoryPersistence().finalizeArtifact(userId, request);
    }
    const access = await this.requireProjectEdit(userId, request.projectId);
    const upload = await this.env.DB.prepare(
      `SELECT artifact_id, object_key, project_id, file_name, content_type, kind, metadata_json, expires_at FROM upload_sessions WHERE id = ?`
    )
      .bind(request.uploadSessionId)
      .first<{
        artifact_id: string;
        object_key: string;
        project_id: string;
        file_name: string;
        content_type: string;
        kind: ArtifactRecord['kind'];
        metadata_json: string;
        expires_at: string;
      }>();
    if (
      !upload ||
      upload.project_id !== request.projectId ||
      upload.artifact_id !== request.artifactId ||
      Date.parse(upload.expires_at) < Date.now()
    ) {
      return null;
    }
    if (!this.env.ARTIFACTS) {
      throw new ArtifactStorageError();
    }
    const stored = await this.env.ARTIFACTS.head(upload.object_key);
    if (!stored) {
      return null;
    }
    const usage = await this.accountArtifactUsage(access.ownerUserId);
    if (usage.bytes + stored.size > MAX_ACCOUNT_ARTIFACT_BYTES) {
      // The assembled object must not linger as unaccounted storage.
      await this.env.ARTIFACTS.delete(upload.object_key).catch(() => undefined);
      await this.env.DB.prepare(`DELETE FROM upload_sessions WHERE id = ?`)
        .bind(request.uploadSessionId)
        .run();
      throw new ArtifactQuotaError(MAX_ACCOUNT_ARTIFACT_BYTES);
    }

    const artifact: ArtifactRecord = {
      artifactId: request.artifactId,
      projectId: request.projectId,
      kind: upload.kind,
      name: upload.file_name,
      objectKey: upload.object_key,
      contentType: upload.content_type,
      bytes: stored.size,
      createdAt: nowIso(),
      metadata: JSON.parse(upload.metadata_json) as ArtifactRecord['metadata']
    };
    if (
      artifact.kind === 'thumbnail' &&
      (stored.size > MAX_THUMBNAIL_BYTES ||
        artifact.contentType !== THUMBNAIL_CONTENT_TYPE)
    ) {
      throw new ArtifactStorageError(
        'Thumbnail artifact is invalid or too large.'
      );
    }

    const supersededThumbnails =
      artifact.kind === 'thumbnail'
        ? await this.env.DB.prepare(
            `SELECT object_key FROM artifacts WHERE project_id = ? AND kind = 'thumbnail'`
          )
            .bind(artifact.projectId)
            .all<{ object_key: string }>()
        : { results: [] as Array<{ object_key: string }> };

    const statements = [
      this.env.DB.prepare(
        `DELETE FROM upload_sessions WHERE id = ? AND artifact_id = ?`
      ).bind(request.uploadSessionId, request.artifactId),
      ...(artifact.kind === 'thumbnail'
        ? [
            this.env.DB.prepare(
              `DELETE FROM artifacts WHERE project_id = ? AND kind = 'thumbnail'`
            ).bind(artifact.projectId)
          ]
        : []),
      this.env.DB.prepare(
        `INSERT INTO artifacts (id, project_id, kind, name, object_key, content_type, bytes, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(
        artifact.artifactId,
        artifact.projectId,
        artifact.kind,
        artifact.name,
        artifact.objectKey,
        artifact.contentType,
        artifact.bytes,
        JSON.stringify(artifact.metadata),
        artifact.createdAt
      )
    ];
    await this.env.DB.batch(statements);

    if (artifact.kind === 'thumbnail') {
      await Promise.all(
        (supersededThumbnails.results ?? []).map((previous) =>
          this.env.ARTIFACTS!.delete(previous.object_key).catch((error) => {
            console.error(
              'Could not remove a superseded thumbnail object.',
              error
            );
          })
        )
      );
    }

    return artifact;
  }

  async listArtifacts(
    userId: UserId,
    projectId: string
  ): Promise<ListArtifactsResponse> {
    if (!this.env.DB) {
      return getInMemoryPersistence().listArtifacts(userId, projectId);
    }
    await this.requireProjectRead(userId, projectId);
    const rows = await this.env.DB.prepare(
      `SELECT id, project_id, kind, name, object_key, content_type, bytes, metadata_json, created_at FROM artifacts WHERE project_id = ? ORDER BY created_at DESC`
    )
      .bind(projectId)
      .all<ArtifactRow>();
    return { artifacts: (rows.results ?? []).map(artifactFromRow) };
  }

  async getArtifactMetadata(
    userId: UserId,
    artifactId: string
  ): Promise<ArtifactMetadataResponse> {
    if (!this.env.DB) {
      return getInMemoryPersistence().getArtifactMetadata(userId, artifactId);
    }
    const row = await this.env.DB.prepare(
      `SELECT id, project_id, kind, name, object_key, content_type, bytes, metadata_json, created_at FROM artifacts WHERE id = ?`
    )
      .bind(artifactId)
      .first<ArtifactRow>();
    if (!row) {
      return { artifact: null };
    }
    await this.requireProjectRead(userId, row.project_id);
    return { artifact: artifactFromRow(row) };
  }

  async downloadArtifact(
    userId: UserId,
    artifactId: string
  ): Promise<{ artifact: ArtifactRecord; body: ArrayBuffer } | null> {
    if (!this.env.DB) {
      return getInMemoryPersistence().downloadArtifact(userId, artifactId);
    }
    const { artifact } = await this.getArtifactMetadata(userId, artifactId);
    if (!artifact) {
      return null;
    }
    if (!this.env.ARTIFACTS) {
      throw new ArtifactStorageError();
    }
    const stored = await this.env.ARTIFACTS.get(artifact.objectKey);
    return stored ? { artifact, body: await stored.arrayBuffer() } : null;
  }

  /**
   * A dedicated project bucket can be introduced later without a flag day.
   * Until then the existing private artifacts bucket is safely namespaced by
   * PROJECT_OBJECT_STORAGE_PREFIX.
   */
  private projectStorageBucket(): R2Bucket | undefined {
    const bucket = this.env.PROJECT_STORAGE ?? this.env.ARTIFACTS;
    return bucket &&
      typeof bucket.put === 'function' &&
      typeof bucket.get === 'function' &&
      typeof bucket.delete === 'function'
      ? bucket
      : undefined;
  }

  private assertCloudDocumentWithinCeiling(document: ProjectDocument): void {
    const bytes = persistedDocumentBytes(document);
    if (bytes > MAX_CLOUD_PROJECT_DOCUMENT_BYTES) {
      throw new DocumentTooLargeError(bytes, MAX_CLOUD_PROJECT_DOCUMENT_BYTES);
    }
  }

  private assertDocumentCanBeStored(document: ProjectDocument): void {
    if (this.projectStorageBucket()) {
      this.assertCloudDocumentWithinCeiling(document);
    } else {
      assertPersistableDocument(document);
    }
  }

  private async putProjectStorageObjects(
    document: ProjectDocument
  ): Promise<ProjectStorageWrite> {
    const bucket = this.projectStorageBucket();
    if (!bucket) {
      throw new ProjectObjectStorageError(
        'Project object storage is not configured.'
      );
    }
    this.assertCloudDocumentWithinCeiling(document);
    const prepared = await prepareProjectStorageSnapshot(document);
    const createdAt = nowIso();
    const objectId = `project_object_${crypto.randomUUID()}`;
    const objectKey = `${PROJECT_OBJECT_STORAGE_PREFIX}/${document.projectId}/documents/${crypto.randomUUID()}.json.gz`;

    // Content-addressed imports are stable across autosaves. Consult D1 before
    // issuing a new Class A R2 write; the metadata row is also what makes
    // project deletion able to sweep every object deterministically.
    const missingAssets: ProjectStorageAssetObject[] = [];
    for (const asset of prepared.assets) {
      const existing = await this.env
        .DB!.prepare(
          `SELECT stored_bytes FROM project_storage_assets WHERE project_id = ? AND checksum_sha256 = ? AND kind = ?`
        )
        .bind(document.projectId, asset.checksumSha256, asset.kind)
        .first<{ stored_bytes: number }>();
      const stored =
        existing && typeof bucket.head === 'function'
          ? await bucket.head(asset.objectKey)
          : null;
      if (!existing || !stored || stored.size !== existing.stored_bytes) {
        missingAssets.push(asset);
      }
    }

    await Promise.all(
      missingAssets.map((asset) =>
        bucket.put(asset.objectKey, Uint8Array.from(asset.storedBody).buffer, {
          httpMetadata: {
            contentType: asset.contentType
          }
        })
      )
    );
    await bucket.put(objectKey, Uint8Array.from(prepared.storedBody).buffer, {
      httpMetadata: {
        contentType: 'application/json'
      }
    });

    return {
      objectId,
      objectKey,
      createdAt,
      prepared,
      missingAssets
    };
  }

  private projectAssetStatements(
    projectId: string,
    write: ProjectStorageWrite
  ): D1PreparedStatement[] {
    return write.prepared.assets.map((asset) =>
      this.env
        .DB!.prepare(
          `INSERT OR IGNORE INTO project_storage_assets
             (id, project_id, kind, object_key, checksum_sha256, logical_bytes,
              stored_bytes, content_encoding, created_at)
           SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?
           WHERE EXISTS (
             SELECT 1 FROM projects
             WHERE id = ? AND document_object_id = ?
           )`
        )
        .bind(
          `project_asset_${crypto.randomUUID()}`,
          projectId,
          asset.kind,
          asset.objectKey,
          asset.checksumSha256,
          asset.logicalBytes,
          asset.storedBytes,
          asset.contentEncoding,
          write.createdAt,
          projectId,
          write.objectId
        )
    );
  }

  private async assertProjectVersion(
    projectId: string,
    ownerUserId: UserId,
    expectedVersion: number
  ): Promise<void> {
    const current = await this.env
      .DB!.prepare(
        `SELECT document_version FROM projects WHERE id = ? AND user_id = ?`
      )
      .bind(projectId, ownerUserId)
      .first<{ document_version: number }>();
    if (!current) {
      throw new ProjectNotFoundError(projectId);
    }
    if (current.document_version !== expectedVersion) {
      throw new RevisionConflictError(projectId, current.document_version);
    }
  }

  private documentObjectInsert(
    projectId: string,
    write: ProjectStorageWrite,
    state: 'pending' | 'committed'
  ): D1PreparedStatement {
    return this.env
      .DB!.prepare(
        `INSERT INTO project_document_objects
           (id, project_id, object_key, checksum_sha256, logical_bytes,
            stored_bytes, content_encoding, state, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        write.objectId,
        projectId,
        write.objectKey,
        write.prepared.checksumSha256,
        write.prepared.logicalBytes,
        write.prepared.storedBytes,
        write.prepared.contentEncoding,
        state,
        write.createdAt
      );
  }

  private async loadProjectObject(
    projectId: string,
    objectId: string
  ): Promise<ProjectDocument> {
    const bucket = this.projectStorageBucket();
    if (!bucket) {
      throw new ProjectObjectStorageError(
        'Project object storage is not configured.'
      );
    }
    const object = await this.env
      .DB!.prepare(
        `SELECT object_key, checksum_sha256, logical_bytes, content_encoding
         FROM project_document_objects
         WHERE id = ? AND project_id = ? AND state = 'committed'`
      )
      .bind(objectId, projectId)
      .first<ProjectDocumentObjectRow>();
    if (!object || object.content_encoding !== 'gzip') {
      throw new ProjectObjectStorageError(
        'Project document object metadata is missing or invalid.'
      );
    }
    const stored = await bucket.get(object.object_key);
    if (!stored) {
      throw new ProjectObjectStorageError(
        'Project document object is missing from storage.'
      );
    }
    const logicalBody = await decodeProjectStorageBody(
      await stored.arrayBuffer(),
      'gzip'
    );
    if (
      logicalBody.byteLength !== object.logical_bytes ||
      (await sha256Hex(logicalBody)) !== object.checksum_sha256
    ) {
      throw new ProjectObjectStorageError(
        'Project document object failed its integrity check.'
      );
    }
    const snapshot = JSON.parse(
      new TextDecoder().decode(logicalBody)
    ) as ProjectStorageSnapshot;
    const hydrated = await hydrateProjectStorageSnapshot(
      snapshot,
      projectId,
      async (reference: ProjectStorageAssetReference) => {
        const asset = await bucket.get(reference.objectKey);
        if (!asset) {
          throw new ProjectObjectStorageError(
            `Project asset ${reference.objectKey} is missing from storage.`
          );
        }
        return decodeProjectStorageBody(
          await asset.arrayBuffer(),
          reference.contentEncoding
        );
      }
    );
    return normalizeDocument(hydrated);
  }

  /**
   * Resolves a D1 response whose outcome cannot be trusted from the response
   * alone. The database pointer is authoritative: an R2 object is removed only
   * after D1 proves that neither a project nor a revision references it.
   */
  private async reconcileProjectStorageWrite(
    projectId: string,
    ownerUserId: UserId,
    write: ProjectStorageWrite
  ): Promise<ProjectStorageWriteResolution> {
    try {
      const row = await this.env
        .DB!.prepare(
          `SELECT
             (SELECT document_object_id FROM projects
              WHERE id = ? AND user_id = ?) AS current_document_object_id,
             (SELECT document_version FROM projects
              WHERE id = ? AND user_id = ?) AS current_document_version,
             (SELECT state FROM project_document_objects
              WHERE id = ? AND project_id = ?) AS object_state,
             (SELECT COUNT(*) FROM projects
              WHERE document_object_id = ?) AS project_references,
             (SELECT COUNT(*) FROM revisions
              WHERE document_object_id = ?) AS revision_references`
        )
        .bind(
          projectId,
          ownerUserId,
          projectId,
          ownerUserId,
          write.objectId,
          projectId,
          write.objectId,
          write.objectId
        )
        .first<ProjectStorageWriteResolutionRow>();
      if (!row) {
        return { state: 'unknown' };
      }

      if (row.current_document_object_id === write.objectId) {
        if (row.object_state !== 'committed') {
          return { state: 'unknown' };
        }
        try {
          await this.loadProjectObject(projectId, write.objectId);
          return { state: 'committed' };
        } catch {
          return { state: 'unknown' };
        }
      }

      const currentVersion = row.current_document_version ?? null;
      if (row.project_references > 0 || row.revision_references > 0) {
        return { state: 'superseded', currentVersion };
      }

      // Delete metadata first. If that acknowledgement is lost, retain the R2
      // object: an orphan is harmless and can be pruned later; deleting a
      // possibly committed object is irrecoverable.
      await this.env
        .DB!.prepare(
          `DELETE FROM project_document_objects
           WHERE id = ?
             AND NOT EXISTS (
               SELECT 1 FROM projects WHERE document_object_id = ?
             )
             AND NOT EXISTS (
               SELECT 1 FROM revisions WHERE document_object_id = ?
             )`
        )
        .bind(write.objectId, write.objectId, write.objectId)
        .run();

      const bucket = this.projectStorageBucket();
      if (bucket) {
        const orphanedAssetKeys = await Promise.all(
          write.missingAssets.map(async (asset) => {
            const reference = await this.env
              .DB!.prepare(
                `SELECT 1 AS referenced FROM project_storage_assets
                 WHERE project_id = ? AND object_key = ? LIMIT 1`
              )
              .bind(projectId, asset.objectKey)
              .first<{ referenced: number }>();
            return reference ? null : asset.objectKey;
          })
        );
        await Promise.allSettled([
          bucket.delete(write.objectKey),
          ...orphanedAssetKeys.flatMap((key) =>
            key === null ? [] : [bucket.delete(key)]
          )
        ]);
      }
      return { state: 'uncommitted', currentVersion };
    } catch {
      return { state: 'unknown' };
    }
  }

  private async pruneUnreferencedProjectObjects(
    projectId: string
  ): Promise<void> {
    const bucket = this.projectStorageBucket();
    if (!bucket) {
      return;
    }
    try {
      const objects = await this.env
        .DB!.prepare(
          `SELECT id, object_key
           FROM project_document_objects AS object
           WHERE object.project_id = ?
             AND NOT EXISTS (
               SELECT 1 FROM projects WHERE document_object_id = object.id
             )
             AND NOT EXISTS (
               SELECT 1 FROM revisions WHERE document_object_id = object.id
             )`
        )
        .bind(projectId)
        .all<{ id: string; object_key: string }>();
      const rows = objects.results ?? [];
      await Promise.all(rows.map((row) => bucket.delete(row.object_key)));
      if (rows.length > 0) {
        await this.env.DB!.batch(
          rows.map((row) =>
            this.env
              .DB!.prepare(`DELETE FROM project_document_objects WHERE id = ?`)
              .bind(row.id)
          )
        );
      }
    } catch {
      // Object cleanup is retryable housekeeping; the committed save wins.
    }
  }

  /** Writes a freshly built document into `projects` and summarizes the row. */
  private async insertProject(
    userId: UserId,
    document: ProjectDocument,
    organization: ProjectOrganization = DEFAULT_PROJECT_ORGANIZATION
  ): Promise<ProjectSummary> {
    this.assertDocumentCanBeStored(document);
    const updatedAt = nowIso();
    if (this.projectStorageBucket()) {
      const write = await this.putProjectStorageObjects(document);
      const envelope = projectObjectEnvelope(document, write.objectId);
      try {
        await this.env.DB!.batch([
          this.env
            .DB!.prepare(
              `INSERT INTO projects
               (id, user_id, name, document_json, document_object_id,
                document_version, document_bytes, updated_at, status, pinned,
                sort_order, last_revision_id, revision_count)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
            )
            .bind(
              document.projectId,
              userId,
              document.name,
              envelope,
              write.objectId,
              document.version,
              persistedDocumentBytes(document),
              updatedAt,
              organization.status,
              organization.pinned ? 1 : 0,
              organization.sortOrder,
              document.revisions.at(-1)?.revisionId ?? null,
              document.revisions.length
            ),
          this.documentObjectInsert(document.projectId, write, 'committed'),
          ...this.projectAssetStatements(document.projectId, write)
        ]);
      } catch (error) {
        const resolution = await this.reconcileProjectStorageWrite(
          document.projectId,
          userId,
          write
        );
        if (resolution.state !== 'committed') {
          if (resolution.state === 'unknown') {
            throw new ProjectObjectStorageError(
              'Cloud project save outcome could not be verified.'
            );
          }
          throw error;
        }
      }
      return {
        projectId: document.projectId,
        name: document.name,
        lastRevisionId: document.revisions.at(-1)?.revisionId,
        revisionCount: document.revisions.length,
        updatedAt,
        documentVersion: document.version,
        organization
      };
    }
    await this.env
      .DB!.prepare(
        `INSERT INTO projects (id, user_id, name, document_json, document_version, document_bytes, updated_at, status, pinned, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        document.projectId,
        userId,
        document.name,
        JSON.stringify(document),
        document.version,
        persistedDocumentBytes(document),
        updatedAt,
        organization.status,
        organization.pinned ? 1 : 0,
        organization.sortOrder
      )
      .run();
    return {
      projectId: document.projectId,
      name: document.name,
      lastRevisionId: document.revisions.at(-1)?.revisionId,
      revisionCount: document.revisions.length,
      updatedAt,
      organization
    };
  }

  /** A "(copy)" name that no other project of this owner already answers to. */
  private async copyNameFor(userId: UserId, name: string): Promise<string> {
    const rows = await this.env
      .DB!.prepare(`SELECT name FROM projects WHERE user_id = ?`)
      .bind(userId)
      .all<{ name: string }>();
    return duplicateProjectName(
      name,
      (rows.results ?? []).map((row) => row.name)
    );
  }

  /**
   * Irreversibly removes projects and their stored bytes. R2 objects are swept
   * first because deleting their index rows first could strand unreferenced
   * user data. Child rows are then removed explicitly so correctness does not
   * depend on D1 foreign-key enforcement being enabled on this connection.
   */
  private async destroyProjects(projectIds: string[]): Promise<void> {
    if (projectIds.length === 0) {
      return;
    }
    // Collaboration rooms keep the latest document and bounded snapshot
    // history in Durable Object storage that no D1/R2 sweep reaches. Erase
    // them before anything else: a failure keeps every database row, so the
    // deletion stays visible and retryable, matching the R2 policy below.
    // Erasure is idempotent, so a retry (or the account-erasure coordinator
    // erasing the same room first) is harmless.
    if (this.env.PROJECT_ROOM) {
      for (const projectId of projectIds) {
        const response = await this.env.PROJECT_ROOM.getByName(
          projectId
        ).fetch(
          new Request(
            `https://project-room.internal/?projectId=${encodeURIComponent(projectId)}`,
            {
              method: 'DELETE',
              headers: { 'x-openzcad-internal-project-erasure': 'v1' }
            }
          )
        );
        if (!response.ok) {
          throw new Error(`Project room erasure failed for ${projectId}.`);
        }
      }
    }
    const placeholders = projectIds.map(() => '?').join(', ');
    if (this.env.ARTIFACTS) {
      const objects = await this.env
        .DB!.prepare(
          `SELECT object_key FROM artifacts WHERE project_id IN (${placeholders}) UNION SELECT object_key FROM upload_sessions WHERE project_id IN (${placeholders})`
        )
        .bind(...projectIds, ...projectIds)
        .all<{ object_key: string }>();
      // Keep the database rows when object deletion fails so the operation is
      // visible, retryable, and cannot strand unreferenced user data in R2.
      await Promise.all(
        (objects.results ?? []).map((row) =>
          this.env.ARTIFACTS!.delete(row.object_key)
        )
      );
    }
    const projectBucket = this.projectStorageBucket();
    if (projectBucket) {
      const objects = await this.env
        .DB!.prepare(
          `SELECT object_key FROM project_document_objects WHERE project_id IN (${placeholders})
           UNION
           SELECT object_key FROM project_storage_assets WHERE project_id IN (${placeholders})`
        )
        .bind(...projectIds, ...projectIds)
        .all<{ object_key: string }>();
      await Promise.all(
        (objects.results ?? []).map((row) =>
          projectBucket.delete(row.object_key)
        )
      );
    }
    // The child rows declare ON DELETE CASCADE, but foreign-key enforcement is
    // a per-connection pragma; deleting them explicitly means a purge cannot
    // leave orphaned revisions behind if it is ever off.
    await this.env.DB!.batch(
      [
        'DELETE FROM project_access_events WHERE project_id IN',
        'DELETE FROM project_share_links WHERE project_id IN',
        'DELETE FROM project_invitations WHERE project_id IN',
        'DELETE FROM project_members WHERE project_id IN',
        'DELETE FROM upload_sessions WHERE project_id IN',
        'DELETE FROM artifacts WHERE project_id IN',
        'DELETE FROM project_measurements WHERE project_id IN',
        'DELETE FROM revisions WHERE project_id IN',
        'DELETE FROM project_document_objects WHERE project_id IN',
        'DELETE FROM project_storage_assets WHERE project_id IN'
      ]
        .map((statement) =>
          this.env
            .DB!.prepare(`${statement} (${placeholders})`)
            .bind(...projectIds)
        )
        .concat(
          this.env
            .DB!.prepare(`DELETE FROM projects WHERE id IN (${placeholders})`)
            .bind(...projectIds)
        )
    );
  }

  private async assertProjectOwner(
    userId: UserId,
    projectId: string
  ): Promise<void> {
    await this.requireProjectOwner(userId, projectId);
  }

  private async resolveProjectAccess(
    userId: UserId,
    projectId: string
  ): Promise<ProjectAccess> {
    if (!isCloudflareFeatureEnabled(this.env, 'PROJECT_SHARING_ENABLED')) {
      const row = await this.env
        .DB!.prepare(
          `SELECT user_id AS owner_user_id
           FROM projects
           WHERE id = ? AND user_id = ?`
        )
        .bind(projectId, userId)
        .first<{ owner_user_id: UserId }>();
      if (!row) {
        throw new ProjectNotFoundError(projectId);
      }
      return {
        projectId,
        ownerUserId: row.owner_user_id,
        role: 'owner'
      };
    }
    const row = await this.env
      .DB!.prepare(
        `SELECT p.user_id AS owner_user_id,
                CASE
                  WHEN p.user_id = ? THEN 'owner'
                  WHEN COALESCE(
                    CASE WHEN json_valid(owner_settings.settings_json)
                      THEN json_extract(
                        owner_settings.settings_json,
                        '$.collaboration.enabled'
                      )
                    END,
                    1
                  ) = 1 AND pm.role = 'editor' THEN 'editor'
                  WHEN COALESCE(
                    CASE WHEN json_valid(owner_settings.settings_json)
                      THEN json_extract(
                        owner_settings.settings_json,
                        '$.collaboration.enabled'
                      )
                    END,
                    1
                  ) = 1 AND pm.role = 'viewer' THEN 'viewer'
                  ELSE NULL
                END AS resolved_role
         FROM projects p
         LEFT JOIN project_members pm
           ON pm.project_id = p.id AND pm.user_id = ?
         LEFT JOIN user_settings owner_settings
           ON owner_settings.user_id = p.user_id
         WHERE p.id = ?`
      )
      .bind(userId, userId, projectId)
      .first<{
        owner_user_id: UserId;
        resolved_role: ProjectAccess['role'] | null;
      }>();
    if (!row?.resolved_role) {
      throw new ProjectNotFoundError(projectId);
    }
    return {
      projectId,
      ownerUserId: row.owner_user_id,
      role: row.resolved_role
    };
  }

  async purgeExpiredUploadSessions(): Promise<number> {
    if (!this.env.DB) {
      return getInMemoryPersistence().purgeExpiredUploadSessions();
    }
    if (!this.env.ARTIFACTS) {
      return 0;
    }
    const expired = await this.env.DB.prepare(
      `SELECT id, object_key, metadata_json FROM upload_sessions WHERE expires_at < ? LIMIT 100`
    )
      .bind(nowIso())
      .all<{ id: string; object_key: string; metadata_json: string }>();
    const rows = expired.results ?? [];
    if (rows.length === 0) {
      return 0;
    }
    const deletions = await Promise.allSettled(
      rows.map(async (row) => {
        let metadata: Record<string, unknown> = {};
        try {
          metadata = JSON.parse(row.metadata_json) as Record<string, unknown>;
        } catch {
          // Absent or malformed metadata reads as "no multipart in flight".
        }
        const multipartUploadId = metadata[MULTIPART_UPLOAD_METADATA_KEY];
        if (typeof multipartUploadId === 'string') {
          // Abort is idempotent-ish: a completed upload's id is already
          // removed from metadata, and aborting an unknown id throws, which
          // allSettled tolerates without blocking the object delete below.
          await this.env
            .ARTIFACTS!.resumeMultipartUpload(row.object_key, multipartUploadId)
            .abort()
            .catch(() => undefined);
        }
        return this.env.ARTIFACTS!.delete(row.object_key);
      })
    );
    const deletedRows = rows.filter(
      (_row, index) => deletions[index]?.status === 'fulfilled'
    );
    if (deletedRows.length === 0) {
      return 0;
    }
    await this.env.DB.batch(
      deletedRows.map((row) =>
        this.env
          .DB!.prepare(`DELETE FROM upload_sessions WHERE id = ?`)
          .bind(row.id)
      )
    );
    return deletedRows.length;
  }
}

/**
 * Session-metadata key holding the R2 multipart upload id while parts are in
 * flight. Written at multipart create, removed at complete, and read by the
 * expired-session purge so an abandoned upload's R2 state is aborted rather
 * than accumulating forever. Never surfaced on finalized artifacts.
 */
const MULTIPART_UPLOAD_METADATA_KEY = '__openzcadMultipartUploadId';

function createUploadSessionRecord(
  request: CreateUploadSessionRequest
): UploadSessionRecord {
  const session: UploadSessionRecord = {
    uploadSessionId: toUploadSessionId(`upload_${crypto.randomUUID()}`),
    artifactId: toArtifactId(`artifact_${crypto.randomUUID()}`),
    projectId: request.projectId,
    objectKey: `${request.projectId}/uploads/${crypto.randomUUID()}-${sanitizeFileName(request.fileName)}`,
    fileName: request.fileName,
    contentType: request.contentType,
    kind: request.kind,
    metadata: request.metadata ?? {},
    expiresAt: new Date(Date.now() + UPLOAD_SESSION_TTL_MS).toISOString()
  };
  session.uploadUrl = `/api/uploads/${session.uploadSessionId}/content`;
  return session;
}

/** Small, non-document fallback kept in the legacy NOT NULL D1 column. */
function projectObjectEnvelope(
  document: ProjectDocument,
  objectId: string
): string {
  return JSON.stringify({
    format: 'openzcad-project-pointer',
    version: 1,
    projectId: document.projectId,
    documentVersion: document.version,
    objectId
  });
}

/**
 * Columns every project summary is built from. Kept as one string so the list
 * and single-row reads cannot drift apart and hand `summaryFromRow` a shape it
 * does not expect.
 */
const PROJECT_SUMMARY_COLUMNS = `SELECT id, name, updated_at, document_json, document_version, last_revision_id, revision_count, status, pinned, sort_order, deleted_at, archived_at, (SELECT a.id FROM artifacts a WHERE a.project_id = projects.id AND a.kind = 'thumbnail' ORDER BY a.created_at DESC LIMIT 1) AS thumbnail_artifact_id`;

interface ProjectRow {
  id: string;
  name: string;
  updated_at: string;
  document_json: string;
  document_version?: number | null;
  last_revision_id?: string | null;
  revision_count?: number | null;
  status: string | null;
  pinned: number | null;
  sort_order: number | null;
  deleted_at: string | null;
  archived_at: string | null;
  thumbnail_artifact_id?: string | null;
}

interface ProjectDocumentObjectRow {
  object_key: string;
  checksum_sha256: string;
  logical_bytes: number;
  content_encoding: string;
}

interface ProjectStorageWrite {
  objectId: string;
  objectKey: string;
  createdAt: string;
  prepared: PreparedProjectStorageSnapshot;
  missingAssets: ProjectStorageAssetObject[];
}

interface ProjectStorageWriteResolutionRow {
  current_document_object_id: string | null;
  current_document_version: number | null;
  object_state: 'pending' | 'committed' | null;
  project_references: number;
  revision_references: number;
}

type ProjectStorageWriteResolution =
  | { state: 'committed' }
  | { state: 'uncommitted'; currentVersion: number | null }
  | { state: 'superseded'; currentVersion: number | null }
  | { state: 'unknown' };

function organizationFromRow(row: ProjectRow): ProjectOrganization {
  const status = PROJECT_STATUSES.includes(row.status as ProjectStatus)
    ? (row.status as ProjectStatus)
    : 'active';
  return {
    status,
    pinned: row.pinned === 1,
    sortOrder: row.sort_order ?? 0,
    ...(status === 'deleted' && row.deleted_at
      ? { deletedAt: row.deleted_at }
      : {}),
    ...(status === 'archived' && row.archived_at
      ? { archivedAt: row.archived_at }
      : {})
  };
}

/** Null when the stored document is unreadable, so the caller can skip it. */
function summaryFromRow(row: ProjectRow): ProjectSummary | null {
  if (
    typeof row.document_version === 'number' &&
    typeof row.revision_count === 'number'
  ) {
    return {
      projectId: toProjectId(row.id),
      name: row.name,
      ...(row.last_revision_id
        ? { lastRevisionId: toRevisionId(row.last_revision_id) }
        : {}),
      ...(row.thumbnail_artifact_id
        ? { thumbnailArtifactId: toArtifactId(row.thumbnail_artifact_id) }
        : {}),
      revisionCount: row.revision_count,
      updatedAt: row.updated_at,
      documentVersion: row.document_version,
      organization: organizationFromRow(row)
    };
  }
  try {
    const document = normalizeDocument(
      JSON.parse(row.document_json) as ProjectDocument
    );
    return {
      projectId: document.projectId,
      name: row.name,
      lastRevisionId: document.revisions.at(-1)?.revisionId,
      ...(row.thumbnail_artifact_id
        ? { thumbnailArtifactId: toArtifactId(row.thumbnail_artifact_id) }
        : {}),
      revisionCount: document.revisions.length,
      updatedAt: row.updated_at,
      // Read from the document rather than the row's `document_version` so the
      // number always describes the blob this summary was built from, even if
      // the two ever disagree.
      documentVersion: document.version,
      organization: organizationFromRow(row)
    };
  } catch {
    return null;
  }
}

interface ArtifactRow {
  id: string;
  project_id: string;
  kind: ArtifactRecord['kind'];
  name: string;
  object_key: string;
  content_type: string;
  bytes: number | null;
  metadata_json: string;
  created_at: string;
}

interface ProjectInvitationRow {
  id: string;
  project_id: string;
  email: string;
  role: ProjectMemberRole;
  created_at: number;
  expires_at: number;
}

interface ProjectShareLinkRow {
  id: string;
  project_id: string;
  mode: ProjectShareLinkMode;
  created_at: number;
}

function shareLinkFromRow(row: ProjectShareLinkRow): ProjectShareLinkSummary {
  return {
    shareLinkId: row.id,
    projectId: row.project_id,
    mode: row.mode,
    createdAt: row.created_at,
    revokedAt: null
  };
}

interface SharedProjectAssetRow {
  id: string;
  project_id: string;
  kind: 'step-source' | 'mesh-payload';
  object_key: string;
  checksum_sha256: string;
  logical_bytes: number;
  content_encoding: string;
}

function invitationFromRow(
  row: ProjectInvitationRow
): ProjectInvitationSummary {
  return {
    invitationId: row.id,
    projectId: row.project_id,
    email: row.email,
    role: row.role,
    createdAt: row.created_at,
    expiresAt: row.expires_at
  };
}

function artifactFromRow(row: ArtifactRow): ArtifactRecord {
  return {
    artifactId: row.id as ArtifactRecord['artifactId'],
    projectId: row.project_id as ArtifactRecord['projectId'],
    kind: row.kind,
    name: row.name,
    objectKey: row.object_key,
    contentType: row.content_type,
    ...(row.bytes === null ? {} : { bytes: row.bytes }),
    createdAt: row.created_at,
    metadata: JSON.parse(row.metadata_json) as ArtifactRecord['metadata']
  };
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

/** Keys under which one room's state lives; see {@link RoomMeta}. */
const ROOM_META_KEY = 'room:meta';
const ROOM_LATEST_KEY = 'room:latest';
const ROOM_HISTORY_PREFIX = 'room:history:';
const ROOM_EDIT_LEASE_KEY = 'room:edit-lease';
const ROOM_SOCKET_TICKETS_KEY = 'room:socket-tickets';
/** Pre-split layout: the whole room under one value. Migrated away on load. */
const LEGACY_ROOM_STATE_KEY = 'room-state';
const ROOM_STORAGE_SCHEMA = 1;
const MAX_ROOM_HISTORY = 20;
const MAX_PENDING_SOCKET_TICKETS = 32;
const SOCKET_TICKET_TTL_MS = 30_000;

/**
 * The room reuses the account's document ceiling
 * ({@link MAX_PERSISTED_DOCUMENT_BYTES}) rather than setting its own, so a
 * document cannot be small enough to live in the room and too large to be
 * saved. SQLite-backed Durable Object storage independently rejects a single
 * value over 2 MiB, and every document now occupies a key of its own, so the
 * shared limit is also below the hard one. Documents above it are refused
 * before any in-memory state moves, because a write that fails after the
 * mutation leaves the room serving state that no longer survives eviction.
 */

/**
 * Structural limits applied to client JSON before it reaches `normalizeDocument`
 * or the three-way merge, both of which recurse without a depth guard.
 */
const MAX_CLIENT_DOCUMENT_DEPTH = 64;
const MAX_CLIENT_DOCUMENT_VALUES = 500_000;

/** Largest HTTP snapshot body accepted, sized to fit one storable document. */
const MAX_SNAPSHOT_PAYLOAD_BYTES = 1_600_000;
const PROJECT_EDIT_LEASE_TTL_MS = 30_000;

interface CollaborationSocketTicket {
  projectId: string;
  userId: UserId;
  displayName: string;
  email?: string;
  role: SharedProjectAccessRole;
  expiresAt: number;
}

type CollaborationSocketTickets = Record<string, CollaborationSocketTicket>;

function randomSocketTicket(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function validSocketTicket(value: string): boolean {
  return /^[A-Za-z0-9_-]{43}$/.test(value);
}

async function socketTicketHash(ticket: string): Promise<string> {
  return sha256Hex(new TextEncoder().encode(ticket));
}

/**
 * Reads a bounded request body without trusting Content-Length or decoding
 * bytes the room will reject. `null` means the caller must return the typed
 * oversize response; an absent body remains an invalid empty payload.
 */
async function readSnapshotBody(request: Request): Promise<string | null> {
  const contentLength = Number(request.headers.get('content-length') ?? '0');
  if (
    Number.isFinite(contentLength) &&
    contentLength > MAX_SNAPSHOT_PAYLOAD_BYTES
  ) {
    return null;
  }
  const reader = request.body?.getReader();
  if (!reader) {
    return '';
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
      if (totalBytes > MAX_SNAPSHOT_PAYLOAD_BYTES) {
        await reader.cancel().catch(() => undefined);
        return null;
      }
      chunks.push(decoder.decode(value, { stream: true }));
    }
  } finally {
    reader.releaseLock();
  }
  chunks.push(decoder.decode());
  return chunks.join('');
}

interface RoomMeta {
  schema: number;
  projectId: string | null;
  latestVersion: number | null;
  historyVersions: number[];
}

interface LegacyRoomState {
  projectId: string | null;
  latestDocument: ProjectDocument | null;
  history?: ProjectDocument[];
}

interface RoomStorage {
  get<T>(key: string): Promise<T | undefined>;
  put: {
    <T>(key: string, value: T): Promise<void>;
    (entries: Record<string, unknown>): Promise<void>;
  };
  delete: {
    (key: string): Promise<boolean>;
    (keys: string[]): Promise<number>;
  };
  deleteAll(): Promise<void>;
}

function historyKey(version: number): string {
  return `${ROOM_HISTORY_PREFIX}${version}`;
}

export class ProjectCollaborationRoom extends DurableObject {
  private readonly roomContext: {
    storage: RoomStorage;
    blockConcurrencyWhile<T>(callback: () => Promise<T>): Promise<T>;
  };
  private readonly ready: Promise<void>;
  private readonly roomEnv: CloudflareEnv;
  private presence = new Map<string, string>();
  private sockets = new Map<
    WebSocket,
    {
      clientId: string;
      userId: UserId;
      displayName: string;
      email?: string;
      role: SharedProjectAccessRole;
    }
  >();
  private editLease: ProjectEditLease | null = null;
  private leaseQueue: Promise<void> = Promise.resolve();
  private ticketQueue: Promise<void> = Promise.resolve();
  private latestDocument: ProjectDocument | null = null;
  private documentHistory = new Map<number, ProjectDocument>();
  private projectId: string | null = null;
  private erasing = false;

  constructor(ctx: unknown, env: unknown) {
    super(ctx, env);
    this.roomEnv = env as CloudflareEnv;
    this.roomContext = ctx as typeof this.roomContext;
    this.ready = this.roomContext.blockConcurrencyWhile(async () => {
      await this.migrateLegacyRoomState();
      const meta = await this.roomContext.storage.get<RoomMeta>(ROOM_META_KEY);
      if (!meta) {
        return;
      }
      this.projectId = meta.projectId ?? null;
      this.latestDocument =
        (await this.roomContext.storage.get<ProjectDocument>(
          ROOM_LATEST_KEY
        )) ?? null;
      const storedLease =
        (await this.roomContext.storage.get<ProjectEditLease>(
          ROOM_EDIT_LEASE_KEY
        )) ?? null;
      if (
        storedLease &&
        storedLease.projectId === this.projectId &&
        storedLease.expiresAt > Date.now()
      ) {
        this.editLease = storedLease;
      } else if (storedLease) {
        await this.roomContext.storage.delete(ROOM_EDIT_LEASE_KEY);
      }
      const history = await Promise.all(
        (meta.historyVersions ?? []).map((version) =>
          this.roomContext.storage.get<ProjectDocument>(historyKey(version))
        )
      );
      for (const document of history) {
        if (document) {
          this.documentHistory.set(document.version, document);
        }
      }
    });
  }

  /**
   * Rewrites a pre-split `room-state` value into one key per document. The
   * legacy key is dropped only once the replacement keys are committed, so an
   * interrupted migration re-runs from the original on the next load.
   */
  private async migrateLegacyRoomState(): Promise<void> {
    const legacy = await this.roomContext.storage.get<LegacyRoomState>(
      LEGACY_ROOM_STATE_KEY
    );
    if (!legacy) {
      return;
    }
    const alreadySplit =
      await this.roomContext.storage.get<RoomMeta>(ROOM_META_KEY);
    if (!alreadySplit) {
      const history = (legacy.history ?? []).slice(-MAX_ROOM_HISTORY);
      const entries: Record<string, unknown> = {};
      for (const document of history) {
        entries[historyKey(document.version)] = document;
      }
      if (legacy.latestDocument) {
        entries[ROOM_LATEST_KEY] = legacy.latestDocument;
      }
      entries[ROOM_META_KEY] = {
        schema: ROOM_STORAGE_SCHEMA,
        projectId: legacy.projectId ?? null,
        latestVersion: legacy.latestDocument?.version ?? null,
        historyVersions: history
          .map((document) => document.version)
          .sort((left, right) => left - right)
      } satisfies RoomMeta;
      await this.roomContext.storage.put(entries);
    }
    await this.roomContext.storage.delete(LEGACY_ROOM_STATE_KEY);
  }

  async fetch(request: Request): Promise<Response> {
    await this.ready;
    if (request.method === 'DELETE') {
      return this.eraseRoom(request);
    }
    if (this.erasing) {
      return new Response('Cloud project deletion is in progress.', {
        status: 410
      });
    }
    if (request.method === 'PATCH') {
      return this.acceptInternalRoleUpdate(request);
    }
    if (request.method === 'PUT') {
      return this.issueSocketTicket(request);
    }
    if (request.method === 'POST') {
      return this.acceptHttpSnapshot(request);
    }
    if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
      return new Response('WebSocket upgrade required.', { status: 426 });
    }
    const url = new URL(request.url);
    const projectId = url.searchParams.get('projectId');
    const ticketValues = url.searchParams.getAll('ticket');
    let userId = request.headers.get('x-openzcad-user-id') as UserId | null;
    let displayName = request.headers.get('x-openzcad-display-name');
    let email = request.headers.get('x-openzcad-user-email') ?? undefined;
    let role = trustedProjectRole(request.headers);
    if (ticketValues.length > 0) {
      const claim =
        projectId && ticketValues.length === 1
          ? await this.consumeSocketTicket(ticketValues[0]!, projectId)
          : null;
      if (!claim) {
        return new Response('Collaboration ticket is invalid or expired.', {
          status: 401
        });
      }
      userId = claim.userId;
      displayName = claim.displayName;
      email = claim.email;
      role = claim.role;
    }
    if (!userId || !displayName || !projectId || !role) {
      return new Response('Missing collaboration identity.', { status: 400 });
    }
    if (!this.collaborationAccessAllowed(role, email)) {
      return new Response('Collaboration access is disabled.', { status: 403 });
    }
    if (this.projectId && this.projectId !== projectId) {
      return new Response('Room project mismatch.', { status: 409 });
    }
    if (this.projectId !== projectId) {
      this.projectId = projectId;
      await this.persistRoomState();
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    server.accept();
    server.addEventListener(
      'message',
      (event: MessageEvent<string | ArrayBuffer>) => {
        // Nothing awaits this handler, so a rejection here would surface as an
        // unhandled rejection and the sender would wait forever for an ack.
        void this.handleSocketMessage(
          server,
          event.data,
          userId,
          displayName,
          role,
          email
        ).catch(() => {
          console.error('Collaboration message handling failed.');
          this.send(server, {
            type: 'error',
            code: 'internal',
            message: 'The collaboration room could not process that message.'
          });
        });
      }
    );
    const close = () => this.removeSocket(server);
    server.addEventListener('close', close);
    server.addEventListener('error', close);
    return new Response(null, { status: 101, webSocket: client });
  }

  /** Internal-only hard deletion used by the account erasure coordinator. */
  private async eraseRoom(request: Request): Promise<Response> {
    const projectId = new URL(request.url).searchParams.get('projectId');
    if (
      request.headers.get('x-openzcad-internal-project-erasure') !== 'v1' ||
      !projectId ||
      (this.projectId !== null && this.projectId !== projectId)
    ) {
      return new Response('Invalid project erasure request.', { status: 403 });
    }
    return this.roomContext.blockConcurrencyWhile(async () => {
      this.erasing = true;
      for (const socket of this.sockets.keys()) {
        socket.close(4001, 'Cloud project was permanently deleted.');
      }
      this.sockets.clear();
      this.presence.clear();
      this.editLease = null;
      this.latestDocument = null;
      this.documentHistory.clear();
      this.projectId = null;
      await this.roomContext.storage.deleteAll();
      return new Response(null, { status: 204 });
    });
  }

  private enqueueTicketOperation<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.ticketQueue.then(operation, operation);
    this.ticketQueue = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }

  private async issueSocketTicket(request: Request): Promise<Response> {
    const projectId = new URL(request.url).searchParams.get('projectId');
    const userId = request.headers.get('x-openzcad-user-id');
    const displayName = request.headers.get('x-openzcad-display-name');
    const email = request.headers.get('x-openzcad-user-email') ?? undefined;
    const role = trustedProjectRole(request.headers);
    if (
      request.headers.get('x-openzcad-internal-ticket-request') !== 'v1' ||
      !projectId ||
      !userId ||
      !displayName ||
      !role ||
      projectId.length > 256 ||
      userId.length > 256 ||
      displayName.length > 256
    ) {
      return new Response('Invalid collaboration ticket request.', {
        status: 400
      });
    }
    if (!this.collaborationAccessAllowed(role, email)) {
      return new Response('Collaboration access is disabled.', { status: 403 });
    }
    if (this.projectId && this.projectId !== projectId) {
      return new Response('Room project mismatch.', { status: 409 });
    }
    if (this.projectId !== projectId) {
      this.projectId = projectId;
      await this.persistRoomState();
    }

    return this.enqueueTicketOperation(async () => {
      const now = Date.now();
      const ticket = randomSocketTicket();
      const ticketHash = await socketTicketHash(ticket);
      const stored =
        (await this.roomContext.storage.get<CollaborationSocketTickets>(
          ROOM_SOCKET_TICKETS_KEY
        )) ?? {};
      const pending = Object.fromEntries(
        Object.entries(stored)
          .filter(([, claim]) => claim.expiresAt > now)
          .sort((left, right) => right[1].expiresAt - left[1].expiresAt)
          .slice(0, MAX_PENDING_SOCKET_TICKETS - 1)
      );
      const expiresAt = now + SOCKET_TICKET_TTL_MS;
      pending[ticketHash] = {
        projectId,
        userId: userId as UserId,
        displayName,
        email,
        role,
        expiresAt
      };
      await this.roomContext.storage.put(ROOM_SOCKET_TICKETS_KEY, pending);
      return Response.json(
        { ticket, expiresAt },
        { headers: { 'cache-control': 'no-store' } }
      );
    });
  }

  private async consumeSocketTicket(
    ticket: string,
    projectId: string
  ): Promise<CollaborationSocketTicket | null> {
    if (!validSocketTicket(ticket)) {
      return null;
    }
    const ticketHash = await socketTicketHash(ticket);
    const claim = await this.enqueueTicketOperation(async () => {
      const now = Date.now();
      const stored =
        (await this.roomContext.storage.get<CollaborationSocketTickets>(
          ROOM_SOCKET_TICKETS_KEY
        )) ?? {};
      const found = stored[ticketHash];
      const pending = Object.fromEntries(
        Object.entries(stored).filter(
          ([hash, candidate]) =>
            hash !== ticketHash && candidate.expiresAt > now
        )
      );
      if (Object.keys(pending).length === 0) {
        await this.roomContext.storage.delete(ROOM_SOCKET_TICKETS_KEY);
      } else {
        await this.roomContext.storage.put(ROOM_SOCKET_TICKETS_KEY, pending);
      }
      return found && found.expiresAt > now && found.projectId === projectId
        ? found
        : null;
    });
    return claim ? this.refreshTicketAccess(claim) : null;
  }

  /** Re-check D1 after ticket issuance so a just-revoked member cannot connect. */
  private async refreshTicketAccess(
    claim: CollaborationSocketTicket
  ): Promise<CollaborationSocketTicket | null> {
    if (!this.roomEnv.DB) {
      return this.roomEnv.ENVIRONMENT === 'development' &&
        this.roomEnv.AUTH_MODE === 'development'
        ? claim
        : null;
    }
    try {
      const erasure = await this.roomEnv.DB.prepare(
        `SELECT 1 AS pending FROM account_erasure_requests WHERE user_id = ?`
      )
        .bind(claim.userId)
        .first<{ pending: number }>();
      if (erasure) {
        return null;
      }
    } catch {
      // Migration 0014 is independently rolled out. Project access remains on
      // its existing checks until the account-erasure feature itself is ready.
    }
    const rollout = projectCollaborationRollout(this.roomEnv, claim.email);
    const owner = await this.roomEnv.DB.prepare(
      `SELECT user_id FROM projects WHERE id = ? AND user_id = ?`
    )
      .bind(claim.projectId, claim.userId)
      .first<{ user_id: string }>();
    if (owner) {
      return rollout.personalSyncEnabled || rollout.sharingEnabled
        ? { ...claim, role: 'owner' }
        : null;
    }
    if (!rollout.sharingEnabled) {
      return null;
    }
    const member = await this.roomEnv.DB.prepare(
      `SELECT role FROM project_members WHERE project_id = ? AND user_id = ?`
    )
      .bind(claim.projectId, claim.userId)
      .first<{ role: string }>();
    return member?.role === 'editor' || member?.role === 'viewer'
      ? { ...claim, role: member.role }
      : null;
  }

  private async handleSocketMessage(
    socket: WebSocket,
    raw: string | ArrayBuffer,
    userId: UserId,
    displayName: string,
    role: SharedProjectAccessRole,
    email?: string
  ): Promise<void> {
    if (this.erasing) {
      socket.close(4001, 'Cloud project was permanently deleted.');
      return;
    }
    if (typeof raw !== 'string' || raw.length > 950_000) {
      socket.close(1009, 'Collaboration message is too large.');
      return;
    }
    let message: CollaborationClientMessage;
    try {
      message = JSON.parse(raw) as CollaborationClientMessage;
    } catch {
      socket.close(1003, 'Invalid collaboration message.');
      return;
    }
    if (!message.clientId) {
      return;
    }

    if (!this.collaborationAccessAllowed(role, email)) {
      socket.close(1008, 'Collaboration access is disabled.');
      this.removeSocket(socket);
      return;
    }

    if (message.type === 'hello') {
      this.sockets.set(socket, {
        clientId: message.clientId,
        userId,
        displayName,
        role,
        email
      });
      this.presence.set(message.clientId, 'active');
      if (message.document) {
        await this.acceptDocument(
          socket,
          message.clientId,
          message.document,
          message.baseVersion,
          false,
          message.leaseId
        );
      }
      this.send(socket, {
        type: 'state',
        members: this.members(),
        document: this.latestDocument,
        role,
        lease: this.editLease
      });
      this.broadcastPresence();
      return;
    }
    const connection = this.sockets.get(socket);
    if (!connection || connection.clientId !== message.clientId) {
      socket.close(1008, 'Collaboration client identity changed.');
      return;
    }
    if (message.type === 'presence') {
      this.presence.set(message.clientId, message.status);
      this.broadcastPresence();
      return;
    }
    if (message.type === 'lease-acquire') {
      await this.enqueueLeaseOperation(() =>
        this.acquireEditLease(socket, connection)
      );
      return;
    }
    if (message.type === 'lease-renew') {
      await this.enqueueLeaseOperation(() =>
        this.renewEditLease(socket, connection, message.leaseId)
      );
      return;
    }
    if (message.type === 'lease-release') {
      await this.enqueueLeaseOperation(() =>
        this.releaseEditLease(socket, connection, message.leaseId)
      );
      return;
    }
    if (message.type === 'document') {
      await this.acceptDocument(
        socket,
        message.clientId,
        message.document,
        message.baseVersion,
        true,
        message.leaseId
      );
    }
  }

  private async acceptDocument(
    socket: WebSocket,
    clientId: string,
    rawDocument: ProjectDocument,
    baseVersion: number | null,
    broadcast: boolean,
    leaseId?: string
  ): Promise<void> {
    await this.enqueueLeaseOperation(() =>
      this.acceptDocumentWithCurrentLease(
        socket,
        clientId,
        rawDocument,
        baseVersion,
        broadcast,
        leaseId
      )
    );
  }

  private async acceptDocumentWithCurrentLease(
    socket: WebSocket,
    clientId: string,
    rawDocument: ProjectDocument,
    baseVersion: number | null,
    broadcast: boolean,
    leaseId?: string
  ): Promise<void> {
    const connection = this.sockets.get(socket);
    if (!connection || !(await this.canAuthor(connection, leaseId, socket))) {
      return;
    }
    const rejection = checkClientDocument(rawDocument);
    if (rejection) {
      this.send(socket, { type: 'error', ...rejection });
      return;
    }
    const document = normalizeDocument(rawDocument);
    if (document.projectId !== this.projectId) {
      socket.close(1008, 'Document project does not match this room.');
      return;
    }
    const latest = this.latestDocument;
    const base =
      baseVersion === null ? undefined : this.documentHistory.get(baseVersion);
    const resolution = resolveCollaborationDocument(latest, document, base);
    if (resolution.kind === 'accept') {
      const oversize = checkPersistedSize(resolution.document);
      if (oversize) {
        this.send(socket, { type: 'error', ...oversize });
        return;
      }
      await this.commitDocument(resolution.document);
      // A merge produces a document the sender never had. The broadcast below
      // skips the sender, so the merged state has to ride along on the ack or
      // the sender stays silently divergent while reporting itself synced.
      this.send(socket, ackFor(resolution.document, document));
      if (broadcast) {
        this.broadcast(
          { type: 'document', clientId, document: resolution.document },
          socket
        );
      }
      return;
    }
    if (resolution.kind === 'conflict') {
      this.send(socket, { type: 'conflict', document: resolution.document });
    }
  }

  private leaseEnforced(email?: string): boolean {
    return projectCollaborationRollout(this.roomEnv, email).editLeasesEnforced;
  }

  private collaborationAccessAllowed(
    role: SharedProjectAccessRole,
    email?: string
  ): boolean {
    // Development rooms remain directly testable. Hosted beta always resolves
    // against global flags or the authenticated account allowlist.
    if (
      this.roomEnv.ENVIRONMENT !== 'beta' &&
      this.roomEnv.PRODUCTION_GUARD === undefined
    ) {
      return true;
    }
    const rollout = projectCollaborationRollout(this.roomEnv, email);
    return role === 'owner'
      ? rollout.personalSyncEnabled || rollout.sharingEnabled
      : rollout.sharingEnabled;
  }

  private async enqueueLeaseOperation<T>(
    operation: () => Promise<T>
  ): Promise<T> {
    const result = this.leaseQueue.then(operation, operation);
    this.leaseQueue = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }

  private async expireEditLease(now = Date.now()): Promise<void> {
    if (!this.editLease || this.editLease.expiresAt > now) {
      return;
    }
    const expired = this.editLease;
    await this.roomContext.storage.delete(ROOM_EDIT_LEASE_KEY);
    this.editLease = null;
    this.notifyLeaseHolder(expired, 'expired');
  }

  private async acquireEditLease(
    socket: WebSocket,
    connection: {
      clientId: string;
      userId: UserId;
      role: SharedProjectAccessRole;
      email?: string;
    }
  ): Promise<void> {
    if (
      connection.role === 'viewer' ||
      !(await this.membershipStillAllowsAuthoring(connection))
    ) {
      if (
        this.editLease?.userId === connection.userId &&
        this.editLease.clientId === connection.clientId
      ) {
        await this.roomContext.storage.delete(ROOM_EDIT_LEASE_KEY);
        this.editLease = null;
      }
      this.send(socket, { type: 'lease-denied', reason: 'read-only' });
      return;
    }
    await this.expireEditLease();
    const current = this.editLease;
    if (
      current &&
      (current.userId !== connection.userId ||
        current.clientId !== connection.clientId)
    ) {
      this.send(socket, {
        type: 'lease-denied',
        reason: 'held',
        expiresAt: current.expiresAt
      });
      return;
    }
    const lease: ProjectEditLease = {
      leaseId: current?.leaseId ?? `lease_${crypto.randomUUID()}`,
      projectId: this.projectId!,
      clientId: connection.clientId,
      userId: connection.userId,
      expiresAt: Date.now() + PROJECT_EDIT_LEASE_TTL_MS
    };
    await this.roomContext.storage.put(ROOM_EDIT_LEASE_KEY, lease);
    this.editLease = lease;
    this.send(socket, { type: 'lease-granted', lease });
  }

  private async renewEditLease(
    socket: WebSocket,
    connection: {
      clientId: string;
      userId: UserId;
      role: SharedProjectAccessRole;
      email?: string;
    },
    leaseId: string
  ): Promise<void> {
    await this.expireEditLease();
    if (!(await this.membershipStillAllowsAuthoring(connection))) {
      if (
        this.editLease?.clientId === connection.clientId &&
        this.editLease.userId === connection.userId
      ) {
        const lost = this.editLease;
        await this.roomContext.storage.delete(ROOM_EDIT_LEASE_KEY);
        this.editLease = null;
        this.notifyLeaseHolder(lost, 'role-changed');
      } else {
        this.send(socket, { type: 'lease-lost', reason: 'role-changed' });
      }
      return;
    }
    if (
      !this.editLease ||
      this.editLease.leaseId !== leaseId ||
      this.editLease.clientId !== connection.clientId ||
      this.editLease.userId !== connection.userId ||
      this.editLease.projectId !== this.projectId
    ) {
      this.send(socket, { type: 'lease-lost', reason: 'invalid' });
      return;
    }
    const lease = {
      ...this.editLease,
      expiresAt: Date.now() + PROJECT_EDIT_LEASE_TTL_MS
    };
    await this.roomContext.storage.put(ROOM_EDIT_LEASE_KEY, lease);
    this.editLease = lease;
    this.send(socket, { type: 'lease-granted', lease });
  }

  private async releaseEditLease(
    socket: WebSocket,
    connection: { clientId: string; userId: UserId },
    leaseId: string
  ): Promise<void> {
    await this.expireEditLease();
    if (
      !this.editLease ||
      this.editLease.leaseId !== leaseId ||
      this.editLease.clientId !== connection.clientId ||
      this.editLease.userId !== connection.userId
    ) {
      this.send(socket, { type: 'lease-lost', reason: 'invalid' });
      return;
    }
    const released = this.editLease;
    await this.roomContext.storage.delete(ROOM_EDIT_LEASE_KEY);
    this.editLease = null;
    this.notifyLeaseHolder(released, 'released');
  }

  private matchesActiveLease(
    userId: UserId,
    clientId: string,
    leaseId: string | undefined
  ): boolean {
    return Boolean(
      leaseId &&
      this.editLease &&
      this.editLease.expiresAt > Date.now() &&
      this.editLease.leaseId === leaseId &&
      this.editLease.projectId === this.projectId &&
      this.editLease.clientId === clientId &&
      this.editLease.userId === userId
    );
  }

  /**
   * The room learns role changes through an internal PATCH from the Worker,
   * which can fail after the D1 change has committed: a 500 there leaves the
   * member row removed while an open socket keeps its old in-memory role. The
   * membership row is the source of truth, so every authored document from a
   * non-owner re-checks it. Owners cannot be demoted, and without a database
   * or a known project the in-memory role is all the room has.
   */
  private async membershipStillAllowsAuthoring(connection: {
    userId: UserId;
    role: SharedProjectAccessRole;
    email?: string;
  }): Promise<boolean> {
    if (!this.collaborationAccessAllowed(connection.role, connection.email)) {
      return false;
    }
    if (connection.role === 'owner' || !this.projectId || !this.roomEnv.DB) {
      return true;
    }
    const row = await this.roomEnv.DB.prepare(
      `SELECT role FROM project_members WHERE project_id = ? AND user_id = ?`
    )
      .bind(this.projectId, connection.userId)
      .first<{ role: string }>();
    return row?.role === 'editor';
  }

  private async canAuthor(
    connection: {
      clientId: string;
      userId: UserId;
      role: SharedProjectAccessRole;
      email?: string;
    },
    leaseId: string | undefined,
    socket: WebSocket
  ): Promise<boolean> {
    if (connection.role === 'viewer') {
      this.send(socket, {
        type: 'error',
        code: 'permission-denied',
        message: 'Viewers cannot change the collaboration document.'
      });
      return false;
    }
    if (!(await this.membershipStillAllowsAuthoring(connection))) {
      this.send(socket, {
        type: 'error',
        code: 'permission-denied',
        message: 'Project membership no longer allows editing.'
      });
      return false;
    }
    if (!this.leaseEnforced(connection.email)) {
      return true;
    }
    await this.expireEditLease();
    if (
      this.matchesActiveLease(connection.userId, connection.clientId, leaseId)
    ) {
      return true;
    }
    this.send(socket, {
      type: 'error',
      code: 'lease-required',
      message: 'A matching active project edit lease is required.'
    });
    return false;
  }

  private notifyLeaseHolder(
    lease: ProjectEditLease,
    reason: 'expired' | 'released' | 'role-changed'
  ): void {
    for (const [socket, connection] of this.sockets) {
      if (
        connection.userId === lease.userId &&
        connection.clientId === lease.clientId
      ) {
        this.send(socket, { type: 'lease-lost', reason });
      }
    }
  }

  private async acceptInternalRoleUpdate(request: Request): Promise<Response> {
    const projectId = new URL(request.url).searchParams.get('projectId');
    const userId = request.headers.get('x-openzcad-internal-user-id');
    const roleValue = request.headers.get('x-openzcad-internal-project-role');
    const role =
      roleValue === 'editor' || roleValue === 'viewer' ? roleValue : null;
    if (
      !projectId ||
      !userId ||
      (roleValue !== null && role === null) ||
      (this.projectId && this.projectId !== projectId)
    ) {
      return new Response('Invalid project role update.', { status: 400 });
    }
    await this.enqueueLeaseOperation(async () => {
      if (
        this.editLease?.userId === userId &&
        (role === null || role === 'viewer')
      ) {
        const lost = this.editLease;
        await this.roomContext.storage.delete(ROOM_EDIT_LEASE_KEY);
        this.editLease = null;
        this.notifyLeaseHolder(lost, 'role-changed');
      }
      for (const [socket, connection] of this.sockets) {
        if (connection.userId !== userId) {
          continue;
        }
        if (role) {
          connection.role = role;
        } else {
          this.send(socket, { type: 'lease-lost', reason: 'role-changed' });
          socket.close(1008, 'Project access was removed.');
          this.removeSocket(socket);
        }
      }
    });
    return new Response(null, { status: 204 });
  }

  /**
   * Promotes a resolved document to latest and persists it. Callers check
   * {@link checkPersistedSize} first: in-memory state must not move ahead of
   * what storage will accept, or the room reverts to an older document the
   * next time it is evicted.
   */
  private async commitDocument(document: ProjectDocument): Promise<void> {
    const dirty = new Set<number>();
    const previousLatest = this.latestDocument;
    const previousHistory = new Map(this.documentHistory);
    if (previousLatest && previousLatest.version !== document.version) {
      this.documentHistory.set(previousLatest.version, previousLatest);
      dirty.add(previousLatest.version);
    }
    this.latestDocument = document;
    this.documentHistory.set(document.version, document);
    dirty.add(document.version);
    try {
      await this.persistRoomState(dirty);
    } catch (error) {
      // A write that failed for any other reason must not leave the room
      // serving a document storage never took; the caller reports the failure.
      this.latestDocument = previousLatest;
      this.documentHistory = previousHistory;
      throw error;
    }
  }

  private async acceptHttpSnapshot(request: Request): Promise<Response> {
    const userId = request.headers.get('x-openzcad-user-id');
    const displayName = request.headers.get('x-openzcad-display-name');
    const email = request.headers.get('x-openzcad-user-email') ?? undefined;
    const role = trustedProjectRole(request.headers);
    const projectId = new URL(request.url).searchParams.get('projectId');
    if (!userId || !displayName || !projectId || !role) {
      return new Response('Missing collaboration identity.', { status: 400 });
    }
    if (!this.collaborationAccessAllowed(role, email)) {
      return new Response('Collaboration access is disabled.', { status: 403 });
    }
    if (role === 'viewer') {
      return rejectionResponse({
        code: 'permission-denied',
        message: 'Viewers cannot change the collaboration document.'
      });
    }
    const body = await readSnapshotBody(request);
    if (body === null) {
      return oversizeSnapshotResponse();
    }
    let payload: {
      clientId?: string;
      baseVersion?: number | null;
      document?: ProjectDocument;
      leaseId?: string;
    };
    try {
      payload = JSON.parse(body) as typeof payload;
    } catch {
      return new Response('Invalid collaboration snapshot.', { status: 400 });
    }
    if (!payload.clientId || !payload.document) {
      return new Response('Invalid collaboration snapshot.', { status: 400 });
    }
    return this.enqueueLeaseOperation(() =>
      this.acceptHttpSnapshotPayload(
        userId as UserId,
        role,
        email,
        projectId,
        payload as {
          clientId: string;
          baseVersion?: number | null;
          document: ProjectDocument;
          leaseId?: string;
        }
      )
    );
  }

  private async acceptHttpSnapshotPayload(
    userId: UserId,
    role: SharedProjectAccessRole,
    email: string | undefined,
    projectId: string,
    payload: {
      clientId: string;
      baseVersion?: number | null;
      document: ProjectDocument;
      leaseId?: string;
    }
  ): Promise<Response> {
    if (!(await this.membershipStillAllowsAuthoring({ userId, role, email }))) {
      return rejectionResponse({
        code: 'permission-denied',
        message: 'Project membership no longer allows editing.'
      });
    }
    if (this.leaseEnforced(email)) {
      await this.expireEditLease();
      if (!this.matchesActiveLease(userId, payload.clientId, payload.leaseId)) {
        return rejectionResponse({
          code: 'lease-required',
          message: 'A matching active project edit lease is required.'
        });
      }
    }
    if (this.projectId && this.projectId !== projectId) {
      return new Response('Room project mismatch.', { status: 409 });
    }
    const rejection = checkClientDocument(payload.document);
    if (rejection) {
      return rejectionResponse(rejection);
    }
    this.projectId = projectId;
    const document = normalizeDocument(payload.document);
    if (document.projectId !== projectId) {
      return new Response('Document project mismatch.', { status: 400 });
    }
    const resolution = resolveCollaborationDocument(
      this.latestDocument,
      document,
      payload.baseVersion === null || payload.baseVersion === undefined
        ? undefined
        : this.documentHistory.get(payload.baseVersion)
    );
    if (resolution.kind === 'conflict') {
      return Response.json(
        { type: 'conflict', document: resolution.document },
        { status: 409 }
      );
    }
    if (resolution.kind === 'accept') {
      const oversize = checkPersistedSize(resolution.document);
      if (oversize) {
        return rejectionResponse(oversize);
      }
      await this.commitDocument(resolution.document);
      this.broadcast({
        type: 'document',
        clientId: payload.clientId,
        document: resolution.document
      });
    }
    return Response.json(ackFor(resolution.document, document));
  }

  /**
   * Writes the room index plus whichever documents changed. Each document owns
   * a key, so no single value grows with history depth; `put` takes them as one
   * batch so the index never advertises a version its key is missing.
   */
  private async persistRoomState(
    dirtyHistoryVersions: ReadonlySet<number> = new Set()
  ): Promise<void> {
    const evicted = this.trimHistory();
    const entries: Record<string, unknown> = {};
    for (const version of dirtyHistoryVersions) {
      const document = this.documentHistory.get(version);
      if (document) {
        entries[historyKey(version)] = document;
      }
    }
    if (this.latestDocument) {
      entries[ROOM_LATEST_KEY] = this.latestDocument;
    }
    entries[ROOM_META_KEY] = {
      schema: ROOM_STORAGE_SCHEMA,
      projectId: this.projectId,
      latestVersion: this.latestDocument?.version ?? null,
      historyVersions: Array.from(this.documentHistory.keys()).sort(
        (left, right) => left - right
      )
    } satisfies RoomMeta;
    await this.roomContext.storage.put(entries);
    // Deleting after the index no longer references these keys keeps a failed
    // delete a storage leak rather than a dangling history version.
    if (evicted.length > 0) {
      await this.roomContext.storage.delete(evicted.map(historyKey));
    }
  }

  /** Drops the oldest history entries, returning the versions to unlink. */
  private trimHistory(): number[] {
    const versions = Array.from(this.documentHistory.keys()).sort(
      (left, right) => left - right
    );
    const evicted = versions.slice(
      0,
      Math.max(0, versions.length - MAX_ROOM_HISTORY)
    );
    for (const version of evicted) {
      this.documentHistory.delete(version);
    }
    return evicted;
  }

  private members(): CollaborationMember[] {
    return Array.from(this.sockets.values()).map((connection) => ({
      clientId: connection.clientId,
      userId: connection.userId,
      displayName: connection.displayName,
      status:
        this.presence.get(connection.clientId) === 'idle' ? 'idle' : 'active'
    }));
  }

  private send(socket: WebSocket, message: CollaborationServerMessage): void {
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(message));
    }
  }

  private broadcast(
    message: CollaborationServerMessage,
    except?: WebSocket
  ): void {
    for (const socket of this.sockets.keys()) {
      if (socket !== except) {
        this.send(socket, message);
      }
    }
  }

  private broadcastPresence(): void {
    this.broadcast({ type: 'presence', members: this.members() });
  }

  private removeSocket(socket: WebSocket): void {
    const connection = this.sockets.get(socket);
    if (!connection) {
      return;
    }
    this.sockets.delete(socket);
    this.presence.delete(connection.clientId);
    this.broadcastPresence();
  }

  async snapshot() {
    return {
      members: Array.from(this.presence.entries()),
      lease: this.editLease
    };
  }
}

function trustedProjectRole(
  headers: Headers,
  name = 'x-openzcad-project-role'
): SharedProjectAccessRole | null {
  const value = headers.get(name);
  return value === 'owner' || value === 'editor' || value === 'viewer'
    ? value
    : null;
}

interface CollaborationRejection {
  code: CollaborationErrorCode;
  message: string;
}

/** Carries a refusal on the HTTP path in the same shape sockets receive. */
function rejectionResponse(rejection: CollaborationRejection): Response {
  return Response.json(
    { type: 'error', ...rejection } satisfies CollaborationServerMessage,
    {
      status:
        rejection.code === 'permission-denied'
          ? 403
          : rejection.code === 'lease-required'
            ? 409
            : rejection.code === 'document-invalid'
              ? 400
              : 413
    }
  );
}

function oversizeSnapshotResponse(): Response {
  return rejectionResponse({
    code: 'document-too-large',
    message: 'Collaboration snapshot is too large to store.'
  });
}

/**
 * Screens client JSON before `normalizeDocument` and the three-way merge walk
 * it. Both recurse, so a deeply nested payload would throw a RangeError out of
 * a path with no natural place to report it. The walk here is iterative for the
 * same reason.
 */
function checkClientDocument(value: unknown): CollaborationRejection | null {
  if (!isRecord(value)) {
    return {
      code: 'document-invalid',
      message: 'Collaboration document must be an object.'
    };
  }
  let visited = 0;
  const pending: Array<{ value: unknown; depth: number }> = [
    { value, depth: 1 }
  ];
  while (pending.length > 0) {
    const entry = pending.pop()!;
    if (entry.depth > MAX_CLIENT_DOCUMENT_DEPTH) {
      return {
        code: 'document-too-complex',
        message: `Collaboration document nests deeper than ${MAX_CLIENT_DOCUMENT_DEPTH} levels.`
      };
    }
    visited += 1;
    if (visited > MAX_CLIENT_DOCUMENT_VALUES) {
      return {
        code: 'document-too-complex',
        message: `Collaboration document holds more than ${MAX_CLIENT_DOCUMENT_VALUES} values.`
      };
    }
    const current = entry.value;
    if (Array.isArray(current)) {
      for (const item of current) {
        pending.push({ value: item, depth: entry.depth + 1 });
      }
    } else if (isRecord(current)) {
      for (const item of Object.values(current)) {
        pending.push({ value: item, depth: entry.depth + 1 });
      }
    }
  }
  if (
    typeof value.schemaVersion !== 'number' ||
    value.schemaVersion > PROJECT_DOCUMENT_SCHEMA_VERSION ||
    !Array.isArray(value.revisions) ||
    !value.revisions.every(isRevisionRecord) ||
    !Array.isArray(value.checkpoints) ||
    value.checkpoints.length > MAX_PROJECT_CHECKPOINTS ||
    !value.checkpoints.every(isProjectCheckpoint)
  ) {
    return {
      code: 'document-invalid',
      message: 'Collaboration document history or schema version is invalid.'
    };
  }
  return null;
}

const documentEncoder = new TextEncoder();

/** Rejects a document that would not fit in one durable-storage value. */
function checkPersistedSize(
  document: ProjectDocument
): CollaborationRejection | null {
  const bytes = documentEncoder.encode(JSON.stringify(document)).byteLength;
  return bytes > MAX_PERSISTED_DOCUMENT_BYTES
    ? {
        code: 'document-too-large',
        message: `Collaboration document is ${bytes} bytes; the room stores at most ${MAX_PERSISTED_DOCUMENT_BYTES}.`
      }
    : null;
}

/**
 * Builds the acknowledgement for an accepted submission.
 *
 * The resolved document only reaches other clients through a broadcast that
 * skips the sender, so whenever resolution produced something other than what
 * the sender submitted it has to travel back on the ack. A differing version is
 * exactly that signal: `accept` hands back the submitted document unchanged,
 * `same` hands back a content-identical document at the same version, and only
 * a merge mints a new version.
 */
function ackFor(
  resolved: ProjectDocument,
  submitted: ProjectDocument
): CollaborationServerMessage {
  return resolved.version === submitted.version
    ? { type: 'ack', version: resolved.version }
    : { type: 'ack', version: resolved.version, document: resolved };
}

export function resolveCollaborationDocument(
  latest: ProjectDocument | null,
  incoming: ProjectDocument,
  base?: ProjectDocument
):
  | { kind: 'accept'; document: ProjectDocument }
  | { kind: 'same'; document: ProjectDocument }
  | { kind: 'conflict'; document: ProjectDocument } {
  if (!latest) {
    return { kind: 'accept', document: incoming };
  }
  if (
    base &&
    base.projectId === latest.projectId &&
    base.projectId === incoming.projectId &&
    base.version < latest.version &&
    base.version < incoming.version
  ) {
    const merged = mergeCollaborationDocuments(base, latest, incoming);
    if (merged) {
      return { kind: 'accept', document: merged };
    }
  }
  if (incoming.version > latest.version) {
    return { kind: 'accept', document: incoming };
  }
  const sameHistory =
    incoming.version === latest.version &&
    JSON.stringify({
      nodes: incoming.nodes,
      featureOrder: incoming.featureOrder,
      bodyOrder: incoming.bodyOrder,
      sketchOrder: incoming.sketchOrder,
      parameterOrder: incoming.parameterOrder,
      commandLog: incoming.commandLog
    }) ===
      JSON.stringify({
        nodes: latest.nodes,
        featureOrder: latest.featureOrder,
        bodyOrder: latest.bodyOrder,
        sketchOrder: latest.sketchOrder,
        parameterOrder: latest.parameterOrder,
        commandLog: latest.commandLog
      });
  return sameHistory
    ? { kind: 'same', document: latest }
    : { kind: 'conflict', document: latest };
}

const MERGE_CONFLICT = Symbol('collaboration-merge-conflict');
type JsonMergeValue =
  | null
  | boolean
  | number
  | string
  | undefined
  | JsonMergeValue[]
  | { [key: string]: JsonMergeValue };

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasJsonPrefix(values: unknown[], prefix: unknown[]): boolean {
  return (
    values.length >= prefix.length &&
    prefix.every((value, index) => sameJson(value, values[index]))
  );
}

function mergeJsonValue(
  base: unknown,
  latest: unknown,
  incoming: unknown
): JsonMergeValue | typeof MERGE_CONFLICT {
  if (sameJson(latest, incoming)) {
    return structuredClone(latest) as JsonMergeValue;
  }
  if (sameJson(base, latest)) {
    return structuredClone(incoming) as JsonMergeValue;
  }
  if (sameJson(base, incoming)) {
    return structuredClone(latest) as JsonMergeValue;
  }
  if (Array.isArray(base) && Array.isArray(latest) && Array.isArray(incoming)) {
    if (!hasJsonPrefix(latest, base) || !hasJsonPrefix(incoming, base)) {
      return MERGE_CONFLICT;
    }
    const merged = structuredClone(latest) as JsonMergeValue[];
    for (const value of incoming.slice(base.length)) {
      if (!merged.some((candidate) => sameJson(candidate, value))) {
        merged.push(structuredClone(value) as JsonMergeValue);
      }
    }
    return merged;
  }
  if (isRecord(base) && isRecord(latest) && isRecord(incoming)) {
    const merged: { [key: string]: JsonMergeValue } = {};
    const keys = new Set([
      ...Object.keys(base),
      ...Object.keys(latest),
      ...Object.keys(incoming)
    ]);
    for (const key of keys) {
      const value = mergeJsonValue(base[key], latest[key], incoming[key]);
      if (value === MERGE_CONFLICT) {
        return MERGE_CONFLICT;
      }
      if (value !== undefined) {
        merged[key] = value;
      }
    }
    return merged;
  }
  return MERGE_CONFLICT;
}

export function mergeCollaborationDocuments(
  base: ProjectDocument,
  latest: ProjectDocument,
  incoming: ProjectDocument
): ProjectDocument | null {
  const withoutVolatileState = (document: ProjectDocument) => {
    const { version: _version, derived: _derived, ...stable } = document;
    return stable;
  };
  const merged = mergeJsonValue(
    withoutVolatileState(base),
    withoutVolatileState(latest),
    withoutVolatileState(incoming)
  );
  if (merged === MERGE_CONFLICT || !isRecord(merged)) {
    return null;
  }
  return normalizeDocument({
    ...merged,
    version: Math.max(latest.version, incoming.version) + 1,
    derived: {
      bodyRepresentations: {},
      exportableBodyIds: [],
      warnings: [],
      updatedAt: nowIso()
    }
  } as unknown as ProjectDocument);
}
