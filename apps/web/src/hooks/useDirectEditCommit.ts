import { useRef } from 'react';
import type { BodyId, ProjectDocument } from '@openzcad/shared';
import type { AnyCommand, CommandManager } from '@openzcad/command-system';
import { directEditRejection } from '../lib/directEdit';
import { errorMessage } from '../lib/errors';

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
  onValidationFailed(message: string, value: number): void;
  /** The edit landed; the target body is the new selection. */
  onCommitted(bodyId: BodyId): void;
  onBusy(busy: boolean): void;
  onStatus(message: string): void;
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
    onSuccess?: () => void
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
      onSuccess
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
      host.onStatus('Validating operation with the exact geometry kernel…');
      try {
        command.validate(current);
        const preview = command.apply(current);
        const derived = await host.derive(preview);
        const live = host.manager();
        const rejection = directEditRejection({
          label: command.label,
          warnings: derived.warnings,
          bodyPresent: Boolean(derived.bodyRepresentations[targetBodyId]),
          documentMoved:
            live !== manager ||
            manager.document.projectId !== current.projectId ||
            manager.document.version !== current.version
        });
        if (rejection) {
          throw new Error(rejection);
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
        host.onValidationFailed(message, submittedValue);
        host.onStatus(message);
        return false;
      } finally {
        inFlight.current = false;
        host.onBusy(false);
      }
    }
  };
}
