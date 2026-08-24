/**
 * One STEP import, from the file the user chose to the fate of its source bytes.
 *
 * This lived inline in `App.tsx` and could only be tested by reading its source
 * text, which is not a test: independent mutations of it — dropping the lock
 * release that keeps a stranded lock from disabling the tab, reordering the
 * storage check behind the lock, deleting the source bytes unconditionally —
 * each left every suite green. It is a plain function taking its collaborators
 * so that a test can run the real thing and watch what it does.
 *
 * The order below is the whole of the design, and each step is here because of
 * a specific way the previous shape failed:
 *
 * 1. Size cap, before anything is read.
 * 2. Settle the storage schema, which is an `indexedDB.open`. Done before the
 *    lock, so no lock is ever held across it.
 * 3. Reserve the commit lock, and hold it across the write. Asking whether it
 *    was free would not do: the write takes seconds to minutes.
 * 4. Write the bytes.
 * 5. Validate against the exact kernel, archiving only once it has accepted.
 * 6. Settle the bytes: kept for a commit, discarded for a refusal, kept for
 *    anything that reached no verdict at all.
 */

import { commandFactories, type AnyCommand } from '@openzcad/command-system';
import {
  createBodyFeatureIds,
  type ImportedStepInput
} from '@openzcad/document-core';
import { parseStepMetadata } from '@openzcad/io-step';
import type {
  ImportedSourceReference,
  ProjectDocument
} from '@openzcad/shared';

import { errorMessage } from './errors';
import {
  settleImportSource,
  type InFlightImportChecksums
} from './importArchival';
import type {
  ImportPhase,
  ImportProgressSink,
  ImportRunOutcome
} from './importProgress';
import {
  deleteSourceBlobIfUnreferenced,
  ensureLocalProjectStorage,
  LOCAL_STORAGE_BLOCKED_MESSAGE,
  putSourceBlobIfAbsent,
  releaseSourceBlobClaim,
  type LocalStorageReadiness,
  type StoredSourceBlob
} from './localProjectStore';
import {
  VALIDATED_FEATURE_BUSY_STATUS,
  type ValidatedFeatureOutcome,
  type ValidatedFeatureReservation,
  type ValidatedFeatureRunOptions
} from '../hooks/useValidatedFeatureCommit';

/**
 * Fallback ceiling when the source blob store cannot be written (private
 * browsing, or storage denied) and the STEP text must be embedded in the
 * document itself, as every import was before content-addressed references.
 */
export const MAX_EMBEDDED_STEP_BYTES = 12 * 1024 * 1024;

/**
 * Reference-form ceiling. It matches the exact kernel's hostile-input byte
 * budget so shared or restored sources cannot opt into a larger parse budget.
 */
export const MAX_SOURCE_IMPORT_BYTES = 128 * 1024 * 1024;

function megabytes(bytes: number): number {
  return Math.round(bytes / (1024 * 1024));
}

function storageUnavailableMessage(maxEmbeddedBytes: number): string {
  return `STEP import over ${megabytes(maxEmbeddedBytes)} MB needs browser storage, which is unavailable in this session.`;
}

/** What this run needs from the device's local source-blob storage. */
export interface StepImportSourceStore {
  ensureLocalProjectStorage(): Promise<LocalStorageReadiness>;
  putSourceBlobIfAbsent(
    source: Blob,
    options?: {
      claimId?: string;
      onBytesRead?(read: number, total: number): void;
    }
  ): Promise<StoredSourceBlob>;
  deleteSourceBlobIfUnreferenced(input: {
    checksumSha256: string;
    claimId: string;
  }): Promise<boolean>;
  releaseSourceBlobClaim(
    checksumSha256: string,
    claimId: string
  ): Promise<void>;
}

/**
 * The production wiring, in one place and defaulted below, so that `App.tsx`
 * passes no store at all.
 *
 * The alternative — the app naming each of these at the call site — is a class
 * of mutation nothing can catch: swapping `deleteSourceBlob` for `async () => {}`
 * there leaves both suites green while a refused import silently leaks its
 * bytes, because no test renders `App.tsx`. Here it is a value a test can
 * compare against the real module exports.
 */
export const localStepImportSourceStore: StepImportSourceStore = {
  ensureLocalProjectStorage,
  putSourceBlobIfAbsent,
  deleteSourceBlobIfUnreferenced,
  releaseSourceBlobClaim
};

/** Where a refusal goes. Both surfaces, because either alone has been wrong. */
export interface StepImportStatusSink {
  /** The status bar: one clipped line, always present. */
  setStatus(message: string): void;
  /**
   * Inline on whichever surface the user is looking at. A refusal that reached
   * only the status bar read as the import having silently done nothing.
   */
  setFeatureFormError(message: string): void;
}

/** This tab's notes about source bytes, shared by every import in the window. */
export interface StepImportMarks {
  /** Checksums of imports between writing their bytes and learning their fate. */
  inFlight: InFlightImportChecksums;
  /** Checksums this tab wrote for imports that never landed; updated in place. */
  abandoned: Set<string>;
}

/**
 * The commit hook, whole.
 *
 * Taken as one object rather than as two callbacks, so a reservation and the run
 * that adopts it cannot come from different hook instances — a mismatch that
 * would degrade silently, since a foreign reservation is simply not recognised
 * and the run competes for the lock as if it had never reserved.
 */
export interface StepImportCommitHook {
  /** Takes the commit lock now, or null when another run already holds it. */
  reserve(): ValidatedFeatureReservation | null;
  run(
    command: AnyCommand,
    options: ValidatedFeatureRunOptions
  ): Promise<ValidatedFeatureOutcome>;
}

export interface StepImportRunDeps {
  file: File;
  /** MIME type for the archived copy; the caller infers it from the name. */
  contentType: string;
  /** Defaults to {@link localStepImportSourceStore}; a test supplies a fake. */
  store?: StepImportSourceStore;
  /** Uploads the original bytes and resolves with the finalized artifact id. */
  archive(input: {
    fileName: string;
    contentType: string;
    kind: 'step-import';
    body: Blob;
    metadata: Record<string, string>;
    onUploadProgress?(uploaded: number, total: number): void;
    signal?: AbortSignal;
  }): Promise<string>;
  validatedFeature: StepImportCommitHook;
  status: StepImportStatusSink;
  /**
   * Where the progress card reads this run, if one is listening.
   *
   * Optional, and deliberately so: unlike {@link status}, nothing here reaches
   * the document, the device, or the user's data, so a host that drops it
   * loses a panel and nothing else. Every other collaborator on this interface
   * is required for exactly the opposite reason.
   */
  progress?: ImportProgressSink;
  /**
   * Stops the run at the next point it can stop without leaving a trace.
   *
   * Deliberately NOT plumbed into the rebuild: the kernel reads the file
   * inside one synchronous wasm call, and no signal can preempt a blocked
   * worker thread. What aborting does is stop the read, decline the upload,
   * and decline the commit — so the geometry already in flight is discarded
   * rather than landed, and the bytes this run wrote are pruned on the way
   * out. See {@link ImportRunResult} for why they are pruned and not kept.
   */
  signal?: AbortSignal;
  marks: StepImportMarks;
  /** The document as it stands now — it moves while the rebuild runs. */
  currentDocument(): ProjectDocument | null;
  /** Non-null while editing is blocked: View mode, or another tab's lease. */
  editDisabledReason(): string | null;
  /** Unique per call. `crypto.randomUUID` in the app. */
  newId(): string;
  /** Alternate atomic command for imports that carry additional evidence. */
  commandFactory?(payload: ImportedStepInput): AnyCommand;
  validatingMessage?: string;
  successMessage?(input: { fileName: string; archived: boolean }): string;
  /** Overridable so a test need not build a 250 MB file. */
  limits?: { maxSourceBytes?: number; maxEmbeddedBytes?: number };
}

export type StepImportOutcome =
  | ValidatedFeatureOutcome
  /** Turned away before anything was written: too large, no storage, or busy. */
  | 'declined'
  /** Threw on the way to or during the run. */
  | 'failed';

export interface StepImportResult {
  outcome: StepImportOutcome;
  /** The key the bytes were stored under, or null when none were stored. */
  checksumSha256: string | null;
  /** True when this run's own write is what put the bytes on the device. */
  sourceBlobCreated: boolean;
  /** Whether the bytes were deleted again as the run wound down. */
  sourceDeleted: boolean;
}

/**
 * How the run ended, in the one line the progress card has room for.
 *
 * Kept apart from the status-bar copy on purpose. The status bar narrates a
 * session and is overwritten by whatever happens next; this is the card's
 * final state and may sit on screen until it is dismissed, so it says the
 * shortest true thing and offers an action only where one exists.
 */
/**
 * Thrown to unwind a cancelled run. A sentinel rather than a message, so the
 * top-level catch can tell "the user stopped this" from "this broke" without
 * matching on error text — and so an abort raised deep inside the blob read
 * cannot be mistaken for a storage failure and quietly fall back to embedding
 * the file, which is what the pre-existing catch around the write does.
 */
class ImportCancelledError extends Error {
  constructor() {
    super('The import was cancelled.');
    this.name = 'ImportCancelledError';
  }
}

/** True for our own sentinel and for the DOMException an abort raises. */
function isCancellation(error: unknown, signal?: AbortSignal): boolean {
  return (
    error instanceof ImportCancelledError ||
    signal?.aborted === true ||
    (error instanceof Error && error.name === 'AbortError')
  );
}

function importRunOutcome(input: {
  outcome: ValidatedFeatureOutcome | 'failed';
  archived: boolean;
  rejection: string | null;
  thrown: string | null;
}): ImportRunOutcome {
  switch (input.outcome) {
    case 'cancelled':
      return { tone: 'cancelled', message: 'Import cancelled' };
    case 'committed':
      // Two different endings, and the difference matters: an import whose
      // source never reached the cloud is a project no other device can
      // rebuild. That is worth an amber card and a button, not a tick.
      return input.archived
        ? { tone: 'ok', message: 'Imported — 1 body' }
        : {
            tone: 'warning',
            message: 'Imported, but saved on this device only',
            action: 'archive'
          };
    case 'rejected':
      return {
        tone: 'error',
        message: input.rejection ?? 'Not imported — the file was refused'
      };
    case 'superseded':
      // Says nothing against the file, so it is amber rather than red.
      return {
        tone: 'warning',
        message: 'Not imported — the model kept changing while it rebuilt'
      };
    case 'busy':
      return {
        tone: 'warning',
        message: 'Not imported — another exact operation was still running'
      };
    default:
      return { tone: 'error', message: input.thrown ?? 'Import failed' };
  }
}

/** Turned away before anything was written, so there is nothing to report. */
function declined(): StepImportResult {
  return {
    outcome: 'declined',
    checksumSha256: null,
    sourceBlobCreated: false,
    sourceDeleted: false
  };
}

export async function runStepImport(
  deps: StepImportRunDeps
): Promise<StepImportResult> {
  const { file, status } = deps;
  const store = deps.store ?? localStepImportSourceStore;
  const maxSourceBytes = deps.limits?.maxSourceBytes ?? MAX_SOURCE_IMPORT_BYTES;
  const maxEmbeddedBytes =
    deps.limits?.maxEmbeddedBytes ?? MAX_EMBEDDED_STEP_BYTES;
  const commandFactory = deps.commandFactory ?? commandFactories.importStep;

  if (file.size > maxSourceBytes) {
    status.setStatus(
      `STEP import is limited to ${megabytes(maxSourceBytes)} MB.`
    );
    return declined();
  }

  // Mint before the lock so no failure between reserving and entering the
  // guarded import body can strand the validated-feature lock. This identity is
  // written atomically beside the blob and lets other tabs see the hold.
  const sourceClaimId = deps.newId();

  // The `indexedDB.open`, asked for BEFORE the lock rather than under it.
  //
  // Version-7 tabs close their live connections on `versionchange`, allowing
  // the version-8 claim-store upgrade to proceed. Older builds may still block;
  // the shared schema gate turns that into a settled result before a commit
  // lock exists.
  const readiness = await store.ensureLocalProjectStorage();
  if (readiness === 'blocked') {
    status.setStatus(LOCAL_STORAGE_BLOCKED_MESSAGE);
    status.setFeatureFormError(LOCAL_STORAGE_BLOCKED_MESSAGE);
    return declined();
  }
  // No storage at all is not a refusal on its own — a file small enough to
  // embed in the document needs no blob store, which is exactly how a
  // storage-denied session has always imported. Past that cap there is nowhere
  // for the bytes to go, and there is no point taking the lock to find out.
  if (readiness === 'unavailable' && file.size > maxEmbeddedBytes) {
    status.setStatus(storageUnavailableMessage(maxEmbeddedBytes));
    status.setFeatureFormError(storageUnavailableMessage(maxEmbeddedBytes));
    return declined();
  }

  // Taken BEFORE anything is written, and HELD across the write: a run that
  // cannot proceed must not leave up to 250 MB of source bytes behind it.
  // Nothing sweeps unreferenced blobs, so those bytes would be permanent — and
  // their mere presence would then disarm the cleanup of every later refused
  // import of the same file, which sees a key it did not create.
  //
  // Merely asking whether the lock was free would not be enough. Hashing and
  // storing the file, reading its text and parsing its header take seconds to
  // minutes for a large assembly, and any other validated operation could take
  // the lock inside that window — leaving the bytes written and the run turned
  // away, which is exactly the outcome this is here to prevent.
  const commitLock = deps.validatedFeature.reserve();
  if (!commitLock) {
    status.setStatus(VALIDATED_FEATURE_BUSY_STATUS);
    status.setFeatureFormError(VALIDATED_FEATURE_BUSY_STATUS);
    return declined();
  }

  // Announced only once the run is certainly going ahead. Everything above
  // this point is settled in well under a second and reports through the
  // status bar; a card that appeared for those would be a panel flashing at
  // someone who has not finished letting go of the mouse.
  //
  // A storage-denied session never writes bytes, so `saving` is not one of
  // its phases and the bar divides over the three that remain.
  const progress = deps.progress;
  const phases: ImportPhase[] = [
    ...(readiness === 'unavailable' ? [] : (['saving'] as const)),
    'reading',
    'building',
    'archiving'
  ];
  progress?.start({ fileName: file.name, phases });
  /** The kernel's own words, kept for the card's one failure line. */
  let rejection: string | null = null;
  const signal = deps.signal;
  const stopIfCancelled = (): void => {
    if (signal?.aborted) {
      throw new ImportCancelledError();
    }
  };

  // Content-addressed storage first: the document carries a checksum reference
  // and the bytes live in the browser's blob store (and the artifact archive,
  // once uploaded). Embedding the text in the document is the fallback.
  let sourceRef: ImportedSourceReference | null = null;
  // Only what this import created may be deleted again: the store is
  // device-global, so the same key can already be backing another project.
  // Bytes an earlier run of this tab wrote and abandoned count as this import's
  // own — nothing else can be pointing at them.
  let sourceBlobCreated = false;
  let archived = false;
  // `failed` is the import going wrong before it ever reached the kernel; its
  // bytes are as abandoned as a refusal's.
  let outcome: ValidatedFeatureOutcome | 'failed' = 'failed';
  /** What went wrong on the way, when nothing ever reached a verdict. */
  let thrown: string | null = null;
  try {
    // A store that could not be opened a moment ago will not open now, and
    // asking anyway only spends a second failed open to learn the same thing.
    if (readiness !== 'unavailable') {
      try {
        progress?.update({ phase: 'saving', fraction: 0 });
        const stored = await store.putSourceBlobIfAbsent(file, {
          claimId: sourceClaimId,
          ...(signal ? { signal } : {}),
          // Covers the read and hash. The IndexedDB write that follows
          // reports nothing, so the bar parks at the end of this phase for
          // the length of that write rather than pretending to advance.
          onBytesRead: (read, total) =>
            progress?.update({
              phase: 'saving',
              fraction: total > 0 ? read / total : null
            })
        });
        sourceRef = stored.ref;
        sourceBlobCreated = stored.created;
        // Marked in-flight in the same tick the bytes become reachable, so no
        // window exists in which a concurrent import of the same file sees a
        // blob it could prune.
        deps.marks.inFlight.acquire(sourceRef.checksumSha256);
      } catch (error) {
        // A cancelled read is not a storage failure. Without this the abort
        // would be swallowed here and the run would carry on to embed the
        // file — completing, in full, the import the user just stopped.
        if (isCancellation(error, signal)) {
          throw error;
        }
        if (file.size > maxEmbeddedBytes) {
          status.setStatus(storageUnavailableMessage(maxEmbeddedBytes));
          progress?.finish({
            tone: 'error',
            message: storageUnavailableMessage(maxEmbeddedBytes)
          });
          return declined();
        }
      }
    }
    stopIfCancelled();
    // Measured at about 0.15 s for 250 MB — decode and header scan together —
    // so this reports no fraction. There is nothing to watch.
    progress?.update({ phase: 'reading', fraction: null });
    const stepText = await file.text();
    const metadata = parseStepMetadata(file.name, stepText);
    // The last point a cancel costs nothing at all: past here the rebuild
    // starts, and stopping it only discards work already done.
    stopIfCancelled();
    const productName = metadata.products[0]?.trim();
    const name = productName || file.name.replace(/\.(step|stp)$/i, '');
    // Pre-assigned so the pre-flight can ask about THIS body, and reused
    // verbatim by the finalized command: the candidate that was accepted and
    // the command that lands must name the same feature and body, or the
    // acceptance check proved nothing about what is in history.
    const ids = createBodyFeatureIds();
    const payload = {
      name,
      ids,
      sourceName: file.name,
      ...(sourceRef ? { stepSourceRef: sourceRef } : { stepText })
    };
    // The artifact id is geometry-inert: the worker resolves source bytes by
    // checksum from the local blob store and reaches for the archive only as a
    // fallback. So a candidate validated against a provisional local id
    // rebuilds identically once the finalized id replaces it.
    const localArtifactId = `artifact_local_${deps.newId()}`;
    // The long pole, and the one phase with nothing to report: the kernel
    // reads the file inside a single synchronous wasm call that blocks the
    // worker thread it runs on.
    progress?.update({ phase: 'building', fraction: null });
    outcome = await deps.validatedFeature.run(
      commandFactory({ ...payload, artifactId: localArtifactId }),
      {
        featureName: name,
        resultBodyId: ids.bodyId,
        // The lock this run has been holding since before it wrote a byte. The
        // run adopts it instead of competing for it.
        reservation: commitLock,
        // The rebuild itself cannot be stopped. This declines to spend the
        // upload on its result, and declines to land it.
        cancelled: () => signal?.aborted === true,
        validatingMessage:
          deps.validatingMessage ??
          `Checking ${file.name} against exact geometry…`,
        // The workspace stays live while this rebuilds, and rebuilding a large
        // assembly takes minutes: renaming a feature or nudging a body in that
        // time must not destroy the import. The candidate is simply rebuilt
        // against the moved document instead — an import appends a feature that
        // reads nothing but its own source bytes, so the second pass can only
        // reach the same verdict, and the parsed source is cached by checksum
        // so it costs no re-parse.
        revalidateOnDocumentMove: true,
        // Archiving ahead of the rebuild spends a transfer of up to 250 MB on a
        // file the kernel may be about to refuse, and leaves an artifact
        // nothing references. Best-effort: the source stays in the local blob
        // store (or embedded) and rebuilds remain deterministic and offline
        // either way.
        finalize: async () => {
          // Edit permission can flip during a rebuild that takes minutes (View
          // mode, or the project opened in a second tab). Refusing here costs
          // nothing and keeps the upload from producing an artifact the commit
          // is then not allowed to reference. The window it leaves is the
          // upload itself, which is why the local bytes survive an archive that
          // outran its permission.
          const blockedReason = deps.editDisabledReason();
          if (blockedReason) {
            throw new Error(`Cannot import geometry: ${blockedReason}.`);
          }
          let artifactId = localArtifactId;
          try {
            progress?.update({ phase: 'archiving', fraction: 0 });
            artifactId = await deps.archive({
              fileName: file.name,
              contentType: deps.contentType,
              kind: 'step-import',
              body: file,
              metadata: { source: 'direct-upload' },
              ...(signal ? { signal } : {}),
              onUploadProgress: (uploaded, total) =>
                progress?.update({
                  phase: 'archiving',
                  fraction: total > 0 ? uploaded / total : null
                })
            });
            archived = true;
          } catch {
            // Local-only, and listed in the File menu for a later retry.
            //
            // A cancelled upload lands here too, and must NOT be rethrown: a
            // throw out of `finalize` is caught by the commit hook and reported
            // as a rejection, which would blame the file for something the user
            // did. The hook re-checks `cancelled` immediately after finalize
            // returns, so the run still ends as cancelled and nothing commits.
          }
          return commandFactory({ ...payload, artifactId });
        },
        // Two separate facts: the source is stored, and the exact kernel
        // rebuilt a body from it. Claiming the second before the rebuild ran is
        // what left a success toast next to an empty viewport.
        successMessage: () =>
          deps.successMessage?.({ fileName: file.name, archived }) ??
          `Imported editable STEP solid from ${file.name}: ` +
            (archived
              ? 'exact body rebuilt, source archived.'
              : 'exact body rebuilt (cloud archive unavailable; source saved locally).'),
        onFailure: (message) => {
          // The kernel's verdict is already in the status bar. The host sink
          // renders inline in whichever feature form is open, and an import has
          // none of its own — routing it there would show a STEP parse error as
          // the refusal of an unrelated operation.
          //
          // Kept here, though, because the progress card is this import's own
          // surface: it can say why the file was refused instead of leaving
          // the reason in a status line that the next message overwrites.
          rejection = message;
        }
      }
    );
  } catch (error) {
    if (isCancellation(error, signal)) {
      outcome = 'cancelled';
    } else {
      thrown = errorMessage(error, 'STEP import failed.');
      status.setStatus(thrown);
    }
  } finally {
    // `run` released the lock itself; this covers every path that never reached
    // it, and releasing twice is a no-op.
    commitLock.release();
    if (sourceRef) {
      deps.marks.inFlight.release(sourceRef.checksumSha256);
    }
  }
  // Said HERE rather than in the catch above, because a cancel reaches this
  // point two different ways: thrown, when it stopped the read or landed at a
  // phase boundary, and RETURNED by the commit hook, when it stopped a rebuild
  // that had to run to completion. Only the thrown path passes through the
  // catch, so a status set there left the status bar still reading "Checking…"
  // for every cancel during the rebuild — the long case, and the one people
  // will actually use.
  if (outcome === 'cancelled') {
    status.setStatus(`${file.name} was not imported: you cancelled it.`);
  }
  progress?.finish(importRunOutcome({ outcome, archived, rejection, thrown }));
  if (!sourceRef) {
    return {
      outcome,
      checksumSha256: null,
      sourceBlobCreated: false,
      sourceDeleted: false
    };
  }
  if (outcome === 'superseded') {
    // The kernel never disagreed with the file; the user's own concurrent edits
    // are why this stopped. Say so, and say what it costs to try again: the
    // bytes are still stored, so the retry re-runs the rebuild and nothing else.
    status.setStatus(
      `${file.name} was not imported: the model kept changing while it rebuilt. ` +
        'Its source is still stored, so importing it again costs only the rebuild.'
    );
  }
  const settledChecksum = sourceRef.checksumSha256;
  const sourceDeleted = await settleImportSource({
    checksumSha256: settledChecksum,
    result:
      outcome === 'committed'
        ? 'committed'
        : outcome === 'cancelled'
          ? // Pruned, not kept. Nobody is waiting on the bytes of an import
            // the user withdrew, nothing sweeps unreferenced blobs, and the
            // re-read a retry costs is measured in tenths of a second.
            'cancelled'
          : outcome === 'busy' || outcome === 'superseded'
            ? 'no-verdict'
            : 'refused',
    createdByThisImport: sourceBlobCreated,
    abandonedChecksums: deps.marks.abandoned,
    document: deps.currentDocument(),
    inFlightChecksums: deps.marks.inFlight,
    deleteSourceBlobIfUnreferenced: (checksumSha256) =>
      store.deleteSourceBlobIfUnreferenced({
        checksumSha256,
        claimId: sourceClaimId
      }),
    releaseSourceBlobClaim: () =>
      store.releaseSourceBlobClaim(settledChecksum, sourceClaimId)
  }).catch(() => {
    // DELIBERATELY SWALLOWED. Storage failing here leaves the bytes and claim in
    // place, which is the no-data-loss direction. The import itself has already
    // reached its user-visible verdict, so a cleanup error must not contradict
    // it or widen deletion.
    return false;
  });
  return {
    outcome,
    checksumSha256: settledChecksum,
    sourceBlobCreated,
    sourceDeleted
  };
}
