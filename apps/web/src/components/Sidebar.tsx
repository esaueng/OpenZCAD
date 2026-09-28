import type { DiagnosticRow } from '../lib/diagnosticsRows';
import { useState, type ReactNode } from 'react';
import { useArrivals } from '../hooks/useArrivals';
import {
  AlertTriangle,
  Box,
  ChevronRight,
  Combine,
  Eye,
  EyeOff,
  FileBox,
  GitBranch,
  History,
  Layers,
  Move3d,
  PenLine,
  RotateCw,
  Search
} from 'lucide-react';
import { isFeatureRollbackSuppressed } from '@openzcad/shared';
import type {
  BodyId,
  BodyRepresentation,
  FeatureId,
  FeatureNode,
  ParameterNode,
  ProjectCheckpoint,
  UnitSystem
} from '@openzcad/shared';
import type { PanelState, SidebarSectionId } from '../lib/panelState';
import { HistoryTimeline } from './HistoryTimeline';
import { AddParameterRow, ParameterRow } from './ParameterRows';

/**
 * One collapsible browser section. The count is on the header so a collapsed
 * section still says how much it is hiding — otherwise collapsing loses
 * information rather than just space.
 */
function SidebarSection({
  id,
  title,
  count,
  open,
  className,
  summary,
  actions,
  onToggle,
  children
}: {
  id: SidebarSectionId;
  title: string;
  count: number | null;
  open: boolean;
  className?: string;
  /**
   * What the header shows instead of the count while collapsed — the
   * History line, which says where in the history the model sits and not
   * just how long the history is.
   */
  summary?: ReactNode;
  /** Controls beside the header, outside its toggle button. */
  actions?: ReactNode;
  onToggle(id: SidebarSectionId): void;
  children: ReactNode;
}) {
  const showSummary = !open && summary !== undefined;
  const header = (
    <button
      type="button"
      className="section-title"
      aria-expanded={open}
      onClick={() => onToggle(id)}
      title={open ? `Collapse ${title}` : `Expand ${title}`}
    >
      <ChevronRight
        size={12}
        className="disclosure-chevron"
        aria-hidden="true"
      />
      <span>{title}</span>
      {showSummary && summary}
      {!showSummary && count !== null && count > 0 && (
        <small className="section-count">{count}</small>
      )}
    </button>
  );
  return (
    <section
      className={`sidebar-section${className ? ` ${className}` : ''}${open ? '' : ' collapsed'}`}
    >
      {actions ? (
        <div className="section-head">
          {header}
          {actions}
        </div>
      ) : (
        header
      )}
      {open && children}
    </section>
  );
}

interface SidebarProps {
  parameters: ParameterNode[];
  parameterValues: Record<string, number>;
  features: FeatureNode[];
  representations: Record<string, BodyRepresentation>;
  selectedFeatureNodeId: string | null;
  selectedBodyIds: string[];
  hiddenBodyIds: ReadonlySet<string>;
  /** Sketches currently hidden — consumed by default, or by the eye toggle. */
  hiddenSketchIds: ReadonlySet<string>;
  warnings: DiagnosticRow[];
  historyDetails?: ReactNode;
  checkpoints: ProjectCheckpoint[];
  /** The open document's version, to mark the save point it sits on. */
  documentVersion: number;
  /**
   * Checkpoints whose model can actually be opened, from this device or the
   * account. The rest are listed as history without an action.
   */
  restorableCheckpointIds: ReadonlySet<string>;
  onSelectFeature(nodeId: string): void;
  onSelectBody(bodyId: string, additive: boolean): void;
  onToggleBodyVisibility(bodyId: string): void;
  onToggleSketchVisibility(sketchId: string): void;
  /** Opens the feature menu at a point: a right-click, or a row's ⋯ button. */
  onFeatureContextMenu(
    at: { clientX: number; clientY: number },
    feature: FeatureNode
  ): void;
  onToggleFeatureSuppression(feature: FeatureNode): void;
  onRollbackAfterFeature(featureId: FeatureId, name: string): void;
  onResumeHistory(): void;
  /** The document's length unit, for the value each history row shows. */
  units: UnitSystem;
  onConfigureToggle?: (name: string, bodyIds: BodyId[]) => void;
  onPreviewParameter?(name: string, expression: string | null): void;
  onSetParameter(
    name: string,
    expression: string
  ): void | Promise<string | null>;
  onViewActivityLog(): void;
  parameterMinimums?: Record<string, number>;
  onDeleteParameter(name: string): void;
  onRenameParameter(name: string, newName: string): string | null;
  onExposeParameter(name: string, exposed: boolean): void;
  onDescribeParameter(name: string, description: string): void;
  /** Names currently offered in Tweak, from `listExposedParameters`. */
  exposedParameterNames: ReadonlySet<string>;
  onReorderFeature(featureId: FeatureId, toIndex: number): void;
  onRestoreCheckpoint(checkpoint: ProjectCheckpoint): void;
  onBranchCheckpoint(checkpoint: ProjectCheckpoint): void;
  panelState: PanelState;
  onToggleSection(id: SidebarSectionId): void;
  /** Closes the drawer; a double-click on its empty space calls it. */
  onClose?(): void;
}

/**
 * Double-clicks that belong to something inside the drawer — a row, a field,
 * a header — rather than to the drawer itself. Rows are listed as well as
 * controls so a fast double-select on a feature never closes the drawer.
 */
const DOUBLE_CLICK_OWNERS =
  'button, a, input, textarea, select, label, summary, [contenteditable], [role="listitem"], [role="button"], [role="slider"], .feature-row, .body-row, .revision-row, .diagnostic-row, .param-row, .history-rollback';

/** Body kind icons mirror the feature icons so the two lists read as one. */
function bodyIcon(body: BodyRepresentation) {
  const size = 13;
  switch (body.source) {
    case 'primitive':
      return <Box size={size} aria-hidden="true" />;
    case 'sketch':
      return <PenLine size={size} aria-hidden="true" />;
    case 'extrude':
      return <Layers size={size} aria-hidden="true" />;
    case 'revolve':
      return <RotateCw size={size} aria-hidden="true" />;
    case 'boolean':
      return <Combine size={size} aria-hidden="true" />;
    case 'transform':
      return <Move3d size={size} aria-hidden="true" />;
    default:
      return <FileBox size={size} aria-hidden="true" />;
  }
}

/** How long a new row keeps `.is-arrival`: its accent wash drains in 900ms. */
const ARRIVAL_MS = 900;

export function Sidebar({
  parameters,
  parameterValues,
  parameterMinimums,
  features,
  representations,
  selectedFeatureNodeId,
  selectedBodyIds,
  hiddenBodyIds,
  hiddenSketchIds,
  warnings,
  historyDetails,
  checkpoints,
  documentVersion,
  restorableCheckpointIds,
  onSelectFeature,
  onSelectBody,
  onToggleBodyVisibility,
  onToggleSketchVisibility,
  onFeatureContextMenu,
  onToggleFeatureSuppression,
  onRollbackAfterFeature,
  onResumeHistory,
  units,
  onConfigureToggle,
  onSetParameter,
  onViewActivityLog,
  onPreviewParameter,
  onDeleteParameter,
  onRenameParameter,
  onExposeParameter,
  onDescribeParameter,
  exposedParameterNames,
  onReorderFeature,
  onRestoreCheckpoint,
  onBranchCheckpoint,
  panelState,
  onToggleSection,
  onClose
}: SidebarProps) {
  const [findOpen, setFindOpen] = useState(false);
  const [showConsumed, setShowConsumed] = useState(false);
  // Bodies in feature-history order so the tree matches the timeline below.
  const bodies: BodyRepresentation[] = [];
  const seen = new Set<string>();
  for (const feature of features) {
    if (feature.bodyId && !seen.has(feature.bodyId)) {
      const body = representations[feature.bodyId];
      if (body) {
        seen.add(feature.bodyId);
        bodies.push(body);
      }
    }
  }
  for (const body of Object.values(representations)) {
    if (!seen.has(body.bodyId)) {
      seen.add(body.bodyId);
      bodies.push(body);
    }
  }
  // Consumed bodies live behind a disclosure row: in a model built from
  // booleans nearly every body is an input to a later feature, and a list
  // that is mostly dead entries buries the ones that still exist.
  const bodyArrivals = useArrivals(
    bodies.map((body) => body.bodyId),
    ARRIVAL_MS
  );
  const liveBodies = bodies.filter((body) => !body.consumed);
  const consumedBodies = bodies.filter((body) => body.consumed);

  function renderBodyRow(body: BodyRepresentation) {
    const hidden = hiddenBodyIds.has(body.bodyId);
    const selected = selectedBodyIds.includes(body.bodyId);
    return (
      <div
        key={body.bodyId}
        className={`body-row ${selected ? 'selected' : ''} ${body.consumed ? 'consumed' : ''} ${hidden ? 'hidden-body' : ''}${bodyArrivals.has(body.bodyId) ? ' is-arrival' : ''}`}
        role="listitem"
      >
        <button
          type="button"
          className="body-row-main"
          aria-pressed={selected}
          title={`${body.name}${body.consumed ? ' — combined into a later feature' : ''} — click to select, ⇧click to add`}
          onClick={(event) =>
            onSelectBody(
              body.bodyId,
              event.shiftKey || event.metaKey || event.ctrlKey
            )
          }
        >
          <span className="feature-icon">{bodyIcon(body)}</span>
          <span className="feature-name">{body.name}</span>
        </button>
        {!body.consumed && (
          <button
            type="button"
            className={`row-visibility ${hidden ? 'is-hidden' : ''}`}
            title={hidden ? `Show body ${body.name}` : `Hide body ${body.name}`}
            aria-label={
              hidden ? `Show body ${body.name}` : `Hide body ${body.name}`
            }
            aria-pressed={hidden}
            onClick={() => onToggleBodyVisibility(body.bodyId)}
          >
            {hidden ? (
              <EyeOff size={12} aria-hidden="true" />
            ) : (
              <Eye size={12} aria-hidden="true" />
            )}
          </button>
        )}
      </div>
    );
  }

  const rollbackMarkerIndex = features.findIndex(
    (feature, index) =>
      index < features.length - 1 &&
      !isFeatureRollbackSuppressed(feature) &&
      features
        .slice(index + 1)
        .every((candidate) => isFeatureRollbackSuppressed(candidate))
  );
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
  const historyScrub = activeFeature ? (
    <span
      className="history-scrub"
      title={`Step ${activeFeatureIndex + 1} of ${features.length}: ${activeFeature.name}`}
    >
      <span className="history-scrub-count">
        {features.length} {features.length === 1 ? 'feature' : 'features'}
      </span>
      <span className="history-scrub-name">
        {' · '}
        {rolledBack ? 'rolled back to ' : 'at '}
        {activeFeature.name}
      </span>
      <span className="visually-hidden">
        {`, step ${activeFeatureIndex + 1} of ${features.length}`}
      </span>
    </span>
  ) : undefined;
  return (
    <aside
      className="sidebar"
      aria-label="Model browser"
      onDoubleClick={(event) => {
        if (
          onClose &&
          event.target instanceof Element &&
          !event.target.closest(DOUBLE_CLICK_OWNERS)
        ) {
          onClose();
        }
      }}
    >
      <SidebarSection
        id="parameters"
        title="Parameters"
        count={parameters.length}
        open={panelState.sidebarSections.parameters}
        onToggle={onToggleSection}
      >
        <div className="param-list">
          {parameters.map((parameter) => (
            <ParameterRow
              key={parameter.parameterId}
              parameter={parameter}
              value={parameterValues[parameter.name]}
              minimum={parameterMinimums?.[parameter.name]}
              onSet={onSetParameter}
              onViewDetails={onViewActivityLog}
              onPreview={onPreviewParameter}
              onDelete={onDeleteParameter}
              onRename={onRenameParameter}
              onExpose={onExposeParameter}
              exposedInTweak={exposedParameterNames.has(parameter.name)}
              onDescribe={onDescribeParameter}
              bodies={liveBodies}
              onConfigureToggle={onConfigureToggle}
            />
          ))}
          <AddParameterRow
            onSet={onSetParameter}
            onConfigureToggle={onConfigureToggle}
            bodies={liveBodies}
          />
        </div>
        {parameters.length === 0 && (
          <p className="muted sidebar-hint">
            Name a value (<span className="mono">w = 30</span>) and use it in
            any feature field.
          </p>
        )}
      </SidebarSection>

      <SidebarSection
        id="bodies"
        title="Bodies"
        count={liveBodies.length}
        open={panelState.sidebarSections.bodies}
        onToggle={onToggleSection}
      >
        <div className="feature-list" role="list" aria-label="Bodies">
          {bodies.length === 0 && (
            <p className="muted sidebar-hint">
              No bodies yet. Create a primitive or extrude a sketch.
            </p>
          )}
          {liveBodies.map(renderBodyRow)}
          {consumedBodies.length > 0 && (
            <button
              type="button"
              className="consumed-toggle"
              aria-expanded={showConsumed}
              onClick={() => setShowConsumed((current) => !current)}
              title={
                showConsumed
                  ? 'Hide the earlier bodies this model was built from'
                  : 'Show the earlier bodies this model was built from — each was combined into a later feature and is no longer separate'
              }
            >
              <ChevronRight
                size={11}
                className="disclosure-chevron"
                aria-hidden="true"
              />
              <span>
                {consumedBodies.length} source{' '}
                {consumedBodies.length === 1 ? 'body' : 'bodies'}
              </span>
            </button>
          )}
          {showConsumed && consumedBodies.map(renderBodyRow)}
        </div>
      </SidebarSection>

      <SidebarSection
        id="history"
        title="History"
        count={features.length}
        open={panelState.sidebarSections.history}
        className="grow"
        {...(historyScrub !== undefined ? { summary: historyScrub } : {})}
        actions={
          panelState.sidebarSections.history && features.length > 0 ? (
            <button
              type="button"
              className="history-find-toggle"
              title="Find a step"
              aria-label="Find a step"
              aria-pressed={findOpen}
              onClick={() => setFindOpen((open) => !open)}
            >
              <Search size={12} aria-hidden="true" />
            </button>
          ) : undefined
        }
        onToggle={onToggleSection}
      >
        <HistoryTimeline
          features={features}
          representations={representations}
          selectedFeatureNodeId={selectedFeatureNodeId}
          hiddenBodyIds={hiddenBodyIds}
          hiddenSketchIds={hiddenSketchIds}
          parameterValues={parameterValues}
          units={units}
          findOpen={findOpen}
          onCloseFind={() => setFindOpen(false)}
          onSelectFeature={onSelectFeature}
          onToggleBodyVisibility={onToggleBodyVisibility}
          onToggleSketchVisibility={onToggleSketchVisibility}
          onFeatureContextMenu={onFeatureContextMenu}
          onToggleFeatureSuppression={onToggleFeatureSuppression}
          onRollbackAfterFeature={onRollbackAfterFeature}
          onResumeHistory={onResumeHistory}
          onReorderFeature={onReorderFeature}
        />
        {/* Below the list, so selecting a row never pushes the rows down. */}
        {historyDetails}
      </SidebarSection>

      {checkpoints.length > 0 && (
        <SidebarSection
          id="revisions"
          title="Revisions"
          count={checkpoints.length}
          open={panelState.sidebarSections.revisions}
          className="revisions"
          onToggle={onToggleSection}
        >
          <div className="revision-list">
            {[...checkpoints].reverse().map((checkpoint, index) => {
              // The save point the open document is currently sitting on.
              // Offering to restore what is already loaded would be a no-op
              // dressed up as an action.
              const isCurrent = checkpoint.documentVersion === documentVersion;
              const stored = restorableCheckpointIds.has(
                checkpoint.checkpointId
              );
              return (
                <div
                  key={checkpoint.checkpointId}
                  className={`revision-row ${index === 0 ? 'latest' : ''}`}
                  title={`${checkpoint.reason} · document v${checkpoint.documentVersion} · ${new Date(checkpoint.createdAt).toLocaleString()}`}
                >
                  <span className="revision-dot" aria-hidden="true" />
                  <span className="revision-reason">{checkpoint.reason}</span>
                  <small className="revision-time mono">
                    {new Date(checkpoint.createdAt).toLocaleDateString()}
                  </small>
                  {stored ? (
                    <span className="revision-actions">
                      {!isCurrent && (
                        <button
                          type="button"
                          className="revision-action"
                          title={`Restore “${checkpoint.reason}”. This is one Undo away, and the current state is saved first.`}
                          aria-label={`Restore ${checkpoint.reason}`}
                          onClick={() => onRestoreCheckpoint(checkpoint)}
                        >
                          <History size={12} aria-hidden="true" />
                        </button>
                      )}
                      <button
                        type="button"
                        className="revision-action"
                        title={`Branch “${checkpoint.reason}” into a new project. This project is left as it is.`}
                        aria-label={`Branch ${checkpoint.reason} into a new project`}
                        onClick={() => onBranchCheckpoint(checkpoint)}
                      >
                        <GitBranch size={12} aria-hidden="true" />
                      </button>
                    </span>
                  ) : (
                    // Retention drops stored documents while the checkpoints
                    // naming them stay in the document, so some rows are a
                    // record of a save rather than a save you can open. Saying
                    // so beats a button that fails when pressed.
                    <span
                      className="revision-unavailable"
                      title="This save is listed in the project's history, but its model is no longer stored."
                    >
                      not stored
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        </SidebarSection>
      )}

      {warnings.length > 0 && (
        <SidebarSection
          id="diagnostics"
          title="Diagnostics"
          count={warnings.length}
          open={panelState.sidebarSections.diagnostics}
          className="diagnostics"
          onToggle={onToggleSection}
        >
          {warnings.map((warning) => (
            <p
              key={warning.key}
              className="diagnostic-row"
              title={warning.detail}
            >
              <AlertTriangle size={12} aria-hidden="true" />
              <span>
                {warning.featureName ? (
                  <strong>{warning.featureName}: </strong>
                ) : null}
                {warning.message}
              </span>
            </p>
          ))}
        </SidebarSection>
      )}
    </aside>
  );
}
