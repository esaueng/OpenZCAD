import type {
  CreateProjectCommentRequest,
  ProjectComment
} from '@openzcad/shared';
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

/**
 * A member's L08 comments: the account's rows on a plaintext project, the
 * members' signed, encrypted logs on an encrypted one. Loaded with the
 * comment client when the panel first needs it, not with the workspace.
 */
export const memberComments = {
  async list(
    projectId: string,
    context: MemberCommentContext
  ): Promise<ProjectComment[]> {
    return isEncryptedProject(projectId)
      ? (await encrypted()).list(projectId, context.ownerUserId)
      : projectCommentsApi.list(projectId);
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
  }
};
