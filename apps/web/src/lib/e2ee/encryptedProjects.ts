/**
 * The page's encrypted-project store (ADR-024 Phase 4, encrypted
 * documents), loaded on demand by `api.ts` the first time a format-2
 * project is created, listed, opened or saved, so no crypto reaches the
 * entry chunk. It unlocks this device's account keys the way Settings ›
 * Encryption does (verifying the device list against this browser's pin)
 * and hands `encryptedProjectStore.ts` the account, this device's certified
 * signing key, the MLS sessions and the decode worker. Everything is
 * dropped when the key session ends (sign-out, expiry, another account).
 */
import type {
  CreateProjectRequest,
  CreateProjectResponse,
  E2eeProjectEnvelopeRecord
} from '@openzcad/shared';
import { ApiError } from '../api';
import { desktopFetch } from '../desktopBridge';
import { loadEncryption, type E2eeContext } from './accountKeys';
import { createE2eeDecoder, type E2eeDecoder } from './decodeWorker';
import { createE2eeApi } from './e2eeApi';
import {
  E2EE_KEYS_LOCKED_CODE,
  createEncryptedProjectStore,
  type EncryptedProjectStore,
  type EncryptedProjectWarning
} from './encryptedProjectStore';
import { deviceKeyStore } from './keychainDeviceKeys';
import { getKeySessionRevision, subscribeKeySession } from './keySession';
import { mlsProjectSessions } from './mls/projectSessions';
import { createProjectGroupsApi, projectGroupAccount } from './projectGroups';

export { E2EE_KEYS_LOCKED_CODE };

interface Opened {
  readonly userId: string;
  readonly revision: number;
  readonly store: Promise<EncryptedProjectStore>;
}

let opened: Opened | null = null;
let decoder: E2eeDecoder | null = null;
const warningListeners = new Set<(warning: EncryptedProjectWarning) => void>();

subscribeKeySession(() => {
  opened = null;
  decoder?.dispose();
  decoder = null;
});

/** Warnings a fresh browser raises, such as a head older than the account's activity. */
export function subscribeEncryptedProjectWarnings(
  listener: (warning: EncryptedProjectWarning) => void
): () => void {
  warningListeners.add(listener);
  return () => warningListeners.delete(listener);
}

async function sessionUserId(): Promise<string> {
  const response = await desktopFetch('/api/session', {
    credentials: 'same-origin'
  });
  if (!response.ok) {
    throw new ApiError(
      response.status,
      'Sign in again to open encrypted projects.'
    );
  }
  const session = (await response.json()) as { userId?: unknown };
  if (typeof session.userId !== 'string') {
    throw new ApiError(401, 'Sign in again to open encrypted projects.');
  }
  return session.userId;
}

const locked = () =>
  new ApiError(
    403,
    'Unlock encryption on this device (Settings › Encryption) to open or save encrypted projects.',
    E2EE_KEYS_LOCKED_CODE
  );

async function openStore(userId: string): Promise<EncryptedProjectStore> {
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
  return createEncryptedProjectStore({
    groups: {
      api: createProjectGroupsApi(),
      sessions: mlsProjectSessions(),
      account: projectGroupAccount(e2ee, account),
      device
    },
    open: (job) => pageDecoder.decodeProjectEnvelope(job),
    onWarning: (warning) => {
      for (const listener of warningListeners) {
        try {
          listener(warning);
        } catch {
          // Every listener still hears it.
        }
      }
    }
  });
}

/** This page's store for the signed-in account, opened once per key session. */
export async function encryptedProjectStore(): Promise<EncryptedProjectStore> {
  const userId = await sessionUserId();
  const revision = getKeySessionRevision();
  if (opened?.userId !== userId || opened.revision !== revision) {
    const store = openStore(userId);
    opened = { userId, revision, store };
    store.catch(() => {
      if (opened?.store === store) opened = null;
    });
  }
  return opened.store;
}

/**
 * Whether new projects of this account are created encrypted: the Worker
 * opens encrypted projects to it and its stored opt-in says so. Reading the
 * server's opt-in without its MAC errs toward encrypting; the Worker
 * refuses plaintext creates for an opted-in account either way (D2).
 */
export async function encryptsNewProjects(): Promise<boolean> {
  try {
    const config = await desktopFetch('/api/e2ee/config', {
      credentials: 'same-origin'
    });
    if (!config.ok) return false;
    const { enabled, projectsEnabled } = (await config.json()) as {
      enabled?: unknown;
      projectsEnabled?: unknown;
    };
    if (enabled !== true || projectsEnabled !== true) return false;
    const response = await desktopFetch('/api/e2ee/project-preferences', {
      credentials: 'same-origin'
    });
    if (!response.ok) return false;
    const { preference } = (await response.json()) as {
      preference?: { encryptNewProjects?: unknown } | null;
    };
    return preference?.encryptNewProjects === true;
  } catch {
    return false;
  }
}

export async function createEncryptedProject(
  request: CreateProjectRequest
): Promise<CreateProjectResponse> {
  return (await encryptedProjectStore()).createProject(request);
}

/** Decrypted names by project id; a name that fails to verify is left out. */
export async function encryptedProjectNames(
  records: readonly E2eeProjectEnvelopeRecord[]
): Promise<Map<string, string>> {
  const store = await encryptedProjectStore();
  const names = new Map<string, string>();
  await Promise.all(
    records.map(async (record) => {
      const name = await store.projectName(record);
      if (name !== null) names.set(record.projectId, name);
    })
  );
  return names;
}
