/**
 * The delete gestures — Del on a picked face or feature, the viewport menu's
 * Delete, a History row's Delete — from the moment the deletion module has
 * loaded to the validated commit.
 *
 * These lived inline in `App.tsx`. Only a delete reaches them, so they load
 * with the deletion module on the first delete instead of with the app: the
 * entry chunk stays under its size budget (scripts/report-bundle-sizes.mjs)
 * by moving gesture-only code out, not by raising the budget again.
 *
 * Each takes the manager and document the gesture started on. A document
 * that moved while the module loaded is refused with the gesture's own
 * "select again" status; a geometry-only echo may replace the document object
 * but keeps its project and revision, so it still owns the deletion.
 */
import type { AnyCommand, CommandManager } from '@openzcad/command-system';
import type {
  FeatureId,
  FeatureNode,
  ProjectDocument,
  TopologySelection
} from '@openzcad/shared';
import type {
  ValidatedFeatureOutcome,
  ValidatedFeatureTransactionRunOptions
} from '../hooks/useValidatedFeatureCommit';
import {
  batchFeatureDeletion,
  cutFaceDeletion,
  faceSetDeletion,
  importedFaceDeletion,
  nativeFeatureDeletion,
  orphanFaceDeletion,
  type CascadeDependent
} from './featureDeletion';
import { countLabel, deleteFeatureToastMessage } from './toasts';

export interface DeletionHost {
  /** The manager the gesture started on, and its document then. */
  readonly manager: CommandManager;
  readonly base: ProjectDocument;
  /** Whether `manager` still owns the workspace. */
  isCurrent(): boolean;
  runTransaction(
    commands: AnyCommand[],
    options: ValidatedFeatureTransactionRunOptions
  ): Promise<ValidatedFeatureOutcome>;
  executeTransaction(label: string, commands: AnyCommand[]): boolean;
  setStatus(message: string): void;
  announce(message: string): void;
  /** Clears the selection and announces `message` with Undo. */
  healed(message: string): void;
  /** A refused detail delete whose blockers can go with it. */
  offerDetailCascade(
    name: string,
    featureIds: readonly FeatureId[],
    dependents: readonly CascadeDependent[],
    message: string
  ): void;
}

function currentDocument(
  host: DeletionHost,
  staleStatus: string
): ProjectDocument | null {
  const current = host.manager.document;
  if (
    !host.isCurrent() ||
    current.projectId !== host.base.projectId ||
    current.version !== host.base.version
  ) {
    host.setStatus(staleStatus);
    return null;
  }
  return current;
}

/**
 * Heals one face by a replayable direct edit: a face of an imported STEP
 * part, which has no history to delete; a face a subtract cut, whose inferred
 * feature (the cutting tool) the cut still needs; or a face no step can be
 * shown to own.
 */
export function deleteFace(
  host: DeletionHost,
  selection: TopologySelection,
  origin: 'imported' | 'cut' | 'orphan'
): void {
  const current = currentDocument(
    host,
    'The model changed. Select the face again before deleting it.'
  );
  if (!current) return;
  const removal =
    origin === 'cut'
      ? cutFaceDeletion(current, selection)
      : origin === 'orphan'
        ? orphanFaceDeletion(current, selection)
        : importedFaceDeletion(current, selection);
  void host.runTransaction([removal.command], {
    label: removal.command.label,
    targets: [removal.target],
    validatingMessage:
      origin === 'cut'
        ? 'Checking the cut removal…'
        : origin === 'orphan'
          ? 'Checking the face removal…'
          : 'Checking imported feature removal…',
    successMessage: removal.successMessage,
    onFailure: (message) => host.announce(message),
    onSuccess: () => host.healed(removal.successMessage)
  });
}

/** Several faces of one body deleted together and healed. */
export function deleteFaces(
  host: DeletionHost,
  faces: readonly TopologySelection[]
): void {
  const current = currentDocument(
    host,
    'The model changed. Select the faces again before deleting them.'
  );
  if (!current) return;
  const removal = faceSetDeletion(current, faces);
  void host.runTransaction([removal.command], {
    label: removal.command.label,
    targets: [removal.target],
    validatingMessage: `Checking the removal of ${faces.length} faces…`,
    successMessage: removal.successMessage,
    onFailure: (message) => host.announce(message),
    onSuccess: () => host.healed(removal.successMessage)
  });
}

/**
 * A hole, fillet or chamfer removed with its input reconnected. A refusal
 * whose blockers are themselves details or direct edits built on it offers
 * to delete them too.
 */
export function deleteDetail(
  host: DeletionHost,
  feature: FeatureNode,
  name: string,
  dependentCount: number,
  finish: () => void
): void {
  const current = currentDocument(
    host,
    'The model changed. Select the feature again before deleting it.'
  );
  if (!current) return;
  const removal = nativeFeatureDeletion(current, feature);
  void host.runTransaction([removal.command], {
    label: `Delete ${name}`,
    targets: [],
    validateDerived: removal.validateDerived,
    validatingMessage: `Checking removal of ${name}…`,
    successMessage: deleteFeatureToastMessage(name, dependentCount),
    onFailure: (message) =>
      host.offerDetailCascade(
        name,
        [feature.featureId],
        removal.cascade(),
        message
      ),
    onSuccess: finish
  });
}

/**
 * Several History steps removed as one undoable transaction, validated when
 * any is a detail. `cascadeName` names the detail a cascade grew from.
 */
export function deleteFeatures(
  host: DeletionHost,
  featureIds: readonly FeatureId[],
  message: string,
  cascadeName: string | undefined,
  finish: () => void
): void {
  const current = currentDocument(
    host,
    'The model changed. Select the features again before deleting them.'
  );
  if (!current) return;
  const removal = batchFeatureDeletion(current, featureIds);
  if (removal.validateDerived) {
    const label = countLabel(featureIds.length, 'feature', 'features');
    void host.runTransaction(removal.commands, {
      label: removal.label,
      targets: [],
      validateDerived: removal.validateDerived,
      validatingMessage: `Checking removal of ${label}…`,
      successMessage: message,
      onFailure: (failure) =>
        host.offerDetailCascade(
          cascadeName ?? label,
          featureIds,
          removal.cascade(),
          failure
        ),
      onSuccess: finish
    });
    return;
  }
  if (host.executeTransaction(removal.label, removal.commands)) finish();
}
