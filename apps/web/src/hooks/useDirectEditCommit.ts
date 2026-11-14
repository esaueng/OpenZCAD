import { useRef } from 'react';
import { refusalOfWorkerError } from '../lib/workerRefusal';
import { ownEntry } from '@openzcad/shared';
import type { BodyId, ProjectDocument } from '@openzcad/shared';
import type { AnyCommand, CommandManager } from '@openzcad/command-system';
import { createdFeatureId, directEditRejection } from '../lib/directEdit';
import { errorMessage } from '../lib/errors';
import type { CommandDiagnostic } from '../lib/interaction/machine';
import {
  refusingWarningDetail,
  splitRefusal,
  validatedFeatureRejection
} from '../lib/featureValidation';
import type { ValidatedFeatureTarget } from './useValidatedFeatureCommit';
import { faceDragTraceEnabled, traceFaceDrag } from '../lib/faceDragTrace';

export interface DirectEditCommitOptions {
  manager(): CommandManager | null;
  /** Rebuilds a candidate document against the exact kernel. */
  derive(document: ProjectDocument): Promise<ProjectDocument['derived']>;
  /**
   * Applies the command for real. False means it was refused. `derived` is
   * the exact rebuild the validation already produced for this command;
   * attaching it at commit time renders the new geometry immediately instead
   * of flashing the stale meshes until the broadcast rebuild echoes back.
   */
  commit(command: AnyCommand, derived: ProjectDocument['derived']): boolean;
  onValidationStart(value: number): void;
  /**
   * The exact rebuild refused this edit. The host owns where that shows: a
   * running command displays it itself, and only a host with no such surface
   * should fall back to the status line.
   */
  onValidationFailed(diagnostic: CommandDiagnostic, value: number): void;
  /** The edit landed; the target body is the new selection. */
  onCommitted(bodyId: BodyId): void;
  onBusy(busy: boolean): void;
  onStatus(message: string): void;
}

/**
 * A rebuild the live preview already ran for this exact command. Reused only
 * when the document is still the one it was computed against, so a preview
 * that passed is never followed by a second wait — or a different answer —
 * for the same value on release.
 *
 * `derived` may still be running: a release at the value whose preview is in
 * flight awaits that rebuild instead of queuing the same edit behind it in the
 * worker, which serialises kernel work and cannot abandon a started rebuild.
 * The commit judges the result exactly as it would its own rebuild.
 */
export interface PrecomputedDirectEditDerived {
  baseProjectId: ProjectDocument['projectId'];
  baseVersion: number;
  derived: ProjectDocument['derived'] | Promise<ProjectDocument['derived']>;
}

/**
 * A release set aside by {@link DirectEditCommit.supersede}: everything its
 * `run` was given, with its exact rebuild (running or done) as `precomputed`
 * for the document it was validating against. Committing it later is one
 * more `run` with these arguments; nothing of it reached the document.
 */
export interface SupersededDirectEdit {
  command: AnyCommand;
  targetBodyId: BodyId;
  successMessage: string;
  submittedValue: number;
  onSuccess?: () => void;
  validationTargets?: readonly ValidatedFeatureTarget[];
  precomputed: PrecomputedDirectEditDerived & {
    derived: Promise<ProjectDocument['derived']>;
  };
}

export interface DirectEditCommit {
  /**
   * Validates a direct edit against the exact kernel and commits it only if
   * the rebuild is sound. Resolves to whether it landed.
   */
  run(
    command: AnyCommand,
    targetBodyId: BodyId,
    successMessage: string,
    submittedValue?: number,
    onSuccess?: () => void,
    validationTargets?: readonly ValidatedFeatureTarget[],
    precomputed?: PrecomputedDirectEditDerived
  ): Promise<boolean>;
  /**
   * Sets aside the edit still validating, so the hand can take its handle
   * again without waiting for the exact kernel: the edit will neither
   * commit nor report a refusal, and the next `run` may start at once. Its
   * rebuild keeps running in the worker and is handed back, so a later
   * `run` of the same edit (the hand let go where it was, or the new
   * gesture was cancelled) commits from it instead of rebuilding it.
   *
   * The busy flag stays raised while the set-aside edit is pending: the
   * next `run` takes it over, and `discard` lowers it when the edit is
   * dropped instead, so no other edit starts in between.
   *
   * Null when nothing is validating, or when the validation has already
   * answered and the edit is committing.
   */
  supersede(): SupersededDirectEdit | null;
  /**
   * Drops the edit `supersede` set aside without committing it, lowering
   * the busy flag it kept raised unless a `run` has taken that over since.
   */
  discard(): void;
  /** Whether a `run` would start now: nothing validating or committing. */
  idle(): boolean;
}

/**
 * The commit path every direct manipulation goes through.
 *
 * A handle drag cannot commit optimistically: the kernel will accept a
 * command and still hand back something the gesture did not mean — a body
 * that vanished, a warning attached to this feature, a result that no longer
 * matches the document it was computed against. The edit is rebuilt, judged,
 * and only then applied, so a refused edit leaves the model untouched and
 * the handle re-armed at its last good value.
 *
 * One edit at a time. Two overlapping validations would race to commit
 * against documents neither of them measured; a newer gesture on the same
 * handle sets the older one aside first (`supersede`), so it never lands.
 */
export function useDirectEditCommit(
  options: DirectEditCommitOptions
): DirectEditCommit {
  const optionsRef = useRef(options);
  optionsRef.current = options;
  // The edit validating, until it answers. `supersede` takes it out of here,
  // which is how its `run` learns, when the rebuild answers, that it no
  // longer owns the commit, the busy flag or the refusal.
  const inFlight = useRef<{
    edit: SupersededDirectEdit | null;
    startedAt: number;
  } | null>(null);
  // Set while a validated edit is being committed: too late to set aside.
  const committing = useRef(false);
  // An edit `supersede` set aside, still holding the busy flag up for the
  // `run` that commits it, or until `discard` drops it.
  const setAside = useRef(false);
  const discard = () => {
    if (!setAside.current) return;
    setAside.current = false;
    if (!inFlight.current && !committing.current)
      optionsRef.current.onBusy(false);
  };

  return {
    supersede() {
      const active = inFlight.current;
      if (!active?.edit || committing.current) return null;
      inFlight.current = null;
      setAside.current = true;
      if (faceDragTraceEnabled())
        traceFaceDrag('superseded', {
          value: active.edit.submittedValue,
          ms: performance.now() - active.startedAt
        });
      return active.edit;
    },
    discard,
    idle() {
      return !inFlight.current && !committing.current;
    },
    async run(
      command,
      targetBodyId,
      successMessage,
      submittedValue = 0,
      onSuccess,
      validationTargets,
      precomputed
    ) {
      const host = optionsRef.current;
      const manager = host.manager();
      if (!manager || inFlight.current || committing.current) {
        // No document left to commit a set-aside edit to: it is dropped.
        if (!manager) discard();
        return false;
      }
      // Takes over the busy flag a set-aside edit kept raised.
      setAside.current = false;
      const startedAt = performance.now();
      if (faceDragTraceEnabled())
        traceFaceDrag('release', { value: submittedValue });
      const record: {
        edit: SupersededDirectEdit | null;
        startedAt: number;
      } = { edit: null, startedAt };
      inFlight.current = record;
      // Whether this run still owns its edit. Read after every await.
      const owned = () => inFlight.current === record;
      host.onValidationStart(submittedValue);
      const current = manager.document;
      host.onBusy(true);
      host.onStatus('Checking geometry…');
      try {
        command.validate(current);
        const preview = command.apply(current);
        const reusable =
          precomputed !== undefined &&
          precomputed.baseProjectId === current.projectId &&
          precomputed.baseVersion === current.version;
        const pending = !reusable
          ? host.derive(preview)
          : precomputed.derived instanceof Promise
            ? // A shared rebuild that failed outright (worker or kernel error,
              // not a refusal) says nothing about this command: derive it
              // afresh, exactly as a commit without a preview would.
              precomputed.derived.catch(() => host.derive(preview))
            : Promise.resolve(precomputed.derived);
        // Never an unhandled rejection: a set-aside edit is awaited by no one.
        pending.catch(() => undefined);
        record.edit = {
          command,
          targetBodyId,
          successMessage,
          submittedValue,
          ...(onSuccess ? { onSuccess } : {}),
          ...(validationTargets ? { validationTargets } : {}),
          precomputed: {
            baseProjectId: current.projectId,
            baseVersion: current.version,
            derived: pending
          }
        };
        const derived = await pending;
        if (!owned()) return false;
        if (faceDragTraceEnabled())
          traceFaceDrag('validated', {
            value: submittedValue,
            ms: performance.now() - startedAt
          });
        const live = host.manager();
        const documentMoved =
          live !== manager ||
          manager.document.projectId !== current.projectId ||
          manager.document.version !== current.version;
        let rejection: CommandDiagnostic | null = null;
        if (validationTargets) {
          for (const target of validationTargets) {
            rejection = validatedFeatureRejection({
              featureName: target.featureName,
              ...(target.featureId ? { featureId: target.featureId } : {}),
              ...(target.dependent ? { dependent: true } : {}),
              warnings: derived.warnings,
              ...(derived.featureWarnings
                ? { featureWarnings: derived.featureWarnings }
                : {}),
              bodyPresent: Boolean(
                ownEntry(derived.bodyRepresentations, target.resultBodyId)
              ),
              documentMoved
            });
            if (rejection) {
              break;
            }
          }
          if (!rejection && validationTargets.length === 0 && documentMoved) {
            rejection = {
              message: 'The document changed while the edit was validating.'
            };
          }
        } else {
          const featureId = createdFeatureId(command);
          const message = directEditRejection({
            label: command.label,
            warnings: derived.warnings,
            ...(derived.featureWarnings
              ? { featureWarnings: derived.featureWarnings }
              : {}),
            ...(featureId ? { featureId } : {}),
            bodyPresent: Boolean(
              ownEntry(derived.bodyRepresentations, targetBodyId)
            ),
            documentMoved
          });
          // Classified exactly as the live preview classifies it
          // (`offsetPreviewRejection`), so the two cannot word or route the
          // same refusal differently.
          const warning = refusingWarningDetail(
            command.label,
            derived.warnings,
            derived.featureWarnings,
            featureId
          );
          rejection = message
            ? splitRefusal(message, warning?.kernelRefusal ?? warning?.category)
            : null;
        }
        // Reported rather than thrown: a refusal is an answer, and rebuilding
        // it from an Error's message would drop the feature it names — which
        // is the part the user can act on.
        if (rejection) {
          host.onValidationFailed(rejection, submittedValue);
          return false;
        }
        committing.current = true;
        if (!host.commit(command, derived)) {
          throw new Error('The validated edit could not be committed.');
        }
        if (faceDragTraceEnabled())
          traceFaceDrag('committed', {
            value: submittedValue,
            ms: performance.now() - startedAt
          });
        host.onCommitted(targetBodyId);
        onSuccess?.();
        host.onStatus(successMessage);
        return true;
      } catch (error) {
        // Set aside meanwhile: its refusal is no longer anyone's to show.
        if (!owned()) return false;
        const message = errorMessage(error, 'Operation was not applied.');
        // One owner per diagnostic. `onValidationFailed` hands the rejection to
        // the command that caused it, which shows it at the handle the user is
        // looking at; echoing it into the workspace status line as well is how
        // the same failure used to appear twice, and how one copy went stale
        // while the other moved on.
        host.onValidationFailed(
          splitRefusal(message, refusalOfWorkerError(error)),
          submittedValue
        );
        return false;
      } finally {
        committing.current = false;
        if (owned()) {
          inFlight.current = null;
          host.onBusy(false);
        }
      }
    }
  };
}
