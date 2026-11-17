import {
  createE2eeShareLinksApi,
  type CreateProjectCommentRequest,
  type ProjectComment
} from '@openzcad/shared';
import { desktopFetch } from './desktopBridge';
import type { LinkCommentsAccess } from './e2ee/shareComments';
import { isEncryptedProject } from './api';
import { linkCommentsApi, projectCommentsApi } from './projectCommentsApi';

export { linkCommentsApi };

/** The project and member a comment change acts for. */
export interface MemberCommentContext {
  /** The project owner's user id, which roots its member logs. */
  ownerUserId: string;
  /** The name the member's encrypted comments carry. */
  authorName: string;
}

const encrypted = async () =>
  (await import('./e2ee/encryptedProjects')).encryptedComments();

const sharing = async () =>
  (await import('./e2ee/encryptedProjects')).encryptedShareLinks();

/**
 * Commenter-link visitors' comments on an encrypted project (L08, plan
 * decision 2), with a warning when some could not be opened.
 */
async function visitorComments(
  projectId: string
): Promise<{ comments: ProjectComment[]; warning: string | null }> {
  try {
    const { listShareLinkComments } = await import('./e2ee/shareLinks');
    const { comments, leftOut } = await listShareLinkComments(
      (await sharing()).ctx,
      projectId
    );
    return {
      comments,
      warning: leftOut
        ? `${leftOut} comment${leftOut === 1 ? '' : 's'} from share links could not be opened and ${leftOut === 1 ? 'is' : 'are'} not shown.`
        : null
    };
  } catch {
    return {
      comments: [],
      warning: 'Comments from share links could not be loaded.'
    };
  }
}

/**
 * A member's L08 comments: the account's rows on a plaintext project, the
 * members' signed, encrypted logs on an encrypted one. Loaded with the
 * comment client when the panel first needs it, not with the workspace.
 */
export const memberComments = {
  /** The comments, and a warning when a member's log was left out. */
  async list(
    projectId: string,
    context: MemberCommentContext
  ): Promise<{ comments: ProjectComment[]; warning: string | null }> {
    if (!isEncryptedProject(projectId))
      return {
        comments: await projectCommentsApi.list(projectId),
        warning: null
      };
    const visitors = await visitorComments(projectId);
    const members = await (
      await encrypted()
    ).list(projectId, context.ownerUserId, visitors.comments);
    const warning =
      [members.warning, visitors.warning].filter(Boolean).join(' ') || null;
    return { comments: members.comments, warning };
  },
  async create(
    projectId: string,
    context: MemberCommentContext,
    input: CreateProjectCommentRequest
  ): Promise<ProjectComment | null> {
    if (!isEncryptedProject(projectId))
      return projectCommentsApi.create(projectId, input);
    await (
      await encrypted()
    ).create(projectId, context.ownerUserId, context.authorName, input);
    return null;
  },
  async resolve(
    projectId: string,
    context: MemberCommentContext,
    threadId: string,
    resolved: boolean
  ): Promise<void> {
    if (!isEncryptedProject(projectId)) {
      await projectCommentsApi.resolve(projectId, threadId, resolved);
      return;
    }
    await (
      await encrypted()
    ).resolve(
      projectId,
      context.ownerUserId,
      context.authorName,
      threadId,
      resolved
    );
  },
  async remove(
    projectId: string,
    context: MemberCommentContext,
    commentId: string
  ): Promise<void> {
    if (!isEncryptedProject(projectId))
      return projectCommentsApi.remove(projectId, commentId);
    await (
      await encrypted()
    ).remove(projectId, context.ownerUserId, context.authorName, commentId);
    // A link visitor's comment the owner hid in their log is deleted from
    // the link too, so its visitors no longer see it.
    if (commentId.startsWith('lcm_'))
      await (await sharing()).ctx.api.hideShareComment?.(projectId, commentId);
  }
};

/**
 * An encrypted commenter link's visitor (L08, plan decisions 2 and 3a):
 * comments sealed and opened in this browser under the link's share key.
 */
export const encryptedLinkComments = {
  async list(access: LinkCommentsAccess): Promise<ProjectComment[]> {
    const { listLinkComments } = await import('./e2ee/shareComments');
    return listLinkComments(linkApi(), access);
  },
  async create(
    access: LinkCommentsAccess,
    authorName: string,
    input: CreateProjectCommentRequest
  ): Promise<{ commentId: string }> {
    const { postLinkComment } = await import('./e2ee/shareComments');
    return {
      commentId: await postLinkComment(linkApi(), access, authorName, input)
    };
  }
};

function linkApi() {
  const api = createE2eeShareLinksApi(desktopFetch);
  return {
    linkComments: api.linkComments!,
    postLinkComment: api.postLinkComment!
  };
}
