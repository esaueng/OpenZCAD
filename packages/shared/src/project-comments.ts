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
