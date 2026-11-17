import {
  MAX_PROJECT_COMMENTS,
  normalizeProjectCommentText,
  parseProjectCommentAnchor,
  type CreateProjectCommentRequest,
  type ProjectAccessRole,
  type ProjectComment
} from '@openzcad/shared';

/**
 * L08 review comments on plaintext projects (migration 0058). Every member
 * may read and write; a thread is resolved by its author, an editor or the
 * owner, and a comment is deleted by its author or the owner. The routes
 * refuse encrypted projects before reaching here (`assertPlaintextProject`):
 * an encrypted project's comments are never stored in plaintext.
 */

export class ProjectCommentRequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string
  ) {
    super(message);
    this.name = 'ProjectCommentRequestError';
  }
}

export interface CommentActor {
  userId: string;
  name: string;
  role: ProjectAccessRole;
}

interface CommentRow {
  id: string;
  project_id: string;
  parent_id: string | null;
  author_user_id: string | null;
  author_name: string;
  body_text: string;
  anchor_json: string | null;
  created_at: string;
  resolved_at: string | null;
  resolved_by_name: string | null;
}

const COMMENT_COLUMNS = `id, project_id, parent_id, author_user_id, author_name,
  body_text, anchor_json, created_at, resolved_at, resolved_by_name`;

/** Whether migration 0058 has been applied where this Worker runs. */
export async function isProjectCommentStorageReady(
  db: D1Database | undefined
): Promise<boolean> {
  if (!db) return false;
  const row = await db
    .prepare(
      `SELECT 1 AS ready FROM sqlite_master
       WHERE type = 'table' AND name = 'project_comments'`
    )
    .first<{ ready: number }>();
  return row?.ready === 1;
}

function toComment(row: CommentRow): ProjectComment {
  return {
    commentId: row.id,
    projectId: row.project_id,
    parentId: row.parent_id,
    anchor: row.anchor_json
      ? parseProjectCommentAnchor(JSON.parse(row.anchor_json))
      : null,
    text: row.body_text,
    authorUserId: row.author_user_id,
    authorName: row.author_name,
    createdAt: row.created_at,
    resolvedAt: row.resolved_at,
    resolvedByName: row.resolved_by_name
  };
}

/** A display name bounded to what the table holds. */
function boundedName(name: string): string {
  const trimmed = name.trim() || 'A member';
  return trimmed.length > 200 ? `${trimmed.slice(0, 199)}…` : trimmed;
}

export function parseCreateProjectCommentRequest(
  body: unknown
): CreateProjectCommentRequest {
  if (!body || typeof body !== 'object' || Array.isArray(body))
    throw new ProjectCommentRequestError(
      400,
      'Request body must be an object.'
    );
  const record = body as Record<string, unknown>;
  if (
    Object.keys(record).some(
      (key) => !['parentId', 'anchor', 'text'].includes(key)
    )
  )
    throw new ProjectCommentRequestError(400, 'Unknown comment field.');
  const text = normalizeProjectCommentText(record.text);
  if (text === null)
    throw new ProjectCommentRequestError(
      400,
      'A comment needs 1 to 2000 characters of text.'
    );
  if (record.parentId !== undefined) {
    if (
      typeof record.parentId !== 'string' ||
      record.parentId.length === 0 ||
      record.parentId.length > 80
    )
      throw new ProjectCommentRequestError(400, 'Invalid thread id.');
    if (record.anchor !== undefined)
      throw new ProjectCommentRequestError(400, 'A reply has no pin.');
    return { parentId: record.parentId, text };
  }
  const anchor = parseProjectCommentAnchor(record.anchor);
  if (!anchor)
    throw new ProjectCommentRequestError(
      400,
      'A new thread needs a point on the model.'
    );
  return { anchor, text };
}

export function parseResolveProjectCommentRequest(body: unknown): boolean {
  if (
    !body ||
    typeof body !== 'object' ||
    Array.isArray(body) ||
    Object.keys(body).length !== 1 ||
    typeof (body as { resolved?: unknown }).resolved !== 'boolean'
  )
    throw new ProjectCommentRequestError(400, 'Send { resolved: boolean }.');
  return (body as { resolved: boolean }).resolved;
}

/**
 * The schema refuses any comment write on a project that is no longer
 * plaintext (migration 0058): a request that passed the route's check and
 * reached the database after the project was encrypted is refused here.
 */
function refuseNotPlaintext(error: unknown): never {
  if (
    error instanceof Error &&
    error.message.includes('COMMENTS_PROJECT_NOT_PLAINTEXT')
  )
    throw new ProjectCommentRequestError(
      409,
      'This project is encrypted now; its comments are not stored in plaintext.',
      'PROJECT_FORMAT_UNSUPPORTED'
    );
  throw error;
}

export async function listProjectComments(
  db: D1Database,
  projectId: string
): Promise<ProjectComment[]> {
  const { results } = await db
    .prepare(
      `SELECT ${COMMENT_COLUMNS} FROM project_comments
       WHERE project_id = ? ORDER BY created_at, id`
    )
    .bind(projectId)
    .all<CommentRow>();
  return (results ?? []).map(toComment);
}

async function commentRow(
  db: D1Database,
  projectId: string,
  commentId: string
): Promise<CommentRow> {
  const row = await db
    .prepare(
      `SELECT ${COMMENT_COLUMNS} FROM project_comments
       WHERE id = ? AND project_id = ?`
    )
    .bind(commentId, projectId)
    .first<CommentRow>();
  if (!row)
    throw new ProjectCommentRequestError(404, 'That comment does not exist.');
  return row;
}

export async function createProjectComment(
  db: D1Database,
  projectId: string,
  actor: CommentActor,
  input: CreateProjectCommentRequest,
  now: () => string = () => new Date().toISOString()
): Promise<ProjectComment> {
  if (input.parentId !== undefined) {
    const parent = await commentRow(db, projectId, input.parentId);
    if (parent.parent_id !== null)
      throw new ProjectCommentRequestError(
        400,
        'Reply to the thread, not to a reply.'
      );
  }
  const id = `cmt_${crypto.randomUUID()}`;
  const createdAt = now();
  // The bound is checked in the insert itself, so two writers racing for
  // the last place cannot both take it.
  const result = await db
    .prepare(
      `INSERT INTO project_comments (${COMMENT_COLUMNS})
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL
       WHERE (SELECT COUNT(*) FROM project_comments WHERE project_id = ?) < ?`
    )
    .bind(
      id,
      projectId,
      input.parentId ?? null,
      actor.userId,
      boundedName(actor.name),
      input.text,
      input.anchor ? JSON.stringify(input.anchor) : null,
      createdAt,
      projectId,
      MAX_PROJECT_COMMENTS
    )
    .run()
    .catch(refuseNotPlaintext);
  if (!result.meta?.changes)
    throw new ProjectCommentRequestError(
      409,
      `This project already holds ${MAX_PROJECT_COMMENTS} comments. Delete resolved threads to add more.`,
      'COMMENT_LIMIT'
    );
  return toComment(await commentRow(db, projectId, id));
}

export async function resolveProjectComment(
  db: D1Database,
  projectId: string,
  commentId: string,
  actor: CommentActor,
  resolved: boolean,
  now: () => string = () => new Date().toISOString()
): Promise<ProjectComment> {
  const row = await commentRow(db, projectId, commentId);
  if (row.parent_id !== null)
    throw new ProjectCommentRequestError(400, 'Only a thread is resolved.');
  if (actor.role === 'viewer' && row.author_user_id !== actor.userId)
    throw new ProjectCommentRequestError(
      403,
      'Only the thread’s author, an editor or the owner can resolve it.'
    );
  await db
    .prepare(
      `UPDATE project_comments SET resolved_at = ?, resolved_by_name = ?
       WHERE id = ? AND project_id = ?`
    )
    .bind(
      resolved ? now() : null,
      resolved ? boundedName(actor.name) : null,
      commentId,
      projectId
    )
    .run()
    .catch(refuseNotPlaintext);
  return toComment(await commentRow(db, projectId, commentId));
}

export async function deleteProjectComment(
  db: D1Database,
  projectId: string,
  commentId: string,
  actor: CommentActor
): Promise<void> {
  const row = await commentRow(db, projectId, commentId);
  if (actor.role !== 'owner' && row.author_user_id !== actor.userId)
    throw new ProjectCommentRequestError(
      403,
      'Only the author or the owner can delete a comment.'
    );
  // A thread's replies go with it (ON DELETE CASCADE).
  await db
    .prepare('DELETE FROM project_comments WHERE id = ? AND project_id = ?')
    .bind(commentId, projectId)
    .run();
}
