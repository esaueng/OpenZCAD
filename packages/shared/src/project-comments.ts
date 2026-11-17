/**
 * L08 review comments: a thread anchored to a point on the model, with
 * replies, that any member of the project can write and the owner, an
 * editor or the author can resolve.
 *
 * This module is the shape both ends agree on. A plaintext project's
 * comments are rows the Worker reads; an encrypted project's are not offered
 * until they can travel as encrypted, signed records (see
 * docs/plans/l08-l03-review-and-versions-plan.md), so nothing about them is
 * ever sent in plaintext.
 */

/** Longest comment text, in UTF-16 code units. */
export const MAX_PROJECT_COMMENT_TEXT = 2000;
/** Comments a project may hold, threads and replies together. */
export const MAX_PROJECT_COMMENTS = 500;
/** A coordinate further out than this is not a point on a model. */
const MAX_ANCHOR_COORDINATE = 1e7;

export type Vector3Tuple = [number, number, number];

/** Where a thread is pinned, in model coordinates. */
export interface ProjectCommentAnchor {
  point: Vector3Tuple;
  /** The surface normal there, when the pick had one. */
  normal?: Vector3Tuple;
  /** The body under the point when it was placed. */
  bodyId?: string;
  /** The document version it was placed on. */
  documentVersion: number;
}

export interface ProjectComment {
  commentId: string;
  projectId: string;
  /** Null for a thread; the thread's id for a reply. */
  parentId: string | null;
  /** A thread's pin; null on a reply. */
  anchor: ProjectCommentAnchor | null;
  text: string;
  authorUserId: string | null;
  authorName: string;
  createdAt: string;
  /** Threads only: when and by whom it was resolved, else null. */
  resolvedAt: string | null;
  resolvedByName: string | null;
}

export interface ListProjectCommentsResponse {
  comments: ProjectComment[];
}

export interface CreateProjectCommentRequest {
  parentId?: string;
  anchor?: ProjectCommentAnchor;
  text: string;
}

function isVector(value: unknown): value is Vector3Tuple {
  return (
    Array.isArray(value) &&
    value.length === 3 &&
    value.every(
      (entry) =>
        typeof entry === 'number' &&
        Number.isFinite(entry) &&
        Math.abs(entry) <= MAX_ANCHOR_COORDINATE
    )
  );
}

/** The anchor `value` describes, or null when it is not one. */
export function parseProjectCommentAnchor(
  value: unknown
): ProjectCommentAnchor | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).some(
      (key) => !['point', 'normal', 'bodyId', 'documentVersion'].includes(key)
    )
  )
    return null;
  if (!isVector(record.point)) return null;
  if (record.normal !== undefined && !isVector(record.normal)) return null;
  if (
    record.bodyId !== undefined &&
    (typeof record.bodyId !== 'string' ||
      record.bodyId.length === 0 ||
      record.bodyId.length > 200)
  )
    return null;
  if (
    typeof record.documentVersion !== 'number' ||
    !Number.isSafeInteger(record.documentVersion) ||
    record.documentVersion < 0
  )
    return null;
  const anchor: ProjectCommentAnchor = {
    point: [record.point[0], record.point[1], record.point[2]],
    documentVersion: record.documentVersion
  };
  if (record.normal) anchor.normal = [...record.normal];
  if (record.bodyId) anchor.bodyId = record.bodyId;
  return anchor;
}

/** Comment text with its edges trimmed, or null when empty or too long. */
export function normalizeProjectCommentText(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  // Control characters other than line breaks and tabs never belong in a
  // comment and would let one disguise itself in a list.
  // eslint-disable-next-line no-control-regex
  const text = value.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').trim();
  return text.length > 0 && text.length <= MAX_PROJECT_COMMENT_TEXT
    ? text
    : null;
}

// --- L08 encrypted comments (held for the owner, #1667) ---------------------
//
// On an end-to-end encrypted project every member keeps one comment log: a
// signed, encrypted `comments` envelope holding the comments they wrote and
// the resolutions they made, replaced whole on each change. The account
// stores only ciphertext; the browser opens every member's log and merges
// them here.

/** One comment as its author's log keeps it. */
export interface CommentLogEntry {
  commentId: string;
  parentId: string | null;
  anchor: ProjectCommentAnchor | null;
  text: string;
  createdAt: string;
}

/** A thread resolved or reopened, by the log's writer. */
export interface CommentLogResolution {
  threadId: string;
  resolved: boolean;
  at: string;
}

/** The body of one member's `comments` envelope. */
export interface CommentLogRecord {
  projectId: string;
  /** The name the writer signs their comments with. */
  name: string;
  comments: CommentLogEntry[];
  resolutions: CommentLogResolution[];
  /** The owner's log only: other members' comments the owner removed. */
  hidden: string[];
  /**
   * The version hashes (lowercase hex) of this log's earlier versions in
   * sequence order, every one or the last `MAX_COMMENT_LOG_ANCESTORS`:
   * signed with the log,
   * so a reader pinned at an earlier version can check that a newer one
   * descends from it rather than from a fork.
   */
  ancestors: string[];
}

export const MAX_COMMENT_LOG_ANCESTORS = 2000;

/** A log as the account serves it: whose, and its signed envelope. */
export interface E2eeCommentLogRecord {
  projectId: string;
  userId: string;
  keyEpoch: number;
  sequence: number;
  envelope: string;
  wrappedVersionKey: string;
  signature: string;
  signerDeviceId: string;
  updatedAt: string;
}

export interface E2eeCommentLogsResponse {
  logs: E2eeCommentLogRecord[];
}

export interface E2eeCommentLogUpload {
  /** The caller's log's next sequence (1 for a first log). */
  sequence: number;
  envelope: string;
  wrappedVersionKey: string;
  signature: string;
  signerDeviceId: string;
}

export const E2EE_COMMENTS_CONFLICT_CODE = 'E2EE_COMMENTS_CONFLICT';

const COMMENT_ID = /^cmt_[0-9a-f-]{36}$/;

function isIso(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= 40 &&
    !Number.isNaN(Date.parse(value))
  );
}

/** The log `value` describes, or null when it is not a well-formed one. */
export function parseCommentLog(
  value: unknown,
  projectId: string
): CommentLogRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.projectId !== projectId) return null;
  if (
    typeof record.name !== 'string' ||
    record.name.trim().length === 0 ||
    record.name.length > 120
  )
    return null;
  if (
    !Array.isArray(record.comments) ||
    record.comments.length > MAX_PROJECT_COMMENTS ||
    !Array.isArray(record.resolutions) ||
    record.resolutions.length > MAX_PROJECT_COMMENTS ||
    !Array.isArray(record.hidden) ||
    record.hidden.length > MAX_PROJECT_COMMENTS
  )
    return null;
  const comments: CommentLogEntry[] = [];
  for (const raw of record.comments as unknown[]) {
    if (!raw || typeof raw !== 'object') return null;
    const entry = raw as Record<string, unknown>;
    const text = normalizeProjectCommentText(entry.text);
    if (
      typeof entry.commentId !== 'string' ||
      !COMMENT_ID.test(entry.commentId) ||
      !(
        entry.parentId === null ||
        (typeof entry.parentId === 'string' && COMMENT_ID.test(entry.parentId))
      ) ||
      text === null ||
      !isIso(entry.createdAt)
    )
      return null;
    const anchor =
      entry.anchor === null ? null : parseProjectCommentAnchor(entry.anchor);
    // A thread has a pin and a reply none.
    if ((entry.parentId === null) !== (anchor !== null)) return null;
    comments.push({
      commentId: entry.commentId,
      parentId: entry.parentId,
      anchor,
      text,
      createdAt: entry.createdAt
    });
  }
  const resolutions: CommentLogResolution[] = [];
  for (const raw of record.resolutions as unknown[]) {
    if (!raw || typeof raw !== 'object') return null;
    const entry = raw as Record<string, unknown>;
    if (
      typeof entry.threadId !== 'string' ||
      !COMMENT_ID.test(entry.threadId) ||
      typeof entry.resolved !== 'boolean' ||
      !isIso(entry.at)
    )
      return null;
    resolutions.push({
      threadId: entry.threadId,
      resolved: entry.resolved,
      at: entry.at
    });
  }
  const hidden = record.hidden as unknown[];
  if (!hidden.every((id) => typeof id === 'string' && COMMENT_ID.test(id)))
    return null;
  const ancestors = record.ancestors ?? [];
  if (
    !Array.isArray(ancestors) ||
    ancestors.length > MAX_COMMENT_LOG_ANCESTORS ||
    !ancestors.every(
      (hash) => typeof hash === 'string' && /^[0-9a-f]{64}$/.test(hash)
    )
  )
    return null;
  return {
    projectId,
    name: record.name.trim(),
    comments,
    resolutions,
    hidden: hidden as string[],
    ancestors: ancestors as string[]
  };
}

/**
 * Every member's log merged into the comments the panel shows. A comment is
 * attributed to the member whose signed log holds it. A thread's state is
 * the latest resolution by its author or the owner; the owner's `hidden`
 * list removes comments (a thread with its replies); a reply whose thread
 * is gone is dropped. Ordered by time, then id.
 */
export function mergeCommentLogs(
  logs: readonly { userId: string; record: CommentLogRecord }[],
  ownerUserId: string
): ProjectComment[] {
  const owner = logs.find((log) => log.userId === ownerUserId);
  const hidden = new Set(owner?.record.hidden ?? []);
  const all: ProjectComment[] = [];
  const authors = new Map<string, string>();
  const names = new Map(logs.map((log) => [log.userId, log.record.name]));
  for (const log of logs)
    for (const entry of log.record.comments) {
      // An id claimed by two logs keeps its first: ids are random, so a
      // second one is a copy, never the author's own.
      if (authors.has(entry.commentId)) continue;
      authors.set(entry.commentId, log.userId);
      all.push({
        commentId: entry.commentId,
        projectId: log.record.projectId,
        parentId: entry.parentId,
        anchor: entry.anchor,
        text: entry.text,
        authorUserId: log.userId,
        authorName: log.record.name,
        createdAt: entry.createdAt,
        resolvedAt: null,
        resolvedByName: null
      });
    }
  const threads = new Set(
    all
      .filter((comment) => comment.parentId === null)
      .filter((comment) => !hidden.has(comment.commentId))
      .map((comment) => comment.commentId)
  );
  const latest = new Map<
    string,
    { at: string; resolved: boolean; by: string }
  >();
  for (const log of logs)
    for (const resolution of log.record.resolutions) {
      const author = authors.get(resolution.threadId);
      if (author === undefined) continue;
      if (log.userId !== author && log.userId !== ownerUserId) continue;
      const current = latest.get(resolution.threadId);
      if (!current || resolution.at > current.at)
        latest.set(resolution.threadId, {
          at: resolution.at,
          resolved: resolution.resolved,
          by: log.userId
        });
    }
  return all
    .filter((comment) =>
      comment.parentId === null
        ? threads.has(comment.commentId)
        : threads.has(comment.parentId) && !hidden.has(comment.commentId)
    )
    .map((comment) => {
      const state =
        comment.parentId === null ? latest.get(comment.commentId) : undefined;
      return state?.resolved
        ? {
            ...comment,
            resolvedAt: state.at,
            resolvedByName: names.get(state.by) ?? null
          }
        : comment;
    })
    .sort((left, right) =>
      left.createdAt === right.createdAt
        ? left.commentId.localeCompare(right.commentId)
        : left.createdAt.localeCompare(right.createdAt)
    );
}
