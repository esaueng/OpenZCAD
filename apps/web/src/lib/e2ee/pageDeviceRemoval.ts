/**
 * The page's wiring for device removal and solo group resets (ADR-024
 * Phase 4, slice 4-10): the project-groups context Settings › Encryption
 * hands `removeDevice`'s participant step and `resetProjectGroup`, over this
 * page's MLS sessions, version pins and the real routes. Loaded lazily by
 * Settings, only when a removal or reset starts.
 */
import {
  signGroupResetWithIdentity,
  type AccountView,
  type E2eeContext,
  type UnlockAuthorization
} from './accountKeys';
import {
  createRevocationCutoffsApi,
  removalParticipant,
  revocationStatements,
  type RemovalOutcome,
  type RemovalParticipant
} from './deviceRemoval';
import { mlsProjectSessions } from './mls/projectSessions';
import {
  GROUP_RESET_CONFIRMATION,
  createProjectGroupsApi,
  projectGroupAccount,
  resetProjectGroup,
  type ProjectGroupContext,
  type ProjectGroupState
} from './projectGroups';
import { versionPins } from './versionPins';

export { GROUP_RESET_CONFIRMATION };

function pageGroups(
  e2ee: E2eeContext,
  account: AccountView
): ProjectGroupContext {
  const cutoffs = createRevocationCutoffsApi();
  return {
    api: createProjectGroupsApi(),
    sessions: mlsProjectSessions(),
    account: projectGroupAccount(e2ee, account),
    device:
      account.deviceStatus === 'certified' && account.device
        ? {
            userId: account.userId,
            deviceId: account.device.deviceId,
            signing: account.device.signing
          }
        : null,
    revocations: revocationStatements(cutoffs, {
      list: account.list,
      generation: account.generation
    })
  };
}

/** The participant step `removeDevice` and the other rotations run. */
export function pageRemovalParticipant(
  e2ee: E2eeContext,
  onOutcome: (outcome: RemovalOutcome) => void
): RemovalParticipant {
  return removalParticipant({
    groups: (account) => pageGroups(e2ee, account),
    pins: versionPins(),
    onOutcome
  });
}

export interface RecoverableProject {
  readonly projectId: string;
  readonly name: string;
}

/** The account's encrypted projects, with their names where they open. */
export async function encryptedProjectsForRecovery(): Promise<
  RecoverableProject[]
> {
  const { api } = await import('../api');
  const { projects } = await api.listProjects();
  return projects
    .filter((project) => project.storageFormat === 2)
    .map((project) => ({ projectId: project.projectId, name: project.name }));
}

/**
 * Reset one solo project's encryption group (decision D9) after the owner
 * confirmed `GROUP_RESET_CONFIRMATION`, signing with the identity key the
 * recovery key or a passkey opens for this one change.
 */
export function resetEncryptedProject(
  e2ee: E2eeContext,
  account: AccountView,
  projectId: string,
  authorization: UnlockAuthorization,
  confirmation: string
): Promise<ProjectGroupState> {
  return resetProjectGroup(
    pageGroups(e2ee, account),
    projectId,
    {
      generation: account.generation,
      sign: (reset) =>
        signGroupResetWithIdentity(e2ee, account, authorization, reset)
    },
    confirmation
  );
}
