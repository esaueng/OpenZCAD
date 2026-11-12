import { useMemo } from 'react';
import { Search } from 'lucide-react';
import type { FeatureNode } from '@openzcad/shared';
import { HistoryTimeline } from '../HistoryTimeline';
import type { ModelPanelSource } from './modelPanelProps';
import type { HistoryFind } from './panelViews';
import { sketchesWithBrokenProjections } from '../../lib/sketch/projection';
import { builtOnFailedFeatures } from '../../lib/featureRepair';

/** The header's Find toggle, shown while the list has something to find. */
export function HistoryFindToggle({ find }: { find: HistoryFind }) {
  return (
    <button
      ref={find.toggleRef}
      type="button"
      className="history-find-toggle"
      title="Find a step"
      aria-label="Find a step"
      aria-pressed={find.open}
      onClick={find.toggle}
    >
      <Search size={12} aria-hidden="true" />
    </button>
  );
}

/** The History header count. The panel always shows, empty or not. */
export function historyCount(features: readonly FeatureNode[]): number {
  return features.length;
}

export type HistoryPanelProps = Pick<
  ModelPanelSource,
  | 'features'
  | 'localAppend'
  | 'representations'
  | 'failedFeatureIds'
  | 'relatedFeatureIds'
  | 'geometryPending'
  | 'geometryPendingShown'
  | 'selectedFeatureNodeId'
  | 'hiddenBodyIds'
  | 'hiddenSketchIds'
  | 'document'
  | 'parameterValues'
  | 'units'
  | 'historyDetails'
  | 'pendingHistoryStep'
  | 'editingHistoryFeatureId'
  | 'onSelectFeature'
  | 'onToggleBodyVisibility'
  | 'onToggleSketchVisibility'
  | 'onFeatureContextMenu'
  | 'onToggleFeatureSuppression'
  | 'onRollbackAfterFeature'
  | 'onResumeHistory'
  | 'onReorderFeature'
  | 'reorderBusy'
  | 'onRenameFeature'
  | 'onDeleteFeatures'
> & { find: HistoryFind };

export function HistoryPanel({
  features,
  localAppend,
  representations,
  failedFeatureIds,
  relatedFeatureIds,
  geometryPending = false,
  geometryPendingShown = geometryPending,
  selectedFeatureNodeId,
  hiddenBodyIds,
  hiddenSketchIds,
  document,
  parameterValues,
  units,
  historyDetails,
  pendingHistoryStep,
  editingHistoryFeatureId,
  onSelectFeature,
  onToggleBodyVisibility,
  onToggleSketchVisibility,
  onFeatureContextMenu,
  onToggleFeatureSuppression,
  onRollbackAfterFeature,
  onResumeHistory,
  onReorderFeature,
  reorderBusy,
  onRenameFeature,
  onDeleteFeatures,
  find
}: HistoryPanelProps) {
  const builtOnFailed = useMemo(
    () =>
      document && failedFeatureIds
        ? builtOnFailedFeatures(document, failedFeatureIds)
        : undefined,
    [document, failedFeatureIds]
  );
  return (
    <>
      <HistoryTimeline
        key={document?.projectId}
        features={features}
        localAppend={localAppend}
        representations={representations}
        failedFeatureIds={failedFeatureIds}
        builtOnFailedFeatures={builtOnFailed}
        relatedFeatureIds={relatedFeatureIds}
        geometryPending={geometryPending}
        geometryPendingShown={geometryPendingShown}
        selectedFeatureNodeId={selectedFeatureNodeId}
        hiddenBodyIds={hiddenBodyIds}
        hiddenSketchIds={hiddenSketchIds}
        brokenProjectionSketchIds={
          document ? sketchesWithBrokenProjections(document) : undefined
        }
        parameterValues={parameterValues}
        units={units}
        pendingStep={pendingHistoryStep ?? null}
        editingFeatureId={editingHistoryFeatureId ?? null}
        findOpen={find.open}
        onCloseFind={find.close}
        onSelectFeature={onSelectFeature}
        onToggleBodyVisibility={onToggleBodyVisibility}
        onToggleSketchVisibility={onToggleSketchVisibility}
        onFeatureContextMenu={onFeatureContextMenu}
        onToggleFeatureSuppression={onToggleFeatureSuppression}
        onRollbackAfterFeature={onRollbackAfterFeature}
        onResumeHistory={onResumeHistory}
        onReorderFeature={onReorderFeature}
        reorderBusy={reorderBusy}
        onRenameFeature={onRenameFeature}
        onDeleteFeatures={onDeleteFeatures}
      />
      {/* Below the list, so selecting a row never pushes the rows down. */}
      {historyDetails}
    </>
  );
}
