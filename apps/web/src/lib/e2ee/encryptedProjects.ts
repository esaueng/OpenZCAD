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
  pageBlobReferences,
  sessionBoundReferences,
  setEncryptedBlobReader
} from './blobReferences';
import {
  createEncryptedContentBlobs,
  type EncryptedContentBlobs
} from './encryptedContentBlobs';
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
import { getKeySessionRevision, subscribeKeySession } from './keySession';
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
import { contactInvitationPeople, type InvitationContext } from './invitations';
import { invitationStore } from './invitationStore';

export { E2EE_KEYS_LOCKED_CODE };

interface Opened {
  readonly userId: string;
  readonly revision: number;
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
let decoder: E2eeDecoder | null = null;
const warningListeners = new Set<(warning: EncryptedProjectWarning) => void>();
const removalListeners = new Set<(removal: MembersRemoved) => void>();

/**
 * Members who lost access to a project in a Commit this page sent or
 * processed (slice 5-5): an owner's removal or a departure. Share links
 * (slice 5-10) listen here to offer reissuing the project's links with new
 * share keys, since a removed member could keep reading later snapshots of
 * links made before the removal.
 */
export function subscribeMemberRemovals(
  listener: (removal: MembersRemoved) => void
): () => void {
  removalListeners.add(listener);
  return () => removalListeners.delete(listener);
}

subscribeKeySession(() => {
  opened = null;
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
  email: string | null
): Promise<{
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
    store: deviceKeyStore()
  };
  const state = await loadEncryption(e2ee);
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
  // Results finishing after this key session ends keep no keys.
  const references = sessionBoundReferences(pageBlobReferences);
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
      void import('./shareLinks')
        .then(({ shareLinksAfterRemoval }) =>
          shareCtx ? shareLinksAfterRemoval(shareCtx, removal) : null
        )
        .catch(() => undefined);
      for (const listener of removalListeners) {
        try {
          listener(removal);
        } catch {
          // Every listener still hears it.
        }
      }
    },
    // A co-member's device removal rotated a project (slice 5-7): the
    // owner's page states its share links again without that device.
    onMemberDevicesRemoved: (removal: MemberDevicesRemoved) => {
      void import('./shareLinks')
        .then(({ shareLinksAfterDeviceRemoval }) =>
          shareCtx ? shareLinksAfterDeviceRemoval(shareCtx, removal) : null
        )
        .catch(() => undefined);
    }
  };
  const blobs = createEncryptedContentBlobs({
    groups,
    references,
    // Decrypted in the decode worker, within its content-blob budget.
    decode: (job) => pageDecoder.decodeContentBlob(job),
    // A lost blob is stored again from this device's source store.
    loadLocal: async (checksum) =>
      (await import('../localProjectStore')).loadSourceBlob(checksum)
  });
  setEncryptedBlobReader((projectId, blobId, signal, onProgress) =>
    blobs.read(projectId, blobId, signal, onProgress)
  );
  const pins = versionPins();
  let shareCtx: ShareLinksContext | null = null;
  // The editor's encryption indicator hears what this key session verifies.
  const sessionCurrent = () => getKeySessionRevision() === revision;
  const verifying = createEncryptedProjectStore({
    groups,
    pins,
    blobReferences: references,
    restoreBlobs: (projectId, blobIds) => blobs.restore(projectId, blobIds),
    open: (job) => pageDecoder.decodeProjectEnvelope(job),
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
  const store = reportingEncryptedProjectStore(verifying, sessionCurrent);
  shareCtx = {
    groups,
    store,
    api: createE2eeShareLinksApi(desktopFetch),
    blobReferences: pageBlobReferences
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

async function openedForSession(): Promise<Opened> {
  const { userId, email } = await pageSession();
  const revision = getKeySessionRevision();
  if (opened?.userId !== userId || opened.revision !== revision) {
    const both = openStore(userId, revision, email);
    const current: Opened = {
      userId,
      revision,
      store: both.then(({ store }) => store),
      blobs: both.then(({ blobs }) => blobs),
      measurements: both.then(({ measurements }) => measurements),
      viewStates: both.then(({ viewStates }) => viewStates),
      invitations: both.then(({ invitations }) => invitations),
      sharing: both.then(({ sharing }) => sharing)
    };
    opened = current;
    both.then(
      () => {
        if (getKeySessionRevision() === revision) reportKeysUnlocked();
      },
      (error: unknown) => {
        if (opened === current) opened = null;
        // A locked key session shows on the indicator; nothing else does.
        if (getKeySessionRevision() === revision) {
          reportEncryptedFailure(null, error);
        }
      }
    );
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
  const [store, blobs] = await Promise.all([session.store, session.blobs]);
  return {
    info: store.info,
    // Bound to the session current now: a late thumbnail or export keeps no key.
    references: sessionBoundReferences(pageBlobReferences),
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
  records: readonly E2eeProjectEnvelopeRecord[]
): Promise<Map<string, EncryptedShelfEntry>> {
  const store = await encryptedProjectStore();
  const shelf = new Map<string, EncryptedShelfEntry>();
  await Promise.all(
    records.map(async (record) => {
      try {
        const body = await store.info.verify(record);
        shelf.set(record.projectId, {
          name: body.name,
          ...(body.thumbnail ? { thumbnailBlobId: body.thumbnail.blobId } : {})
        });
      } catch {
        // Left out: the placeholder name, no picture.
      }
    })
  );
  return shelf;
}
