import type {
  ProjectAccessRole,
  ProjectDocument,
  ProjectEditLease
} from '@openzcad/shared';
import { projectRebuildInputs } from './localProjectStore';

const CONFLICT_MARKER_PREFIX = 'openzcad-unresolved-project-conflict:';
// Separate from legacy automatic-recovery records: those must not consume an
// explicit Keep both request. This ledger only prevents duplicate retries.
const COPY_LEDGER_PREFIX = 'openzcad-explicit-conflict-copies:';
/** Enough for any realistic run of resolutions; the ledger is a dedupe, not a history. */
const COPY_LEDGER_LIMIT = 32;

/**
 * Where the divergent copy came from. The resolutions are identical either
 * way — this only decides how the winning document gets written back, and lets
 * the UI name the other side accurately.
 */
export type ConflictSource = 'room' | 'account';

export interface ProjectConflict {
  projectId: string;
  source: ConflictSource;
  localDocument: ProjectDocument;
  remoteDocument: ProjectDocument;
  /** The exact remote version against which a keep-mine write must be based. */
  expectedRemoteVersion: number;
}

export interface UnresolvedConflictMarker {
  projectId: string;
  source: ConflictSource;
  localVersion: number;
  remoteVersion: number;
  detectedAt: number;
}

export type ConflictResolution = 'use-remote' | 'keep-mine' | 'save-local-copy';

/** Whether an explicit Keep both request saved a local project. */
export interface ConflictResolutionOutcome {
  localCopy: 'not-requested' | 'saved' | 'already-saved';
}

export interface ConflictResolutionHandlers {
  useRemoteVersion(
    document: ProjectDocument,
    outcome: ConflictResolutionOutcome
  ): Promise<void> | void;
  keepMyVersion(
    input: {
      document: ProjectDocument;
      expectedRemoteVersion: number;
      /** Absent outside a room, where nothing hands out leases. */
      leaseId?: string;
    },
    outcome: ConflictResolutionOutcome
  ): Promise<void> | void;
  /** Persist a new project before replacing the local original. */
  saveLocalAsCopy(document: ProjectDocument): Promise<void>;
}

export interface ConflictResolutionContext {
  role: ProjectAccessRole | null;
  lease: ProjectEditLease | null;
  /**
   * Whether this deployment enforces the project edit lease. A conflict against
   * the account rather than a room has no lease to hold, and demanding one
   * would make the divergence unresolvable.
   */
  leasesEnforced?: boolean;
  now?: number;
}

export class ConflictRecoveryError extends Error {
  constructor(
    readonly code:
      | 'PROJECT_MISMATCH'
      | 'REMOTE_VERSION_MISMATCH'
      | 'VIEWER_FORBIDDEN'
      | 'LEASE_REQUIRED',
    message: string
  ) {
    super(message);
    this.name = 'ConflictRecoveryError';
  }
}

/**
 * One marker per (project, source). The room and the account are independent
 * version lines that can diverge from the local document at the same time;
 * a single shared key let each side overwrite the other's recorded versions.
 * encodeURIComponent escapes ':', so the suffix cannot collide with an id.
 */
function markerKey(projectId: string, source: ConflictSource): string {
  return `${CONFLICT_MARKER_PREFIX}${encodeURIComponent(projectId)}:${source}`;
}

/** The pre-source key, still read and cleared so old markers cannot strand. */
function legacyMarkerKey(projectId: string): string {
  return `${CONFLICT_MARKER_PREFIX}${encodeURIComponent(projectId)}`;
}

/**
 * Persist only the small conflict sentinel. The full local document remains in
 * the normal IndexedDB project store and is supplied again by the app after a
 * reload; the next remote state reconstructs the conflict without putting a CAD
 * document in synchronous Web Storage.
 */
export function rememberUnresolvedConflict(
  marker: UnresolvedConflictMarker,
  storage: Storage = localStorage
): void {
  storage.setItem(
    markerKey(marker.projectId, marker.source),
    JSON.stringify(marker)
  );
}

function parseMarker(
  value: string | null,
  projectId: string,
  source: ConflictSource
): UnresolvedConflictMarker | null {
  if (!value) {
    return null;
  }
  try {
    const marker = JSON.parse(value) as Partial<UnresolvedConflictMarker>;
    if (
      marker.projectId !== projectId ||
      !Number.isSafeInteger(marker.localVersion) ||
      !Number.isSafeInteger(marker.remoteVersion) ||
      typeof marker.detectedAt !== 'number' ||
      !Number.isFinite(marker.detectedAt)
    ) {
      return null;
    }
    return { ...marker, source } as UnresolvedConflictMarker;
  } catch {
    return null;
  }
}

export function readUnresolvedConflict(
  projectId: string,
  source: ConflictSource,
  storage: Storage = localStorage
): UnresolvedConflictMarker | null {
  return (
    parseMarker(
      storage.getItem(markerKey(projectId, source)),
      projectId,
      source
    ) ??
    parseMarker(storage.getItem(legacyMarkerKey(projectId)), projectId, source)
  );
}

/** Whether any source — room, account, or a pre-source marker — is unresolved. */
export function hasUnresolvedConflict(
  projectId: string,
  storage: Storage = localStorage
): boolean {
  return (
    readUnresolvedConflict(projectId, 'room', storage) !== null ||
    readUnresolvedConflict(projectId, 'account', storage) !== null
  );
}

export function clearUnresolvedConflict(
  projectId: string,
  source: ConflictSource,
  storage: Storage = localStorage
): void {
  storage.removeItem(markerKey(projectId, source));
  storage.removeItem(legacyMarkerKey(projectId));
}

function ledgerKey(projectId: string): string {
  return `${COPY_LEDGER_PREFIX}${encodeURIComponent(projectId)}`;
}

/** JSON with object keys in sorted order, so equal values print equally. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/** 64-bit FNV-1a over the text, as hex. A dedupe key, not a security hash. */
function fnv1a64(text: string): string {
  let hash = 0xcbf29ce484222325n;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= BigInt(text.charCodeAt(index));
    hash = (hash * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return hash.toString(16).padStart(16, '0');
}

/** The model a local copy preserves, independent of remote version fences. */
function localCopyKey(document: ProjectDocument): string {
  return `content:${fnv1a64(canonicalJson(projectRebuildInputs(document)))}`;
}

/** Successfully written explicit copies survive a failed remote adoption. */
function readCopyLedger(
  projectId: string,
  storage: Storage = localStorage
): string[] {
  try {
    const parsed: unknown = JSON.parse(
      storage.getItem(ledgerKey(projectId)) ?? '[]'
    );
    return Array.isArray(parsed)
      ? parsed.filter((entry): entry is string => typeof entry === 'string')
      : [];
  } catch {
    return [];
  }
}

function rememberLocalCopy(
  projectId: string,
  copyKey: string,
  storage: Storage = localStorage
): void {
  const ledger = readCopyLedger(projectId, storage).filter(
    (entry) => entry !== copyKey
  );
  ledger.push(copyKey);
  storage.setItem(
    ledgerKey(projectId),
    JSON.stringify(ledger.slice(-COPY_LEDGER_LIMIT))
  );
}

export function conflictFromDocuments(
  localDocument: ProjectDocument,
  remoteDocument: ProjectDocument,
  source: ConflictSource = 'room',
  detectedAt = Date.now()
): ProjectConflict {
  if (localDocument.projectId !== remoteDocument.projectId) {
    throw new ConflictRecoveryError(
      'PROJECT_MISMATCH',
      'Local and remote documents belong to different projects.'
    );
  }
  // A conflict is re-detected on every inbound frame while unresolved. Keep
  // the original detection time for the same divergence.
  const existing = readUnresolvedConflict(localDocument.projectId, source);
  const sameDivergence =
    existing !== null &&
    existing.localVersion === localDocument.version &&
    existing.remoteVersion === remoteDocument.version;
  rememberUnresolvedConflict({
    projectId: localDocument.projectId,
    source,
    localVersion: localDocument.version,
    remoteVersion: remoteDocument.version,
    detectedAt: sameDivergence ? existing.detectedAt : detectedAt
  });
  return {
    projectId: localDocument.projectId,
    source,
    localDocument: structuredClone(localDocument),
    remoteDocument: structuredClone(remoteDocument),
    expectedRemoteVersion: remoteDocument.version
  };
}

/**
 * Resolve only the user's chosen version on the original project. No automatic
 * copy is made. Keep both durably copies the local work before adopting remote;
 * retries reuse that copy while version fencing and room authorization remain.
 */
export async function resolveProjectConflict(
  conflict: ProjectConflict,
  resolution: ConflictResolution,
  context: ConflictResolutionContext,
  handlers: ConflictResolutionHandlers
): Promise<ConflictResolutionOutcome> {
  if (
    conflict.projectId !== conflict.localDocument.projectId ||
    conflict.projectId !== conflict.remoteDocument.projectId
  ) {
    throw new ConflictRecoveryError(
      'PROJECT_MISMATCH',
      'Conflict documents no longer identify one project.'
    );
  }
  if (conflict.expectedRemoteVersion !== conflict.remoteDocument.version) {
    throw new ConflictRecoveryError(
      'REMOTE_VERSION_MISMATCH',
      'The remote version changed before conflict recovery began.'
    );
  }
  if (resolution === 'keep-mine') {
    if (context.role === 'viewer') {
      throw new ConflictRecoveryError(
        'VIEWER_FORBIDDEN',
        'Viewers cannot replace the remote version.'
      );
    }
    // A lease is a room concept. Requiring one for a conflict against the
    // account — where none is ever issued — would leave the user with a
    // divergence they are not permitted to resolve.
    const leaseRequired =
      conflict.source === 'room' && context.leasesEnforced !== false;
    const now = context.now ?? Date.now();
    if (
      leaseRequired &&
      (!context.lease ||
        context.lease.projectId !== conflict.projectId ||
        context.lease.expiresAt <= now)
    ) {
      throw new ConflictRecoveryError(
        'LEASE_REQUIRED',
        'Keeping the local version requires an active project edit lease.'
      );
    }
  }

  const outcome: ConflictResolutionOutcome = { localCopy: 'not-requested' };
  if (resolution === 'save-local-copy') {
    const copyKey = localCopyKey(conflict.localDocument);
    if (readCopyLedger(conflict.projectId).includes(copyKey)) {
      outcome.localCopy = 'already-saved';
    } else {
      await handlers.saveLocalAsCopy(structuredClone(conflict.localDocument));
      rememberLocalCopy(conflict.projectId, copyKey);
      outcome.localCopy = 'saved';
    }
  }

  if (resolution === 'use-remote') {
    await handlers.useRemoteVersion(
      structuredClone(conflict.remoteDocument),
      outcome
    );
  } else if (resolution === 'keep-mine') {
    await handlers.keepMyVersion(
      {
        document: structuredClone(conflict.localDocument),
        expectedRemoteVersion: conflict.expectedRemoteVersion,
        ...(context.lease ? { leaseId: context.lease.leaseId } : {})
      },
      outcome
    );
  } else {
    await handlers.useRemoteVersion(
      structuredClone(conflict.remoteDocument),
      outcome
    );
  }
  if (resolution === 'save-local-copy') {
    // Successful adoption completes this request. A later, separate Keep both
    // choice must still be able to create a copy, even of the same model.
    const copyKey = localCopyKey(conflict.localDocument);
    const pending = readCopyLedger(conflict.projectId).filter(
      (key) => key !== copyKey
    );
    localStorage.setItem(
      ledgerKey(conflict.projectId),
      JSON.stringify(pending)
    );
  }
  return outcome;
}

/** Only Keep both should claim that a separate project exists. */
export function conflictCopyNote(outcome: ConflictResolutionOutcome): string {
  return outcome.localCopy === 'not-requested'
    ? ''
    : '; your changes were kept as a separate project';
}
