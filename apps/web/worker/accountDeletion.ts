import { e2eeErasureTables } from './e2ee';
import { contactErasureStatements } from './e2eeContacts';
import { invitationErasureStatements } from './e2eeInvitations';
import { proposalErasureStatements } from './e2eeProposals';
import { shareLinkErasureStatements } from './e2eeShareLinks';
import { projectGroupErasureStatements } from './e2eeProjects';
import { assistantConsentErasureStatements } from './e2eeAssistantConsents';
import { deviceRemovalErasureStatements } from './e2eeDeviceRemoval';
import { projectMigrationErasureStatements } from './e2eeProjectMigrations';
import { projectVersionErasureStatements } from './e2eeProjectDocuments';
import {
  isE2eeProjectPreferenceStorageReady,
  projectPreferenceErasureStatement
} from './e2eeProjectPreferences';
import type {
  AccountDeletionPreview,
  AccountDeletionScope,
  AuthSession,
  DeleteAccountDataRequest,
  DeleteAccountDataResponse,
  ProjectId,
  UserId
} from '@openzcad/shared';
import {
  isProjectInstanceReady,
  type CloudflareEnv,
  type ProjectCollaborationRoom
} from '@openzcad/cloudflare-adapters';
import type {
  OwnedProjectInstance,
  PersistenceService
} from '@openzcad/persistence';
import {
  authEmailRateLimitBucket,
  authKnownDeviceAllowanceBucket
} from './auth';
import { libraryFolderErasureStatements } from './libraryFolderSets';
import {
  isAccountErasureReady,
  isProjectObjectStorageReady
} from './readiness';

export class AccountDeletionError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string
  ) {
    super(message);
    this.name = 'AccountDeletionError';
  }
}

type AccountDeletionEnv = CloudflareEnv & {
  PROJECT_ROOM?: DurableObjectNamespace<ProjectCollaborationRoom>;
};

const DEVELOPMENT_CONFIRMATIONS: Record<AccountDeletionScope, string> = {
  profile: 'DELETE CLOUD PROFILE',
  projects: 'DELETE CLOUD PROJECTS',
  all: 'DELETE ALL CLOUD DATA'
};

async function assertDeletionStorageReady(
  scope: AccountDeletionScope,
  env: AccountDeletionEnv
): Promise<void> {
  if (
    scope !== 'profile' &&
    (!env.PROJECT_ROOM ||
      !(await isProjectObjectStorageReady(
        env.DB,
        env.PROJECT_STORAGE ?? env.ARTIFACTS
      )))
  ) {
    throw new AccountDeletionError(
      503,
      'PROJECT_ERASURE_UNAVAILABLE',
      'Cloud project deletion is temporarily unavailable. No cloud data was deleted.'
    );
  }
}

function parseScope(value: unknown): AccountDeletionScope {
  if (value === 'profile' || value === 'projects' || value === 'all') {
    return value;
  }
  throw new AccountDeletionError(
    400,
    'ACCOUNT_DELETION_SCOPE_INVALID',
    'Choose which cloud data to delete.'
  );
}

function parseDeletionRequest(value: unknown): DeleteAccountDataRequest {
  const input =
    value && typeof value === 'object'
      ? (value as Record<string, unknown>)
      : {};
  return {
    scope: parseScope(input.scope),
    confirmation:
      typeof input.confirmation === 'string' ? input.confirmation : ''
  };
}

function confirmationFor(
  session: AuthSession,
  scope: AccountDeletionScope
): Pick<AccountDeletionPreview, 'confirmationKind' | 'confirmationText'> {
  const email = session.email?.trim().toLowerCase();
  return email
    ? { confirmationKind: 'email', confirmationText: email }
    : {
        confirmationKind: 'phrase',
        confirmationText: DEVELOPMENT_CONFIRMATIONS[scope]
      };
}

function confirmationMatches(
  actual: string,
  expected: Pick<
    AccountDeletionPreview,
    'confirmationKind' | 'confirmationText'
  >
): boolean {
  const trimmed = actual.trim();
  return expected.confirmationKind === 'email'
    ? trimmed.toLowerCase() === expected.confirmationText
    : trimmed === expected.confirmationText;
}

export async function accountDeletionPreview(
  session: AuthSession,
  scopeValue: unknown,
  env: AccountDeletionEnv,
  persistence: PersistenceService
): Promise<AccountDeletionPreview> {
  const scope = parseScope(scopeValue);
  if (!(await isAccountErasureReady(env.DB))) {
    throw new AccountDeletionError(
      503,
      'ACCOUNT_DELETION_UNAVAILABLE',
      'Cloud data deletion is temporarily unavailable.'
    );
  }
  await assertDeletionStorageReady(scope, env);
  // Includes encrypted projects' heads and named saves (ADR-024 Phase 4),
  // which are erased with the rest.
  const usage = await persistence.getStorageUsage(session.userId);
  const collaborators = await env
    .DB!.prepare(
      `SELECT COUNT(*) AS collaborator_count
     FROM project_members
     JOIN projects ON projects.id = project_members.project_id
     WHERE projects.user_id = ?`
    )
    .bind(session.userId)
    .first<{ collaborator_count: number }>();
  return {
    ...confirmationFor(session, scope),
    projectCount: usage.projectCount,
    documentBytes: usage.documentBytes,
    revisionBytes: usage.revisionBytes,
    revisionCount: usage.revisionCount,
    collaboratorCount: collaborators?.collaborator_count ?? 0
  };
}

export async function assertAccountNotErasing(
  db: D1Database | undefined,
  userId: UserId
): Promise<void> {
  if (!db) {
    return;
  }
  try {
    const row = await db
      .prepare(`SELECT scope FROM account_erasure_requests WHERE user_id = ?`)
      .bind(userId)
      .first<{ scope: AccountDeletionScope }>();
    if (row) {
      throw new AccountDeletionError(
        409,
        'ACCOUNT_ERASURE_IN_PROGRESS',
        'Cloud data deletion is already in progress. Retry that deletion before making other cloud changes.'
      );
    }
  } catch (error) {
    if (error instanceof AccountDeletionError) {
      throw error;
    }
    // Migration 0014 is independently rolled out. Older Workers keep their
    // existing cloud behavior while the destructive endpoints remain closed.
  }
}

async function beginErasure(
  db: D1Database,
  userId: UserId,
  scope: AccountDeletionScope
): Promise<void> {
  const timestamp = Math.floor(Date.now() / 1_000);
  const result = await db
    .prepare(
      `INSERT INTO account_erasure_requests
         (user_id, scope, started_at, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET updated_at = excluded.updated_at
       WHERE account_erasure_requests.scope = excluded.scope`
    )
    .bind(userId, scope, timestamp, timestamp)
    .run();
  if (result.meta?.changes === 1) {
    return;
  }
  const existing = await db
    .prepare(`SELECT scope FROM account_erasure_requests WHERE user_id = ?`)
    .bind(userId)
    .first<{ scope: AccountDeletionScope }>();
  if (existing?.scope === scope) {
    return;
  }
  throw new AccountDeletionError(
    409,
    'ACCOUNT_ERASURE_SCOPE_CONFLICT',
    `Finish the existing ${existing?.scope ?? 'cloud data'} deletion before starting a different one.`
  );
}

/**
 * The account's projects, each with its instance (migration 0052): listed
 * once, and then the only projects this erasure attempt touches, so a
 * project created again under one of their ids is never erased by it.
 */
async function ownedProjectInstances(
  db: D1Database,
  userId: UserId
): Promise<OwnedProjectInstance[]> {
  const instances = await isProjectInstanceReady(db);
  const rows = await db
    .prepare(
      `SELECT p.id, ${
        instances
          ? `(SELECT i.instance_id FROM project_instances i
              WHERE i.project_id = p.id)`
          : 'NULL'
      } AS instance_id
       FROM projects p WHERE p.user_id = ? ORDER BY p.id`
    )
    .bind(userId)
    .all<{ id: string; instance_id: string | null }>();
  return (rows.results ?? []).map((row) => ({
    projectId: row.id,
    instance: row.instance_id
  }));
}

/** Which of `listed` still exist as the very instance listed. */
async function remainingInstances(
  db: D1Database,
  userId: UserId,
  listed: readonly OwnedProjectInstance[]
): Promise<OwnedProjectInstance[]> {
  const now = await ownedProjectInstances(db, userId);
  return now.filter((row) =>
    listed.some(
      (item) =>
        item.projectId === row.projectId &&
        (item.instance ?? '') === (row.instance ?? '')
    )
  );
}

/**
 * Whether this erasure request (by its `started_at`, migration 0014) is
 * still the one in progress: a retry that completed it removed its row, so
 * a stale attempt that resumes afterwards stops instead of continuing.
 */
async function erasureStillCurrent(
  db: D1Database,
  userId: UserId,
  startedAt: number | null
): Promise<boolean> {
  if (startedAt === null) return true;
  return !!(await db
    .prepare(
      `SELECT 1 AS current FROM account_erasure_requests
       WHERE user_id = ? AND started_at = ?`
    )
    .bind(userId, startedAt)
    .first<{ current: number }>());
}

async function eraseProjectRooms(
  env: AccountDeletionEnv,
  projects: readonly OwnedProjectInstance[]
): Promise<void> {
  for (const { projectId, instance } of projects) {
    const response = await env.PROJECT_ROOM!.getByName(projectId).fetch(
      new Request(
        `https://project-room.internal/?projectId=${encodeURIComponent(projectId)}`,
        {
          method: 'DELETE',
          headers: {
            'x-openzcad-internal-project-erasure': 'v1',
            // The room erases only while it serves this very instance.
            ...(instance ? { 'x-openzcad-project-instance': instance } : {})
          }
        }
      )
    );
    if (!response.ok) {
      throw new Error(`Project room erasure failed for ${projectId}.`);
    }
  }
}

function profileCleanupStatements(
  db: D1Database,
  userId: UserId,
  email: string | undefined,
  authRateBucket: string | undefined,
  scope: 'profile' | 'all',
  e2eeTables: readonly string[],
  e2eeProjectPreferencesReady = false,
  projectGroupStatements: readonly D1PreparedStatement[] = []
): D1PreparedStatement[] {
  const statements: D1PreparedStatement[] = [];
  if (email) {
    statements.push(
      db
        .prepare(
          `UPDATE project_access_events SET invitation_id = NULL
           WHERE invitation_id IN (
             SELECT id FROM project_invitations
             WHERE email = ? OR accepted_by_user_id = ?
           )`
        )
        .bind(email, userId),
      db
        .prepare(
          `DELETE FROM project_invitations
           WHERE email = ? OR accepted_by_user_id = ?`
        )
        .bind(email, userId),
      db
        .prepare(`DELETE FROM auth_email_challenges WHERE email = ?`)
        .bind(email)
    );
  }
  if (authRateBucket) {
    statements.push(
      db
        // Requester buckets share this opaque email prefix. Erase them with
        // the pending challenges, while keeping the shared IP limiter intact.
        .prepare(
          `DELETE FROM auth_rate_limits
           WHERE bucket = ? OR bucket GLOB ? OR bucket GLOB ?`
        )
        .bind(
          authRateBucket,
          `${authRateBucket}:ip:*`,
          authKnownDeviceAllowanceBucket(authRateBucket, '*')
        )
    );
  }
  if (e2eeProjectPreferencesReady) {
    // The "Encrypt new projects" opt-in (migration 0031) is profile data too.
    statements.push(projectPreferenceErasureStatement(db, userId));
  }
  // Encrypted projects' key wraps and leaf certifications (migration 0032).
  statements.push(...projectGroupStatements);
  // End-to-end encryption keys are profile data: device labels and public
  // keys besides the wrapped keys and the account-key history. The users row
  // survives a profile deletion, so its cascade cannot be relied on here.
  // Every key table that exists, children first.
  statements.push(
    ...e2eeTables.map((table) =>
      db.prepare(`DELETE FROM ${table} WHERE user_id = ?`).bind(userId)
    )
  );
  statements.push(
    db.prepare(`DELETE FROM user_settings WHERE user_id = ?`).bind(userId),
    db
      .prepare(`DELETE FROM user_ai_credentials WHERE user_id = ?`)
      .bind(userId),
    db.prepare(`DELETE FROM auth_sessions WHERE user_id = ?`).bind(userId),
    db
      .prepare('DELETE FROM auth_rate_limits WHERE bucket IN (?, ?)')
      .bind(`api:${userId}`, `api-read:${userId}`),
    db
      .prepare(`DELETE FROM desktop_auth_attempts WHERE user_id = ?`)
      .bind(userId),
    db
      .prepare(`DELETE FROM desktop_refresh_tokens WHERE user_id = ?`)
      .bind(userId),
    db
      .prepare(`DELETE FROM desktop_access_tokens WHERE user_id = ?`)
      .bind(userId),
    db
      .prepare(`DELETE FROM ai_rate_limits WHERE user_id = ?`)
      .bind(`account:${userId}`),
    db
      .prepare(`DELETE FROM ai_concurrency_leases WHERE account_bucket = ?`)
      .bind(`account:${userId}`)
  );
  if (scope === 'all') {
    statements.push(
      db
        .prepare('DELETE FROM project_workspace_sessions WHERE user_id = ?')
        .bind(userId),
      db
        .prepare('DELETE FROM project_adoptions WHERE user_id = ?')
        .bind(userId),
      db
        .prepare(`DELETE FROM artifact_account_usage WHERE owner_user_id = ?`)
        .bind(userId),
      db
        .prepare(
          `UPDATE project_access_events SET invitation_id = NULL
           WHERE invitation_id IN (
             SELECT id FROM project_invitations WHERE invited_by_user_id = ?
           )`
        )
        .bind(userId),
      db
        .prepare(`DELETE FROM project_invitations WHERE invited_by_user_id = ?`)
        .bind(userId),
      db
        .prepare(
          `UPDATE project_access_events SET share_link_id = NULL
           WHERE share_link_id IN (
             SELECT id FROM project_share_links WHERE created_by_user_id = ?
           )`
        )
        .bind(userId),
      db
        .prepare(`DELETE FROM project_share_links WHERE created_by_user_id = ?`)
        .bind(userId),
      db
        .prepare(
          `DELETE FROM project_members
           WHERE user_id = ? OR added_by_user_id = ?`
        )
        .bind(userId, userId),
      db
        .prepare(
          `UPDATE project_access_events
           SET actor_user_id = CASE WHEN actor_user_id = ? THEN NULL ELSE actor_user_id END,
               subject_user_id = CASE WHEN subject_user_id = ? THEN NULL ELSE subject_user_id END
           WHERE actor_user_id = ? OR subject_user_id = ?`
        )
        .bind(userId, userId, userId, userId),
      db
        .prepare(
          `UPDATE revisions SET author_user_id = NULL WHERE author_user_id = ?`
        )
        .bind(userId),
      db.prepare(`DELETE FROM users WHERE id = ?`).bind(userId)
    );
  } else {
    statements.push(
      db.prepare(`UPDATE users SET email = NULL WHERE id = ?`).bind(userId)
    );
  }
  statements.push(
    db
      .prepare(`DELETE FROM account_erasure_requests WHERE user_id = ?`)
      .bind(userId)
  );
  return statements;
}

export async function deleteAccountData(
  session: AuthSession,
  body: unknown,
  env: AccountDeletionEnv,
  persistence: PersistenceService
): Promise<DeleteAccountDataResponse> {
  const input = parseDeletionRequest(body);
  if (!(await isAccountErasureReady(env.DB))) {
    throw new AccountDeletionError(
      503,
      'ACCOUNT_DELETION_UNAVAILABLE',
      'Cloud data deletion is temporarily unavailable.'
    );
  }
  await assertDeletionStorageReady(input.scope, env);
  const expected = confirmationFor(session, input.scope);
  if (!confirmationMatches(input.confirmation, expected)) {
    throw new AccountDeletionError(
      400,
      'ACCOUNT_DELETION_CONFIRMATION_MISMATCH',
      `Type ${expected.confirmationKind === 'email' ? 'your email address' : 'the confirmation phrase'} exactly to continue.`
    );
  }

  const db = env.DB!;
  await beginErasure(db, session.userId, input.scope);
  // This attempt's request, by when it started: an overlapping retry that
  // completes the request removes it, and this attempt then stops.
  const startedAt =
    (
      await db
        .prepare(
          `SELECT started_at FROM account_erasure_requests WHERE user_id = ?`
        )
        .bind(session.userId)
        .first<{ started_at: number }>()
    )?.started_at ?? null;
  const completedElsewhere = (projectIds: ProjectId[]) =>
    ({
      ok: true,
      scope: input.scope,
      deletedProjectIds: projectIds,
      signedOut: input.scope !== 'projects'
    }) satisfies DeleteAccountDataResponse;
  let deletedProjectIds: ProjectId[] = [];
  if (input.scope === 'projects' || input.scope === 'all') {
    const before = await ownedProjectInstances(db, session.userId);
    const beforeIds = before.map((row) => row.projectId as ProjectId);
    await eraseProjectRooms(env, before);
    if (!(await erasureStillCurrent(db, session.userId, startedAt))) {
      return completedElsewhere(beforeIds);
    }
    const removed = await persistence.deleteOwnedProjects(
      session.userId,
      before
    );
    deletedProjectIds = Array.from(
      new Set<ProjectId>([...beforeIds, ...removed])
    );
    if ((await remainingInstances(db, session.userId, before)).length > 0) {
      throw new Error('Owned cloud projects remain after deletion.');
    }
  }
  if (!(await erasureStillCurrent(db, session.userId, startedAt))) {
    return completedElsewhere(deletedProjectIds);
  }

  if (input.scope === 'projects') {
    await db
      .prepare(`DELETE FROM account_erasure_requests WHERE user_id = ?`)
      .bind(session.userId)
      .run();
  } else {
    const email = session.email?.trim().toLowerCase();
    const authRateBucket =
      email && env.AUTH_OTP_PEPPER
        ? await authEmailRateLimitBucket(email, env.AUTH_OTP_PEPPER)
        : undefined;
    // Before migration 0029 the tables do not exist, and before 0030 the
    // history table does not; deletion must keep working either way.
    const e2eeTables = await e2eeErasureTables(db);
    await db.batch(
      profileCleanupStatements(
        db,
        session.userId,
        email,
        authRateBucket,
        input.scope,
        e2eeTables,
        // Before migration 0031 there is no opt-in table.
        await isE2eeProjectPreferenceStorageReady(db),
        // Before migration 0032 there are no MLS group tables, and before
        // 0033 no version tables.
        [
          ...(await projectGroupErasureStatements(
            db,
            session.userId,
            input.scope
          )),
          ...(await projectVersionErasureStatements(
            db,
            session.userId,
            input.scope
          )),
          // Before migration 0036 there are no revocation cutoffs.
          ...(await deviceRemovalErasureStatements(db, session.userId)),
          // Before migration 0037 there is no contacts table; its rows go
          // before the identities they reference, and only beside them.
          ...(e2eeTables.length > 0
            ? await contactErasureStatements(db, session.userId)
            : []),
          // Library folders are profile data (migration 0045), when the
          // table exists.
          ...(await libraryFolderErasureStatements(db, session.userId)),
          // Assistant consents (migration 0041), when the table exists.
          ...(await assistantConsentErasureStatements(db, session.userId)),
          // Encrypted invitations this account received, its KeyPackages
          // and Welcomes (migration 0038), when the tables exist.
          ...(await invitationErasureStatements(db, session.userId, email)),
          // Proposals it sent in other owners' projects lose their sender
          // (migration 0039), when the table exists.
          ...(await proposalErasureStatements(db, session.userId, input.scope)),
          // The account's share delegation, and with `all` its user id on
          // share-link rows in other owners' projects (migration 0040).
          ...(await shareLinkErasureStatements(
            db,
            session.userId,
            input.scope
          )),
          // Before migration 0042 there is no migration state.
          ...(await projectMigrationErasureStatements(
            db,
            session.userId,
            input.scope
          ))
        ]
      )
    );
  }

  return {
    ok: true,
    scope: input.scope,
    deletedProjectIds,
    signedOut: input.scope !== 'projects'
  };
}
