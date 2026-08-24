import { useState, type ReactNode } from 'react';
import {
  AlertTriangle,
  Box,
  ChevronDown,
  ChevronRight,
  CirclePause,
  CirclePlay,
  Combine,
  Cone,
  Cylinder,
  Eye,
  EyeOff,
  FileBox,
  GitBranch,
  Globe,
  GripVertical,
  History,
  Layers,
  Move3d,
  PenLine,
  RotateCw,
  Torus,
  Trash2
} from 'lucide-react';
import {
  isFeatureRollbackSuppressed,
  isFeatureSuppressed
} from '@openzcad/shared';
import type {
  BodyRepresentation,
  FeatureId,
  FeatureNode,
  ParameterNode,
  ProjectCheckpoint
} from '@openzcad/shared';
import { FEATURE_KIND_LABELS } from '../lib/model';
import type { PanelState, SidebarSectionId } from '../lib/panelState';
import { AddParameterRow, ParameterRow } from './ParameterRows';

function featureIcon(feature: FeatureNode) {
  const size = 13;
  if (feature.data.featureKind === 'primitive') {
    switch (feature.data.primitiveKind) {
      case 'box':
        return <Box size={size} aria-hidden="true" />;
      case 'cylinder':
        return <Cylinder size={size} aria-hidden="true" />;
      case 'sphere':
        return <Globe size={size} aria-hidden="true" />;
      case 'cone':
        return <Cone size={size} aria-hidden="true" />;
      case 'torus':
        return <Torus size={size} aria-hidden="true" />;
    }
  }
  switch (feature.featureKind) {
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
  onToggle,
  children
}: {
  id: SidebarSectionId;
  title: string;
  count: number | null;
  open: boolean;
  className?: string;
  onToggle(id: SidebarSectionId): void;
  children: ReactNode;
}) {
  return (
    <section
      className={`sidebar-section${className ? ` ${className}` : ''}${open ? '' : ' collapsed'}`}
    >
      <button
        type="button"
        className="section-title"
        aria-expanded={open}
        onClick={() => onToggle(id)}
        title={open ? `Collapse ${title}` : `Expand ${title}`}
      >
        {open ? (
          <ChevronDown size={12} aria-hidden="true" />
        ) : (
          <ChevronRight size={12} aria-hidden="true" />
        )}
        <span>{title}</span>
        {count !== null && count > 0 && (
          <small className="section-count">{count}</small>
        )}
      </button>
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
  warnings: string[];
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
  onFeatureContextMenu(event: React.MouseEvent, feature: FeatureNode): void;
  onToggleFeatureSuppression(feature: FeatureNode): void;
  onRollbackAfterFeature(featureId: FeatureId, name: string): void;
  onSetParameter(name: string, expression: string): void;
  onDeleteParameter(name: string): void;
  onExposeParameter(name: string, exposed: boolean): void;
  onDescribeParameter(name: string, description: string): void;
  /** Names currently offered in Tweak, from `listExposedParameters`. */
  exposedParameterNames: ReadonlySet<string>;
  onDeleteFeature(featureId: FeatureId, name: string): void;
  onReorderFeature(featureId: FeatureId, toIndex: number): void;
  onRestoreCheckpoint(checkpoint: ProjectCheckpoint): void;
  onBranchCheckpoint(checkpoint: ProjectCheckpoint): void;
  panelState: PanelState;
  onToggleSection(id: SidebarSectionId): void;
}

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

export function Sidebar({
  parameters,
  parameterValues,
  features,
  representations,
  selectedFeatureNodeId,
  selectedBodyIds,
  hiddenBodyIds,
  warnings,
  checkpoints,
  documentVersion,
  restorableCheckpointIds,
  onSelectFeature,
  onSelectBody,
  onToggleBodyVisibility,
  onFeatureContextMenu,
  onToggleFeatureSuppression,
  onRollbackAfterFeature,
  onSetParameter,
  onDeleteParameter,
  onExposeParameter,
  onDescribeParameter,
  exposedParameterNames,
  onDeleteFeature,
  onReorderFeature,
  onRestoreCheckpoint,
  onBranchCheckpoint,
  panelState,
  onToggleSection
}: SidebarProps) {
  // Drag-to-reorder state for the history timeline (StartScreen's pattern).
  const [dragFeatureId, setDragFeatureId] = useState<string | null>(null);
  const [dropFeatureId, setDropFeatureId] = useState<string | null>(null);
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
  const liveBodies = bodies.filter((body) => !body.consumed);
  const consumedBodies = bodies.filter((body) => body.consumed);

  function renderBodyRow(body: BodyRepresentation) {
    const hidden = hiddenBodyIds.has(body.bodyId);
    const selected = selectedBodyIds.includes(body.bodyId);
    return (
      <div
        key={body.bodyId}
        className={`body-row ${selected ? 'selected' : ''} ${body.consumed ? 'consumed' : ''} ${hidden ? 'hidden-body' : ''}`}
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
            aria-label={hidden ? `Show body ${body.name}` : `Hide body ${body.name}`}
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
  return (
    <aside className="sidebar" aria-label="Model browser">
      <div className="sidebar-label">Model</div>
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
              onSet={onSetParameter}
              onDelete={onDeleteParameter}
              onExpose={onExposeParameter}
              exposedInTweak={exposedParameterNames.has(parameter.name)}
              onDescribe={onDescribeParameter}
            />
          ))}
          <AddParameterRow onSet={onSetParameter} />
        </div>
        {parameters.length === 0 && (
          <p className="muted sidebar-hint">
            Name a value here (e.g. <span className="mono">w = 30</span>), then
            use it in any feature field.
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
              {showConsumed ? (
                <ChevronDown size={11} aria-hidden="true" />
              ) : (
                <ChevronRight size={11} aria-hidden="true" />
              )}
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
        onToggle={onToggleSection}
      >
        <div className="feature-list">
          {features.length === 0 && (
            <p className="muted sidebar-hint">
              {/* Names the rail, and deliberately does not say where it is:
                  it sits right of this panel on a wide screen, but under
                  620px the workspace stacks into one column (responsive.css)
                  and the rail lands below instead. "Above" was wrong at every
                  width; a direction would be wrong at one of them. */}
              No features yet. Pick a tool from the Feature tools rail.
            </p>
          )}
          {features.map((feature, index) => {
            const suppressed = isFeatureSuppressed(feature);
            const body = feature.bodyId
              ? representations[feature.bodyId]
              : undefined;
            const consumed = body?.consumed ?? false;
            const hidden = feature.bodyId
              ? hiddenBodyIds.has(feature.bodyId)
              : false;
            const failed =
              !suppressed &&
              feature.bodyId !== undefined &&
              feature.featureKind !== 'sketch' &&
              body === undefined;
            return (
              <div
                key={feature.id}
                className={`feature-row ${selectedFeatureNodeId === feature.id ? 'selected' : ''} ${consumed ? 'consumed' : ''} ${hidden ? 'hidden-body' : ''} ${suppressed ? 'suppressed' : ''} ${rollbackMarkerIndex === index ? 'rollback-marker' : ''} ${dragFeatureId === feature.featureId ? 'is-dragging' : ''} ${dropFeatureId === feature.featureId ? 'is-drop-target' : ''}`}
                onContextMenu={(event) => {
                  event.preventDefault();
                  onFeatureContextMenu(event, feature);
                }}
                onDragOver={(event) => {
                  if (!dragFeatureId || dragFeatureId === feature.featureId) {
                    return;
                  }
                  event.preventDefault();
                  event.dataTransfer.dropEffect = 'move';
                  setDropFeatureId(feature.featureId);
                }}
                onDragLeave={() => {
                  setDropFeatureId((current) =>
                    current === feature.featureId ? null : current
                  );
                }}
                onDrop={(event) => {
                  if (!dragFeatureId) {
                    return;
                  }
                  event.preventDefault();
                  onReorderFeature(dragFeatureId as FeatureId, index);
                  setDragFeatureId(null);
                  setDropFeatureId(null);
                }}
              >
                <button
                  type="button"
                  className="row-action feature-row-grip"
                  aria-label={`Reorder ${feature.name}. Use the arrow keys to move it.`}
                  title="Drag to reorder"
                  draggable
                  onDragStart={(event) => {
                    event.dataTransfer.effectAllowed = 'move';
                    event.dataTransfer.setData('text/plain', feature.featureId);
                    const row = event.currentTarget.closest('.feature-row');
                    if (row instanceof HTMLElement) {
                      // Without this the drag ghost is the grip alone, which
                      // gives no clue which row is being moved.
                      event.dataTransfer.setDragImage(row, 16, 16);
                    }
                    setDragFeatureId(feature.featureId);
                  }}
                  onDragEnd={() => {
                    setDragFeatureId(null);
                    setDropFeatureId(null);
                  }}
                  onKeyDown={(event) => {
                    const offset =
                      event.key === 'ArrowUp'
                        ? -1
                        : event.key === 'ArrowDown'
                          ? 1
                          : 0;
                    if (offset === 0) {
                      return;
                    }
                    event.preventDefault();
                    onReorderFeature(feature.featureId, index + offset);
                  }}
                >
                  <GripVertical size={12} aria-hidden="true" />
                </button>
                <button
                  type="button"
                  className="feature-row-main"
                  onClick={() => onSelectFeature(feature.id)}
                  // Every row used to announce the same generic kind label, so
                  // a history read aloud was a list of identical items. The
                  // feature's own name comes first, as on screen.
                  title={`${feature.name} — ${FEATURE_KIND_LABELS[feature.featureKind]}${consumed ? ', combined into a later feature' : ''}, click to edit`}
                >
                  <span className="feature-icon">{featureIcon(feature)}</span>
                  <span className="feature-name">{feature.name}</span>
                  {failed && (
                    <span
                      className="feature-flag error"
                      title="Feature failed to build"
                    >
                      <AlertTriangle size={11} aria-hidden="true" />
                    </span>
                  )}
                  {suppressed && (
                    <small className="feature-flag">suppressed</small>
                  )}
                </button>
                <button
                  type="button"
                  className={`row-suppression ${suppressed ? 'is-suppressed' : ''}`}
                  title={
                    suppressed
                      ? `Resume ${feature.name}`
                      : `Suppress ${feature.name}`
                  }
                  aria-label={
                    suppressed
                      ? `Resume ${feature.name}`
                      : `Suppress ${feature.name}`
                  }
                  aria-pressed={suppressed}
                  onClick={() => onToggleFeatureSuppression(feature)}
                >
                  {suppressed ? (
                    <CirclePlay size={12} aria-hidden="true" />
                  ) : (
                    <CirclePause size={12} aria-hidden="true" />
                  )}
                </button>
                <button
                  type="button"
                  className={`row-rollback ${rollbackMarkerIndex === index ? 'is-active' : ''}`}
                  title={`Roll back history after ${feature.name}`}
                  aria-label={`Roll back history after ${feature.name}`}
                  aria-pressed={rollbackMarkerIndex === index}
                  onClick={() =>
                    onRollbackAfterFeature(feature.featureId, feature.name)
                  }
                >
                  <History size={12} aria-hidden="true" />
                </button>
                {feature.bodyId && body && !consumed && (
                  <button
                    type="button"
                    className={`row-visibility ${hidden ? 'is-hidden' : ''}`}
                    title={hidden ? `Show ${feature.name}` : `Hide ${feature.name}`}
                    aria-label={
                      hidden ? `Show ${feature.name}` : `Hide ${feature.name}`
                    }
                    aria-pressed={hidden}
                    onClick={() => onToggleBodyVisibility(feature.bodyId!)}
                  >
                    {hidden ? (
                      <EyeOff size={12} aria-hidden="true" />
                    ) : (
                      <Eye size={12} aria-hidden="true" />
                    )}
                  </button>
                )}
                <button
                  type="button"
                  className="row-delete"
                  title={`Delete ${feature.name}`}
                  aria-label={`Delete ${feature.name}`}
                  onClick={() =>
                    onDeleteFeature(feature.featureId, feature.name)
                  }
                >
                  <Trash2 size={12} aria-hidden="true" />
                </button>
              </div>
            );
          })}
        </div>
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
          {warnings.map((warning, index) => (
            <p key={index} className="diagnostic-row">
              <AlertTriangle size={12} aria-hidden="true" />
              <span>{warning}</span>
            </p>
          ))}
        </SidebarSection>
      )}
    </aside>
  );
}
