import type {
  AccountDeletionPreview,
  AccountDeletionScope,
  AuthSession,
  DeleteAccountDataRequest,
  DeleteAccountDataResponse,
  ProjectId,
  UserId
} from '@openzcad/shared';
import type {
  CloudflareEnv,
  ProjectCollaborationRoom
} from '@openzcad/cloudflare-adapters';
import type { PersistenceService } from '@openzcad/persistence';
import { authEmailRateLimitBucket } from './auth';
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

async function ownedProjectIds(
  db: D1Database,
  userId: UserId
): Promise<ProjectId[]> {
  const rows = await db
    .prepare(`SELECT id FROM projects WHERE user_id = ? ORDER BY id`)
    .bind(userId)
    .all<{ id: ProjectId }>();
  return (rows.results ?? []).map((row) => row.id);
}

async function eraseProjectRooms(
  env: AccountDeletionEnv,
  projectIds: readonly ProjectId[]
): Promise<void> {
  for (const projectId of projectIds) {
    const response = await env.PROJECT_ROOM!.getByName(projectId).fetch(
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

function profileCleanupStatements(
  db: D1Database,
  userId: UserId,
  email: string | undefined,
  authRateBucket: string | undefined,
  scope: 'profile' | 'all'
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
        .prepare(`DELETE FROM auth_rate_limits WHERE bucket = ?`)
        .bind(authRateBucket)
    );
  }
  statements.push(
    db.prepare(`DELETE FROM user_settings WHERE user_id = ?`).bind(userId),
    db
      .prepare(`DELETE FROM user_ai_credentials WHERE user_id = ?`)
      .bind(userId),
    db.prepare(`DELETE FROM auth_sessions WHERE user_id = ?`).bind(userId),
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
  let deletedProjectIds: ProjectId[] = [];
  if (input.scope === 'projects' || input.scope === 'all') {
    const before = await ownedProjectIds(db, session.userId);
    await eraseProjectRooms(env, before);
    const removed = await persistence.deleteOwnedProjects(session.userId);
    deletedProjectIds = Array.from(new Set<ProjectId>([...before, ...removed]));
    if ((await ownedProjectIds(db, session.userId)).length > 0) {
      throw new Error('Owned cloud projects remain after deletion.');
    }
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
    await db.batch(
      profileCleanupStatements(
        db,
        session.userId,
        email,
        authRateBucket,
        input.scope
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
