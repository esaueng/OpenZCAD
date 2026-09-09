import {
  MAX_WORKSPACE_SESSION_BYTES,
  parseWorkspaceResumeState,
  type ProjectWorkspaceSession
} from '@openzcad/shared';
import { HttpError } from './validation';

export function parseWorkspaceSession(
  value: unknown,
  projectId: string
): Omit<ProjectWorkspaceSession, 'updatedAt'> {
  const input = value as Partial<ProjectWorkspaceSession> | null;
  const state = parseWorkspaceResumeState(input?.state);
  if (
    !input ||
    input.schemaVersion !== 1 ||
    input.projectId !== projectId ||
    !state ||
    !/^[a-zA-Z0-9_-]{1,80}$/.test(input.deviceId ?? '') ||
    !/^[a-zA-Z0-9_-]{1,80}$/.test(input.sessionId ?? '') ||
    !['Desktop', 'Mobile'].includes(input.deviceLabel ?? '') ||
    !Number.isSafeInteger(input.sequence) ||
    Number(input.sequence) < 1 ||
    !Number.isSafeInteger(input.documentVersion) ||
    Number(input.documentVersion) < 1 ||
    new TextEncoder().encode(JSON.stringify(value)).byteLength >
      MAX_WORKSPACE_SESSION_BYTES
  ) {
    throw new HttpError(400, 'Invalid workspace session.');
  }
  return {
    schemaVersion: 1,
    projectId,
    deviceId: input.deviceId!,
    sessionId: input.sessionId!,
    deviceLabel: input.deviceLabel!,
    sequence: input.sequence!,
    documentVersion: input.documentVersion!,
    state
  };
}

export async function loadWorkspaceSessions(
  db: D1Database,
  userId: string,
  projectId: string
): Promise<ProjectWorkspaceSession[]> {
  const rows = await db
    .prepare(
      `SELECT record_json, updated_at FROM project_workspace_sessions
    WHERE user_id = ? AND project_id = ? AND updated_at > ? ORDER BY updated_at DESC LIMIT 20`
    )
    .bind(
      userId,
      projectId,
      new Date(Date.now() - 30 * 86400_000).toISOString()
    )
    .all<{ record_json: string; updated_at: string }>();
  return (rows.results ?? []).map((row) => ({
    ...parseWorkspaceSession(JSON.parse(row.record_json), projectId),
    updatedAt: row.updated_at
  }));
}

export async function saveWorkspaceSession(
  db: D1Database,
  userId: string,
  input: Omit<ProjectWorkspaceSession, 'updatedAt'>
): Promise<void> {
  const now = new Date().toISOString();
  const result = await db
    .prepare(
      `INSERT INTO project_workspace_sessions
    (user_id, project_id, session_id, device_id, sequence, record_json, updated_at)
    SELECT ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM projects WHERE id = ? AND document_version >= ?)
    ON CONFLICT(user_id, project_id, session_id) DO UPDATE SET
      sequence = excluded.sequence, record_json = excluded.record_json, updated_at = excluded.updated_at
    WHERE excluded.sequence > project_workspace_sessions.sequence AND excluded.device_id = project_workspace_sessions.device_id`
    )
    .bind(
      userId,
      input.projectId,
      input.sessionId,
      input.deviceId,
      input.sequence,
      JSON.stringify(input),
      now,
      input.projectId,
      input.documentVersion
    )
    .run();
  if (!result.meta?.changes) {
    const existing = await db
      .prepare(
        `SELECT sequence FROM project_workspace_sessions WHERE user_id = ? AND project_id = ? AND session_id = ?`
      )
      .bind(userId, input.projectId, input.sessionId)
      .first<{ sequence: number }>();
    if (!existing || existing.sequence < input.sequence)
      throw new HttpError(
        409,
        'Sync the project before saving its workspace session.'
      );
  }
  await db
    .prepare(
      `DELETE FROM project_workspace_sessions WHERE user_id = ? AND project_id = ? AND session_id NOT IN
    (SELECT session_id FROM project_workspace_sessions WHERE user_id = ? AND project_id = ? ORDER BY updated_at DESC LIMIT 20)`
    )
    .bind(userId, input.projectId, userId, input.projectId)
    .run();
}
