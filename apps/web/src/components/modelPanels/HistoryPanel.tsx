import { useCallback, useMemo, useState } from 'react';
import { AlertTriangle, Search } from 'lucide-react';
import { isFeatureSuppressed } from '@openzcad/shared';
import type { FeatureId, FeatureNode } from '@openzcad/shared';
import { HistoryTimeline, type HistoryRevealRequest } from '../HistoryTimeline';
import type { ModelPanelSource } from './modelPanelProps';
import type { HistoryFind } from './panelViews';
import { sketchesWithBrokenProjections } from '../../lib/sketch/projection';
import {
  failedStepsInRepairOrder,
  failureLineage,
  featureNeedsRepair
} from '../../lib/featureRepair';

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

/**
 * What the History panel knows about the rebuild's failures, shared by the
 * list's rows and the header's repair chip so both name the same steps.
 */
export interface HistoryRepair {
  /** Each step with a failed step upstream, and the earliest such step. */
  lineage: ReadonlyMap<FeatureId, FeatureNode>;
  /** The steps that need repair: first failures, then the rest, in order. */
  order: readonly FeatureNode[];
  /** Steps that built, but on a failed step's unchanged input. */
  builtOnFailedCount: number;
  reveal: HistoryRevealRequest | null;
  requestReveal(nodeId: string): void;
}

export function useHistoryRepair({
  features,
  representations,
  failedFeatureIds,
  geometryPending = false,
  document
}: Pick<
  ModelPanelSource,
  | 'features'
  | 'representations'
  | 'failedFeatureIds'
  | 'geometryPending'
  | 'document'
>): HistoryRepair {
  const [reveal, setReveal] = useState<HistoryRevealRequest | null>(null);
  const requestReveal = useCallback(
    (nodeId: string) =>
      setReveal((current) => ({ nodeId, seq: (current?.seq ?? 0) + 1 })),
    []
  );
  const verdict = useMemo(() => {
    // Pending geometry has no verdict yet: nothing is called broken, as on
    // the rows.
    const needsRepair = new Set<FeatureId>(
      geometryPending
        ? []
        : features
            .filter((feature) =>
              featureNeedsRepair(feature, representations, failedFeatureIds)
            )
            .map((feature) => feature.featureId)
    );
    const lineage = document
      ? failureLineage(document, needsRepair)
      : new Map<FeatureId, FeatureNode>();
    return {
      lineage,
      order: failedStepsInRepairOrder(features, needsRepair, lineage),
      builtOnFailedCount: features.filter(
        (feature) =>
          lineage.has(feature.featureId) &&
          !needsRepair.has(feature.featureId) &&
          !isFeatureSuppressed(feature)
      ).length
    };
  }, [features, representations, failedFeatureIds, geometryPending, document]);
  return { ...verdict, reveal, requestReveal };
}

/** "1 step needs repair" / "4 steps need repair". */
function stepsNeedRepair(count: number): string {
  return count === 1 ? '1 step needs repair' : `${count} steps need repair`;
}

/**
 * The header's summary of what needs repair, shown only while something
 * does. Each press selects the next step to fix — the first failures, then
 * those that failed after them — and wraps, so the edit card and History
 * details for each are one press away. A plain button: no live region, so
 * the list's own status lines are what is announced.
 */
export function HistoryRepairChip({
  repair,
  selectedFeatureNodeId,
  onSelectFeature
}: {
  repair: HistoryRepair;
  selectedFeatureNodeId: string | null;
  onSelectFeature(nodeId: string): void;
}) {
  const { order, builtOnFailedCount } = repair;
  if (order.length === 0) return null;
  const at = order.findIndex((feature) => feature.id === selectedFeatureNodeId);
  const next = order[(at + 1) % order.length]!;
  const summary = stepsNeedRepair(order.length);
  const builtOn =
    builtOnFailedCount === 0
      ? ''
      : ` ${builtOnFailedCount} later ${builtOnFailedCount === 1 ? 'step' : 'steps'} built on a failed step.`;
  return (
    <button
      type="button"
      className="history-repair-chip"
      aria-label={`${summary}. Show ${next.name}`}
      title={`${summary}.${builtOn} Show ${next.name}.`}
      onClick={() => {
        // Selecting the selected step would clear it: only bring it back
        // into view.
        if (next.id !== selectedFeatureNodeId) onSelectFeature(next.id);
        repair.requestReveal(next.id);
      }}
    >
      <AlertTriangle size={12} aria-hidden="true" />
      <span className="mono">{order.length}</span>
      <span className="history-repair-chip-label">
        {order.length === 1 ? 'needs repair' : 'need repair'}
      </span>
    </button>
  );
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
> & { find: HistoryFind; repair: HistoryRepair };

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
  find,
  repair
}: HistoryPanelProps) {
  return (
    <>
      <HistoryTimeline
        key={document?.projectId}
        features={features}
        localAppend={localAppend}
        representations={representations}
        failedFeatureIds={failedFeatureIds}
        failureLineage={repair.lineage}
        revealRequest={repair.reveal}
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
