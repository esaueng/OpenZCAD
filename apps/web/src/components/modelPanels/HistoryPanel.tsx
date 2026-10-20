import { useRef, useState, type RefObject } from 'react';
import { Search } from 'lucide-react';
import type { FeatureNode } from '@openzcad/shared';
import { HistoryTimeline } from '../HistoryTimeline';
import type { ModelPanelSource } from './modelPanelProps';

/**
 * The History step search: whether the field is open, and the header toggle
 * that opens it. The panel's frame holds it, because the toggle sits in the
 * header rather than the body.
 */
export interface HistoryFind {
  open: boolean;
  toggleRef: RefObject<HTMLButtonElement | null>;
  toggle(): void;
  close(): void;
}

export function useHistoryFind(): HistoryFind {
  const [findOpen, setFindOpen] = useState(false);
  const findToggleRef = useRef<HTMLButtonElement>(null);
  return {
    open: findOpen,
    toggleRef: findToggleRef,
    toggle: () => setFindOpen((open) => !open),
    close: () => {
      setFindOpen(false);
      // The field unmounts with focus in it; hand focus back to the
      // toggle that opened it rather than dropping it on the page.
      findToggleRef.current?.focus();
    }
  };
}

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
