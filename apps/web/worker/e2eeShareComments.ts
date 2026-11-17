/**
 * L08 commenter links on end-to-end encrypted projects (plan decisions 2 and
 * 3a, migration 0061).
 *
 * - The owner lets one link's visitors comment with an owner-signed comment
 *   grant (`PUT …/share-links/:shareId/comment-grant`), kept beside the link.
 *   It is not a link-grant mode: the grant set travels inside the encrypted
 *   document, and an older build refuses a document whose grants carry a
 *   mode it does not know. Older builds never ask for this record.
 * - A visitor of a link with a grant reads and writes its comments through
 *   the token (`GET/POST /api/e2ee/share/:token/comments`). Each comment is
 *   an unsigned `share-comment` envelope whose key is wrapped under the
 *   link's share key, so the server stores ciphertext only.
 * - Members read every link's comments with the grants that admit them
 *   (`GET /api/e2ee/projects/:id/share-comments`), and the owner hides one
 *   by deleting it (`DELETE …/share-comments/:commentId`).
 */
import {
  MAX_SHARE_COMMENT_GRANT_BYTES,
  decodeShareCommentGrant,
  fromBase64Url,
  parseEnvelope,
  verifyShareCommentGrant
} from '@openzcad/crypto';
import {
  MAX_E2EE_LINK_COMMENTS,
  type E2eeLinkCommentsResponse,
  type E2eeShareCommentRecord,
  type E2eeShareCommentsResponse,
  type E2eeSignedStatement
} from '@openzcad/shared';
import {
  RouteError,
  bytesField,
  idField,
  invalid,
  json,
  record,
  refuse,
  requireCertifiedSigner,
  requireEncryptedProjectAccess,
  requireOwnedEncryptedProject
} from './e2eeProjects';

/** One visitor comment: a 64 KiB body at most, plus the envelope framing. */
const MAX_SHARE_COMMENT_ENVELOPE_BYTES = 66 * 1024;
const WRAP_BYTES = 41;
const SIGNATURE_BYTES = 65;
const MAX_REQUEST_CHARS = 100_000;

const MEMBER_ROUTE =
  /^\/api\/e2ee\/projects\/([^/]+)\/share-comments(?:\/([^/]+))?$/;
const VISITOR_ROUTE = /^\/api\/e2ee\/share\/([^/]+)\/comments$/;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;

/** Members' and the owner's share-comment routes. */
export function isE2eeShareCommentsPath(pathname: string): boolean {
  return MEMBER_ROUTE.test(pathname);
}

/** The anonymous visitor comment route. */
export function isEncryptedLinkCommentsPath(pathname: string): boolean {
  return VISITOR_ROUTE.test(pathname);
}

/** Migration 0061 is applied. */
export async function isShareCommentStorageReady(
  db: D1Database
): Promise<boolean> {
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS n FROM sqlite_master
       WHERE type = 'table'
         AND name IN ('e2ee_share_comments', 'e2ee_share_comment_grants')`
    )
    .first<{ n: number }>();
  return row?.n === 2;
}

function unavailable(): never {
  refuse(
    503,
    'E2EE_SHARE_COMMENTS_UNAVAILABLE',
    'Comments on encrypted share links are unavailable until the database is updated.'
  );
}

async function readJson(request: Request): Promise<Record<string, unknown>> {
  const text = await request.text();
  if (text.length > MAX_REQUEST_CHARS) {
    refuse(413, 'E2EE_REQUEST_TOO_LARGE', 'Request body is too large.');
  }
  try {
    return record(JSON.parse(text), 'body');
  } catch (error) {
    if (error instanceof RouteError) throw error;
    invalid('body must be JSON');
  }
}

function routeResponse(error: unknown): Response {
  if (error instanceof RouteError) {
    return json(
      { error: error.message, code: error.code, ...error.extra },
      error.status
    );
  }
  throw error;
}

interface CommentRow {
  share_id: string;
  comment_id: string;
  envelope: string;
  wrapped_version_key: string;
  created_at: string;
}

const commentRecord = (row: CommentRow): E2eeShareCommentRecord => ({
  shareId: row.share_id,
  commentId: row.comment_id,
  envelope: row.envelope,
  wrappedVersionKey: row.wrapped_version_key,
  createdAt: row.created_at
});

// --- The owner's comment grant ----------------------------------------------

/**
 * Stores the owner's comment grant for a live link of the owner's
 * encrypted project. The grant names that link (project, id and share-key
 * hash) and is signed by a device the owner's current device list
 * certifies; visitors and members check it again themselves. A link keeps
 * its first grant.
 */
export async function putShareCommentGrant(
  request: Request,
  db: D1Database,
  userId: string,
  projectId: string,
  shareId: string
): Promise<Response> {
  if (!(await isShareCommentStorageReady(db))) unavailable();
  await requireOwnedEncryptedProject(db, userId, projectId);
  const body = await readJson(request);
  const grant = record(body.grant, 'grant');
  const statement = bytesField(grant.statement, 'grant.statement', {
    max: MAX_SHARE_COMMENT_GRANT_BYTES
  });
  const signature = bytesField(grant.signature, 'grant.signature', {
    exact: SIGNATURE_BYTES
  });
  let signerKeyHash: Uint8Array;
  try {
    signerKeyHash = decodeShareCommentGrant(statement.bytes).signerKeyHash;
  } catch {
    invalid('grant is not a comment grant');
  }
  const link = await db
    .prepare(
      `SELECT share_key_hash FROM e2ee_share_links
       WHERE project_id = ? AND share_id = ? AND revoked_at IS NULL`
    )
    .bind(projectId, shareId)
    .first<{ share_key_hash: string }>();
  if (!link) {
    refuse(404, 'E2EE_SHARE_LINK_NOT_FOUND', 'This share link does not exist.');
  }
  const { signingKey } = await requireCertifiedSigner(
    db,
    userId,
    signerKeyHash
  );
  const verified = await verifyShareCommentGrant(
    { statement: statement.bytes, signature: signature.bytes },
    {
      projectId,
      shareId,
      shareKeyHash: fromBase64Url(link.share_key_hash)
    },
    [signingKey]
  ).catch(() => null);
  if (!verified) {
    refuse(
      400,
      'E2EE_SIGNATURE_INVALID',
      'The comment grant is not this link’s, signed by one of your devices.'
    );
  }
  await db
    .prepare(
      `INSERT INTO e2ee_share_comment_grants
         (project_id, share_id, grant_statement, grant_signature, created_at)
       SELECT ?, ?, ?, ?, ?
       WHERE EXISTS (SELECT 1 FROM e2ee_share_links
                     WHERE project_id = ? AND share_id = ? AND revoked_at IS NULL)
       ON CONFLICT (project_id, share_id) DO NOTHING`
    )
    .bind(
      projectId,
      shareId,
      statement.text,
      signature.text,
      new Date().toISOString(),
      projectId,
      shareId
    )
    .run();
  return json({ ok: true });
}

// --- Members and the owner -------------------------------------------------

export async function handleE2eeShareCommentsRequest(
  request: Request,
  pathname: string,
  db: D1Database,
  userId: string
): Promise<Response> {
  try {
    const match = MEMBER_ROUTE.exec(pathname);
    if (!match) refuse(404, 'NOT_FOUND', 'Not found.');
    let projectId: string;
    let commentId: string | null;
    try {
      projectId = decodeURIComponent(match[1]!);
      commentId = match[2] === undefined ? null : decodeURIComponent(match[2]);
    } catch {
      refuse(404, 'NOT_FOUND', 'Not found.');
    }
    if (!(await isShareCommentStorageReady(db))) unavailable();
    if (commentId === null && request.method === 'GET') {
      await requireEncryptedProjectAccess(db, userId, projectId, 'read');
      const [comments, grants] = await Promise.all([
        db
          .prepare(
            `SELECT share_id, comment_id, envelope, wrapped_version_key,
               created_at
             FROM e2ee_share_comments WHERE project_id = ?
             ORDER BY created_at, comment_id`
          )
          .bind(projectId)
          .all<CommentRow>(),
        db
          .prepare(
            `SELECT share_id, grant_statement, grant_signature
             FROM e2ee_share_comment_grants WHERE project_id = ?
             ORDER BY share_id`
          )
          .bind(projectId)
          .all<{
            share_id: string;
            grant_statement: string;
            grant_signature: string;
          }>()
      ]);
      return json({
        comments: (comments.results ?? []).map(commentRecord),
        grants: (grants.results ?? []).map((row) => ({
          shareId: row.share_id,
          grant: {
            statement: row.grant_statement,
            signature: row.grant_signature
          }
        }))
      } satisfies E2eeShareCommentsResponse);
    }
    if (commentId !== null && request.method === 'DELETE') {
      // The owner hides a visitor's comment: it is deleted.
      await requireOwnedEncryptedProject(db, userId, projectId);
      idField(commentId, 'commentId');
      await db
        .prepare(
          'DELETE FROM e2ee_share_comments WHERE project_id = ? AND comment_id = ?'
        )
        .bind(projectId, commentId)
        .run();
      return json({ ok: true });
    }
    refuse(404, 'NOT_FOUND', 'Not found.');
  } catch (error) {
    return routeResponse(error);
  }
}

// --- Visitors ----------------------------------------------------------------

interface CommenterLink {
  project_id: string;
  share_id: string;
  grant_statement: string;
  grant_signature: string;
}

/**
 * The live link a token names on an encrypted project, when its owner gave
 * it a comment grant; null for every other token (an opaque 404).
 */
async function commenterLink(
  db: D1Database,
  rawToken: string,
  tokenHash: (token: string) => Promise<string>
): Promise<CommenterLink | null> {
  let token: string;
  try {
    token = decodeURIComponent(rawToken);
  } catch {
    return null;
  }
  if (!TOKEN.test(token) || !(await isShareCommentStorageReady(db))) {
    return null;
  }
  return db
    .prepare(
      `SELECT l.project_id, l.share_id, g.grant_statement, g.grant_signature
       FROM e2ee_share_links l
       JOIN projects p ON p.id = l.project_id
       JOIN e2ee_share_comment_grants g
         ON g.project_id = l.project_id AND g.share_id = l.share_id
       WHERE l.token_hash = ? AND l.revoked_at IS NULL
         AND l.authority IS NOT NULL
         AND p.storage_format = 2 AND p.status <> 'deleted'`
    )
    .bind(await tokenHash(token))
    .first<CommenterLink>();
}

async function linkComments(
  db: D1Database,
  link: CommenterLink
): Promise<E2eeShareCommentRecord[]> {
  const rows = await db
    .prepare(
      `SELECT share_id, comment_id, envelope, wrapped_version_key, created_at
       FROM e2ee_share_comments WHERE project_id = ? AND share_id = ?
       ORDER BY created_at, comment_id`
    )
    .bind(link.project_id, link.share_id)
    .all<CommentRow>();
  return (rows.results ?? []).map(commentRecord);
}

/**
 * A commenter link's visitor reads the link's comments, or adds one: an
 * unsigned `share-comment` envelope of the link's project, without files,
 * whose key wrap binds the comment id. At most
 * {@link MAX_E2EE_LINK_COMMENTS} per link.
 */
export async function handleEncryptedLinkComments(
  request: Request,
  pathname: string,
  db: D1Database | undefined,
  open: boolean,
  tokenHash: (token: string) => Promise<string>
): Promise<Response> {
  const notFound = () => json({ error: 'Share link not found.' }, 404);
  if (!open || !db) return notFound();
  const match = VISITOR_ROUTE.exec(pathname);
  if (!match) return notFound();
  const link = await commenterLink(db, match[1] ?? '', tokenHash);
  if (!link) return notFound();
  try {
    if (request.method === 'GET') {
      return json({
        comments: await linkComments(db, link)
      } satisfies E2eeLinkCommentsResponse);
    }
    if (request.method !== 'POST') return notFound();
    const body = await readJson(request);
    const commentId = idField(body.commentId, 'commentId');
    const envelope = bytesField(body.envelope, 'envelope', {
      max: MAX_SHARE_COMMENT_ENVELOPE_BYTES
    });
    let header: ReturnType<typeof parseEnvelope>['header'];
    try {
      header = parseEnvelope(envelope.bytes).header;
    } catch {
      invalid('envelope is not an envelope');
    }
    if (
      header.class !== 'project' ||
      header.kind !== 'share-comment' ||
      header.projectId !== link.project_id ||
      header.blobIds.length > 0
    ) {
      invalid('envelope must be this project’s share comment, without files');
    }
    const wrapped = bytesField(body.wrappedVersionKey, 'wrappedVersionKey', {
      exact: WRAP_BYTES
    });
    const inserted = await db
      .prepare(
        `INSERT INTO e2ee_share_comments
           (project_id, share_id, comment_id, envelope, wrapped_version_key,
            created_at)
         SELECT ?, ?, ?, ?, ?, ?
         WHERE (SELECT COUNT(*) FROM e2ee_share_comments
                WHERE project_id = ? AND share_id = ?) < ?
         ON CONFLICT (project_id, comment_id) DO NOTHING`
      )
      .bind(
        link.project_id,
        link.share_id,
        commentId,
        envelope.text,
        wrapped.text,
        new Date().toISOString(),
        link.project_id,
        link.share_id,
        MAX_E2EE_LINK_COMMENTS
      )
      .run();
    if (!inserted.meta?.changes) {
      const exists = await db
        .prepare(
          'SELECT 1 AS found FROM e2ee_share_comments WHERE project_id = ? AND comment_id = ?'
        )
        .bind(link.project_id, commentId)
        .first<{ found: number }>();
      if (exists) {
        refuse(409, 'COMMENT_EXISTS', 'That comment already exists.');
      }
      refuse(
        409,
        'COMMENT_LIMIT',
        `This link takes at most ${MAX_E2EE_LINK_COMMENTS} comments.`
      );
    }
    return json(
      {
        comments: await linkComments(db, link)
      } satisfies E2eeLinkCommentsResponse,
      201
    );
  } catch (error) {
    return routeResponse(error);
  }
}

/** The link's comment grant for the visitor's snapshot frame, if any. */
export async function linkCommentGrant(
  db: D1Database,
  projectId: string,
  shareId: string
): Promise<E2eeSignedStatement | undefined> {
  if (!(await isShareCommentStorageReady(db))) return undefined;
  const row = await db
    .prepare(
      `SELECT grant_statement, grant_signature FROM e2ee_share_comment_grants
       WHERE project_id = ? AND share_id = ?`
    )
    .bind(projectId, shareId)
    .first<{ grant_statement: string; grant_signature: string }>();
  return row
    ? { statement: row.grant_statement, signature: row.grant_signature }
    : undefined;
}

/** Drops a forgotten link's grant and comments (its tombstone stays). */
export async function forgetLinkComments(
  db: D1Database,
  projectId: string,
  shareId: string
): Promise<void> {
  if (!(await isShareCommentStorageReady(db))) return;
  await db.batch([
    db
      .prepare(
        'DELETE FROM e2ee_share_comments WHERE project_id = ? AND share_id = ?'
      )
      .bind(projectId, shareId),
    db
      .prepare(
        'DELETE FROM e2ee_share_comment_grants WHERE project_id = ? AND share_id = ?'
      )
      .bind(projectId, shareId)
  ]);
}
