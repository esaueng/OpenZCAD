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
import { E2eeError } from '@openzcad/crypto';
import {
  GROUP_RESET_CONFIRMATION,
  ProjectGroupError,
  createProjectGroupsApi,
  epochAuthority,
  projectGroupAccount,
  resetProjectGroup,
  type ProjectGroupContext,
  type ProjectGroupState
} from './projectGroups';
import {
  AUTHORITY_RESTORE_CONFIRMATION,
  ProjectAuthorityError,
  projectAuthorityRecovery,
  restoreProjectAuthority
} from './projectAuthority';
import { versionPins, type VersionPinStore } from './versionPins';
import {
  createEncryptedDocumentsApi,
  type EncryptedDocumentsApi
} from './encryptedDocumentsApi';
import { contactsContext } from './contacts';
import { contactMemberLists } from './memberLists';
import { createE2eeShareLinksApi } from '@openzcad/shared';
import { desktopFetch } from '../desktopBridge';
import { getKeySessionRevision, isCurrentKeySession } from './keySession';

export { AUTHORITY_RESTORE_CONFIRMATION, GROUP_RESET_CONFIRMATION };

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
  /**
   * Shown beside the name wherever a restoration is offered or confirmed:
   * two projects whose encrypted names this device cannot verify share one
   * placeholder name, and the id is what tells them apart.
   */
  readonly projectId: string;
  /**
   * The project's verified name. While the account's encrypted name does
   * not verify (as for every project whose record was withdrawn), the title
   * this device itself holds, see {@link trustedProjectName}.
   */
  readonly name: string;
  /**
   * Set when this device knows no title for a project whose encrypted name
   * did not verify: `name` is {@link UNVERIFIED_PROJECT_NAME}, never what
   * the account listed, and the project is told apart by its id.
   */
  readonly unnamed?: true;
  /**
   * Set when the account no longer returns the authority record this device
   * verified for the project (issue #1704): `restorable` when this device's
   * pins name this account, under its current identity, as the owner;
   * `identity-discontinued` when the account's keys were set up afresh.
   */
  readonly authority?: 'restorable' | 'identity-discontinued';
}

interface DeviceTitle {
  readonly name: string;
  readonly updatedAt: string;
}

/** Shown, beside its project ID, for a project this device has no title for. */
export const UNVERIFIED_PROJECT_NAME = 'Encrypted project';

/**
 * The name to show for an encrypted project whose encrypted name did not
 * verify: the title of this device's own copy of the project, or the title
 * this device last verified on the shelf, whichever is newer, as the start
 * screen chooses. Null when this device knows no title. The name the
 * account lists for such a project is unverified and is never shown: the
 * caller shows {@link UNVERIFIED_PROJECT_NAME} and the project's id.
 */
export function trustedProjectName(
  device: DeviceTitle | undefined,
  lastVerified: DeviceTitle | undefined
): string | null {
  if (lastVerified && (!device || device.updatedAt <= lastVerified.updatedAt))
    return lastVerified.name;
  return device?.name ?? null;
}

/**
 * The account's encrypted projects, with their names where they open. Given
 * the account, each project this device holds a verified record of is also
 * asked for its record, so a withdrawn one can be offered its restoration.
 * A project that cannot be asked is listed without one.
 */
export async function encryptedProjectsForRecovery(
  e2ee?: E2eeContext,
  account?: AccountView
): Promise<RecoverableProject[]> {
  const { api } = await import('../api');
  const { projects, pendingEncryptedProjectIds: unnamed } =
    await api.listProjects();
  const groups = e2ee && account ? pageGroups(e2ee, account) : null;
  const encrypted = projects.filter((project) => project.storageFormat === 2);
  // A withdrawn record leaves the project's encrypted name unverified, so
  // every such project arrives under the same placeholder. Name those from
  // what this device holds instead.
  const device = new Map<string, DeviceTitle>();
  let lastVerified: ReadonlyMap<string, DeviceTitle> = new Map();
  if (encrypted.some((project) => unnamed?.has(project.projectId))) {
    const [{ listLocalProjects }, { cachedShelfNames }] = await Promise.all([
      import('../localProjectStore'),
      import('../projectShelfNames')
    ]);
    for (const project of await listLocalProjects().catch(() => []))
      device.set(project.projectId, project);
    lastVerified = cachedShelfNames(account?.userId ?? e2ee?.userId ?? null);
  }
  const listed: RecoverableProject[] = [];
  // A few at a time: only projects this device pinned cost a request.
  for (let start = 0; start < encrypted.length; start += 6) {
    listed.push(
      ...(await Promise.all(
        encrypted.slice(start, start + 6).map(async (project) => {
          const recovery = groups
            ? await projectAuthorityRecovery(groups, project.projectId).catch(
                () => 'none' as const
              )
            : 'none';
          const title = unnamed?.has(project.projectId)
            ? trustedProjectName(
                device.get(project.projectId),
                lastVerified.get(project.projectId)
              )
            : project.name;
          return {
            projectId: project.projectId,
            name: title ?? UNVERIFIED_PROJECT_NAME,
            ...(title === null ? { unnamed: true as const } : {}),
            ...(recovery === 'restorable' ||
            recovery === 'identity-discontinued'
              ? { authority: recovery }
              : {})
          };
        })
      ))
    );
  }
  return listed;
}

/** What the check after a restoration found, and how far it reached. */
export interface AuthorityRestoreOutcome {
  /** Whether everything that was checked verified. */
  readonly verified: boolean;
  /**
   * Whether the check ran through the account's current saved version, as
   * opening the project does. False when that version could not be read:
   * only the restored record's own key epoch was checked, and `verified`
   * says nothing about a saved version made after it.
   */
  readonly savedVersionChecked: boolean;
  readonly problem?: string;
}

/** This device's version pins, read but never moved. */
const unmovedPins = (pins: Pick<VersionPinStore, 'read'>): VersionPinStore => ({
  read: (userId, projectId) => pins.read(userId, projectId),
  advance: async () => true,
  advanceInfo: async () => true,
  advanceEnvelope: async () => true
});

/**
 * Check a restored project as opening it does, by running the open path
 * itself: the account's saved head and the whole signed log from this
 * device's pinned version up to it, page after page, every version's
 * author checked against the membership of the key epoch its own signed
 * header names, and the head decrypted. Nothing the account merely says
 * about those versions (their key epochs, where the log ends) decides
 * anything, so the project is reported verified only when opening it
 * would succeed.
 *
 * The head may be at a later key epoch than the record this device restored
 * (another device rotated the keys and saved after this one last verified);
 * opening needs that epoch's history too.
 *
 * Verifies only. It reads this device's version pins and moves none: the
 * page that opens the project accepts the head itself. The document it
 * decrypts is dropped.
 */
export async function verifyRestoredAuthority(
  deps: {
    readonly groups: ProjectGroupContext;
    readonly documents: EncryptedDocumentsApi;
    readonly pins: Pick<VersionPinStore, 'read'>;
  },
  projectId: string,
  restoredKeyEpoch: number
): Promise<AuthorityRestoreOutcome> {
  const { groups } = deps;
  const problem = (error: unknown) =>
    error instanceof Error ? error.message : String(error);
  try {
    await epochAuthority(groups, projectId, restoredKeyEpoch);
  } catch (error) {
    return {
      verified: false,
      savedVersionChecked: false,
      problem: problem(error)
    };
  }
  const [
    { createEncryptedProjectStore, EncryptedProjectIntegrityError },
    { createBlobReferenceRegistry }
  ] = await Promise.all([
    import('./encryptedProjectStore'),
    import('./blobReferences')
  ]);
  const references = createBlobReferenceRegistry();
  try {
    await createEncryptedProjectStore({
      groups,
      api: deps.documents,
      pins: unmovedPins(deps.pins),
      blobReferences: references
    }).loadProject(projectId);
    return { verified: true, savedVersionChecked: true };
  } catch (error) {
    // A refusal by the checks themselves is the answer. Anything else (the
    // account unreachable, the session ended) left the saved version
    // unchecked, which is reported as such and never as verified.
    return error instanceof EncryptedProjectIntegrityError ||
      error instanceof ProjectGroupError ||
      error instanceof ProjectAuthorityError ||
      error instanceof E2eeError
      ? {
          verified: false,
          savedVersionChecked: true,
          problem: problem(error)
        }
      : { verified: true, savedVersionChecked: false };
  } finally {
    references.clear();
  }
}

/**
 * Restore one project's authority record from this device's verified copy
 * (issue #1704) after the owner confirmed `AUTHORITY_RESTORE_CONFIRMATION`,
 * then check the project's membership history against it, as opening the
 * project does ({@link verifyRestoredAuthority}). A restored record whose
 * history does not verify leaves the project refused as before.
 */
export async function restoreEncryptedProjectAuthority(
  e2ee: E2eeContext,
  account: AccountView,
  projectId: string,
  confirmation: string
): Promise<AuthorityRestoreOutcome> {
  const groups = pageGroups(e2ee, account);
  const restored = await restoreProjectAuthority(
    groups,
    projectId,
    confirmation
  );
  return verifyRestoredAuthority(
    {
      groups,
      documents: createEncryptedDocumentsApi(desktopFetch),
      pins: versionPins()
    },
    projectId,
    restored.value.latestKeyEpoch
  );
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
