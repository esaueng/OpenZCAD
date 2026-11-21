import {
  MAX_PROJECT_COMMENTS,
  normalizeProjectCommentText,
  parseProjectCommentAnchor,
  type CreateProjectCommentRequest,
  type ProjectAccessRole,
  type ProjectComment
} from '@openzcad/shared';
import { isShareLinkHistoryReady } from '@openzcad/cloudflare-adapters';

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
      // A link visitor has no account (L08 commenter links).
      actor.userId || null,
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

/** Longest name a link visitor signs a comment with. */
export const MAX_LINK_COMMENTER_NAME = 60;

/**
 * The project a commenter link (L08, migration 0059) lets its visitor
 * comment on, or null. The same rules as the link's read: not revoked,
 * within its lifetime, the project not trashed and plaintext, the owner's
 * sharing switched on, and the link made with comments.
 *
 * `tokenHash` (the bare hash) finds only a link to the live project; a
 * link without history (migration 0065) is found only by
 * `frozenTokenHash`, its own domain, and comes back `frozen`: its visitor
 * reads and answers only the threads started through that link.
 */
export async function commentLinkProject(
  db: D1Database,
  tokenHash: string,
  oldestValidCreation: number,
  frozenTokenHash?: string
): Promise<CommentLink | null> {
  const historyReady = await isShareLinkHistoryReady(db);
  const frozenHash =
    historyReady && frozenTokenHash !== undefined ? frozenTokenHash : null;
  const byToken = !historyReady
    ? 'l.token_hash = ?'
    : frozenHash === null
      ? '(l.token_hash = ? AND l.history = 1)'
      : `((l.token_hash = ? AND l.history = 1)
          OR (l.token_hash = ? AND l.history = 0))`;
  const row = await db
    .prepare(
      `SELECT l.id AS share_link_id, l.project_id,
              ${historyReady ? 'l.history' : '1 AS history'}
       FROM project_share_links l
       INNER JOIN projects p ON p.id = l.project_id
       LEFT JOIN user_settings owner_settings
         ON owner_settings.user_id = p.user_id
       WHERE ${byToken}
         AND l.revoked_at IS NULL
         AND l.created_at > ?
         AND l.allow_comments = 1
         AND p.status != 'deleted'
         AND COALESCE(p.storage_format, 1) = 1
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
    .bind(
      tokenHash,
      ...(frozenHash === null ? [] : [frozenHash]),
      oldestValidCreation
    )
    .first<{ share_link_id: string; project_id: string; history: number }>();
  return row
    ? {
        projectId: row.project_id,
        shareLinkId: row.share_link_id,
        // Anything but 1 is a link without history.
        frozen: row.history !== 1
      }
    : null;
}

/** The link a visitor comments through. */
export interface CommentLink {
  projectId: string;
  shareLinkId: string;
  /**
   * L08: a link without history. It serves a frozen model, not the
   * project, so it serves none of the project's comments either: a pin
   * carries a point, a normal, a body id and a document version of the
   * live model, on bodies and versions the link never shared. Its visitor
   * sees the threads started through this link (pinned to the frozen model
   * the visitor was shown) and the replies to them.
   */
  frozen: boolean;
}

/** A thread started through a link: the only kind a frozen link shows. */
const OWN_THREAD = `parent_id IS NULL AND share_link_id = ?`;

/** A link visitor's comment request: the text, its pin or thread, and a name. */
export function parseLinkCommentRequest(body: unknown): {
  name: string;
  input: CreateProjectCommentRequest;
} {
  if (!body || typeof body !== 'object' || Array.isArray(body))
    throw new ProjectCommentRequestError(
      400,
      'Request body must be an object.'
    );
  const { name, ...rest } = body as Record<string, unknown>;
  // Control characters never belong in a name shown beside a comment.
  // eslint-disable-next-line no-control-regex
  const controls = /[\u0000-\u001f\u007f-\u009f]/g;
  const signed =
    typeof name === 'string'
      ? name.replace(controls, '').replace(/\s+/g, ' ').trim()
      : '';
  if (!signed || [...signed].length > MAX_LINK_COMMENTER_NAME)
    throw new ProjectCommentRequestError(
      400,
      `Sign your comment with a name of 1 to ${MAX_LINK_COMMENTER_NAME} characters.`
    );
  return { name: signed, input: parseCreateProjectCommentRequest(rest) };
}

/** A visitor's comment: no account, signed with the name typed, via its link. */
export async function createLinkComment(
  db: D1Database,
  link: CommentLink,
  name: string,
  input: CreateProjectCommentRequest
): Promise<ProjectComment> {
  // A frozen link's visitor answers only a thread of that link. Any other
  // thread does not exist for them, in the words used for an unknown id.
  if (link.frozen && input.parentId !== undefined) {
    const own = await db
      .prepare(
        `SELECT 1 AS own FROM project_comments
         WHERE id = ? AND project_id = ? AND ${OWN_THREAD}`
      )
      .bind(input.parentId, link.projectId, link.shareLinkId)
      .first<{ own: number }>();
    if (!own)
      throw new ProjectCommentRequestError(404, 'That comment does not exist.');
  }
  const comment = await createProjectComment(
    db,
    link.projectId,
    { userId: '', name: `${name} (via link)`, role: 'viewer' },
    input
  );
  await db
    .prepare('UPDATE project_comments SET share_link_id = ? WHERE id = ?')
    .bind(link.shareLinkId, comment.commentId)
    .run();
  return { ...comment, authorUserId: null };
}

/**
 * What a link visitor sees, with no member's account id: every comment of
 * the project through a link that shares it, and only the link's own
 * threads (and their replies) through a link without history.
 */
export async function listLinkComments(
  db: D1Database,
  link: CommentLink
): Promise<ProjectComment[]> {
  const comments = link.frozen
    ? (
        (
          await db
            .prepare(
              `SELECT ${COMMENT_COLUMNS} FROM project_comments
               WHERE project_id = ?
                 AND ((${OWN_THREAD})
                   OR parent_id IN (
                     SELECT id FROM project_comments
                     WHERE project_id = ? AND ${OWN_THREAD}))
               ORDER BY created_at, id`
            )
            .bind(
              link.projectId,
              link.shareLinkId,
              link.projectId,
              link.shareLinkId
            )
            .all<CommentRow>()
        ).results ?? []
      ).map(toComment)
    : await listProjectComments(db, link.projectId);
  return comments.map((comment) => ({ ...comment, authorUserId: null }));
}
