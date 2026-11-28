import { renderHook } from '../../apps/web/node_modules/@testing-library/react';
import type { AnyCommand, CommandManager } from '@openzcad/command-system';
import type { BodyId, ProjectDocument } from '@openzcad/shared';
import {
  useValidatedFeatureCommit,
  type ValidatedFeatureOutcome
} from '../../apps/web/src/hooks/useValidatedFeatureCommit';
import type { FeatureBuildError } from '../../apps/web/src/lib/featureValidation';

/**
 * A feature Create through the commit path the workspace uses
 * (`createValidatedFeature` in `App.tsx`): the app's own
 * `useValidatedFeatureCommit`, rebuilding the candidate with `derive` and
 * committing to `manager` only once the rebuild accepts it. `derive` stands
 * for the geometry worker, which runs the same exact adapter.
 *
 * Needs a DOM (`// @vitest-environment happy-dom`) to render the hook.
 */
export async function validatedCreate(
  manager: CommandManager,
  command: AnyCommand,
  target: { featureName: string; resultBodyId: BodyId },
  derive: (document: ProjectDocument) => Promise<ProjectDocument['derived']>
): Promise<{
  outcome: ValidatedFeatureOutcome;
  /** Every command the hook handed to the app to commit. */
  committed: AnyCommand[];
  /** What the open card would show inline, latest last (nulls dropped). */
  failures: string[];
  /** What History records as the refused step. */
  rejections: FeatureBuildError[];
}> {
  const committed: AnyCommand[] = [];
  const failures: string[] = [];
  const rejections: FeatureBuildError[] = [];
  const { result, unmount } = renderHook(() =>
    useValidatedFeatureCommit({
      manager: () => manager,
      derive,
      // The app's `executeCommand`, less the React state it also sets.
      commit: (candidate) => {
        committed.push(candidate);
        manager.execute(candidate);
        return true;
      },
      commitTransaction: () => {
        throw new Error('A single Create commits no transaction.');
      },
      onBusy: () => {},
      onStatus: () => {},
      onFailure: (message) => {
        if (message !== null) failures.push(message);
      },
      onRejection: (error) => {
        rejections.push(error);
      }
    })
  );
  try {
    const outcome = await result.current.run(command, {
      ...target,
      successMessage: `${target.featureName} added.`
    });
    return { outcome, committed, failures, rejections };
  } finally {
    unmount();
  }
}
