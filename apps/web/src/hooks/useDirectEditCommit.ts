import { useRef } from 'react';
import type { BodyId, ProjectDocument } from '@openzcad/shared';
import type { AnyCommand, CommandManager } from '@openzcad/command-system';
import { directEditRejection } from '../lib/directEdit';
import { errorMessage } from '../lib/errors';
import type { CommandDiagnostic } from '../lib/interaction/machine';
import {
  splitRefusal,
  validatedFeatureRejection
} from '../lib/featureValidation';
import type { ValidatedFeatureTarget } from './useValidatedFeatureCommit';

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
 */
export interface PrecomputedDirectEditDerived {
  baseProjectId: ProjectDocument['projectId'];
  baseVersion: number;
  derived: ProjectDocument['derived'];
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
 * against documents neither of them measured.
 */
export function useDirectEditCommit(
  options: DirectEditCommitOptions
): DirectEditCommit {
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const inFlight = useRef(false);

  return {
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
      if (!manager || inFlight.current) {
        return false;
      }
      inFlight.current = true;
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
        const derived = reusable
          ? precomputed.derived
          : await host.derive(preview);
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
              break;
            }
          }
          if (!rejection && validationTargets.length === 0 && documentMoved) {
            rejection = {
              message: 'The document changed while the edit was validating.'
            };
          }
        } else {
          const message = directEditRejection({
            label: command.label,
            warnings: derived.warnings,
            ...(derived.featureWarnings
              ? { featureWarnings: derived.featureWarnings }
              : {}),
            bodyPresent: Boolean(derived.bodyRepresentations[targetBodyId]),
            documentMoved
          });
          rejection = message ? splitRefusal(message) : null;
        }
        // Reported rather than thrown: a refusal is an answer, and rebuilding
        // it from an Error's message would drop the feature it names — which
        // is the part the user can act on.
        if (rejection) {
          host.onValidationFailed(rejection, submittedValue);
          return false;
        }
        if (!host.commit(command, derived)) {
          throw new Error('The validated edit could not be committed.');
        }
        host.onCommitted(targetBodyId);
        onSuccess?.();
        host.onStatus(successMessage);
        return true;
      } catch (error) {
        const message = errorMessage(error, 'Operation was not applied.');
        // One owner per diagnostic. `onValidationFailed` hands the rejection to
        // the command that caused it, which shows it at the handle the user is
        // looking at; echoing it into the workspace status line as well is how
        // the same failure used to appear twice, and how one copy went stale
        // while the other moved on.
        host.onValidationFailed(splitRefusal(message), submittedValue);
        return false;
      } finally {
        inFlight.current = false;
        host.onBusy(false);
      }
    }
  };
}
