/**
 * The page's encrypted-project store (ADR-024 Phase 4, encrypted
 * documents), loaded on demand by `api.ts` the first time a format-2
 * project is created, listed, opened or saved, so no crypto reaches the
 * entry chunk. It unlocks this device's account keys the way Settings ›
 * Encryption does (verifying the device list against this browser's pin)
 * and hands `encryptedProjectStore.ts` the account, this device's certified
 * signing key, the MLS sessions and the decode worker. It also opens the
 * page's encrypted content blobs (`encryptedContentBlobs.ts`): archiving a
 * file into an encrypted project, and reading one back for the source
 * resolver through the decode worker. Slice 4-7 adds the project info's
 * thumbnail and archived exports, encrypted measurements and view state
 * (`replacedEnvelopes.ts`), and the restore of blobs the account lost.
 * Slice 5-10 adds share links (`shareLinks.ts`): after each save this page
 * republishes every active link's snapshot and, on the owner's page,
 * renews statements that are due; a removal issues new ones at once.
 * Everything is dropped when the key session ends (sign-out, expiry,
 * another account).
 */
import type {
  ArtifactRecord,
  CreateProjectRequest,
  CreateProjectResponse,
  E2eeProjectEnvelopeRecord
} from '@openzcad/shared';
import { ApiError } from '../api';
import type { ArchiveArtifactInput } from '../archiveArtifact';
import {
  createBlobReferenceRegistry,
  KeySessionEndedError,
  pageBlobReferences,
  sessionBoundReferences,
  setEncryptedBlobReader,
  type BlobReferenceRegistry
} from './blobReferences';
import {
  createContentBlobsApi,
  createEncryptedContentBlobs,
  uploadTransport,
  type EncryptedContentBlobs
} from './encryptedContentBlobs';
import { createEncryptedDocumentsApi } from './encryptedDocumentsApi';
import type { MigrationStagingClients } from './projectMigrationEngine';
import { desktopFetch } from '../desktopBridge';
import {
  loadEncryption,
  withIdentityKey,
  type E2eeContext,
  type UnlockAuthorization
} from './accountKeys';
import { createE2eeDecoder, type E2eeDecoder } from './decodeWorker';
import { createE2eeApi } from './e2eeApi';
import {
  E2EE_KEYS_LOCKED_CODE,
  createEncryptedProjectStore,
  type EncryptedCopyRequest,
  type EncryptedProjectStore,
  type EncryptedProjectWarning
} from './encryptedProjectStore';
import { deviceKeyStore } from './keychainDeviceKeys';
import {
  getKeySessionRevision,
  isCurrentKeySession,
  subscribeKeySession
} from './keySession';
import { mlsProjectSessions } from './mls/projectSessions';
import {
  createProjectGroupsApi,
  projectGroupAccount,
  type MemberDevicesRemoved,
  type MembersRemoved
} from './projectGroups';
import {
  createEncryptedMeasurements,
  createEncryptedViewStates,
  createReplacedEnvelopesApi,
  type EncryptedMeasurements,
  type EncryptedViewStates
} from './replacedEnvelopes';
import {
  EXPORT_ARTIFACT_KINDS,
  archiveExport,
  exportArtifacts,
  publishThumbnail,
  type ProjectFilesDeps
} from './encryptedProjectInfo';
import { versionPins } from './versionPins';
import {
  reportEncryptedFailure,
  reportKeysUnlocked,
  reportVerificationWarning
} from './encryptionStatus';
import { reportingEncryptedProjectStore } from './encryptionStatusReports';
import {
  createRevocationCutoffsApi,
  localPendingCutoffs,
  revocationStatements,
  storePendingCutoffs
} from './deviceRemoval';
import { contactsContext } from './contacts';
import { contactMemberLists } from './memberLists';
import {
  createE2eeInvitationsApi,
  createE2eeShareLinksApi
} from '@openzcad/shared';
import type { ShareDelegationState, ShareLinksContext } from './shareLinks';
import type { ShareRemovalNotice } from './shareWorkStore';
import { contactInvitationPeople, type InvitationContext } from './invitations';
import { invitationStore } from './invitationStore';
import { subscribeEncryptionState } from './encryptionStateEvents';
import { unlockedAccount } from './unlockedKeys';
import { verifyShelfEntries } from './progressiveShelf';

export { E2EE_KEYS_LOCKED_CODE };

interface Opened {
  readonly userId: string;
  readonly revision: number;
  readonly lifetime: { active: boolean };
  readonly references: Promise<BlobReferenceRegistry>;
  readonly store: Promise<EncryptedProjectStore>;
  readonly blobs: Promise<EncryptedContentBlobs>;
  readonly measurements: Promise<EncryptedMeasurements>;
  readonly viewStates: Promise<EncryptedViewStates>;
  readonly invitations: Promise<InvitationContext>;
  readonly sharing: Promise<PageShareLinks>;
}

/** The page's share links of encrypted projects (slice 5-10). */
export interface PageShareLinks {
  readonly ctx: ShareLinksContext;
  /**
   * Renews this account's share delegation with the identity key, opened by
   * a fresh passkey ceremony or the recovery key for this one signature.
   */
  renewDelegation(
    authorization: UnlockAuthorization
  ): Promise<ShareDelegationState>;
}

let opened: Opened | null = null;
let accountViewRevision = 0;
let stopEncryptionState: (() => void) | null = null;
let decoder: E2eeDecoder | null = null;
const warningListeners = new Set<(warning: EncryptedProjectWarning) => void>();
type SharingRemoval = MembersRemoved & {
  readonly shareNotice?: ShareRemovalNotice;
};
const removalListeners = new Set<(removal: SharingRemoval) => void>();

/**
 * Members who lost access to a project in a Commit this page sent or
 * processed (slice 5-5): an owner's removal or a departure. Share links
 * (slice 5-10) listen here to offer reissuing the project's links with new
 * share keys, since a removed member could keep reading later snapshots of
 * links made before the removal.
 */
export function subscribeMemberRemovals(
  listener: (removal: SharingRemoval) => void
): () => void {
  removalListeners.add(listener);
  return () => removalListeners.delete(listener);
}

function forgetOpened(keepStateSubscription = false): void {
  if (opened) {
    accountViewRevision += 1;
    opened.lifetime.active = false;
    // Rechecks and rotations preserve unlocked file references. A lock
    // drops them before a newly opened reader can use them.
    if (!unlockedAccount(opened.userId)) pageBlobReferences.clear();
  }
  opened = null;
  setEncryptedBlobReader(null);
  if (!keepStateSubscription) {
    stopEncryptionState?.();
    stopEncryptionState = null;
  }
}

/** Retire the view; unlocked direct file readers can reopen lazily. */
function invalidateAccountClients(userId: string, revision: number): void {
  if (!opened) accountViewRevision += 1;
  forgetOpened(true);
  if (!unlockedAccount(userId)) {
    pageBlobReferences.clear();
    return;
  }
  const viewRevision = accountViewRevision;
  setEncryptedBlobReader(async (projectId, blobId, signal, onProgress) => {
    const requireExpected = (sessionUserId = userId) => {
      if (
        sessionUserId !== userId ||
        accountViewRevision !== viewRevision ||
        !isCurrentKeySession(revision) ||
        !unlockedAccount(userId)
      ) {
        throw new KeySessionEndedError();
      }
    };
    requireExpected();
    const session = await openedForSession(requireExpected);
    return (await session.blobs).read(projectId, blobId, signal, onProgress);
  });
}

subscribeKeySession(() => {
  forgetOpened();
  decoder?.dispose();
  decoder = null;
  // Blob keys go with the key session that opened their documents.
  setEncryptedBlobReader(null);
  pageBlobReferences.clear();
});

/** Warnings a fresh browser raises, such as a head older than the account's activity. */
export function subscribeEncryptedProjectWarnings(
  listener: (warning: EncryptedProjectWarning) => void
): () => void {
  warningListeners.add(listener);
  return () => warningListeners.delete(listener);
}

/** Journal completion wakes the dialog independently of remote upkeep. */
function removalNotifier(
  removal: MembersRemoved
): (notice?: ShareRemovalNotice) => void {
  let notified = false;
  return (notice) => {
    if (notified) return;
    notified = true;
    for (const listener of removalListeners) {
      try {
        listener({ ...removal, ...(notice ? { shareNotice: notice } : {}) });
      } catch {
        /* Every listener still hears it. */
      }
    }
  };
}

async function pageSession(): Promise<{
  userId: string;
  email: string | null;
}> {
  const response = await desktopFetch('/api/session', {
    credentials: 'same-origin'
  });
  if (!response.ok) {
    throw new ApiError(
      response.status,
      'Sign in again to open encrypted projects.'
    );
  }
  const session = (await response.json()) as {
    userId?: unknown;
    email?: unknown;
  };
  if (typeof session.userId !== 'string') {
    throw new ApiError(401, 'Sign in again to open encrypted projects.');
  }
  return {
    userId: session.userId,
    email: typeof session.email === 'string' ? session.email : null
  };
}

const locked = () =>
  new ApiError(
    403,
    'Unlock encryption on this device (Settings › Encryption) to open or save encrypted projects.',
    E2EE_KEYS_LOCKED_CODE
  );

async function openStore(
  userId: string,
  revision: number,
  email: string | null,
  current: () => boolean
): Promise<{
  references: BlobReferenceRegistry;
  store: EncryptedProjectStore;
  blobs: EncryptedContentBlobs;
  measurements: EncryptedMeasurements;
  viewStates: EncryptedViewStates;
  invitations: InvitationContext;
  sharing: PageShareLinks;
}> {
  const e2ee: E2eeContext = {
    userId,
    api: createE2eeApi(),
    store: deviceKeyStore(),
    isCurrent: () => current() && getKeySessionRevision() === revision
  };
  const state = await loadEncryption(e2ee);
  const requireCurrent = () => {
    if (!current() || !isCurrentKeySession(revision)) {
      throw new KeySessionEndedError();
    }
  };
  requireCurrent();
  if (state.kind !== 'ready' || !state.account.unlocked) throw locked();
  const account = state.account;
  const device =
    account.deviceStatus === 'certified' && account.device
      ? {
          userId,
          deviceId: account.device.deviceId,
          signing: account.device.signing
        }
      : null;
  decoder ??= createE2eeDecoder();
  const pageDecoder = decoder;
  // Both the key session and this particular account view own these keys.
  const references = sessionBoundReferences(pageBlobReferences, {
    revision: () => revision,
    isCurrent: (seen) =>
      seen === revision && current() && isCurrentKeySession(revision)
  });
  const cutoffsApi = createRevocationCutoffsApi();
  // A cutoff statement an earlier removal on this device could not store
  // goes first, so the directory and authorship below can read it.
  await storePendingCutoffs(cutoffsApi, localPendingCutoffs(), userId).catch(
    () => 0
  );
  const groupsApi = createProjectGroupsApi();
  const contacts = contactsContext(e2ee);
  const groups = {
    api: groupsApi,
    sessions: mlsProjectSessions(),
    account: projectGroupAccount(e2ee, account),
    device,
    // Verified revocation cutoffs (slice 4-10): the MLS directory and
    // version authorship need one for every removed device.
    revocations: revocationStatements(cutoffsApi, {
      list: account.list,
      generation: account.generation
    }),
    // Shared projects (slice 5-2): co-members' device lists, checked by the
    // contacts module (slice 5-1) against this browser's verified and seen
    // pins. A solo project looks nothing up.
    members: contactMemberLists({
      contacts,
      account,
      leaves: (projectId) => groupsApi.leaves(projectId)
    }),
    // The share-link reissue hook (slice 5-5, for slice 5-10): the owner's
    // page issues new statements at once, and the dialog offers reissue.
    onMembersRemoved: (removal: MembersRemoved) => {
      const notify = removalNotifier(removal);
      void import('./shareLinks')
        .then(({ shareLinksAfterRemoval }) => {
          if (shareCtx)
            return shareLinksAfterRemoval(shareCtx, removal, notify);
          notify();
          return null;
        })
        .catch(() => notify());
    },
    // A co-member's device removal rotated a project (slice 5-7): the
    // owner's page states its share links again without that device.
    onMemberDevicesRemoved: (removal: MemberDevicesRemoved) => {
      const notice: MembersRemoved = {
        projectId: removal.projectId,
        keyEpoch: removal.keyEpoch,
        userIds: [...new Set(removal.devices.map((device) => device.userId))]
      };
      const notify = removalNotifier(notice);
      void import('./shareLinks')
        .then(({ shareLinksAfterDeviceRemoval }) => {
          if (shareCtx)
            return shareLinksAfterDeviceRemoval(shareCtx, removal, notify);
          notify();
          return null;
        })
        .catch(() => notify());
    },
    // A Commit refused because this account's devices changed elsewhere
    // (#908 review): `account` is stale, so the next operation opens the
    // store again on a freshly loaded account view, whose Commit carries
    // the rotation a removal made due. The unlocked keys stay.
    onDeviceListChanged: () => {
      if (current()) invalidateAccountClients(userId, revision);
    }
  };
  const readingBlobs = createEncryptedContentBlobs({
    groups,
    references,
    // Decrypted in the decode worker, within its content-blob budget.
    decode: async (job) => {
      requireCurrent();
      const result = await pageDecoder.decodeContentBlob(job);
      try {
        requireCurrent();
      } catch (error) {
        if ('chunks' in result) {
          for (const chunk of result.chunks) chunk.fill(0);
        }
        throw error;
      }
      return result;
    },
    // A lost blob is stored again from this device's source store.
    loadLocal: async (checksum) =>
      (await import('../localProjectStore')).loadSourceBlob(checksum)
  });
  const blobs: EncryptedContentBlobs = {
    ...readingBlobs,
    async read(...args) {
      requireCurrent();
      const bytes = await readingBlobs.read(...args);
      try {
        requireCurrent();
      } catch (error) {
        bytes.fill(0);
        throw error;
      }
      return bytes;
    }
  };
  requireCurrent();
  setEncryptedBlobReader((...args) => blobs.read(...args));
  const pins = versionPins();
  let shareCtx: ShareLinksContext | null = null;
  // The editor's encryption indicator hears what this key session verifies.
  const sessionCurrent = () =>
    current() && getKeySessionRevision() === revision;
  const verifying = createEncryptedProjectStore({
    groups,
    pins,
    blobReferences: references,
    restoreBlobs: (projectId, blobIds) => blobs.restore(projectId, blobIds),
    open: async (job) => {
      requireCurrent();
      const result = await pageDecoder.decodeProjectEnvelope(job);
      try {
        requireCurrent();
      } catch (error) {
        if ('blobs' in result.value) {
          for (const reference of result.value.blobs ?? [])
            reference.key.fill(0);
        }
        throw error;
      }
      return result;
    },
    seal: (job) => pageDecoder.sealDocument(job),
    // Share links (slice 5-10): every active link's snapshot follows the
    // save, and the owner's page renews statements that are due.
    onVersionWritten: async (projectId, head) => {
      if (!shareCtx || !head.shareLinks?.links.length) return;
      const links = await import('./shareLinks');
      await links.publishShareSnapshots(shareCtx, projectId, head);
      await links
        .issueShareAuthorities(shareCtx, projectId, { head })
        .catch(() => undefined);
    },
    // Geometry workers resolve sources from this device's blob store: put
    // the document's encrypted sources there before it is rebuilt.
    onDocument: async (_projectId, document) => {
      const { preloadEncryptedImportSources } =
        await import('../exactSourceResolver');
      await preloadEncryptedImportSources(document);
    },
    onWarning: (warning) => {
      if (sessionCurrent()) {
        reportVerificationWarning(warning.projectId, {
          kind: warning.kind,
          signedAt: warning.signedAt,
          updatedAt: warning.updatedAt
        });
      }
      for (const listener of warningListeners) {
        try {
          listener(warning);
        } catch {
          // Every listener still hears it.
        }
      }
    }
  });
  const store = reportingEncryptedProjectStore(
    verifying,
    sessionCurrent,
    requireCurrent
  );
  shareCtx = {
    groups,
    store,
    api: createE2eeShareLinksApi(desktopFetch),
    blobReferences: references
  };
  const sharingCtx = shareCtx;
  const sharing: PageShareLinks = {
    ctx: sharingCtx,
    renewDelegation: async (authorization) => {
      const { renewShareDelegation, signWithIdentityKey } =
        await import('./shareLinks');
      return withIdentityKey(e2ee, account, authorization, (key) =>
        renewShareDelegation(sharingCtx, signWithIdentityKey(key))
      );
    }
  };
  return {
    references,
    store,
    blobs,
    sharing,
    measurements: createEncryptedMeasurements({
      userId,
      kit: store.replaced,
      pins
    }),
    viewStates: createEncryptedViewStates({
      userId,
      kit: store.replaced,
      pins
    }),
    // Invitations (slice 5-3b): verified-contact checks through the same
    // contacts module the co-members' lists come from.
    invitations: {
      groups,
      api: createE2eeInvitationsApi(desktopFetch),
      people: contactInvitationPeople(contacts, account),
      store: invitationStore(),
      email
    }
  };
}

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

/**
 * The encrypted-project clients a migration stages through (ADR-024 Phase
 * 7, slice 7-2): this device's keys, MLS sessions, pins and decode worker,
 * as the page's own store has them, but every request through the
 * fetcher `open` is given, which names the migration lease. Their blob keys stay in a registry of
 * their own until the project's verified documents hand them to the page.
 */
export async function openMigrationStaging(expectedUserId?: string): Promise<{
  deviceId: string;
  open: (fetcher: Fetch) => MigrationStagingClients;
}> {
  const revision = getKeySessionRevision();
  const { userId, email } = await pageSession();
  if (
    (expectedUserId !== undefined && expectedUserId !== userId) ||
    !isCurrentKeySession(revision)
  )
    throw locked();
  const e2ee: E2eeContext = {
    userId,
    api: createE2eeApi(),
    store: deviceKeyStore(),
    isCurrent: () => isCurrentKeySession(revision)
  };
  const state = await loadEncryption(e2ee);
  if (state.kind !== 'ready' || !state.account.unlocked) throw locked();
  const account = state.account;
  if (account.deviceStatus !== 'certified' || !account.device) {
    throw new ApiError(
      403,
      'Encrypt existing projects from a device listed in Settings › Encryption.',
      'E2EE_READ_ONLY_DEVICE'
    );
  }
  const device = {
    userId,
    deviceId: account.device.deviceId,
    signing: account.device.signing
  };
  decoder ??= createE2eeDecoder();
  const pageDecoder = decoder;
  const contacts = contactsContext(e2ee);
  return {
    deviceId: device.deviceId,
    open(fetcher) {
      const groupsApi = createProjectGroupsApi(fetcher);
      const groups = {
        api: groupsApi,
        sessions: mlsProjectSessions(),
        account: projectGroupAccount(e2ee, account),
        device,
        revocations: revocationStatements(createRevocationCutoffsApi(fetcher), {
          list: account.list,
          generation: account.generation
        }),
        // Slice 7-4: the members a shared project's staging re-adds, from
        // the contacts module, as the page's own store has them.
        members: contactMemberLists({
          contacts,
          account,
          leaves: (projectId) => groupsApi.leaves(projectId)
        })
      };
      const references = createBlobReferenceRegistry();
      const blobs = createEncryptedContentBlobs({
        groups,
        references,
        api: createContentBlobsApi(fetcher),
        transport: uploadTransport(fetcher),
        decode: (job) => pageDecoder.decodeContentBlob(job)
      });
      const documents = createEncryptedDocumentsApi(fetcher);
      const pins = versionPins();
      const store = createEncryptedProjectStore({
        groups,
        api: documents,
        pins,
        blobReferences: references,
        open: (job) => pageDecoder.decodeProjectEnvelope(job),
        seal: (job) => pageDecoder.sealDocument(job)
      });
      const replacedApi = createReplacedEnvelopesApi(fetcher);
      return {
        store,
        blobs,
        references,
        groups,
        documents,
        // Slice 7-4: re-add invitations and Adds of a shared project's
        // members, under the lease.
        invitations: {
          groups,
          api: createE2eeInvitationsApi(fetcher),
          people: contactInvitationPeople(contacts, account),
          store: invitationStore(),
          email
        },
        measurements: createEncryptedMeasurements({
          userId,
          kit: store.replaced,
          pins,
          api: replacedApi
        }),
        viewStates: createEncryptedViewStates({
          userId,
          kit: store.replaced,
          pins,
          api: replacedApi
        })
      };
    }
  };
}

async function openedForSession(
  checkSession?: (userId: string) => void
): Promise<Opened> {
  const { userId, email } = await pageSession();
  checkSession?.(userId);
  const revision = getKeySessionRevision();
  if (opened?.userId !== userId || opened.revision !== revision) {
    // An unlocked invalidation already installed a lazy reader. Keep it
    // available while this shared opening is pending.
    if (opened) forgetOpened();
    const lifetime = { active: true };
    const both = openStore(userId, revision, email, () => lifetime.active);
    const current: Opened = {
      userId,
      revision,
      lifetime,
      references: both.then(({ references }) => references),
      store: both.then(({ store }) => store),
      blobs: both.then(({ blobs }) => blobs),
      measurements: both.then(({ measurements }) => measurements),
      viewStates: both.then(({ viewStates }) => viewStates),
      invitations: both.then(({ invitations }) => invitations),
      sharing: both.then(({ sharing }) => sharing)
    };
    opened = current;
    // Settings can rotate this account's keys without ending its session.
    // Every client above captures the verified account view, so reopen them
    // after that change rather than pairing the old view with the new key.
    // Keep unlocked keys on rotations; a locked state drops blob access too.
    stopEncryptionState?.();
    stopEncryptionState = subscribeEncryptionState(userId, () => {
      if (!opened || opened === current)
        invalidateAccountClients(userId, revision);
    });
    both.then(
      () => {
        if (opened === current && getKeySessionRevision() === revision)
          reportKeysUnlocked();
      },
      (error: unknown) => {
        const report =
          opened === current && getKeySessionRevision() === revision;
        if (opened === current) invalidateAccountClients(userId, revision);
        // A locked key session shows on the indicator; nothing else does.
        if (report) {
          reportEncryptedFailure(null, error);
        }
      }
    );
    current.store.catch(() => undefined);
    current.references.catch(() => undefined);
    current.blobs.catch(() => undefined);
    current.measurements.catch(() => undefined);
    current.viewStates.catch(() => undefined);
    current.invitations.catch(() => undefined);
    current.sharing.catch(() => undefined);
  }
  return opened;
}

/** This page's store for the signed-in account, opened once per key session. */
export async function encryptedProjectStore(): Promise<EncryptedProjectStore> {
  return (await openedForSession()).store;
}

/** The thumbnail and export paths' view of this page. */
async function projectFiles(): Promise<ProjectFilesDeps> {
  const session = await openedForSession();
  const [store, blobs, references] = await Promise.all([
    session.store,
    session.blobs,
    session.references
  ]);
  return {
    info: store.info,
    references,
    archive: (projectId, input) => blobs.archive(projectId, input)
  };
}

/**
 * `archiveArtifact` for an encrypted project: the file becomes an encrypted
 * content blob, and its blob id is the artifact id the document records.
 * An export is listed in the project info as well (slice 4-7).
 */
export async function archiveEncryptedArtifact(
  projectId: string,
  input: ArchiveArtifactInput
): Promise<string> {
  if (EXPORT_ARTIFACT_KINDS.has(input.kind)) {
    return archiveExport(await projectFiles(), projectId, input);
  }
  return (await (await openedForSession()).blobs).archive(projectId, input);
}

/**
 * The account's archived exports of an encrypted project, as the File menu
 * lists stored files: from its verified project info, newest first.
 */
export async function listEncryptedArtifacts(
  projectId: string
): Promise<ArtifactRecord[]> {
  const { body } = await (await encryptedProjectStore()).info.read(projectId);
  return exportArtifacts(projectId, body);
}

/**
 * Publishes a captured shelf thumbnail of an encrypted project: a thumbnail
 * blob, named by a new project info (slice 4-7). Resolves to its blob id.
 */
export async function publishEncryptedThumbnail(
  projectId: string,
  image: Blob
): Promise<string> {
  return publishThumbnail(await projectFiles(), projectId, image);
}

/**
 * The page's invitations to encrypted projects (slice 5-3b): the sharing
 * dialog's encrypted branch and Settings › Encryption › Invitations.
 */
export async function encryptedInvitations(): Promise<InvitationContext> {
  return (await openedForSession()).invitations;
}

/** The page's share links of encrypted projects (slice 5-10). */
export async function encryptedShareLinks(): Promise<PageShareLinks> {
  return (await openedForSession()).sharing;
}

/** The page's encrypted measurements client (`measurementCloudSync.ts`). */
export async function encryptedMeasurements(): Promise<EncryptedMeasurements> {
  return (await openedForSession()).measurements;
}

/** The page's encrypted view-state client (`workspaceResume.ts`). */
export async function encryptedViewStates(): Promise<EncryptedViewStates> {
  return (await openedForSession()).viewStates;
}

export async function createEncryptedProject(
  request: CreateProjectRequest
): Promise<CreateProjectResponse> {
  return (await encryptedProjectStore()).createProject(request);
}

/**
 * Stores a copy or branch of an encrypted project the page built from its
 * verified source (slice 4-8): the account copies its files byte for byte.
 */
export async function copyEncryptedProject(
  request: EncryptedCopyRequest
): Promise<CreateProjectResponse> {
  return (await encryptedProjectStore()).copyProject(request);
}

/** Decrypted names by project id; a name that fails to verify is left out. */
export async function encryptedProjectNames(
  records: readonly E2eeProjectEnvelopeRecord[]
): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  for (const [projectId, shelf] of await encryptedProjectShelf(records)) {
    names.set(projectId, shelf.name);
  }
  return names;
}

/** What the shelf shows of an encrypted project, from its project info. */
export interface EncryptedShelfEntry {
  readonly name: string;
  /** The thumbnail blob, whose reference this page now holds. */
  readonly thumbnailBlobId?: string;
}

/**
 * Names and thumbnails by project id, from verified project-info
 * envelopes; one that fails to verify is left out. Each thumbnail's
 * reference is registered with this page, so the shelf downloads and
 * decrypts it like any other blob.
 */
export async function encryptedProjectShelf(
  records: readonly E2eeProjectEnvelopeRecord[],
  progress?: {
    isCurrent(): boolean;
    onEntry(projectId: string, entry: EncryptedShelfEntry): void;
  }
): Promise<Map<string, EncryptedShelfEntry>> {
  const revision = getKeySessionRevision();
  const sessionCurrent = () =>
    isCurrentKeySession(revision) && (progress?.isCurrent() ?? true);
  if (!sessionCurrent()) return new Map();
  const view = await openedForSession();
  let store = await view.store;
  const isCurrent = () => sessionCurrent() && !!unlockedAccount(view.userId);
  const shelf = new Map<string, EncryptedShelfEntry>();
  await verifyShelfEntries(
    records,
    async (record) => {
      try {
        return await store.info.verify(record);
      } catch (error) {
        if (!(error instanceof KeySessionEndedError) || !isCurrent())
          throw error;
        // A settings recheck retired the captured verifier. Retry once
        // against the fresh account view without another catalog request.
        store = await encryptedProjectStore();
        return store.info.verify(record);
      }
    },
    (record, body) => {
      const entry = {
        name: body.name,
        ...(body.thumbnail ? { thumbnailBlobId: body.thumbnail.blobId } : {})
      };
      shelf.set(record.projectId, entry);
      progress?.onEntry(record.projectId, entry);
    },
    isCurrent
  );
  return isCurrent() ? shelf : new Map();
}
