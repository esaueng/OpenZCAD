import { useRef, useState } from 'react';
import {
  AlertTriangle,
  Box,
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
  hiddenBodyIds: ReadonlySet<string>;
  warnings: string[];
  checkpoints: ProjectCheckpoint[];
  onSelectFeature(nodeId: string): void;
  onToggleBodyVisibility(bodyId: string): void;
  onFeatureContextMenu(event: React.MouseEvent, feature: FeatureNode): void;
  onSetParameter(name: string, expression: string): void;
  onDeleteParameter(name: string): void;
  onDeleteFeature(featureId: FeatureId, name: string): void;
}

export function Sidebar({
  parameters,
  parameterValues,
  features,
  representations,
  selectedFeatureNodeId,
  hiddenBodyIds,
  warnings,
  checkpoints,
  onSelectFeature,
  onToggleBodyVisibility,
  onFeatureContextMenu,
  onSetParameter,
  onDeleteParameter,
  onDeleteFeature
}: SidebarProps) {
  return (
    <aside className="sidebar" aria-label="Model browser">
      <div className="sidebar-label">Model</div>
      <section className="sidebar-section">
        <h3 className="section-title">Parameters</h3>
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
      </section>

      <section className="sidebar-section grow">
        <h3 className="section-title">Features</h3>
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
      </section>

      {checkpoints.length > 0 && (
        <section className="sidebar-section revisions">
          <h3 className="section-title">Revisions</h3>
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
        </section>
      )}

      {warnings.length > 0 && (
        <section className="sidebar-section diagnostics">
          <h3 className="section-title">Diagnostics</h3>
          {warnings.map((warning, index) => (
            <p key={index} className="diagnostic-row">
              <AlertTriangle size={12} aria-hidden="true" />
              <span>{warning}</span>
            </p>
          ))}
        </section>
      )}
    </aside>
  );
}
