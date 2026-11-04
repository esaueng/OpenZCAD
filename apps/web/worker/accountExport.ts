import {
  createPersistenceService,
  projectCollaborationRollout,
  isShareLinkLabelReady,
  type CloudflareEnv
} from '@openzcad/cloudflare-adapters';
import {
  ProjectNotFoundError,
  type PersistenceService
} from '@openzcad/persistence';
import type { AuthSession } from '@openzcad/shared';

/** Explicit projections keep credentials, token hashes and other users' data
 * out of the export. Project contents travel through the existing authorized
 * readers, and encrypted contents are opened only in the browser.
 */
export async function exportAccountData(
  session: AuthSession,
  env: CloudflareEnv,
  persistence: Pick<
    PersistenceService,
    'requireProjectRead'
  > = createPersistenceService({
    ...env,
    PROJECT_SHARING_ENABLED: String(
      projectCollaborationRollout(env, session.email).sharingEnabled
    )
  })
): Promise<Record<string, unknown>> {
  if (!env.DB) return { profile: session, records: {} };
  const db = env.DB;
  const tables = new Set(
    (
      await db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all<{ name: string }>()
    ).results?.map((row) => row.name) ?? []
  );
  const owned = 'SELECT id FROM projects WHERE user_id = ?';
  const shareLinkLabel = (await isShareLinkLabelReady(db)) ? 'label, ' : '';
  const queries: [string, string, unknown[]][] = [
    [
      'users',
      'SELECT id, email, created_at FROM users WHERE id = ?',
      [session.userId]
    ],
    [
      'user_settings',
      'SELECT settings_json, revision, updated_at FROM user_settings WHERE user_id = ?',
      [session.userId]
    ],
    [
      'library_folder_sets',
      'SELECT format, revision, record, updated_at FROM library_folder_sets WHERE user_id = ?',
      [session.userId]
    ],
    [
      'user_ai_credentials',
      'SELECT token_hint, updated_at, last_validated_at FROM user_ai_credentials WHERE user_id = ?',
      [session.userId]
    ],
    [
      'auth_sessions',
      'SELECT created_at, expires_at FROM auth_sessions WHERE user_id = ?',
      [session.userId]
    ],
    [
      'desktop_refresh_tokens',
      'SELECT client_id, created_at, expires_at, rotated_at, revoked_at FROM desktop_refresh_tokens WHERE user_id = ?',
      [session.userId]
    ],
    [
      'desktop_access_tokens',
      'SELECT client_id, created_at, expires_at, revoked_at FROM desktop_access_tokens WHERE user_id = ?',
      [session.userId]
    ],
    [
      'glimpse_account_consent',
      'SELECT expires_at FROM glimpse_account_consent WHERE user_id = ?',
      [session.userId]
    ],
    [
      'project_members',
      `SELECT project_id, user_id, role, added_by_user_id, created_at, updated_at FROM project_members WHERE user_id = ? OR project_id IN (${owned})`,
      [session.userId, session.userId]
    ],
    [
      'project_invitations',
      `SELECT id, project_id, email, role, invited_by_user_id, accepted_by_user_id, created_at, expires_at, accepted_at, revoked_at FROM project_invitations WHERE invited_by_user_id = ? OR accepted_by_user_id = ? OR email = ? OR project_id IN (${owned})`,
      [
        session.userId,
        session.userId,
        session.email?.toLowerCase() ?? '',
        session.userId
      ]
    ],
    [
      'project_share_links',
      `SELECT id, project_id, mode, ${shareLinkLabel}created_by_user_id, created_at, revoked_at FROM project_share_links WHERE project_id IN (${owned})`,
      [session.userId]
    ],
    [
      'project_access_events',
      `SELECT id, project_id, actor_user_id, subject_user_id, event_type, previous_role, next_role, created_at FROM project_access_events WHERE actor_user_id = ? OR subject_user_id = ? OR project_id IN (${owned})`,
      [session.userId, session.userId, session.userId]
    ],
    [
      'project_workspace_sessions',
      'SELECT project_id, record_json, updated_at FROM project_workspace_sessions WHERE user_id = ?',
      [session.userId]
    ],
    [
      'project_measurements',
      `SELECT project_id, payload_json, revision, updated_at FROM project_measurements WHERE project_id IN (${owned}) OR project_id IN (SELECT project_id FROM project_members WHERE user_id = ?)`,
      [session.userId, session.userId]
    ],
    [
      'e2ee_contact_entries',
      'SELECT generation, sequence, entry, signature, entry_hash, created_at FROM e2ee_contact_entries WHERE user_id = ?',
      [session.userId]
    ]
  ];
  const records: Record<string, unknown[]> = {};
  // Sequential queries avoid holding many D1 response buffers at once.
  for (const [table, sql, bindings] of queries) {
    if (!tables.has(table)) continue;
    const rows =
      (
        await db
          .prepare(sql)
          .bind(...bindings)
          .all()
      ).results ?? [];
    if (table === 'project_measurements') {
      const readable = [];
      for (const row of rows) {
        if (typeof row.project_id !== 'string')
          throw new Error('Invalid measurement project ID.');
        try {
          // Reuse the same owner, membership, Trash and sharing-preference
          // authorization as the project's measurement endpoint.
          await persistence.requireProjectRead(session.userId, row.project_id);
          readable.push(row);
        } catch (error) {
          if (!(error instanceof ProjectNotFoundError)) throw error;
        }
      }
      records[table] = readable;
    } else records[table] = rows;
  }
  return { profile: session, records };
}
