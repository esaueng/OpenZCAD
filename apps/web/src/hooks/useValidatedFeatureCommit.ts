import { useRef } from 'react';
import type {
  FeatureId, BodyId, ProjectDocument } from '@openzcad/shared';
import { CommandManager, type AnyCommand } from '@openzcad/command-system';
import { errorMessage } from '../lib/errors';
import { validatedFeatureRejection } from '../lib/featureValidation';

export interface ValidatedFeatureCommitOptions {
  manager(): CommandManager | null;
  derive(document: ProjectDocument): Promise<ProjectDocument['derived']>;
  /**
   * Exact rebuild boundary for work that must be preemptible. The app backs
   * this with a disposable browser worker, so aborting can terminate a
   * synchronous wasm rebuild without restarting the live geometry worker.
   */
  deriveCancellable?(
    document: ProjectDocument,
    signal: AbortSignal
  ): Promise<ProjectDocument['derived']>;
  /**
   * `derived` is the exact rebuild validation already produced for this
   * candidate; committing it alongside the command lets the caller render
   * the new geometry immediately instead of waiting for the broadcast
   * rebuild (which briefly shows the stale meshes).
   *
   * It is null when the document moved while `finalize` ran: that rebuild
   * predates whatever else landed, so attaching it would blank the body the
   * other operation just produced. The broadcast rebuild fills it in instead.
   */
  commit(
    command: AnyCommand,
    derived: ProjectDocument['derived'] | null
  ): boolean;
  commitTransaction(
    label: string,
    commands: AnyCommand[],
    derived: ProjectDocument['derived'] | null
  ): boolean;
  onBusy(busy: boolean): void;
  onStatus(message: string): void;
  /**
   * A refusal, verbatim, for the surface the user is actually looking at.
   *
   * `onStatus` already carries it, but the status bar is one clipped line at
   * the bottom of the window: a refused Create leaves the dialog open and
   * unchanged, so the operation reads as having silently done nothing. The
   * form renders this inline instead of making the reason something you have
   * to go find.
   */
  onFailure?(message: string): void;
}

export interface ValidatedFeatureTarget {
  featureName: string;
  /** Identifies the feature so a refusal naming it can offer to open it. */
  featureId?: FeatureId;
  resultBodyId: BodyId;
}

/**
 * The commit lock, held before a run exists.
 *
 * For callers whose preparation is itself expensive or destructive — an import
 * hashes and stores up to 250 MB of source bytes before it can validate
 * anything. Asking `isRunning()` first would not do: that answers about the
 * instant it was asked, and the write that follows takes seconds to minutes, so
 * another operation can take the lock while the bytes are going to disk and the
 * run is then turned away with the write already done. Reserving takes the lock
 * for real, and {@link ValidatedFeatureRunOptions.reservation} hands it to the
 * run instead of making it compete for it.
 */
export interface ValidatedFeatureReservation {
  /**
   * Releases the hold without running anything. Idempotent, and safe to call
   * after handing the reservation to a run that has already released it — a
   * caller can simply release in a `finally`.
   */
  release(): void;
}

/** The reservation as this hook holds it; callers only see `release`. */
interface HeldCommitLock extends ValidatedFeatureReservation {
  settled: Promise<void>;
}

export interface ValidatedFeatureRunOptions extends ValidatedFeatureTarget {
  /**
   * Emitted once the result body exists. A function is resolved after
   * `finalize`, so the message can report what finalize actually achieved.
   */
  successMessage: string | (() => string);
  /**
   * Status while the rebuild runs. The default names an "operation", which
   * reads wrong for work that takes long enough to be worth narrating.
   */
  validatingMessage?: string;
  /** Exact result features reachable from the edited source feature. */
  targets?: readonly ValidatedFeatureTarget[];
  /**
   * Rebuilds the candidate once more against the current document when an
   * unrelated edit lands mid-validation, instead of refusing outright.
   *
   * The refusal exists because committing a rebuild computed against a stale
   * document reverts whatever else landed — so the fresh rebuild, not the
   * stale one, is what gets committed here. Opt in only where re-applying the
   * command to the moved document is known to describe the same result: a
   * STEP import appends a feature whose geometry depends on nothing but its
   * own source bytes, so the second pass can only agree with the first, and
   * the parsed source is cached by checksum so it costs no re-parse. An edit
   * of an existing feature is the opposite case — there the move may be a
   * conflicting change to the very thing being edited, which the user needs to
   * be told about rather than silently validated against.
   */
  revalidateOnDocumentMove?: boolean;
  /**
   * Yields the command actually committed, once validation has accepted the
   * previewed one. Work a rejection would waste — a large upload, say —
   * belongs here rather than ahead of the rebuild.
   *
   * The returned command MUST carry the same ids as the previewed one. Those
   * ids are what {@link ValidatedFeatureTarget} named, so a command that
   * differs in them lands history the acceptance check never looked at.
   *
   * The commit lock is released while this runs, because a network transfer is
   * not geometry and other modelling must not stall behind it. The command it
   * returns therefore has to stay valid against a document that moved
   * underneath it — true for a STEP import, whose geometry depends only on its
   * own source bytes, and the reason no other caller uses this.
   */
  finalize?(): Promise<AnyCommand>;
  /**
   * Refusal sink for this run, replacing the host's. The host's renders inline
   * in an open feature form; a caller that has none — the File menu's import —
   * must not leave its refusal in an unrelated panel.
   */
  onFailure?(message: string): void;
  onSuccess?(): void;
  /**
   * Asked at each point where this run could still stop without a trace, so a
   * caller with a cancel control can withdraw a candidate it no longer wants.
   *
   * With `signal` and a cancellable derive boundary this also stops the rebuild
   * itself. The checks remain necessary after a successful rebuild and after
   * finalize, where cancellation must still decline the archive or commit.
   */
  cancelled?(): boolean;
  /**
   * Cancels a rebuild through {@link ValidatedFeatureCommitOptions.deriveCancellable}.
   * Callers still provide `cancelled` because the same signal must guard the
   * finalize and commit boundaries after a successful rebuild.
   */
  signal?: AbortSignal;
  /**
   * A lock this caller already holds, from {@link ValidatedFeatureReservation}.
   * The run adopts it rather than testing whether the lock is free — which is
   * the point: between reserving and running, the caller did the expensive
   * preparation that must not be spent on a run the lock would refuse.
   *
   * A reservation that is no longer held (already released) is ignored, and the
   * run competes for the lock as usual.
   */
  reservation?: ValidatedFeatureReservation;
}

export interface ValidatedFeatureTransactionRunOptions {
  label: string;
  targets: readonly ValidatedFeatureTarget[];
  successMessage: string;
  onSuccess?(): void;
}

/**
 * How a run ended. This was one `false` until a caller had to undo work on
 * refusal: an import prunes the source blob it wrote, and pruning it on
 * anything but a verdict against the file itself throws away bytes that are
 * either still live — `busy`, where the checksum may be the one another import
 * is committing against — or exactly what the retry needs.
 *
 * Only `rejected` means "the candidate was judged and refused".
 */
export type ValidatedFeatureOutcome =
  /** Validated, accepted, and in document history. */
  | 'committed'
  /** Validation ran and refused the candidate; nothing changed. */
  | 'rejected'
  /** Never validated: no document, or another run holds the commit lock. */
  | 'busy'
  /**
   * Validated, but the document kept moving underneath it, so no verdict on
   * the candidate itself was ever reached. Like `busy`, and unlike `rejected`,
   * this says nothing against the input — a caller that undoes its own work on
   * refusal must keep it here, because the obvious next step is to try the
   * same input again.
   */
  | 'superseded'
  /**
   * The caller withdrew it. Nothing was committed, and — unlike every other
   * outcome here — nothing failed either, so this must not reach a failure
   * sink: the user already knows, having asked for it.
   */
  | 'cancelled';

export const VALIDATED_FEATURE_BUSY_STATUS =
  'Another exact operation is still finishing. Try again once it completes.';

export const VALIDATED_FEATURE_REVALIDATING_STATUS =
  'The document changed while this validated. Rebuilding against the current model…';

export const VALIDATED_FEATURE_SUPERSEDED_STATUS =
  'The document kept changing while this validated, so nothing was applied. Try again once other edits have settled.';

/**
 * Rebuilds an exact feature candidate before placing it in document history.
 * A rejected candidate leaves the current model, selection, and tool intact.
 */
export function useValidatedFeatureCommit(
  options: ValidatedFeatureCommitOptions
) {
  const optionsRef = useRef(options);
  optionsRef.current = options;
  /**
   * Serialises validate → commit. Held as the holder's own object, carrying the
   * promise that settles when it lets go, rather than as a boolean: a run that
   * stepped aside for `finalize` can then wait for whoever took its place
   * instead of committing on top of them, and a caller holding a reservation
   * can be recognised as the current holder rather than as a competitor.
   */
  const inFlight = useRef<HeldCommitLock | null>(null);

  function takeLock(): HeldCommitLock {
    let settle!: () => void;
    const lock: HeldCommitLock = {
      settled: new Promise<void>((resolve) => {
        settle = resolve;
      }),
      release() {
        if (inFlight.current === lock) {
          inFlight.current = null;
        }
        settle();
      }
    };
    inFlight.current = lock;
    return lock;
  }

  async function waitForLock(): Promise<HeldCommitLock> {
    while (inFlight.current) {
      await inFlight.current.settled;
    }
    return takeLock();
  }

  async function validateAndCommit(input: {
    targets: readonly ValidatedFeatureTarget[];
    successMessage: string | (() => string);
    validatingMessage?: string;
    revalidateOnDocumentMove?: boolean;
    onSuccess?(): void;
    onFailure?(message: string): void;
    preview(current: ProjectDocument): ProjectDocument;
    reservation?: ValidatedFeatureReservation;
    cancelled?(): boolean;
    signal?: AbortSignal;
    finalize?(): Promise<AnyCommand>;
    commit(
      host: ValidatedFeatureCommitOptions,
      derived: ProjectDocument['derived'] | null,
      finalized: AnyCommand | null
    ): boolean;
    commitFailure: string;
  }): Promise<ValidatedFeatureOutcome> {
    const host = optionsRef.current;
    const manager = host.manager();
    if (!manager) {
      // Straight to the host sink: with no project open there is no run of our
      // own whose form could be showing this.
      host.onStatus('Open a project before running an exact operation.');
      host.onFailure?.('Open a project before running an exact operation.');
      return 'busy';
    }
    const reserved =
      input.reservation && inFlight.current === input.reservation
        ? (input.reservation as HeldCommitLock)
        : null;
    if (!reserved && inFlight.current) {
      // Never silent, on either surface: the refusal used to look identical to
      // a tool that had simply done nothing, and the status bar alone leaves
      // an open feature form — the thing the user is actually looking at —
      // unchanged. This goes to the HOST sink rather than the run's own,
      // because it is a statement about the operation that owns that form, not
      // about whatever input this run was carrying.
      host.onStatus(VALIDATED_FEATURE_BUSY_STATUS);
      host.onFailure?.(VALIDATED_FEATURE_BUSY_STATUS);
      return 'busy';
    }

    // Adopting the reservation rather than taking a fresh lock is what makes it
    // a reservation: the caller has been holding it since before its own
    // preparation, so nothing could have slipped in behind it.
    let lock = reserved ?? takeLock();
    /** The document the candidate in hand was previewed and rebuilt against. */
    let current = manager.document;
    const projectSwitched = (): boolean => host.manager() !== manager;
    const documentMovedFrom = (base: ProjectDocument): boolean =>
      projectSwitched() ||
      manager.document.projectId !== base.projectId ||
      manager.document.version !== base.version;
    host.onBusy(true);
    host.onStatus(
      input.validatingMessage ??
        'Checking geometry…'
    );
    try {
      let derived: ProjectDocument['derived'];
      let documentMoved: boolean;
      // At most twice: an unrelated edit landing mid-rebuild is not the
      // candidate's fault, and destroying a multi-minute import over a feature
      // rename is a punishment out of all proportion to it. A second move ends
      // the run rather than looping, so a steady stream of edits cannot hold a
      // rebuild running forever.
      for (let attempt = 0; ; attempt += 1) {
        const preview = input.preview(current);
        derived =
          input.signal && host.deriveCancellable
            ? await host.deriveCancellable(preview, input.signal)
            : await host.derive(preview);
        documentMoved = documentMovedFrom(current);
        if (
          !documentMoved ||
          !input.revalidateOnDocumentMove ||
          // A different project is open. Re-previewing would build the
          // candidate against a document it was never meant for.
          projectSwitched()
        ) {
          break;
        }
        if (attempt > 0) {
          const message = VALIDATED_FEATURE_SUPERSEDED_STATUS;
          host.onStatus(message);
          (input.onFailure ?? host.onFailure)?.(message);
          return 'superseded';
        }
        host.onStatus(VALIDATED_FEATURE_REVALIDATING_STATUS);
        current = manager.document;
      }
      for (const target of input.targets) {
        const rejection = validatedFeatureRejection({
          featureName: target.featureName,
          ...(target.featureId ? { featureId: target.featureId } : {}),
          warnings: derived.warnings,
          ...(derived.featureWarnings
            ? { featureWarnings: derived.featureWarnings }
            : {}),
          bodyPresent: Boolean(
            derived.bodyRepresentations[target.resultBodyId]
          ),
          documentMoved
        });
        if (rejection) {
          throw new Error(rejection.message);
        }
      }
      if (input.targets.length === 0 && documentMoved) {
        throw new Error('The document changed while the operation validated.');
      }
      // Withdrawn while the rebuild ran. Checked HERE, before `finalize`,
      // because finalize is where an import spends its upload: a cancel that
      // only stopped the commit would still push up to 250 MB first and leave
      // the artifact behind, unreferenced.
      if (input.cancelled?.()) {
        return 'cancelled';
      }
      // Past the acceptance decision, so anything deferred to `finalize` is
      // spent only on a candidate that is going into history.
      let finalized: AnyCommand | null = null;
      let commitDerived: ProjectDocument['derived'] | null = derived;
      if (input.finalize) {
        // The lock covers geometry, and this is a network transfer: holding it
        // across a 250 MB upload turns every other validated operation into a
        // silent no-op for minutes. Dropping it and simply carrying on would
        // interleave a concurrent run with the commit below, so the lock is
        // handed back and then re-acquired — waiting for whoever took it.
        lock.release();
        try {
          finalized = await input.finalize();
        } finally {
          lock = await waitForLock();
        }
        host.onBusy(true);
        if (host.manager() !== manager) {
          // A different project is open. Landing an import in it would be
          // worse than the artifact this leaves unreferenced.
          throw new Error('The project changed while the operation finished.');
        }
        if (documentMovedFrom(current)) {
          commitDerived = null;
        }
        // Again after finalize: the lock was handed back for the transfer, so
        // this window is as long as the upload and is exactly where a user
        // watching a slow archive would reach for cancel.
        if (input.cancelled?.()) {
          return 'cancelled';
        }
      }
      if (!input.commit(host, commitDerived, finalized)) {
        throw new Error(input.commitFailure);
      }

      input.onSuccess?.();
      host.onStatus(
        typeof input.successMessage === 'function'
          ? input.successMessage()
          : input.successMessage
      );
      return 'committed';
    } catch (error) {
      // A disposable rebuild worker rejects as soon as its signal terminates
      // it. Cancellation is the requested outcome, not a kernel refusal, so it
      // must bypass both failure sinks while the finally block releases the
      // atomic-commit lock.
      if (input.cancelled?.() || input.signal?.aborted) {
        return 'cancelled';
      }
      const message = errorMessage(error, 'Operation was not applied.');
      host.onStatus(message);
      if (input.onFailure) {
        input.onFailure(message);
      } else {
        host.onFailure?.(message);
      }
      return 'rejected';
    } finally {
      lock.release();
      host.onBusy(false);
    }
  }

  return {
    /**
     * Takes the commit lock now, for a caller that must do expensive or
     * destructive preparation before it can call {@link run}. Null when another
     * run already holds it.
     *
     * Hand the result to `run` as `reservation`, and release it in a `finally`
     * — releasing twice is harmless, and forgetting to release deadlocks every
     * later validated operation.
     */
    reserve(): ValidatedFeatureReservation | null {
      return inFlight.current ? null : takeLock();
    },

    async run(
      command: AnyCommand,
      runOptions: ValidatedFeatureRunOptions
    ): Promise<ValidatedFeatureOutcome> {
      return validateAndCommit({
        targets: runOptions.targets ?? [runOptions],
        successMessage: runOptions.successMessage,
        validatingMessage: runOptions.validatingMessage,
        revalidateOnDocumentMove: runOptions.revalidateOnDocumentMove,
        onSuccess: runOptions.onSuccess,
        onFailure: runOptions.onFailure,
        preview(current) {
          command.validate(current);
          return command.apply(current);
        },
        ...(runOptions.cancelled ? { cancelled: runOptions.cancelled } : {}),
        ...(runOptions.signal ? { signal: runOptions.signal } : {}),
        ...(runOptions.reservation
          ? { reservation: runOptions.reservation }
          : {}),
        finalize: runOptions.finalize,
        commit: (host, derived, finalized) =>
          host.commit(finalized ?? command, derived),
        commitFailure: 'The validated operation could not be committed.'
      });
    },

    async runTransaction(
      commands: AnyCommand[],
      runOptions: ValidatedFeatureTransactionRunOptions
    ): Promise<ValidatedFeatureOutcome> {
      return validateAndCommit({
        targets: runOptions.targets,
        successMessage: runOptions.successMessage,
        onSuccess: runOptions.onSuccess,
        preview: (current) =>
          new CommandManager(current).runTransaction(
            runOptions.label,
            commands
          ),
        commit: (host, derived) =>
          host.commitTransaction(runOptions.label, commands, derived),
        commitFailure: 'The validated patch could not be committed.'
      });
    }
  };
}
