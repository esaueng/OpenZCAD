import { useRef, useState, type ReactNode } from 'react';
import {
  AlertTriangle,
  Box,
  ChevronDown,
  ChevronRight,
  Combine,
  Cone,
  Cylinder,
  Eye,
  EyeOff,
  FileBox,
  Globe,
  Layers,
  Move3d,
  PenLine,
  Plus,
  RotateCw,
  Torus,
  Trash2
} from 'lucide-react';
import type {
  BodyRepresentation,
  FeatureId,
  FeatureNode,
  ParameterNode,
  ProjectCheckpoint
} from '@openzcad/shared';
import { FEATURE_KIND_LABELS, formatNumber } from '../lib/model';
import type { PanelState, SidebarSectionId } from '../lib/panelState';

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

interface ParameterRowProps {
  parameter: ParameterNode;
  value: number | undefined;
  onSet(name: string, expression: string): void;
  onDelete(name: string): void;
}

function ParameterRow({
  parameter,
  value,
  onSet,
  onDelete
}: ParameterRowProps) {
  const [expression, setExpression] = useState(parameter.expression);
  const [editing, setEditing] = useState(false);
  const [syncedExpression, setSyncedExpression] = useState(
    parameter.expression
  );
  const changedByUser = useRef(false);

  // Undo/redo, document hydration and collaborator edits all replace the
  // canonical expression underneath us. Adopt it, but never yank the field out
  // from under someone who is actively typing in it.
  if (parameter.expression !== syncedExpression) {
    setSyncedExpression(parameter.expression);
    if (!editing) {
      setExpression(parameter.expression);
      changedByUser.current = false;
    }
  }

  function commit() {
    if (!changedByUser.current) {
      setExpression(parameter.expression);
      return;
    }
    changedByUser.current = false;
    const trimmed = expression.trim();
    if (trimmed.length > 0 && trimmed !== parameter.expression) {
      onSet(parameter.name, trimmed);
    } else {
      setExpression(parameter.expression);
    }
  }

  return (
    <div
      className="param-row"
      title={`${parameter.name} = ${parameter.expression}`}
    >
      <span className="param-name mono">{parameter.name}</span>
      <input
        className="mono"
        value={expression}
        spellCheck={false}
        aria-label={`Expression for ${parameter.name}`}
        onChange={(event) => {
          changedByUser.current = true;
          setExpression(event.target.value);
        }}
        onFocus={() => {
          changedByUser.current = false;
          setEditing(true);
        }}
        onBlur={() => {
          setEditing(false);
          commit();
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.currentTarget.blur();
          }
          if (event.key === 'Escape') {
            changedByUser.current = false;
            setExpression(parameter.expression);
          }
        }}
      />
      <span
        className={`param-value mono ${value === undefined ? 'error' : ''}`}
      >
        {value === undefined ? 'err' : formatNumber(value)}
      </span>
      <button
        type="button"
        className="row-delete"
        title={`Delete parameter ${parameter.name}`}
        aria-label={`Delete parameter ${parameter.name}`}
        onClick={() => onDelete(parameter.name)}
      >
        <Trash2 size={12} aria-hidden="true" />
      </button>
    </div>
  );
}

function AddParameterRow({
  onSet
}: {
  onSet(name: string, expression: string): void;
}) {
  const [name, setName] = useState('');
  const [expression, setExpression] = useState('');

  function submit() {
    if (name.trim().length > 0 && expression.trim().length > 0) {
      onSet(name.trim(), expression.trim());
      setName('');
      setExpression('');
    }
  }

  return (
    <form
      className="param-add"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <input
        className="mono"
        placeholder="name"
        value={name}
        spellCheck={false}
        aria-label="New parameter name"
        onChange={(event) => setName(event.target.value)}
      />
      <input
        className="mono"
        placeholder="expression"
        value={expression}
        spellCheck={false}
        aria-label="New parameter expression"
        onChange={(event) => setExpression(event.target.value)}
      />
      <button
        type="submit"
        className="icon-button"
        title="Add parameter"
        aria-label="Add parameter"
      >
        <Plus size={13} aria-hidden="true" />
      </button>
    </form>
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
  onSelectFeature(nodeId: string): void;
  onSelectBody(bodyId: string, additive: boolean): void;
  onToggleBodyVisibility(bodyId: string): void;
  onFeatureContextMenu(event: React.MouseEvent, feature: FeatureNode): void;
  onSetParameter(name: string, expression: string): void;
  onDeleteParameter(name: string): void;
  onDeleteFeature(featureId: FeatureId, name: string): void;
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
  onSelectFeature,
  onSelectBody,
  onToggleBodyVisibility,
  onFeatureContextMenu,
  onSetParameter,
  onDeleteParameter,
  onDeleteFeature,
  panelState,
  onToggleSection
}: SidebarProps) {
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
        count={bodies.length}
        open={panelState.sidebarSections.bodies}
        onToggle={onToggleSection}
      >
        <div className="feature-list" role="list" aria-label="Bodies">
          {bodies.length === 0 && (
            <p className="muted sidebar-hint">
              No bodies yet. Create a primitive or extrude a sketch.
            </p>
          )}
          {bodies.map((body) => {
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
                  title={`${body.name} — click to select, ⇧click to add`}
                  onClick={(event) =>
                    onSelectBody(
                      body.bodyId,
                      event.shiftKey || event.metaKey || event.ctrlKey
                    )
                  }
                >
                  <span className="feature-icon">{bodyIcon(body)}</span>
                  <span className="feature-name">{body.name}</span>
                  {body.consumed && <small className="feature-flag">consumed</small>}
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
          })}
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
              No features yet. Pick a tool from the toolbar above.
            </p>
          )}
          {features.map((feature) => {
            const body = feature.bodyId
              ? representations[feature.bodyId]
              : undefined;
            const consumed = body?.consumed ?? false;
            const hidden = feature.bodyId
              ? hiddenBodyIds.has(feature.bodyId)
              : false;
            const failed =
              feature.bodyId !== undefined &&
              feature.featureKind !== 'sketch' &&
              body === undefined;
            return (
              <div
                key={feature.id}
                className={`feature-row ${selectedFeatureNodeId === feature.id ? 'selected' : ''} ${consumed ? 'consumed' : ''} ${hidden ? 'hidden-body' : ''}`}
                onContextMenu={(event) => {
                  event.preventDefault();
                  onFeatureContextMenu(event, feature);
                }}
              >
                <button
                  type="button"
                  className="feature-row-main"
                  onClick={() => onSelectFeature(feature.id)}
                  title={`${FEATURE_KIND_LABELS[feature.featureKind]} — click to edit`}
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
                  {consumed && <small className="feature-flag">consumed</small>}
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
            {[...checkpoints].reverse().map((checkpoint, index) => (
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
              </div>
            ))}
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
