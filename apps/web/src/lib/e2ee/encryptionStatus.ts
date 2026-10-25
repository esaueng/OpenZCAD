/**
 * What the editor's encryption indicator shows for an end-to-end encrypted
 * project (ADR-024 Phase 4): the outcome of the last head this page opened
 * or wrote, an active verification warning, keys locked on this device, or
 * a verification failure. The encrypted-project store reports here
 * (`encryptionStatusReports.ts`, loaded with it); the top bar reads it.
 *
 * Free of any crypto import, like `unlockedKeys.ts` and `keySession.ts`, so
 * the app shell can read it without pulling the key code into the entry
 * chunk. Everything is forgotten when the key session ends.
 */
import { useCallback, useSyncExternalStore } from 'react';
import { subscribeKeySession } from './keySession';

export type EncryptionStatusState =
  /** Nothing this page opened or wrote for the project has been checked yet. */
  | 'unverified'
  /** The last head this page opened or wrote passed verification. */
  | 'verified'
  /** It passed, but a verification warning is active (a head trailing activity). */
  | 'warning'
  /** This device's encryption keys are locked. */
  | 'locked'
  /** A version failed verification, or the account copy needs repair. */
  | 'problem';

/** A fresh browser's head trailing the account's activity (`stale-head`). */
export interface EncryptionStatusWarning {
  readonly kind: 'stale-head';
  /** The head's signed timestamp, Unix ms. */
  readonly signedAt: number;
  /** The account's last recorded activity, Unix ms (plaintext, a hint). */
  readonly updatedAt: number;
}

export interface EncryptionStatus {
  readonly state: EncryptionStatusState;
  readonly warning?: EncryptionStatusWarning;
  /** The failed verification's own words, for `problem`. */
  readonly problem?: string;
}

/** A project-scoped verification outcome; the lock is device-wide. */
interface ProjectRecord {
  readonly verified: boolean;
  readonly warning?: EncryptionStatusWarning;
  readonly problem?: string;
}

/** The refusal code a locked key session raises (`encryptedProjectStore.ts`). */
const KEYS_LOCKED_CODE = 'E2EE_KEYS_LOCKED';

const UNVERIFIED: EncryptionStatus = Object.freeze({ state: 'unverified' });
const records = new Map<string, ProjectRecord>();
const derived = new Map<string, EncryptionStatus>();
const listeners = new Set<() => void>();
let keysLocked = false;

function changed(): void {
  derived.clear();
  for (const listener of listeners) {
    try {
      listener();
    } catch {
      // Every other subscriber still hears it.
    }
  }
}

/** Stores the record; whether it differs from the one it replaces. */
function store(projectId: string, next: ProjectRecord): boolean {
  const previous = records.get(projectId);
  if (
    previous &&
    previous.verified === next.verified &&
    previous.warning === next.warning &&
    previous.problem === next.problem
  ) {
    return false;
  }
  records.set(projectId, next);
  return true;
}

/** The last head this page opened or wrote for the project verified. */
export function reportHeadVerified(projectId: string): void {
  const previous = records.get(projectId);
  // A head that verified shows the keys are open on this page.
  const wasLocked = keysLocked;
  keysLocked = false;
  const stored = store(projectId, {
    verified: true,
    ...(previous?.warning ? { warning: previous.warning } : {})
  });
  if (stored || wasLocked) changed();
}

/**
 * A verification warning for the project. It stays until the project is
 * switched away from or the key session ends: a later head of this page
 * does not show that the head it trailed was the newest.
 */
export function reportVerificationWarning(
  projectId: string,
  warning: EncryptionStatusWarning
): void {
  const previous = records.get(projectId);
  const stored = store(projectId, {
    verified: previous?.verified ?? false,
    warning,
    ...(previous?.problem ? { problem: previous.problem } : {})
  });
  if (stored) changed();
}

/** The integrity reason an `EncryptedProjectIntegrityError` carries. */
function integrityReasonOf(error: unknown): string | null {
  if (!error || typeof error !== 'object') return null;
  const details = (error as { details?: unknown }).details;
  if (!details || typeof details !== 'object') return null;
  const reason = (details as { e2eeIntegrity?: unknown }).e2eeIntegrity;
  return typeof reason === 'string' ? reason : null;
}

export function isKeysLockedError(error: unknown): boolean {
  return (
    !!error &&
    typeof error === 'object' &&
    (error as { code?: unknown }).code === KEYS_LOCKED_CODE
  );
}

/**
 * An encrypted-project operation failed. A verification failure of a
 * project marks it `problem`; a locked key session marks every encrypted
 * project `locked`. Anything else (offline, a refused write) says nothing
 * about verification and changes nothing.
 */
export function reportEncryptedFailure(
  projectId: string | null,
  error: unknown
): void {
  if (isKeysLockedError(error)) {
    reportKeysLocked();
    return;
  }
  if (projectId === null || integrityReasonOf(error) === null) return;
  const previous = records.get(projectId);
  const message =
    error instanceof Error && error.message
      ? error.message
      : 'A version of this project did not pass verification.';
  const stored = store(projectId, {
    verified: false,
    ...(previous?.warning ? { warning: previous.warning } : {}),
    problem: message
  });
  if (stored) changed();
}

/** This device's encryption keys are locked. */
export function reportKeysLocked(): void {
  if (keysLocked) return;
  keysLocked = true;
  changed();
}

/** The page opened its encrypted-project store: the keys are unlocked. */
export function reportKeysUnlocked(): void {
  if (!keysLocked) return;
  keysLocked = false;
  changed();
}

/**
 * The open project changed: forget every other project's outcome, so a
 * project opened again is shown from what this page reads of it then.
 */
export function retainEncryptionStatus(projectId: string | null): void {
  let removed = false;
  for (const id of [...records.keys()]) {
    if (id !== projectId) {
      records.delete(id);
      removed = true;
    }
  }
  if (removed) changed();
}

/** Forgets everything: the key session ended. */
export function resetEncryptionStatus(): void {
  if (records.size === 0 && !keysLocked) return;
  records.clear();
  keysLocked = false;
  changed();
}

/** The project's status; the same object until something changes. */
export function encryptionStatusOf(projectId: string): EncryptionStatus {
  const cached = derived.get(projectId);
  if (cached) return cached;
  const record = records.get(projectId);
  let status: EncryptionStatus;
  if (record?.problem !== undefined) {
    status = {
      state: 'problem',
      problem: record.problem,
      ...(record.warning ? { warning: record.warning } : {})
    };
  } else if (keysLocked) {
    status = { state: 'locked' };
  } else if (record?.warning) {
    status = { state: 'warning', warning: record.warning };
  } else if (record?.verified) {
    status = { state: 'verified' };
  } else {
    status = UNVERIFIED;
  }
  derived.set(projectId, status);
  return status;
}

export function subscribeEncryptionStatus(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The project's status, re-rendering when it changes. */
export function useEncryptionStatus(
  projectId: string | null
): EncryptionStatus {
  const snapshot = useCallback(
    () => (projectId ? encryptionStatusOf(projectId) : UNVERIFIED),
    [projectId]
  );
  return useSyncExternalStore(subscribeEncryptionStatus, snapshot, snapshot);
}

// Teardown, not a key session becoming ready, forgets what this page saw.
subscribeKeySession((event) => {
  if (event.phase !== 'ready') resetEncryptionStatus();
});
