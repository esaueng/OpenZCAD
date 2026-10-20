import { useRef, useState, type ReactNode, type RefObject } from 'react';
import { Search } from 'lucide-react';
import type { FeatureNode } from '@openzcad/shared';
import { findRollbackMarkerIndex, HistoryTimeline } from '../HistoryTimeline';
import type { SidebarProps } from '../Sidebar';

/**
 * The History step search: whether the field is open, and the header toggle
 * that opens it. The composer holds it, because the toggle sits in the
 * panel's header rather than its body.
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

/**
 * The header's Find toggle. The composer shows it only while the list is
 * open and has something to find.
 */
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

/**
 * The one-line header summary, or undefined for an empty history: how many
 * features there are and where the history sits.
 */
export function historyScrub({
  features,
  selectedFeatureNodeId
}: Pick<SidebarProps, 'features' | 'selectedFeatureNodeId'>): ReactNode {
  const rollbackMarkerIndex = findRollbackMarkerIndex(features);
  // The feature the scrub strip points at: the selected one, else the last
  // one still in the build (the rollback marker), else the newest.
  const activeFeatureIndex =
    features.length === 0
      ? -1
      : selectedFeatureNodeId !== null &&
          features.some((feature) => feature.id === selectedFeatureNodeId)
        ? features.findIndex((feature) => feature.id === selectedFeatureNodeId)
        : rollbackMarkerIndex >= 0
          ? rollbackMarkerIndex
          : features.length - 1;
  const activeFeature =
    activeFeatureIndex >= 0 ? features[activeFeatureIndex] : undefined;
  // Collapsed, History reads as one line of plain text: how many features
  // there are and which one the history is at — the selected one, the
  // rollback marker, or the newest. The name takes the ellipsis; the count
  // never does. The position rides the tooltip and the accessible name.
  const rolledBack =
    rollbackMarkerIndex >= 0 &&
    activeFeatureIndex === rollbackMarkerIndex &&
    selectedFeatureNodeId !== activeFeature?.id;
  return activeFeature ? (
    <span
      className="history-scrub"
      title={`Step ${activeFeatureIndex + 1} of ${features.length}: ${activeFeature.name}`}
    >
      <span className="history-scrub-count">
        {features.length} {features.length === 1 ? 'feature' : 'features'}
      </span>
      <span className="history-scrub-name">
        {/* A plain leading space collapses at the start of a flex item. */}
        {' · '}
        {rolledBack ? 'rolled back to ' : 'at '}
        {activeFeature.name}
      </span>
      <span className="visually-hidden">
        {`, step ${activeFeatureIndex + 1} of ${features.length}`}
      </span>
    </span>
  ) : undefined;
}

export type HistoryPanelProps = Pick<
  SidebarProps,
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
