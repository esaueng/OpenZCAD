import { useState } from 'react';
import {
  Check,
  ChevronDown,
  ChevronRight,
  Circle,
  CircleDot,
  Construction,
  Equal,
  Grid3x3,
  Layers3,
  Magnet,
  MousePointer2,
  Minus,
  MoveHorizontal,
  MoveVertical,
  Play,
  Radius,
  ScanSearch,
  Square,
  Trash2,
  Type,
  Waypoints
} from 'lucide-react';
import type { AppSettings } from '@openzcad/shared';
import type {
  PendingSketchConstraint,
  SketchCircleMode,
  SketchConstraintToolKind,
  SketchToolId
} from '../lib/interaction/machine';
import { CONSTRAINT_TOOL_SPECS } from '../lib/sketch/constraints';

/** One row of the palette's constraint list, pre-rendered by App. */
export interface SketchConstraintListItem {
  constraintId: string;
  label: string;
}

/** What the solve-status pill shows; null until a solve has run. */
export interface SketchSolveStatus {
  label: string;
  tone: 'ok' | 'info' | 'warn';
}

interface SketchToolRailProps {
  tool: SketchToolId;
  circleMode: SketchCircleMode;
  construction: boolean;
  settings: AppSettings['sketching'];
  units: string;
  paletteVisible: boolean;
  /** Null until the first entity commit creates the sketch node. */
  canConstrain: boolean;
  pendingConstraint: PendingSketchConstraint | null;
  constraints: SketchConstraintListItem[];
  solveStatus: SketchSolveStatus | null;
  solving: boolean;
  onTool(tool: SketchToolId): void;
  onCircleMode(mode: SketchCircleMode): void;
  onConstruction(value: boolean): void;
  onSettings(settings: AppSettings['sketching']): void;
  onConstraintTool(kind: SketchConstraintToolKind | null): void;
  onDeleteConstraint(constraintId: string): void;
  onSolve(): void;
  onDiagnostics(): void;
  onExtrude(): void;
  onExit(): void;
}

const CONSTRAINT_ICONS: Record<SketchConstraintToolKind, typeof Minus> = {
  horizontal: MoveHorizontal,
  vertical: MoveVertical,
  parallel: Equal,
  coincident: CircleDot,
  radius: Radius
};

const TOOLS: {
  id: Exclude<SketchToolId, 'circle'>;
  label: string;
  keyHint: string;
  icon: typeof Minus;
}[] = [
  { id: 'select', label: 'Select', keyHint: 'V', icon: MousePointer2 },
  { id: 'line', label: 'Line', keyHint: 'L', icon: Minus },
  { id: 'arc', label: 'Arc', keyHint: 'A', icon: Waypoints },
  { id: 'rectangle', label: 'Rectangle', keyHint: 'R', icon: Square },
  { id: 'text', label: 'Text', keyHint: 'T', icon: Type }
];

const CIRCLE_MODES: {
  mode: SketchCircleMode;
  label: string;
  detail: string;
}[] = [
  {
    mode: 'center-radius',
    label: 'Center Circle',
    detail: 'Center and radius'
  },
  {
    mode: 'two-point-diameter',
    label: 'Two-Point Diameter',
    detail: 'Opposite diameter endpoints'
  },
  {
    mode: 'three-point',
    label: 'Three-Point Circle',
    detail: 'Three circumference points'
  }
];

const CIRCLE_LABELS: Record<SketchCircleMode, string> = {
  'center-radius': 'Center Circle',
  'two-point-diameter': 'Diameter Circle',
  'three-point': 'Three-Point Circle'
};

/** Dedicated sketch toolbar and contextual palette for in-viewport sketching. */
export function SketchToolRail({
  tool,
  circleMode,
  construction,
  settings,
  units,
  paletteVisible,
  canConstrain,
  pendingConstraint,
  constraints,
  solveStatus,
  solving,
  onTool,
  onCircleMode,
  onConstruction,
  onSettings,
  onConstraintTool,
  onDeleteConstraint,
  onSolve,
  onDiagnostics,
  onExtrude,
  onExit
}: SketchToolRailProps) {
  const [circleMenuOpen, setCircleMenuOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(true);
  const patchSettings = (patch: Partial<AppSettings['sketching']>) =>
    onSettings({ ...settings, ...patch });

  return (
    <>
      <div className="sketch-rail" role="toolbar" aria-label="Sketch tools">
        <span className="sketch-rail-group-label">Draw</span>
        {TOOLS.slice(0, 3).map(({ id, label, keyHint, icon: Icon }) => (
          <button
            key={id}
            type="button"
            className={tool === id ? 'active' : undefined}
            aria-pressed={tool === id}
            title={`${label} (${keyHint})`}
            onClick={() => onTool(id)}
          >
            <Icon size={14} aria-hidden="true" />
            {label}
            <kbd>{keyHint}</kbd>
          </button>
        ))}
        <span className="sketch-circle-tool">
          <button
            type="button"
            className={tool === 'circle' ? 'active' : undefined}
            aria-pressed={tool === 'circle'}
            aria-label={`Circle: ${CIRCLE_LABELS[circleMode]}`}
            title={`${CIRCLE_LABELS[circleMode]} (C)`}
            onClick={() => onTool('circle')}
          >
            <Circle size={14} aria-hidden="true" />
            Circle
            <kbd>C</kbd>
          </button>
          <button
            type="button"
            className="sketch-circle-chevron"
            aria-label="Choose circle type"
            aria-expanded={circleMenuOpen}
            onClick={() => setCircleMenuOpen((open) => !open)}
          >
            <ChevronDown size={12} aria-hidden="true" />
          </button>
          {circleMenuOpen ? (
            <span className="sketch-circle-menu" role="menu">
              {CIRCLE_MODES.map(({ mode, label, detail }) => (
                <button
                  key={mode}
                  type="button"
                  role="menuitemradio"
                  aria-checked={circleMode === mode}
                  className={circleMode === mode ? 'active' : undefined}
                  onClick={() => {
                    onCircleMode(mode);
                    setCircleMenuOpen(false);
                  }}
                >
                  <Circle size={14} aria-hidden="true" />
                  <span>
                    <strong>{label}</strong>
                    <small>{detail}</small>
                  </span>
                </button>
              ))}
            </span>
          ) : null}
        </span>
        {TOOLS.slice(3).map(({ id, label, keyHint, icon: Icon }) => (
          <button
            key={id}
            type="button"
            className={tool === id ? 'active' : undefined}
            aria-pressed={tool === id}
            title={`${label} (${keyHint})`}
            onClick={() => onTool(id)}
          >
            <Icon size={14} aria-hidden="true" />
            {label}
            <kbd>{keyHint}</kbd>
          </button>
        ))}
        <span className="sketch-rail-divider" aria-hidden="true" />
        <span className="sketch-rail-group-label">Constrain</span>
        {CONSTRAINT_TOOL_SPECS.map(({ kind, label, hint }) => {
          const Icon = CONSTRAINT_ICONS[kind];
          const active = pendingConstraint?.kind === kind;
          return (
            // Icon-only on purpose: five labelled buttons made the rail wider
            // than the viewer, sliding its left edge under the sidebar where
            // the parameter form intercepted every click on the Select tool.
            <button
              key={kind}
              type="button"
              className={active ? 'active' : undefined}
              aria-pressed={active}
              aria-label={label}
              disabled={!canConstrain}
              title={
                canConstrain ? `${label} — ${hint}` : 'Draw an entity first.'
              }
              onClick={() => onConstraintTool(active ? null : kind)}
            >
              <Icon size={14} aria-hidden="true" />
            </button>
          );
        })}
        <button
          type="button"
          disabled={!canConstrain || constraints.length === 0 || solving}
          title={
            constraints.length === 0
              ? 'Add a constraint first.'
              : 'Solve the sketch constraints and apply the result.'
          }
          onClick={onSolve}
        >
          <Play size={14} aria-hidden="true" />
          {solving ? 'Solving…' : 'Solve'}
        </button>
        {solveStatus ? (
          <span
            className="sketch-solve-pill"
            data-tone={solveStatus.tone}
            role="status"
          >
            {solveStatus.label}
          </span>
        ) : null}
        <span className="sketch-rail-divider" aria-hidden="true" />
        <button
          type="button"
          className={construction ? 'active' : undefined}
          aria-pressed={construction}
          title="Toggle construction geometry"
          onClick={() => onConstruction(!construction)}
        >
          <Construction size={14} aria-hidden="true" />
          Construction
        </button>
        <button
          type="button"
          title="Find open endpoints and invalid profile geometry"
          onClick={onDiagnostics}
        >
          <ScanSearch size={14} aria-hidden="true" />
          Diagnostics
        </button>
        <button
          type="button"
          title="Extrude valid profiles"
          onClick={onExtrude}
        >
          <Layers3 size={14} aria-hidden="true" />
          Extrude
        </button>
        <span className="sketch-rail-divider" aria-hidden="true" />
        <button
          type="button"
          className="sketch-rail-exit"
          title="Finish Sketch"
          onClick={onExit}
        >
          <Check size={14} aria-hidden="true" />
          Finish Sketch
        </button>
      </div>

      {paletteVisible ? (
        <aside
          className={`sketch-palette${paletteOpen ? '' : ' collapsed'}`}
          aria-label="Sketch palette"
        >
          <button
            type="button"
            className="sketch-palette-header"
            aria-expanded={paletteOpen}
            onClick={() => setPaletteOpen((open) => !open)}
          >
            <span>
              <Grid3x3 size={14} aria-hidden="true" />
              Sketch palette
            </span>
            {paletteOpen ? (
              <ChevronDown size={13} aria-hidden="true" />
            ) : (
              <ChevronRight size={13} aria-hidden="true" />
            )}
          </button>
          {paletteOpen ? (
            <div className="sketch-palette-content">
              <fieldset>
                <legend>Display</legend>
                <label>
                  <input
                    type="checkbox"
                    checked={settings.gridVisible}
                    onChange={(event) =>
                      patchSettings({
                        gridVisible: event.currentTarget.checked
                      })
                    }
                  />
                  Show adaptive grid
                </label>
              </fieldset>
              <fieldset>
                <legend>Snapping</legend>
                <label>
                  <input
                    type="checkbox"
                    checked={settings.geometrySnapEnabled}
                    onChange={(event) =>
                      patchSettings({
                        geometrySnapEnabled: event.currentTarget.checked
                      })
                    }
                  />
                  Geometry snaps
                </label>
                <label>
                  <input
                    type="checkbox"
                    checked={settings.inferenceEnabled}
                    onChange={(event) =>
                      patchSettings({
                        inferenceEnabled: event.currentTarget.checked
                      })
                    }
                  />
                  Automatic inferencing
                </label>
                <label>
                  <input
                    type="checkbox"
                    checked={settings.snapEnabled}
                    onChange={(event) =>
                      patchSettings({
                        snapEnabled: event.currentTarget.checked
                      })
                    }
                  />
                  Snap to grid
                </label>
                <label className="sketch-palette-number">
                  <span>Snap spacing</span>
                  <span>
                    <input
                      type="number"
                      min="0.001"
                      max="10000"
                      step="0.1"
                      value={settings.linearSnap}
                      aria-label="Sketch snap spacing"
                      onChange={(event) => {
                        const value = event.currentTarget.valueAsNumber;
                        if (
                          Number.isFinite(value) &&
                          value >= 0.001 &&
                          value <= 10_000
                        ) {
                          patchSettings({ linearSnap: value });
                        }
                      }}
                    />
                    <small>{units}</small>
                  </span>
                </label>
              </fieldset>
              {constraints.length > 0 ? (
                <fieldset>
                  <legend>Constraints</legend>
                  <ul className="sketch-constraint-list">
                    {constraints.map(({ constraintId, label }) => (
                      <li key={constraintId}>
                        <span title={label}>{label}</span>
                        <button
                          type="button"
                          className="row-delete"
                          title={`Delete constraint: ${label}`}
                          aria-label={`Delete constraint: ${label}`}
                          onClick={() => onDeleteConstraint(constraintId)}
                        >
                          <Trash2 size={12} aria-hidden="true" />
                        </button>
                      </li>
                    ))}
                  </ul>
                </fieldset>
              ) : null}
              <p className="sketch-palette-help">
                <Magnet size={12} aria-hidden="true" />
                Tab cycles overlaps · Shift suppresses snaps
              </p>
            </div>
          ) : null}
        </aside>
      ) : null}
    </>
  );
}
