import { useRef } from 'react';
import type { BodyId, ProjectDocument } from '@openzcad/shared';
import type { AnyCommand, CommandManager } from '@openzcad/command-system';
import { errorMessage } from '../lib/errors';
import { validatedFeatureRejection } from '../lib/featureValidation';

export interface ValidatedFeatureCommitOptions {
  manager(): CommandManager | null;
  derive(document: ProjectDocument): Promise<ProjectDocument['derived']>;
  commit(command: AnyCommand): boolean;
  onBusy(busy: boolean): void;
  onStatus(message: string): void;
}

export interface ValidatedFeatureRunOptions {
  featureName: string;
  resultBodyId: BodyId;
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

  return {
    async run(
      command: AnyCommand,
      runOptions: ValidatedFeatureRunOptions
    ): Promise<boolean> {
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
        command.validate(current);
        const preview = command.apply(current);
        const derived = await host.derive(preview);
        const live = host.manager();
        const rejection = validatedFeatureRejection({
          featureName: runOptions.featureName,
          warnings: derived.warnings,
          bodyPresent: Boolean(
            derived.bodyRepresentations[runOptions.resultBodyId]
          ),
          documentMoved:
            live !== manager ||
            manager.document.projectId !== current.projectId ||
            manager.document.version !== current.version
        });
        if (rejection) {
          throw new Error(rejection);
        }
        if (!host.commit(command)) {
          throw new Error('The validated operation could not be committed.');
        }

        runOptions.onSuccess?.();
        host.onStatus(runOptions.successMessage);
        return true;
      } catch (error) {
        host.onStatus(errorMessage(error, 'Operation was not applied.'));
        return false;
      } finally {
        inFlight.current = false;
        host.onBusy(false);
      }
    }
  };
}
