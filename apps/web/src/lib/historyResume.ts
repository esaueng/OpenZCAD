import { commandFactories, type AnyCommand } from '@openzcad/command-system';
import {
  FEATURE_ROLLBACK_SUPPRESSED_METADATA_KEY,
  FEATURE_SUPPRESSED_METADATA_KEY,
  isFeatureManuallySuppressed,
  isFeatureRollbackSuppressed,
  isFeatureSuppressed,
  type FeatureId,
  type FeatureNode,
  type ProjectDocument
} from '@openzcad/shared';
import {
  featureFailureReason,
  listNames,
  type RefusedDependent
} from './featureSuppression';

/**
 * One move of the rollback marker: the metadata commands it commits as a
 * single transaction, and the features it brings back into the build.
 */
export interface RollbackMarkerMove {
  commands: AnyCommand[];
  /**
   * Paused features the move resumes that will actually build again, in
   * history order. A feature the user also suppressed by hand stays out of
   * the build, so it is not listed.
   */
  resumed: FeatureNode[];
  /** Features the move newly pauses, in history order. */
  paused: FeatureNode[];
}

/**
 * What Resume full history says it did. The note that hand-suppressed
 * features stay suppressed is said only when one is: it was said every time,
 * on a model with nothing suppressed, where it read as a warning about
 * something that was not there.
 */
export function resumeHistoryMessage(features: readonly FeatureNode[]): string {
  const kept = features.filter(isFeatureManuallySuppressed).length;
  if (kept === 0) return 'Full history resumed.';
  return kept === 1
    ? 'Full history resumed. 1 feature you suppressed stays suppressed.'
    : `Full history resumed. ${kept} features you suppressed stay suppressed.`;
}

/**
 * The marker after `features[markerIndex]`, or at the end of history when
 * `markerIndex` is null (Resume full history).
 */
export function rollbackMarkerMove(
  features: readonly FeatureNode[],
  markerIndex: number | null
): RollbackMarkerMove {
  const move: RollbackMarkerMove = { commands: [], resumed: [], paused: [] };
  features.forEach((feature, index) => {
    const rollbackSuppressed = markerIndex !== null && index > markerIndex;
    if (isFeatureRollbackSuppressed(feature) === rollbackSuppressed) return;
    move.commands.push(
      commandFactories.setNodeMetadata(
        {
          nodeId: feature.id,
          metadata: {
            [FEATURE_ROLLBACK_SUPPRESSED_METADATA_KEY]: rollbackSuppressed
              ? true
              : null
          }
        },
        rollbackSuppressed
          ? `Roll back ${feature.name}`
          : `Resume ${feature.name}`
      )
    );
    if (rollbackSuppressed) move.paused.push(feature);
    else if (!isFeatureManuallySuppressed(feature)) move.resumed.push(feature);
  });
  return move;
}

/**
 * A History row's own Resume: one command that clears both its suppression
 * and its rollback pause, and the features whose build it can change.
 */
export interface RowResume {
  feature: FeatureNode;
  command: AnyCommand;
  /**
   * The resumed row, then every later feature that builds with or without
   * it, in history order. A later feature that already built and now fails
   * can only fail because of the row; features before it rebuild unchanged.
   */
  checked: FeatureNode[];
}

/**
 * The resume a row's suppression toggle commits, or null when the row is
 * building and the toggle suppresses it instead.
 */
export function rowResume(
  features: readonly FeatureNode[],
  featureId: FeatureId
): RowResume | null {
  const index = features.findIndex(
    (feature) => feature.featureId === featureId
  );
  const feature = features[index];
  if (!feature || !isFeatureSuppressed(feature)) return null;
  return {
    feature,
    command: commandFactories.setNodeMetadata(
      {
        nodeId: feature.id,
        metadata: {
          [FEATURE_SUPPRESSED_METADATA_KEY]: null,
          [FEATURE_ROLLBACK_SUPPRESSED_METADATA_KEY]: null
        }
      },
      `Resume ${feature.name}`
    ),
    checked: [
      feature,
      ...features
        .slice(index + 1)
        .filter((later) => !isFeatureSuppressed(later))
    ]
  };
}

/**
 * The checked features a row resume is not blamed for: later features that
 * already fail in `derived`, the rebuild of the document before the resume
 * (null when that rebuild is not in yet, so none is known), and the row
 * itself when a rollback in this session paused it while it was failing.
 */
export function rowResumeAlreadyFailing(
  resume: RowResume,
  derived: ProjectDocument['derived'] | null,
  rollbackFailing: ReadonlySet<FeatureId> = new Set()
): Set<FeatureId> {
  const failing = new Set(
    derived ? failingFeatureIds(resume.checked.slice(1), derived) : []
  );
  if (
    isFeatureRollbackSuppressed(resume.feature) &&
    rollbackFailing.has(resume.feature.featureId)
  )
    failing.add(resume.feature.featureId);
  return failing;
}

/**
 * The features that do not build in `derived`, among `features`. Recorded
 * when a rollback pauses them, so a later resume does not blame itself for
 * a failure the model already had.
 */
export function failingFeatureIds(
  features: readonly FeatureNode[],
  derived: ProjectDocument['derived']
): FeatureId[] {
  return features
    .filter((feature) => featureFailureReason(feature, derived) !== null)
    .map((feature) => feature.featureId);
}

/**
 * The resumed features that would not rebuild in the candidate `derived`,
 * in history order. A feature in `alreadyFailing` was failing when it was
 * paused, so its failure is not the resume's doing and is left out.
 */
export function resumeFailures(
  resumed: readonly FeatureNode[],
  derived: ProjectDocument['derived'],
  alreadyFailing: ReadonlySet<FeatureId> = new Set()
): RefusedDependent[] {
  return resumed.flatMap((feature): RefusedDependent[] => {
    if (alreadyFailing.has(feature.featureId)) return [];
    const reason = featureFailureReason(feature, derived);
    return reason
      ? [{ featureId: feature.featureId, name: feature.name, reason }]
      : [];
  });
}

/** The plain sentence for a resume that would leave features failing. */
export function resumeRefusalMessage(
  failures: readonly Pick<RefusedDependent, 'name'>[]
): string {
  const count = failures.length;
  return `Resuming would leave ${count} ${count === 1 ? 'feature' : 'features'} unable to rebuild: ${listNames(failures.map((failure) => failure.name))}.`;
}

/**
 * Thrown from a validated commit's `validateDerived` hook so the candidate is
 * not committed. Deliberately not a `FeatureBuildError`: the user is asked
 * whether to resume anyway, so no History failure record is filed for it.
 */
export class HistoryResumeRefusal extends Error {
  constructor(public readonly failures: readonly RefusedDependent[]) {
    super(resumeRefusalMessage(failures));
    this.name = 'HistoryResumeRefusal';
  }
}

/** Throws the refusal when any resumed feature newly fails, for `validateDerived`. */
export function validateHistoryResume(
  resumed: readonly FeatureNode[],
  derived: ProjectDocument['derived'],
  alreadyFailing?: ReadonlySet<FeatureId>
): void {
  const failures = resumeFailures(resumed, derived, alreadyFailing);
  if (failures.length) throw new HistoryResumeRefusal(failures);
}

/**
 * The resume prompt that still answers the open document, or null. It was
 * checked against one version; any later edit, undo or other project makes
 * its failure list stale, so it is dropped rather than acted on.
 */
export function activeResumePrompt<
  T extends { projectId: string; version: number }
>(
  pending: T | null,
  document: { projectId: string; version: number } | null | undefined
): T | null {
  return pending &&
    document &&
    pending.projectId === document.projectId &&
    pending.version === document.version
    ? pending
    : null;
}
