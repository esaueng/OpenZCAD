import type { ProjectDocument } from '@openzcad/shared';

/**
 * Whether the live document's kernel session may be persisted on this
 * device (and a stored one offered when it reopens); see
 * `kernelSessionStore.ts`.
 *
 * Only for the current user's own local project. Never for a shared link's
 * model, which is ephemeral until the visitor makes a copy (ADR-024), and
 * never for someone else's project opened as a collaborator or member,
 * viewer or editor: a session is a plaintext snapshot of the whole model,
 * and none of those is the user's to keep.
 */
export function persistsKernelSession(input: {
  document: ProjectDocument | null;
  /** A shared link is open (the state, or the ref set before it lands). */
  shareSession: boolean;
  /** The signed-out device user, which owns projects made without an account. */
  localUserId: string;
  /** The signed-in account, if any. */
  accountUserId: string | undefined;
}): boolean {
  const { document } = input;
  return Boolean(
    document &&
    !input.shareSession &&
    (document.ownerUserId === input.localUserId ||
      (input.accountUserId !== undefined &&
        document.ownerUserId === input.accountUserId))
  );
}
