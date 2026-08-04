import { useRef } from 'react';
import type { BodyId, ProjectDocument } from '@openzcad/shared';
import { CommandManager, type AnyCommand } from '@openzcad/command-system';
import { errorMessage } from '../lib/errors';
import { validatedFeatureRejection } from '../lib/featureValidation';

export interface ValidatedFeatureCommitOptions {
  manager(): CommandManager | null;
  derive(document: ProjectDocument): Promise<ProjectDocument['derived']>;
  /**
   * `derived` is the exact rebuild validation already produced for this
   * candidate; committing it alongside the command lets the caller render
   * the new geometry immediately instead of waiting for the broadcast
   * rebuild (which briefly shows the stale meshes).
   */
  commit(command: AnyCommand, derived: ProjectDocument['derived']): boolean;
  commitTransaction(
    label: string,
    commands: AnyCommand[],
    derived: ProjectDocument['derived']
  ): boolean;
  onBusy(busy: boolean): void;
  onStatus(message: string): void;
}

export interface ValidatedFeatureTarget {
  featureName: string;
  resultBodyId: BodyId;
}

export interface ValidatedFeatureRunOptions extends ValidatedFeatureTarget {
  successMessage: string;
  /** Exact result features reachable from the edited source feature. */
  targets?: readonly ValidatedFeatureTarget[];
  onSuccess?(): void;
}

export interface ValidatedFeatureTransactionRunOptions {
  label: string;
  targets: readonly ValidatedFeatureTarget[];
  successMessage: string;
  onSuccess?(): void;
}

/**
 * Rebuilds an exact feature candidate before placing it in document history.
 * A rejected candidate leaves the current model, selection, and tool intact.
 */
export function useValidatedFeatureCommit(
  options: ValidatedFeatureCommitOptions
) {
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const inFlight = useRef(false);

  async function validateAndCommit(input: {
    targets: readonly ValidatedFeatureTarget[];
    successMessage: string;
    onSuccess?(): void;
    preview(current: ProjectDocument): ProjectDocument;
    commit(
      host: ValidatedFeatureCommitOptions,
      derived: ProjectDocument['derived']
    ): boolean;
    commitFailure: string;
  }): Promise<boolean> {
    const host = optionsRef.current;
    const manager = host.manager();
    if (!manager || inFlight.current) {
      return false;
    }

    inFlight.current = true;
    const current = manager.document;
    host.onBusy(true);
    host.onStatus('Validating operation with the exact geometry kernel…');
    try {
      const preview = input.preview(current);
      const derived = await host.derive(preview);
      const live = host.manager();
      const documentMoved =
        live !== manager ||
        manager.document.projectId !== current.projectId ||
        manager.document.version !== current.version;
      for (const target of input.targets) {
        const rejection = validatedFeatureRejection({
          featureName: target.featureName,
          warnings: derived.warnings,
          bodyPresent: Boolean(
            derived.bodyRepresentations[target.resultBodyId]
          ),
          documentMoved
        });
        if (rejection) {
          throw new Error(rejection);
        }
      }
      if (input.targets.length === 0 && documentMoved) {
        throw new Error('The document changed while the operation validated.');
      }
      if (!input.commit(host, derived)) {
        throw new Error(input.commitFailure);
      }

      input.onSuccess?.();
      host.onStatus(input.successMessage);
      return true;
    } catch (error) {
      host.onStatus(errorMessage(error, 'Operation was not applied.'));
      return false;
    } finally {
      inFlight.current = false;
      host.onBusy(false);
    }
  }

  return {
    async run(
      command: AnyCommand,
      runOptions: ValidatedFeatureRunOptions
    ): Promise<boolean> {
      return validateAndCommit({
        targets: runOptions.targets ?? [runOptions],
        successMessage: runOptions.successMessage,
        onSuccess: runOptions.onSuccess,
        preview(current) {
          command.validate(current);
          return command.apply(current);
        },
        commit: (host, derived) => host.commit(command, derived),
        commitFailure: 'The validated operation could not be committed.'
      });
    },

    async runTransaction(
      commands: AnyCommand[],
      runOptions: ValidatedFeatureTransactionRunOptions
    ): Promise<boolean> {
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
