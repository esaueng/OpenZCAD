/**
 * Carrying out a sync conflict's chosen resolution, with the Keep both copy
 * ledger that makes a retry reuse its copy. Loaded when the user resolves a
 * conflict; detecting and naming one stays in `conflictRecovery`.
 */
import type { ProjectDocument } from '@openzcad/shared';
import { projectRebuildInputs } from './localProjectStore';
import {
  ConflictRecoveryError,
  type ConflictResolution,
  type ConflictResolutionContext,
  type ConflictResolutionHandlers,
  type ConflictResolutionOutcome,
  type ProjectConflict
} from './conflictRecovery';

// Separate from legacy automatic-recovery records: those must not consume an
// explicit Keep both request. This ledger only prevents duplicate retries.
const COPY_LEDGER_PREFIX = 'openzcad-explicit-conflict-copies:';
/** Enough for any realistic run of resolutions; the ledger is a dedupe, not a history. */
const COPY_LEDGER_LIMIT = 32;

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

interface CopyLedgerEntry {
  copyKey: string;
  copyProjectId: string;
}

/** Successfully written explicit copies survive a failed remote adoption. */
function readCopyLedger(
  projectId: string,
  storage: Storage = localStorage
): CopyLedgerEntry[] {
  try {
    const parsed: unknown = JSON.parse(
      storage.getItem(ledgerKey(projectId)) ?? '[]'
    );
    return Array.isArray(parsed)
      ? parsed.filter((entry): entry is CopyLedgerEntry => {
          if (!entry || typeof entry !== 'object') return false;
          const record = entry as Partial<CopyLedgerEntry>;
          return (
            typeof record.copyKey === 'string' &&
            typeof record.copyProjectId === 'string' &&
            record.copyProjectId.length > 0 &&
            record.copyProjectId !== projectId
          );
        })
      : [];
  } catch {
    return [];
  }
}

function rememberLocalCopy(
  projectId: string,
  copyKey: string,
  copyProjectId: string,
  storage: Storage = localStorage
): void {
  const ledger = readCopyLedger(projectId, storage).filter(
    (entry) => entry.copyKey !== copyKey
  );
  ledger.push({ copyKey, copyProjectId });
  storage.setItem(
    ledgerKey(projectId),
    JSON.stringify(ledger.slice(-COPY_LEDGER_LIMIT))
  );
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
    const recorded = readCopyLedger(conflict.projectId).find(
      (entry) => entry.copyKey === copyKey
    );
    if (recorded && (await handlers.localCopyExists(recorded.copyProjectId))) {
      outcome.localCopy = 'already-saved';
    } else {
      const copyProjectId = await handlers.saveLocalAsCopy(
        structuredClone(conflict.localDocument)
      );
      rememberLocalCopy(conflict.projectId, copyKey, copyProjectId);
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
      (entry) => entry.copyKey !== copyKey
    );
    localStorage.setItem(
      ledgerKey(conflict.projectId),
      JSON.stringify(pending)
    );
  }
  return outcome;
}
