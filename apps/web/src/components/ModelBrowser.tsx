import { useEffect, useRef, useState } from 'react';
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
  FeatureNode,
  ParameterNode
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

function ParameterRow({ parameter, value, onSet, onDelete }: ParameterRowProps) {
  const [expression, setExpression] = useState(parameter.expression);

  function commit() {
    const trimmed = expression.trim();
    if (trimmed.length > 0 && trimmed !== parameter.expression) {
      onSet(parameter.name, trimmed);
    } else {
      setExpression(parameter.expression);
    }
  }

  return (
    <div className="param-row" title={`${parameter.name} = ${parameter.expression}`}>
      <span className="param-name mono">{parameter.name}</span>
      <input
        className="mono"
        value={expression}
        spellCheck={false}
        aria-label={`Expression for ${parameter.name}`}
        onChange={(event) => setExpression(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.currentTarget.blur();
          }
          if (event.key === 'Escape') {
            setExpression(parameter.expression);
          }
        }}
      />
      <span className={`param-value mono ${value === undefined ? 'error' : ''}`}>
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

function AddParameterRow({ onSet }: { onSet(name: string, expression: string): void }) {
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
      <button type="submit" className="icon-button" title="Add parameter" aria-label="Add parameter">
        <Plus size={13} aria-hidden="true" />
      </button>
    </form>
  );
}

function RenameInput({
  initial,
  onCommit,
  onCancel
}: {
  initial: string;
  onCommit(name: string): void;
  onCancel(): void;
}) {
  const [value, setValue] = useState(initial);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  return (
    <input
      ref={inputRef}
      className="rename-input"
      value={value}
      aria-label="Rename"
      onChange={(event) => setValue(event.target.value)}
      onBlur={() => {
        const trimmed = value.trim();
        if (trimmed.length > 0 && trimmed !== initial) {
          onCommit(trimmed);
        } else {
          onCancel();
        }
      }}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === 'Enter') {
          event.currentTarget.blur();
        }
        if (event.key === 'Escape') {
          setValue(initial);
          onCancel();
        }
      }}
    />
  );
}

export interface ModelBrowserProps {
  parameters: ParameterNode[];
  parameterValues: Record<string, number>;
  features: FeatureNode[];
  representations: Record<string, BodyRepresentation>;
  selectedFeatureNodeIds: string[];
  hiddenBodyIds: ReadonlySet<string>;
  warnings: string[];
  /** Node currently in inline-rename mode, controlled by App (F2 / menu). */
  renamingNodeId: string | null;
  onSelectFeature(nodeId: string, additive: boolean): void;
  onRenameNode(nodeId: string, name: string): void;
  onRenameStateChange(nodeId: string | null): void;
  onToggleBodyVisibility(bodyId: string): void;
  onFeatureContextMenu(event: React.MouseEvent, feature: FeatureNode): void;
  onSetParameter(name: string, expression: string): void;
  onDeleteParameter(name: string): void;
}

/**
 * Collapsible model browser: parameter table plus the ordered feature tree
 * with inline rename, hover visibility toggles, and state badges. Secondary
 * controls appear on hover/selection; everything else lives in the context
 * menu so rows stay scannable.
 */
export function ModelBrowser({
  parameters,
  parameterValues,
  features,
  representations,
  selectedFeatureNodeIds,
  hiddenBodyIds,
  warnings,
  renamingNodeId,
  onSelectFeature,
  onRenameNode,
  onRenameStateChange,
  onToggleBodyVisibility,
  onFeatureContextMenu,
  onSetParameter,
  onDeleteParameter
}: ModelBrowserProps) {
  const [showParams, setShowParams] = useState(true);

  return (
    <aside className="model-browser" aria-label="Model browser">
      <section className="browser-section">
        <button
          type="button"
          className="browser-section-title"
          aria-expanded={showParams}
          onClick={() => setShowParams((value) => !value)}
        >
          {showParams ? (
            <ChevronDown size={11} aria-hidden="true" />
          ) : (
            <ChevronRight size={11} aria-hidden="true" />
          )}
          Parameters
          <span className="browser-count">{parameters.length}</span>
        </button>
        {showParams && (
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
            {parameters.length === 0 && (
              <p className="muted browser-hint">
                Name a value (e.g. <span className="mono">w = 30</span>) and use it in any field.
              </p>
            )}
          </div>
        )}
      </section>

      <section className="browser-section grow">
        <h3 className="browser-section-title static">
          Features
          <span className="browser-count">{features.length}</span>
        </h3>
        <div className="feature-list" role="tree" aria-label="Feature history">
          {features.length === 0 && (
            <p className="muted browser-hint">
              Nothing yet — start a sketch (K) or add a box (B).
            </p>
          )}
          {features.map((feature) => {
            const body = feature.bodyId ? representations[feature.bodyId] : undefined;
            const consumed = body?.consumed ?? false;
            const hidden = feature.bodyId ? hiddenBodyIds.has(feature.bodyId) : false;
            const failed =
              feature.bodyId !== undefined &&
              feature.featureKind !== 'sketch' &&
              body === undefined;
            const selected = selectedFeatureNodeIds.includes(feature.id);
            return (
              <div
                key={feature.id}
                role="treeitem"
                aria-selected={selected}
                className={`feature-row ${selected ? 'selected' : ''} ${consumed ? 'consumed' : ''} ${hidden ? 'hidden-body' : ''}`}
                onContextMenu={(event) => {
                  event.preventDefault();
                  onFeatureContextMenu(event, feature);
                }}
              >
                <button
                  type="button"
                  className="feature-row-main"
                  title={`${FEATURE_KIND_LABELS[feature.featureKind]} — double-click to rename`}
                  onClick={(event) =>
                    onSelectFeature(feature.id, event.shiftKey || event.metaKey || event.ctrlKey)
                  }
                  onDoubleClick={() => onRenameStateChange(feature.id)}
                >
                  <span className="feature-icon">{featureIcon(feature)}</span>
                  {renamingNodeId === feature.id ? (
                    <RenameInput
                      initial={feature.name}
                      onCommit={(name) => {
                        onRenameNode(feature.id, name);
                        onRenameStateChange(null);
                      }}
                      onCancel={() => onRenameStateChange(null)}
                    />
                  ) : (
                    <span className="feature-name">{feature.name}</span>
                  )}
                  {failed && (
                    <span className="feature-flag error" title="Feature failed to build">
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
                    aria-label={hidden ? `Show ${feature.name}` : `Hide ${feature.name}`}
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
              </div>
            );
          })}
        </div>
      </section>

      {warnings.length > 0 && (
        <section className="browser-section diagnostics">
          <h3 className="browser-section-title static">Diagnostics</h3>
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
