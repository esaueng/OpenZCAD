import type { CommandManager } from '@openzcad/command-system';
import { listFeaturesInOrder } from '@openzcad/document-core';
import type { FeatureId, ProjectDocument } from '@openzcad/shared';
import { featuresNeedingRepair } from './featureRepair';
import { suppressFeatureToastMessage } from './toasts';

export interface SuppressionNotice {
  manager: CommandManager;
  projectId: ProjectDocument['projectId'];
  version: number;
  featureId: FeatureId;
  name: string;
  resume: boolean;
  before: ReadonlySet<FeatureId> | null;
}

/** A causal count needs geometry from the live document before the toggle. */
export function suppressionRepairSnapshot(
  manager: CommandManager,
  geometryReady: boolean
): ReadonlySet<FeatureId> | null {
  return geometryReady
    ? featuresNeedingRepair(
        listFeaturesInOrder(manager.document),
        manager.document.derived.bodyRepresentations
      )
    : null;
}

export function settleSuppressionNotice(
  notice: SuppressionNotice,
  manager: CommandManager | null,
  derived: ProjectDocument['derived'] | null
): { state: 'pending' | 'discarded' } | { state: 'ready'; message: string } {
  const document = manager?.document;
  if (
    manager !== notice.manager ||
    !document ||
    document.projectId !== notice.projectId ||
    document.version > notice.version
  ) {
    return { state: 'discarded' };
  }
  if (document.version < notice.version) return { state: 'pending' };
  // A dropped earlier rebuild leaves no qualified before-state for this
  // toggle. Announce the action without attributing the combined cascade.
  const before = notice.before;
  const broken =
    derived && before
      ? [
          ...featuresNeedingRepair(
            listFeaturesInOrder(document),
            derived.bodyRepresentations
          )
        ].filter((id) => id !== notice.featureId && !before.has(id)).length
      : 0;
  return {
    state: 'ready',
    message: suppressFeatureToastMessage(notice.name, notice.resume, broken)
  };
}
