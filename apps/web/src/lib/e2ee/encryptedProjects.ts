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
  pageBlobReferences,
  sessionBoundReferences,
  setEncryptedBlobReader
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
import { loadEncryption, type E2eeContext } from './accountKeys';
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
import { createE2eeInvitationsApi } from '@openzcad/shared';
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
    // The share-link reissue hook (slice 5-5, for slice 5-10).
    onMembersRemoved: (removal: MembersRemoved) => {
      for (const listener of removalListeners) {
        try {
          listener(removal);
        } catch {
          // Every listener still hears it.
        }
      }
    },
    // A Commit refused because this account's devices changed elsewhere
    // (#908 review): `account` is stale, so the next operation opens the
    // store again on a freshly loaded account view, whose Commit carries
    // the rotation a removal made due. The unlocked keys stay.
    onDeviceListChanged: () => {
      if (opened?.userId === userId && opened.revision === revision) {
        opened = null;
      }
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
  // The editor's encryption indicator hears what this key session verifies.
  const sessionCurrent = () => getKeySessionRevision() === revision;
  const verifying = createEncryptedProjectStore({
    groups,
    pins,
    blobReferences: references,
    restoreBlobs: (projectId, blobIds) => blobs.restore(projectId, blobIds),
    open: (job) => pageDecoder.decodeProjectEnvelope(job),
    seal: (job) => pageDecoder.sealDocument(job),
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
  return {
    store,
    blobs,
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
export async function openMigrationStaging(): Promise<{
  deviceId: string;
  open: (fetcher: Fetch) => MigrationStagingClients;
}> {
  const { userId } = await pageSession();
  const e2ee: E2eeContext = {
    userId,
    api: createE2eeApi(),
    store: deviceKeyStore()
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
  return {
    deviceId: device.deviceId,
    open(fetcher) {
      const groups = {
        api: createProjectGroupsApi(fetcher),
        sessions: mlsProjectSessions(),
        account: projectGroupAccount(e2ee, account),
        device,
        revocations: revocationStatements(createRevocationCutoffsApi(fetcher), {
          list: account.list,
          generation: account.generation
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
      invitations: both.then(({ invitations }) => invitations)
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
