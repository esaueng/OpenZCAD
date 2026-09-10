import { useState, type ReactNode } from 'react';
import {
  ChevronDown,
  ChevronRight,
  Circle,
  Construction,
  Grid3x3,
  Layers3,
  Magnet,
  MousePointer2,
  Minus,
  Play,
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
import { CONSTRAINT_ICONS } from './constraintIcons';
import { StableLabel } from './StableLabel';
import { Tooltip } from './Tooltip';

/** One row of the palette's constraint list, pre-rendered by App. */
export interface SketchConstraintListItem {
  constraintId: string;
  label: string;
  editable: boolean;
}

/** What the solve-status pill shows; null until a solve has run. */
export interface SketchSolveStatus {
  label: string;
  tone: 'ok' | 'info' | 'warn';
}

interface SketchToolRailProps {
  workflow?: ReactNode;
  canExtrude?: boolean;
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
  onEditConstraint(
    constraintId: string,
    anchor: { x: number; y: number }
  ): void;
  onDeleteConstraint(constraintId: string): void;
  onSolve(): void;
  onDiagnostics(): void;
  onExtrude(): void;
}

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
const SOLVE_LABEL_RESERVE = [
  'Fully constrained',
  '99 DOF remaining',
  'Over-constrained',
  'Constraints conflict'
];

export function SketchToolRail({
  workflow,
  canExtrude = true,
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
  onEditConstraint,
  onDeleteConstraint,
  onSolve,
  onDiagnostics,
  onExtrude
}: SketchToolRailProps) {
  const [circleMenuOpen, setCircleMenuOpen] = useState(false);
  // The sketch settings are a disclosure under the tools; closed until asked.
  const [paletteOpen, setPaletteOpen] = useState(false);
  const patchSettings = (patch: Partial<AppSettings['sketching']>) =>
    onSettings({ ...settings, ...patch });

  // The same buttons serve both layouts; only their grouping differs, so each
  // block is rendered once here and placed below.
  const drawTools = (
    <>
      {TOOLS.slice(0, 3).map(({ id, label, keyHint, icon: Icon }) => (
        <Tooltip key={id} label={label} shortcut={keyHint}>
          <button
            type="button"
            className={tool === id ? 'active' : undefined}
            aria-pressed={tool === id}
            onClick={() => onTool(id)}
          >
            <Icon size={14} aria-hidden="true" />
            {label}
            <kbd>{keyHint}</kbd>
          </button>
        </Tooltip>
      ))}
      <span className="sketch-circle-tool">
        <Tooltip
          label={CIRCLE_LABELS[circleMode]}
          shortcut="C"
          description="Choose the circle type from the adjacent menu"
        >
          <button
            type="button"
            className={tool === 'circle' ? 'active' : undefined}
            aria-pressed={tool === 'circle'}
            aria-label={`Circle: ${CIRCLE_LABELS[circleMode]}`}
            onClick={() => onTool('circle')}
          >
            <Circle size={14} aria-hidden="true" />
            Circle
            <kbd>C</kbd>
          </button>
        </Tooltip>
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
        <Tooltip key={id} label={label} shortcut={keyHint}>
          <button
            type="button"
            className={tool === id ? 'active' : undefined}
            aria-pressed={tool === id}
            onClick={() => onTool(id)}
          >
            <Icon size={14} aria-hidden="true" />
            {label}
            <kbd>{keyHint}</kbd>
          </button>
        </Tooltip>
      ))}
    </>
  );
  const constraintTools = (
    <>
      {CONSTRAINT_TOOL_SPECS.map(({ kind, label, hint }) => {
        const Icon = CONSTRAINT_ICONS[kind];
        const active = pendingConstraint?.kind === kind;
        return (
          // Icon-only on purpose: five labelled buttons made the rail wider
          // than the viewer, sliding its left edge under the sidebar where
          // the parameter form intercepted every click on the Select tool.
          <Tooltip
            key={kind}
            label={label}
            description={canConstrain ? hint : 'Draw an entity first.'}
          >
            <button
              type="button"
              className={active ? 'active' : undefined}
              aria-pressed={active}
              aria-label={label}
              disabled={!canConstrain}
              onClick={() => onConstraintTool(active ? null : kind)}
            >
              <Icon size={14} aria-hidden="true" />
            </button>
          </Tooltip>
        );
      })}
    </>
  );
  const solveButton = (
    <>
      <Tooltip
        label={solving ? 'Solving…' : 'Solve'}
        description={
          constraints.length === 0
            ? 'Add a constraint first.'
            : 'Solve the sketch constraints and apply the result.'
        }
      >
        <button
          type="button"
          disabled={!canConstrain || constraints.length === 0 || solving}
          onClick={onSolve}
        >
          <Play size={14} aria-hidden="true" />
          <StableLabel reserve={['Solving…', 'Solve']}>
            {solving ? 'Solving…' : 'Solve'}
          </StableLabel>
        </button>
      </Tooltip>
    </>
  );
  const solvePill = (
    <>
      {/* Always in the rail: the rail is centred, so a pill that came and
          went re-centred every sketch tool button with it. */}
      <span
        className={`sketch-solve-pill${solveStatus ? '' : ' empty'}`}
        data-tone={solveStatus?.tone}
        role="status"
      >
        <StableLabel reserve={SOLVE_LABEL_RESERVE} align="center">
          {solveStatus?.label ?? ''}
        </StableLabel>
      </span>
    </>
  );
  const utilityTools = (
    <>
      <Tooltip label="Construction" description="Toggle construction geometry">
        <button
          type="button"
          className={construction ? 'active' : undefined}
          aria-pressed={construction}
          onClick={() => onConstruction(!construction)}
        >
          <Construction size={14} aria-hidden="true" />
          Construction
        </button>
      </Tooltip>
      <Tooltip
        label="Diagnostics"
        description="Find open endpoints and invalid profile geometry"
      >
        <button type="button" onClick={onDiagnostics}>
          <ScanSearch size={14} aria-hidden="true" />
          Diagnostics
        </button>
      </Tooltip>
      <Tooltip
        label="Extrude"
        description={
          canExtrude
            ? 'Extrude valid profiles'
            : 'Close a profile before extruding.'
        }
      >
        <button
          type="button"
          disabled={!canExtrude || solving}
          onClick={onExtrude}
        >
          <Layers3 size={14} aria-hidden="true" />
          Extrude
        </button>
      </Tooltip>
    </>
  );
  const palette = (
    <>
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
                    {constraints.map(({ constraintId, label, editable }) => (
                      <li key={constraintId}>
                        {editable ? (
                          <Tooltip label={`Edit constraint: ${label}`}>
                            <button
                              type="button"
                              className="sketch-constraint-edit"
                              aria-label={`Edit constraint: ${label}`}
                              onClick={(event) =>
                                onEditConstraint(constraintId, {
                                  x: event.clientX,
                                  y: event.clientY
                                })
                              }
                            >
                              {label}
                            </button>
                          </Tooltip>
                        ) : (
                          <Tooltip label={label}>
                            <span>{label}</span>
                          </Tooltip>
                        )}
                        <Tooltip label={`Delete constraint: ${label}`}>
                          <button
                            type="button"
                            className="row-delete"
                            aria-label={`Delete constraint: ${label}`}
                            onClick={() => onDeleteConstraint(constraintId)}
                          >
                            <Trash2 size={12} aria-hidden="true" />
                          </button>
                        </Tooltip>
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

  return (
    <>
      {workflow}
      <div className="sketch-rail" role="toolbar" aria-label="Sketch tools">
        <div className="sketch-rail-group draw">{drawTools}</div>
        <span className="sketch-rail-group-label">Constrain</span>
        <div className="sketch-rail-group constrain">{constraintTools}</div>
        <div className="sketch-rail-group solve">
          {solveButton}
          {solvePill}
        </div>
        <div className="sketch-rail-group utility">{utilityTools}</div>
      </div>
      {palette}
    </>
  );
}
