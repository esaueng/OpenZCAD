import { Search } from 'lucide-react';
import type { FeatureNode } from '@openzcad/shared';
import { HistoryTimeline } from '../HistoryTimeline';
import type { ModelPanelSource } from './modelPanelProps';
import type { HistoryFind } from './panelViews';
import { sketchesWithBrokenProjections } from '../../lib/sketch/projection';

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
  | 'representations'
  | 'failedFeatureIds'
  | 'relatedFeatureIds'
  | 'geometryPending'
  | 'selectedFeatureNodeId'
  | 'hiddenBodyIds'
  | 'hiddenSketchIds'
  | 'document'
  | 'parameterValues'
  | 'units'
  | 'historyDetails'
  | 'onSelectFeature'
  | 'onToggleBodyVisibility'
  | 'onToggleSketchVisibility'
  | 'onFeatureContextMenu'
  | 'onToggleFeatureSuppression'
  | 'onRollbackAfterFeature'
  | 'onResumeHistory'
  | 'onReorderFeature'
  | 'onRenameFeature'
> & { find: HistoryFind };

export function HistoryPanel({
  features,
  representations,
  failedFeatureIds,
  relatedFeatureIds,
  geometryPending = false,
  selectedFeatureNodeId,
  hiddenBodyIds,
  hiddenSketchIds,
  document,
  parameterValues,
  units,
  historyDetails,
  onSelectFeature,
  onToggleBodyVisibility,
  onToggleSketchVisibility,
  onFeatureContextMenu,
  onToggleFeatureSuppression,
  onRollbackAfterFeature,
  onResumeHistory,
  onReorderFeature,
  onRenameFeature,
  find
}: HistoryPanelProps) {
  return (
    <>
      <HistoryTimeline
        features={features}
        representations={representations}
        failedFeatureIds={failedFeatureIds}
        relatedFeatureIds={relatedFeatureIds}
        geometryPending={geometryPending}
        selectedFeatureNodeId={selectedFeatureNodeId}
        hiddenBodyIds={hiddenBodyIds}
        hiddenSketchIds={hiddenSketchIds}
        brokenProjectionSketchIds={
          document ? sketchesWithBrokenProjections(document) : undefined
        }
        parameterValues={parameterValues}
        units={units}
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
        onRenameFeature={onRenameFeature}
      />
      {/* Below the list, so selecting a row never pushes the rows down. */}
      {historyDetails}
    </>
  );
}
