/**
 * Members of end-to-end encrypted projects in the browser (ADR-024 Phase 5;
 * roadmap L11): what this account may do in a shared project, the owner's
 * role changes (slice 5-4), removals and leaving (slice 5-5).
 *
 * - **This account's role** (`ownProjectRole`) comes from the MLS roles of
 *   the group's current epoch, as this device's own session holds them
 *   after catching up, or as the epoch's key archive records them (a device
 *   without a leaf, decision D4). The server's `project_members` mirror is
 *   never trusted for it: the page shows a viewer the read-only UI from
 *   these roles, and the encrypted store refuses a viewer's write from the
 *   same roles before anything is sent. Reading it also commits any
 *   departure pending in the project (any member may, a viewer included).
 * - **Role changes** (`changeMemberRole` in `projectGroups.ts`): the owner
 *   commits `setRoles`; the Worker mirrors the role in the same batch.
 *   Ownership never moves on an encrypted project.
 * - **Removal** (`removeMember`): the owner commits `dropUsers`; the Worker
 *   drops the member's row, wraps and assistant consent in the same batch.
 * - **Leaving** (`leaveProject`): a SelfRemove proposal, on which the
 *   Worker drops this account's access (decision M4); another member
 *   commits it.
 *
 * Only `encryptedProjects.ts` and the sharing dialog load this, on demand.
 */
import type { ProjectAccessRole } from '@openzcad/shared';
import { encryptedInvitations } from './encryptedProjects';
import {
  ProjectGroupApiError,
  catchUpProjectGroup,
  changeMemberRole,
  commitPendingDepartures,
  epochRoles,
  leaveProject,
  removeMember,
  type ProjectGroupContext
} from './projectGroups';
import { forgetProjectKeys } from './unlockedProjectKeys';

/**
 * This account's role in the group's current epoch, or null when the roles
 * do not list it, or the server no longer lets it read the project (it was
 * removed, or it left). A device with a session catches up first, so a role
 * change it has not processed yet counts, and commits a pending departure.
 */
export async function ownProjectRole(
  ctx: ProjectGroupContext,
  projectId: string
): Promise<ProjectAccessRole | null> {
  let group;
  try {
    ({ group } = await ctx.api.group(projectId));
  } catch (error) {
    if (error instanceof ProjectGroupApiError && error.status === 404) {
      return null;
    }
    throw error;
  }
  if (ctx.device) {
    // A device that cannot catch up (no session yet, or behind a removal)
    // still reads the current epoch's roles from its key archive.
    await (
      (group.pendingProposals ?? 0) > 0
        ? commitPendingDepartures(ctx, projectId)
        : catchUpProjectGroup(ctx, projectId)
    ).catch(() => undefined);
    ({ group } = await ctx.api.group(projectId));
  }
  const roles = await epochRoles(
    ctx,
    projectId,
    group.keyEpochBase + group.epoch
  );
  return (
    roles.users.find((entry) => entry.userId === ctx.account.userId)?.role ??
    null
  );
}

/** This page's account's role in an encrypted project (`ownProjectRole`). */
export async function encryptedMemberRole(
  projectId: string
): Promise<ProjectAccessRole | null> {
  return ownProjectRole((await encryptedInvitations()).groups, projectId);
}

/** The owner changes a member's role from this page (slice 5-4). */
export async function changeEncryptedMemberRole(
  projectId: string,
  userId: string,
  role: 'editor' | 'viewer'
): Promise<void> {
  await changeMemberRole(
    (await encryptedInvitations()).groups,
    projectId,
    userId,
    role
  );
}

/** The owner removes a member from this page (slice 5-5). */
export async function removeEncryptedMember(
  projectId: string,
  userId: string
): Promise<void> {
  await removeMember((await encryptedInvitations()).groups, projectId, userId);
}

/**
 * This page's account leaves a project (slice 5-5). Its access is gone once
 * this resolves; the project keys this page held for it are forgotten.
 */
export async function leaveEncryptedProject(projectId: string): Promise<void> {
  const ctx = (await encryptedInvitations()).groups;
  await leaveProject(ctx, projectId);
  forgetProjectKeys(ctx.account.userId, projectId);
}
