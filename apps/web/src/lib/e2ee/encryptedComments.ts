import { encodeCommentsBody, type CommentsBody } from '@openzcad/crypto';
import {
  E2EE_COMMENTS_CONFLICT_CODE,
  MAX_PROJECT_COMMENTS,
  mergeCommentLogs,
  normalizeProjectCommentText,
  parseCommentLog,
  type CommentLogRecord,
  type CreateProjectCommentRequest,
  type E2eeCommentLogRecord,
  type E2eeCommentLogsResponse,
  type E2eeCommentLogUpload,
  type E2eeProjectEnvelopeRecord,
  type ProjectComment
} from '@openzcad/shared';
import { ApiError } from '../api';
import { desktopFetch } from '../desktopBridge';
import {
  ReplacedEnvelopeRollbackError,
  storedEnvelopeHash,
  type ReplacedEnvelopeKit
} from './replacedEnvelopes';
import { envelopeMayFollow, type VersionPinStore } from './versionPins';

/**
 * L08 review comments on an end-to-end encrypted project (held for the
 * owner, #1667). Every member keeps one comment log: a `comments` project
 * envelope holding the comments they wrote and the resolutions they made,
 * encrypted under the project's key, signed by their certified device and
 * replaced whole (`/api/e2ee/projects/:id/comments`). The account stores and
 * serves ciphertext only.
 *
 * Reading opens every member's log: signed by a device of a member of the
 * project in that key epoch (`kit.open`, any role), its sequence pinned per
 * writer so the account cannot roll a log back, and a log that does not
 * verify is left out rather than trusted. `mergeCommentLogs` then attributes
 * each comment to the log that holds it and applies resolutions by a
 * thread's author or the owner, and the owner's removals.
 */

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

export interface EncryptedCommentsApi {
  logs(projectId: string): Promise<E2eeCommentLogsResponse>;
  save(projectId: string, upload: E2eeCommentLogUpload): Promise<void>;
}

export function createEncryptedCommentsApi(
  fetcher: Fetch = desktopFetch
): EncryptedCommentsApi {
  const path = (projectId: string) =>
    `/api/e2ee/projects/${encodeURIComponent(projectId)}/comments`;
  const refusal = async (response: Response) => {
    const body = (await response.json().catch(() => null)) as {
      error?: string;
      code?: string;
    } | null;
    return new ApiError(
      response.status,
      body?.error ?? `${response.status} ${response.statusText}`,
      body?.code,
      body ?? undefined
    );
  };
  return {
    async logs(projectId) {
      const response = await fetcher(path(projectId), {
        credentials: 'same-origin'
      });
      if (!response.ok) throw await refusal(response);
      return (await response.json()) as E2eeCommentLogsResponse;
    },
    async save(projectId, upload) {
      const response = await fetcher(path(projectId), {
        method: 'PUT',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(upload)
      });
      if (!response.ok) throw await refusal(response);
    }
  };
}

export interface EncryptedComments {
  list(projectId: string, ownerUserId: string): Promise<ProjectComment[]>;
  create(
    projectId: string,
    ownerUserId: string,
    name: string,
    input: CreateProjectCommentRequest
  ): Promise<void>;
  resolve(
    projectId: string,
    ownerUserId: string,
    name: string,
    threadId: string,
    resolved: boolean
  ): Promise<void>;
  remove(
    projectId: string,
    ownerUserId: string,
    name: string,
    commentId: string
  ): Promise<void>;
}

interface CommentDeps {
  readonly userId: string;
  readonly kit: ReplacedEnvelopeKit;
  readonly pins: VersionPinStore;
  readonly api?: EncryptedCommentsApi;
  readonly now?: () => string;
  readonly newId?: () => string;
}

const pinKey = (writer: string) => `comments:${writer}`;

/** A stored log as the kit opens replaced envelopes. */
const asEnvelopeRecord = (
  log: E2eeCommentLogRecord
): E2eeProjectEnvelopeRecord => ({
  projectId: log.projectId,
  kind: 'comments',
  keyEpoch: log.keyEpoch,
  sequence: log.sequence,
  envelope: log.envelope,
  wrappedVersionKey: log.wrappedVersionKey,
  signature: log.signature,
  signerDeviceId: log.signerDeviceId,
  updatedAt: log.updatedAt
});

export function createEncryptedComments(deps: CommentDeps): EncryptedComments {
  const api = deps.api ?? createEncryptedCommentsApi();
  const { userId, kit, pins } = deps;
  const now = deps.now ?? (() => new Date().toISOString());
  const newId = deps.newId ?? (() => `cmt_${crypto.randomUUID()}`);

  /** Every verified log, and this account's own with its chain position. */
  async function read(projectId: string): Promise<{
    logs: { userId: string; record: CommentLogRecord }[];
    own: {
      sequence: number;
      hash: string | null;
      record: CommentLogRecord | null;
    };
  }> {
    const { logs } = await api.logs(projectId);
    const pinned = (await pins.read(userId, projectId))?.envelopes ?? {};
    const opened: { userId: string; record: CommentLogRecord }[] = [];
    let own: {
      sequence: number;
      hash: string | null;
      record: CommentLogRecord | null;
    } = { sequence: 0, hash: null, record: null };
    const seen = new Set<string>();
    for (const log of logs) {
      if (log.projectId !== projectId || seen.has(log.userId)) continue;
      seen.add(log.userId);
      const hash = await storedEnvelopeHash(log.envelope);
      if (
        !envelopeMayFollow(
          pinned[pinKey(log.userId)] ?? null,
          log.sequence,
          hash
        )
      ) {
        // Older than a log this browser already accepted: never shown, and
        // for this account's own log, never written over.
        if (log.userId === userId)
          throw new ReplacedEnvelopeRollbackError('comments');
        continue;
      }
      let record: CommentLogRecord | null = null;
      try {
        const result = await kit.open(asEnvelopeRecord(log), 'comments');
        // The log must be signed by the member the account says wrote it.
        if (result.signerUserId === log.userId)
          record = parseCommentLog(
            (result.value as CommentsBody).record,
            projectId
          );
      } catch {
        record = null;
      }
      if (log.userId === userId) own = { sequence: log.sequence, hash, record };
      if (!record) continue;
      await pins.advanceEnvelope(userId, projectId, pinKey(log.userId), {
        sequence: log.sequence,
        hash
      });
      opened.push({ userId: log.userId, record });
    }
    // Pinned logs the account no longer serves are a rollback for our own.
    if ((pinned[pinKey(userId)]?.sequence ?? 0) > 0 && own.sequence === 0)
      throw new ReplacedEnvelopeRollbackError('comments');
    return { logs: opened, own };
  }

  /** Replaces this account's log with `change` applied, retrying a race. */
  async function write(
    projectId: string,
    name: string,
    change: (record: CommentLogRecord) => CommentLogRecord
  ): Promise<void> {
    for (let attempt = 0; ; attempt++) {
      const { own } = await read(projectId);
      const base: CommentLogRecord = own.record ?? {
        projectId,
        name,
        comments: [],
        resolutions: [],
        hidden: []
      };
      const next = change({ ...base, name: name.trim() || base.name });
      const sequence = own.sequence + 1;
      const sealed = await kit.seal(
        projectId,
        {
          kind: 'comments',
          sequence,
          previousHash: own.hash,
          blobIds: []
        },
        (header) =>
          encodeCommentsBody(
            { record: next as unknown as Record<string, unknown> },
            header
          )
      );
      try {
        await api.save(projectId, {
          sequence,
          envelope: sealed.envelope,
          wrappedVersionKey: sealed.wrappedVersionKey,
          signature: sealed.signature,
          signerDeviceId: sealed.signerDeviceId
        });
        await pins.advanceEnvelope(userId, projectId, pinKey(userId), {
          sequence,
          hash: sealed.hash
        });
        return;
      } catch (error) {
        const retry =
          error instanceof ApiError &&
          (error.code === E2EE_COMMENTS_CONFLICT_CODE ||
            error.code === 'E2EE_EPOCH_STALE') &&
          attempt < 2;
        if (!retry) throw error;
      }
    }
  }

  return {
    async list(projectId, ownerUserId) {
      return mergeCommentLogs((await read(projectId)).logs, ownerUserId);
    },
    async create(projectId, ownerUserId, name, input) {
      const text = normalizeProjectCommentText(input.text);
      if (text === null)
        throw new ApiError(
          400,
          'A comment needs 1 to 2000 characters of text.'
        );
      if (input.parentId !== undefined) {
        const comments = await this.list(projectId, ownerUserId);
        const thread = comments.find(
          (comment) => comment.commentId === input.parentId
        );
        if (!thread || thread.parentId !== null)
          throw new ApiError(400, 'Reply to a thread of this project.');
      } else if (!input.anchor) {
        throw new ApiError(400, 'A new thread needs a point on the model.');
      }
      await write(projectId, name, (record) => {
        if (record.comments.length >= MAX_PROJECT_COMMENTS)
          throw new ApiError(
            409,
            `You already hold ${MAX_PROJECT_COMMENTS} comments on this project. Delete some to add more.`
          );
        return {
          ...record,
          comments: [
            ...record.comments,
            {
              commentId: newId(),
              parentId: input.parentId ?? null,
              anchor: input.parentId === undefined ? input.anchor! : null,
              text,
              createdAt: now()
            }
          ]
        };
      });
    },
    async resolve(projectId, _ownerUserId, name, threadId, resolved) {
      await write(projectId, name, (record) => ({
        ...record,
        resolutions: [
          ...record.resolutions.filter(
            (resolution) => resolution.threadId !== threadId
          ),
          { threadId, resolved, at: now() }
        ]
      }));
    },
    async remove(projectId, ownerUserId, name, commentId) {
      await write(projectId, name, (record) =>
        record.comments.some((comment) => comment.commentId === commentId)
          ? {
              ...record,
              comments: record.comments.filter(
                (comment) =>
                  comment.commentId !== commentId &&
                  comment.parentId !== commentId
              )
            }
          : userId === ownerUserId
            ? // The owner removes another member's comment by hiding it.
              { ...record, hidden: [...new Set([...record.hidden, commentId])] }
            : record
      );
    }
  };
}
