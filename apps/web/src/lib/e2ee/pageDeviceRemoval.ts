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
import { contactsContext } from './contacts';
import { contactMemberLists } from './memberLists';
import { createE2eeShareLinksApi } from '@openzcad/shared';
import { desktopFetch } from '../desktopBridge';
import { getKeySessionRevision, isCurrentKeySession } from './keySession';

export { GROUP_RESET_CONFIRMATION };

function pageGroups(
  e2ee: E2eeContext,
  account: AccountView,
  fetcher = desktopFetch
): ProjectGroupContext {
  const cutoffs = createRevocationCutoffsApi(fetcher);
  const api = createProjectGroupsApi(fetcher);
  return {
    api,
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
    }),
    // Shared projects' co-members (slice 5-2), from contacts (slice 5-1).
    members: contactMemberLists({
      contacts: contactsContext(e2ee),
      account,
      leaves: (projectId) => api.leaves(projectId)
    })
  };
}

/** The participant step `removeDevice` and the other rotations run. */
export function pageRemovalParticipant(
  e2ee: E2eeContext,
  onOutcome: (outcome: RemovalOutcome) => void
): RemovalParticipant {
  const participant = removalParticipant({
    groups: (account) => pageGroups(e2ee, account),
    pins: versionPins(),
    onOutcome
  });
  // While encrypted projects are closed to the account there is nothing to
  // rotate, and the cutoff routes would only answer 501. When the config
  // cannot be read, the participant runs and handles the routes' answers.
  let open: Promise<boolean> | null = null;
  const projectsOpen = () =>
    (open ??= e2ee.api.config().then(
      (config) => config.enabled && config.projectsEnabled === true,
      () => true
    ));
  return {
    prepare: async (account) => {
      if (await projectsOpen()) await participant.prepare(account);
    },
    cutoffsFor: async (step) =>
      (await projectsOpen()) ? participant.cutoffsFor?.(step) : undefined,
    written: async (step) => {
      if (await projectsOpen()) await participant.written?.(step);
    },
    complete: async (step) => {
      if (!(await projectsOpen())) {
        return { rotated: [], left: [], cutoffsStored: false };
      }
      const outcome = await participant.complete(step);
      if (step.kind === 'device') {
        await renewShareDelegationAfterRemoval(e2ee, {
          ...step,
          projectIds: [
            ...outcome.rotated,
            ...outcome.left
              .map((project) => project.projectId)
              .filter((id) => id !== '*')
          ]
        }).catch(() => undefined);
      }
      return outcome;
    }
  };
}

/**
 * A removed owner device must stop signing share-authority statements at
 * once (ADR-024, share links): the removal has the identity key open, so a
 * new share delegation without it is signed now, when the account has one
 * (slice 5-10). Best effort; the sharing dialog asks again otherwise.
 */
export async function renewShareDelegationAfterRemoval(
  e2ee: E2eeContext,
  step: {
    readonly identityPrivateKey: CryptoKey;
    readonly account: AccountView;
    readonly projectIds?: readonly string[];
  },
  api = createE2eeShareLinksApi(desktopFetch)
): Promise<boolean> {
  const revision = getKeySessionRevision();
  const { delegation } = await api.delegation();
  if (!delegation) return false;
  const {
    renewShareDelegation,
    signWithIdentityKey,
    refreshOwnerShareAuthorities
  } = await import('./shareLinks');
  await renewShareDelegation(
    { groups: pageGroups(e2ee, step.account), api },
    signWithIdentityKey(step.identityPrivateKey)
  );
  if (step.projectIds?.length) {
    const current = () =>
      isCurrentKeySession(revision) && e2ee.isCurrent?.() !== false;
    const guard = () => {
      if (!current())
        throw new DOMException('The encryption session ended.', 'AbortError');
    };
    guard();
    // Fresh clients use the account view and key after the removal, rather
    // than this page's store cached before its account key rotated.
    const [
      { createEncryptedProjectStore },
      { createEncryptedDocumentsApi },
      { createBlobReferenceRegistry }
    ] = await Promise.all([
      import('./encryptedProjectStore'),
      import('./encryptedDocumentsApi'),
      import('./blobReferences')
    ]);
    const fetcher: typeof desktopFetch = async (path, init) => {
      guard();
      const response = await desktopFetch(path, init);
      guard();
      return response;
    };
    guard();
    const groups = pageGroups(
      { ...e2ee, isCurrent: current },
      step.account,
      fetcher
    );
    const references = createBlobReferenceRegistry();
    try {
      await refreshOwnerShareAuthorities(
        {
          groups,
          api: createE2eeShareLinksApi(fetcher),
          blobReferences: references,
          store: createEncryptedProjectStore({
            groups,
            pins: versionPins(),
            blobReferences: references,
            api: createEncryptedDocumentsApi(fetcher)
          })
        },
        step.projectIds
      );
    } finally {
      references.clear();
    }
  }
  return true;
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
