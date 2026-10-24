/**
 * Members of end-to-end encrypted projects in the browser (ADR-024 Phase 5;
 * roadmap L11): what this account may do in a shared project, and the
 * owner's role changes (slice 5-4).
 *
 * - **This account's role** (`ownProjectRole`) comes from the MLS roles of
 *   the group's current epoch, as this device's own session holds them
 *   after catching up, or as the epoch's key archive records them (a device
 *   without a leaf, decision D4). The server's `project_members` mirror is
 *   never trusted for it: the page shows a viewer the read-only UI from
 *   these roles, and the encrypted store refuses a viewer's write from the
 *   same roles before anything is sent.
 * - **Role changes** (`changeMemberRole` in `projectGroups.ts`): the owner
 *   commits `setRoles`; the Worker mirrors the role in the same batch.
 *   Ownership never moves on an encrypted project.
 *
 * Only `encryptedProjects.ts` and the sharing dialog load this, on demand.
 */
import type { ProjectAccessRole } from '@openzcad/shared';
import { encryptedInvitations } from './encryptedProjects';
import {
  catchUpProjectGroup,
  changeMemberRole,
  epochRoles,
  type ProjectGroupContext
} from './projectGroups';

/**
 * This account's role in the group's current epoch, or null when the roles
 * do not list it (not a member, or no longer one). A device with a session
 * catches up first, so a role change it has not processed yet counts.
 */
export async function ownProjectRole(
  ctx: ProjectGroupContext,
  projectId: string
): Promise<ProjectAccessRole | null> {
  if (ctx.device) {
    // A device that cannot catch up (no session yet, or behind a removal)
    // still reads the current epoch's roles from its key archive.
    await catchUpProjectGroup(ctx, projectId).catch(() => undefined);
  }
  const { group } = await ctx.api.group(projectId);
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
