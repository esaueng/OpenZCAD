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
import { createBodyFeatureIds } from '@openzcad/document-core';
import { parseStepMetadata } from '@openzcad/io-step';
import type { ImportedSourceReference, ProjectDocument } from '@openzcad/shared';

import { errorMessage } from './errors';
import {
  settleImportSource,
  type InFlightImportChecksums
} from './importArchival';
import {
  deleteSourceBlob,
  ensureLocalProjectStorage,
  putSourceBlobIfAbsent,
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
 * Reference-form ceiling. The kernel comfortably imports files this size
 * (measured: 283 MB peaks at 1.2 GB wasm memory, ~7 s — see
 * scripts/profile-step-import.mjs); the binding constraint is wasm32 address
 * space, which this leaves 40% headroom against.
 */
export const MAX_SOURCE_IMPORT_BYTES = 250 * 1024 * 1024;

function megabytes(bytes: number): number {
  return Math.round(bytes / (1024 * 1024));
}

function storageUnavailableMessage(maxEmbeddedBytes: number): string {
  return `STEP import over ${megabytes(maxEmbeddedBytes)} MB needs browser storage, which is unavailable in this session.`;
}

/** What this run needs from the device's local source-blob storage. */
export interface StepImportSourceStore {
  ensureLocalProjectStorage(): Promise<LocalStorageReadiness>;
  putSourceBlobIfAbsent(source: Blob): Promise<StoredSourceBlob>;
  deleteSourceBlob(checksumSha256: string): Promise<void>;
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
  deleteSourceBlob
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
  }): Promise<string>;
  validatedFeature: StepImportCommitHook;
  status: StepImportStatusSink;
  marks: StepImportMarks;
  /** The document as it stands now — it moves while the rebuild runs. */
  currentDocument(): ProjectDocument | null;
  /** Non-null while editing is blocked: View mode, or another tab's lease. */
  editDisabledReason(): string | null;
  /** Unique per call. `crypto.randomUUID` in the app. */
  newId(): string;
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

  if (file.size > maxSourceBytes) {
    status.setStatus(
      `STEP import is limited to ${megabytes(maxSourceBytes)} MB.`
    );
    return declined();
  }

  // The `indexedDB.open`, asked for BEFORE the lock rather than under it.
  //
  // Nothing here can park today — this build's schema version is the one every
  // device already holds — but the first thing this run does under the commit
  // lock is a write that opens the database, and a lock held across an open is
  // a lock held across whatever the browser decides that open costs. A stranded
  // commit lock is not one failed import: it is every boolean, fillet and
  // primitive edit in the tab silently doing nothing until it is reloaded.
  const readiness = await store.ensureLocalProjectStorage();
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
  try {
    // A store that could not be opened a moment ago will not open now, and
    // asking anyway only spends a second failed open to learn the same thing.
    if (readiness !== 'unavailable') {
      try {
        const stored = await store.putSourceBlobIfAbsent(file);
        sourceRef = stored.ref;
        sourceBlobCreated = stored.created;
        // Marked in-flight in the same tick the bytes become reachable, so no
        // window exists in which a concurrent import of the same file sees a
        // blob it could prune.
        deps.marks.inFlight.acquire(sourceRef.checksumSha256);
      } catch {
        if (file.size > maxEmbeddedBytes) {
          status.setStatus(storageUnavailableMessage(maxEmbeddedBytes));
          return declined();
        }
      }
    }
    const stepText = await file.text();
    const metadata = parseStepMetadata(file.name, stepText);
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
    outcome = await deps.validatedFeature.run(
      commandFactories.importStep({ ...payload, artifactId: localArtifactId }),
      {
        featureName: name,
        resultBodyId: ids.bodyId,
        // The lock this run has been holding since before it wrote a byte. The
        // run adopts it instead of competing for it.
        reservation: commitLock,
        validatingMessage: `Rebuilding ${file.name} with the exact geometry kernel…`,
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
            artifactId = await deps.archive({
              fileName: file.name,
              contentType: deps.contentType,
              kind: 'step-import',
              body: file,
              metadata: { source: 'direct-upload' }
            });
            archived = true;
          } catch {
            // Local-only, and listed in the File menu for a later retry.
          }
          return commandFactories.importStep({ ...payload, artifactId });
        },
        // Two separate facts: the source is stored, and the exact kernel
        // rebuilt a body from it. Claiming the second before the rebuild ran is
        // what left a success toast next to an empty viewport.
        successMessage: () =>
          `Imported editable STEP solid from ${file.name}: ` +
          (archived
            ? 'exact body rebuilt, source archived.'
            : 'exact body rebuilt (cloud archive unavailable; source saved locally).'),
        onFailure: () => {
          // The kernel's verdict is already in the status bar. The host sink
          // renders inline in whichever feature form is open, and an import has
          // none of its own — routing it there would show a STEP parse error as
          // the refusal of an unrelated operation.
        }
      }
    );
  } catch (error) {
    status.setStatus(errorMessage(error, 'STEP import failed.'));
  } finally {
    // `run` released the lock itself; this covers every path that never reached
    // it, and releasing twice is a no-op.
    commitLock.release();
    if (sourceRef) {
      deps.marks.inFlight.release(sourceRef.checksumSha256);
    }
  }
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
        : outcome === 'busy' || outcome === 'superseded'
          ? 'no-verdict'
          : 'refused',
    createdByThisImport: sourceBlobCreated,
    abandonedChecksums: deps.marks.abandoned,
    document: deps.currentDocument(),
    inFlightChecksums: deps.marks.inFlight,
    deleteSourceBlob: (checksumSha256) => store.deleteSourceBlob(checksumSha256)
  }).catch(() => {
    // DELIBERATELY SWALLOWED. Storage failing here leaves the bytes in place,
    // which is the safe direction: an orphaned blob is a leak that the next
    // refused import of the same file collects, while a deleted one is the
    // source of somebody's committed feature. There is also nothing the user
    // could do about it — the import itself has already succeeded or failed on
    // its own terms, and saying so here would only contradict the verdict
    // already on screen.
    return false;
  });
  return {
    outcome,
    checksumSha256: settledChecksum,
    sourceBlobCreated,
    sourceDeleted
  };
}
