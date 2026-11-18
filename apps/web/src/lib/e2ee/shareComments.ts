/**
 * L08 commenter links on end-to-end encrypted projects (plan decisions 2
 * and 3a), in the browser.
 *
 * - The owner lets a link's visitors comment by signing a comment grant
 *   (`signLinkCommentGrant`) that the server keeps beside the link.
 * - A visitor whose verified snapshot frame carries a valid grant writes
 *   comments as unsigned `share-comment` envelopes, each under a fresh key
 *   wrapped with the link's share key (`sealShareComment`), and reads the
 *   link's comments back (`openShareComments`).
 * - Members open every commenter link's comments the same way, with the
 *   share keys they already hold, once each link's grant checks out against
 *   the owner's devices. They are shown "(via link)": nobody vouches for a
 *   visitor's name.
 */
import {
  EnvelopeKey,
  decodeShareCommentBody,
  decryptProjectEnvelope,
  encodeShareCommentBody,
  encryptProjectEnvelope,
  fromBase64Url,
  shareKeyHash,
  signShareCommentGrant,
  toBase64Url,
  unwrapKey,
  verifyShareCommentGrant,
  wrapKey,
  type ProjectEnvelopeHeaderInit,
  type SigningPrivateKey
} from '@openzcad/crypto';
import {
  normalizeProjectCommentText,
  parseProjectCommentAnchor,
  type CreateProjectCommentRequest,
  type E2eeCreateLinkCommentRequest,
  type E2eeShareCommentRecord,
  type E2eeShareLinksApi,
  type E2eeSignedStatement,
  type ProjectComment
} from '@openzcad/shared';

/** The longest name a visitor signs a comment with, as for plaintext links. */
export const MAX_SHARE_COMMENTER_NAME = 60;

const BODY_SCHEMA = 1;

/** What a visitor's comment carries inside its envelope. */
interface ShareCommentRecordBody {
  readonly schema: typeof BODY_SCHEMA;
  readonly commentId: string;
  readonly parentId: string | null;
  readonly anchor: ProjectComment['anchor'];
  readonly text: string;
  readonly authorName: string;
  readonly createdAt: string;
}

const COMMENT_ID = /^lcm_[0-9a-f-]{36}$/;

function newCommentId(): string {
  return `lcm_${crypto.randomUUID()}`;
}

function keyContext(projectId: string, shareId: string, commentId: string) {
  return {
    purpose: 'share-comment-key' as const,
    projectId,
    shareId,
    versionId: commentId
  };
}

/** An owner device signs the grant that lets one link's visitors comment. */
export async function signLinkCommentGrant(input: {
  readonly ownerDeviceKey: SigningPrivateKey;
  readonly ownerDeviceKeyHash: Uint8Array;
  readonly projectId: string;
  readonly shareId: string;
  readonly shareKey: Uint8Array;
  readonly now: number;
}): Promise<E2eeSignedStatement> {
  const signed = await signShareCommentGrant(input.ownerDeviceKey, {
    projectId: input.projectId,
    shareId: input.shareId,
    shareKeyHash: await shareKeyHash(input.shareKey),
    issuedAt: input.now,
    signerKeyHash: input.ownerDeviceKeyHash
  });
  return {
    statement: toBase64Url(signed.statement),
    signature: toBase64Url(signed.signature)
  };
}

/**
 * Whether `grant` lets the link's visitors comment: it names this link and
 * its share key, signed by one of `ownerDeviceKeys` (the devices the
 * visitor's verified delegation names, or the owner's devices a member's
 * pinned list certifies). Never throws; a bad grant is no grant.
 */
export async function linkTakesComments(
  grant: E2eeSignedStatement | undefined,
  link: {
    readonly projectId: string;
    readonly shareId: string;
    readonly shareKey: Uint8Array;
  },
  ownerDeviceKeys: readonly Uint8Array[]
): Promise<boolean> {
  if (!grant) return false;
  try {
    await verifyShareCommentGrant(
      {
        statement: fromBase64Url(grant.statement),
        signature: fromBase64Url(grant.signature)
      },
      {
        projectId: link.projectId,
        shareId: link.shareId,
        shareKeyHash: await shareKeyHash(link.shareKey)
      },
      ownerDeviceKeys
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * Seals a visitor's comment for one link: a `share-comment` envelope of the
 * link's project under a fresh key, wrapped with the share key. The header
 * reuses the key epoch and epoch binding of the snapshot the visitor
 * opened; nothing in it is secret.
 */
export async function sealShareComment(input: {
  readonly projectId: string;
  readonly shareId: string;
  readonly shareKey: Uint8Array;
  readonly keyEpoch: number;
  readonly epochBindingHash: Uint8Array;
  readonly schemaVersion: number;
  readonly authorName: string;
  readonly comment: CreateProjectCommentRequest;
  readonly now: number;
}): Promise<E2eeCreateLinkCommentRequest> {
  const authorName = input.authorName.trim();
  if (!authorName || authorName.length > MAX_SHARE_COMMENTER_NAME) {
    throw new Error(
      `Sign your comment with a name of 1 to ${MAX_SHARE_COMMENTER_NAME} characters.`
    );
  }
  const text = normalizeProjectCommentText(input.comment.text);
  if (text === null) {
    throw new Error('A comment needs 1 to 2000 characters of text.');
  }
  const parentId = input.comment.parentId ?? null;
  const anchor =
    parentId === null ? parseProjectCommentAnchor(input.comment.anchor) : null;
  if (parentId === null && !anchor) {
    throw new Error('A new thread needs a point on the model.');
  }
  const commentId = newCommentId();
  const body: ShareCommentRecordBody = {
    schema: BODY_SCHEMA,
    commentId,
    parentId,
    anchor,
    text,
    authorName,
    createdAt: new Date(input.now).toISOString()
  };
  const init: ProjectEnvelopeHeaderInit = {
    kind: 'share-comment',
    projectId: input.projectId,
    documentVersion: 1,
    previousVersionHash: null,
    epochBindingHash: input.epochBindingHash,
    schemaVersion: input.schemaVersion,
    keyEpoch: input.keyEpoch,
    blobIds: []
  };
  const plaintext = encodeShareCommentBody(
    { record: body as unknown as Record<string, unknown> },
    init
  );
  const key = EnvelopeKey.generate();
  const versionKey = key.bytes;
  try {
    const envelope = await encryptProjectEnvelope(key, init, plaintext);
    const wrapped = await wrapKey(
      input.shareKey,
      versionKey,
      keyContext(input.projectId, input.shareId, commentId)
    );
    return {
      commentId,
      envelope: toBase64Url(envelope),
      wrappedVersionKey: toBase64Url(wrapped)
    };
  } finally {
    versionKey.fill(0);
  }
}

function parseBody(
  value: Readonly<Record<string, unknown>>,
  commentId: string
): ShareCommentRecordBody | null {
  if (value.schema !== BODY_SCHEMA || value.commentId !== commentId) {
    return null;
  }
  const text = normalizeProjectCommentText(value.text);
  const authorName =
    typeof value.authorName === 'string' ? value.authorName.trim() : '';
  const parentId =
    value.parentId === null
      ? null
      : typeof value.parentId === 'string' && value.parentId.length <= 80
        ? value.parentId
        : undefined;
  const anchor =
    value.anchor === null ? null : parseProjectCommentAnchor(value.anchor);
  if (
    text === null ||
    !authorName ||
    authorName.length > MAX_SHARE_COMMENTER_NAME ||
    parentId === undefined ||
    (parentId === null) === (anchor === null) ||
    typeof value.createdAt !== 'string' ||
    Number.isNaN(Date.parse(value.createdAt))
  ) {
    return null;
  }
  return {
    schema: BODY_SCHEMA,
    commentId,
    parentId,
    anchor: anchor ?? null,
    text,
    authorName,
    createdAt: value.createdAt
  };
}

/**
 * Opens a link's comments with its share key, as comments the panel shows
 * "(via link)". One that does not open, does not belong to this project and
 * link, or does not parse is left out and counted, never shown.
 */
export async function openShareComments(
  projectId: string,
  records: readonly E2eeShareCommentRecord[],
  shareKeys: ReadonlyMap<string, Uint8Array>
): Promise<{ comments: ProjectComment[]; leftOut: number }> {
  const comments: ProjectComment[] = [];
  let leftOut = 0;
  for (const record of records) {
    const shareKey = shareKeys.get(record.shareId);
    if (!shareKey || !COMMENT_ID.test(record.commentId)) {
      leftOut += 1;
      continue;
    }
    let versionKey: Uint8Array | null = null;
    try {
      versionKey = await unwrapKey(
        shareKey,
        fromBase64Url(record.wrappedVersionKey),
        keyContext(projectId, record.shareId, record.commentId)
      );
      const opened = await decryptProjectEnvelope(
        versionKey,
        fromBase64Url(record.envelope),
        { expect: { projectId, kind: 'share-comment' } }
      );
      const body = parseBody(
        decodeShareCommentBody(opened.plaintext, opened.header).record,
        record.commentId
      );
      if (!body) {
        leftOut += 1;
        continue;
      }
      comments.push({
        commentId: body.commentId,
        projectId,
        parentId: body.parentId,
        anchor: body.anchor,
        text: body.text,
        authorUserId: null,
        authorName: `${body.authorName} (via link)`,
        createdAt: body.createdAt,
        resolvedAt: null,
        resolvedByName: null
      });
    } catch {
      leftOut += 1;
    } finally {
      versionKey?.fill(0);
    }
  }
  return { comments, leftOut };
}

/** What a commenter link's visitor writes and reads with (the loader's). */
export interface LinkCommentsAccess {
  readonly projectId: string;
  readonly shareId: string;
  readonly token: string;
  readonly shareKey: Uint8Array;
  readonly keyEpoch: number;
  readonly epochBindingHash: Uint8Array;
  readonly schemaVersion: number;
}

type LinkCommentsApi = Required<
  Pick<E2eeShareLinksApi, 'linkComments' | 'postLinkComment'>
>;

/** A commenter link's comments, as its visitor sees them. */
export async function listLinkComments(
  api: LinkCommentsApi,
  access: LinkCommentsAccess
): Promise<ProjectComment[]> {
  const answer = await api.linkComments(access.token);
  if (!answer) throw new Error('This link no longer takes comments.');
  return (
    await openShareComments(
      access.projectId,
      answer.comments,
      new Map([[access.shareId, access.shareKey]])
    )
  ).comments;
}

/** A commenter link's visitor adds a comment, sealed in this browser. */
export async function postLinkComment(
  api: LinkCommentsApi,
  access: LinkCommentsAccess,
  authorName: string,
  comment: CreateProjectCommentRequest,
  now = Date.now()
): Promise<string> {
  const sealed = await sealShareComment({
    projectId: access.projectId,
    shareId: access.shareId,
    shareKey: access.shareKey,
    keyEpoch: access.keyEpoch,
    epochBindingHash: access.epochBindingHash,
    schemaVersion: access.schemaVersion,
    authorName,
    comment,
    now
  });
  await api.postLinkComment(access.token, sealed);
  return sealed.commentId;
}
