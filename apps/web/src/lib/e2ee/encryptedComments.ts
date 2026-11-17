import { encodeCommentsBody, toHex, type CommentsBody } from '@openzcad/crypto';
import {
  E2EE_COMMENTS_CONFLICT_CODE,
  MAX_COMMENT_LOG_ANCESTORS,
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

/** A comment log this browser cannot trust; nothing is written over it. */
export class EncryptedCommentsIntegrityError extends ApiError {
  constructor(what: string) {
    super(
      502,
      `Your comments on this project cannot be verified: ${what} Nothing was changed.`,
      'E2EE_COMMENTS_INTEGRITY'
    );
    this.name = 'EncryptedCommentsIntegrityError';
  }
}

export interface EncryptedComments {
  /** The merged comments, and a warning when a member's log was left out. */
  list(
    projectId: string,
    ownerUserId: string
  ): Promise<{ comments: ProjectComment[]; warning: string | null }>;
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

  /**
   * Every log that verifies and follows what this browser saw, this
   * account's own with its chain position, and what the account hid.
   *
   * A writer's log is accepted only when it is the version this browser
   * pinned, or a later one whose signed `ancestors` name the pinned version
   * (so a fork is caught when its branches meet). This account's own log
   * that is behind, forked, missing or unverifiable stops every write: a
   * write would replace it. Another member's is left out and reported in
   * `warnings`, never shown as if nothing happened.
   */
  async function read(projectId: string): Promise<{
    logs: { userId: string; record: CommentLogRecord }[];
    own: {
      sequence: number;
      hash: string | null;
      record: CommentLogRecord | null;
    };
    warnings: string[];
  }> {
    const { logs } = await api.logs(projectId);
    const pinned = (await pins.read(userId, projectId))?.envelopes ?? {};
    const opened: { userId: string; record: CommentLogRecord }[] = [];
    const warnings: string[] = [];
    let own: {
      sequence: number;
      hash: string | null;
      record: CommentLogRecord | null;
    } = { sequence: 0, hash: null, record: null };
    const seen = new Set<string>();
    const refuse = (writer: string, what: string): void => {
      if (writer === userId) throw new EncryptedCommentsIntegrityError(what);
      warnings.push(
        `A member's comments were left out: ${what} The account may be withholding them.`
      );
    };
    for (const log of logs) {
      if (log.projectId !== projectId || seen.has(log.userId)) continue;
      seen.add(log.userId);
      const hash = await storedEnvelopeHash(log.envelope);
      const pin = pinned[pinKey(log.userId)] ?? null;
      if (!envelopeMayFollow(pin, log.sequence, hash)) {
        if (log.userId === userId)
          throw new ReplacedEnvelopeRollbackError('comments');
        refuse(
          log.userId,
          'the account served an older version than this browser saw.'
        );
        continue;
      }
      let record: CommentLogRecord | null = null;
      let previous: string | null = null;
      try {
        const result = await kit.open(asEnvelopeRecord(log), 'comments');
        // The log must be signed by the member the account says wrote it.
        if (result.signerUserId === log.userId) {
          record = parseCommentLog(
            (result.value as CommentsBody).record,
            projectId
          );
          previous = result.header.previousVersionHash
            ? toHex(result.header.previousVersionHash)
            : null;
        }
      } catch {
        record = null;
      }
      if (!record) {
        // Never trusted, and for this account never written over.
        if (log.userId === userId || pin)
          refuse(log.userId, 'their comment log does not verify.');
        continue;
      }
      // The signed chain: the log names its previous version, and every
      // version before it, so a newer log must descend from the pinned one.
      if ((record.ancestors.at(-1) ?? null) !== previous) {
        refuse(log.userId, 'their comment log names a broken history.');
        continue;
      }
      if (
        pin &&
        pin.sequence > 0 &&
        log.sequence > pin.sequence &&
        !record.ancestors.includes(pin.hash ?? '')
      ) {
        refuse(
          log.userId,
          'their comment log forks from the one this browser saw.'
        );
        continue;
      }
      if (log.userId === userId) own = { sequence: log.sequence, hash, record };
      await pins.advanceEnvelope(userId, projectId, pinKey(log.userId), {
        sequence: log.sequence,
        hash
      });
      opened.push({ userId: log.userId, record });
    }
    // A pinned log the account no longer serves was withdrawn.
    for (const [key, pin] of Object.entries(pinned)) {
      if (!key.startsWith('comments:') || (pin?.sequence ?? 0) === 0) continue;
      const writer = key.slice('comments:'.length);
      if (seen.has(writer)) continue;
      if (writer === userId)
        throw new ReplacedEnvelopeRollbackError('comments');
      refuse(
        writer,
        'the account no longer serves a comment log this browser saw.'
      );
    }
    return { logs: opened, own, warnings };
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
        hidden: [],
        ancestors: []
      };
      const changed = change({ ...base, name: name.trim() || base.name });
      const next: CommentLogRecord = {
        ...changed,
        ancestors: own.hash
          ? [...base.ancestors, own.hash].slice(-MAX_COMMENT_LOG_ANCESTORS)
          : base.ancestors
      };
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
      const { logs, warnings } = await read(projectId);
      return {
        comments: mergeCommentLogs(logs, ownerUserId),
        warning: warnings.length ? warnings.join(' ') : null
      };
    },
    async create(projectId, ownerUserId, name, input) {
      const text = normalizeProjectCommentText(input.text);
      if (text === null)
        throw new ApiError(
          400,
          'A comment needs 1 to 2000 characters of text.'
        );
      if (input.parentId !== undefined) {
        const { comments } = await this.list(projectId, ownerUserId);
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
