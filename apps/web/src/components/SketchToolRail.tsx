import { useId, useState, type ReactNode } from 'react';
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
  Radius,
  ScanSearch,
  Slice,
  Square,
  SquareDashed,
  Trash2,
  Type,
  Waypoints
} from 'lucide-react';
import type { AppSettings } from '@openzcad/shared';
import type {
  PendingSketchConstraint,
  PendingSketchEdit,
  SketchCircleMode,
  SketchConstraintToolKind,
  SketchEditToolKind,
  SketchToolId
} from '../lib/interaction/machine';
import { CONSTRAINT_TOOL_SPECS } from '../lib/sketch/constraints';
import { SKETCH_EDIT_TOOL_SPECS } from '../lib/sketch/edits';
import { CONSTRAINT_ICONS } from './constraintIcons';
import { StableLabel } from './StableLabel';
import { Tooltip } from './Tooltip';

/** One row of the palette's constraint list, pre-rendered by App. */
export interface SketchConstraintListItem {
  constraintId: string;
  label: string;
  editable: boolean;
  conflicted?: boolean;
}

/** What the solve-status pill shows; null until a solve has run. */
export interface SketchSolveStatus {
  label: string;
  tone: 'ok' | 'info' | 'warn';
  /** Entities named by constraints with measurable residuals, if any. */
  diagnosticObjectIds?: string[];
  /** Constraints with measurable residuals, if the solver named any. */
  conflictingConstraintIds?: string[];
}

interface SketchToolRailProps {
  workflow?: ReactNode;
  /**
   * The selected entity's editor, when one is selected: the card changes
   * with the pick like the command card does, under the tools that stay put.
   */
  entityEditor?: ReactNode;
  canExtrude?: boolean;
  tool: SketchToolId;
  circleMode: SketchCircleMode;
  construction: boolean;
  settings: AppSettings['sketching'];
  units: string;
  paletteVisible: boolean;
  /** Null until the first entity commit creates the sketch node. */
  canConstrain: boolean;
  /** Armed modify tool, if any. */
  pendingEdit: PendingSketchEdit | null;
  constraints: SketchConstraintListItem[];
  solveStatus: SketchSolveStatus | null;
  solving: boolean;
  onTool(tool: SketchToolId): void;
  onCircleMode(mode: SketchCircleMode): void;
  onConstruction(value: boolean): void;
  onSettings(settings: AppSettings['sketching']): void;
  /** The hint travels with the tool: the rail already holds the specs. */
  onEditTool(kind: SketchEditToolKind | null, hint?: string): void;
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

const EDIT_TOOL_ICONS: Record<SketchEditToolKind, typeof Minus> = {
  fillet: Radius,
  chamfer: Slice,
  offset: SquareDashed
};

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
  entityEditor,
  canExtrude = true,
  tool,
  circleMode,
  construction,
  settings,
  units,
  paletteVisible,
  canConstrain,
  pendingEdit,
  constraints,
  solveStatus,
  solving,
  onTool,
  onCircleMode,
  onConstruction,
  onSettings,
  onEditTool,
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
  const modifyTools = (
    <>
      {SKETCH_EDIT_TOOL_SPECS.map(({ kind, label, hint }) => {
        const Icon = EDIT_TOOL_ICONS[kind];
        const active = pendingEdit?.kind === kind;
        return (
          <Tooltip
            key={kind}
            label={label}
            description={canConstrain ? hint : 'Draw an entity first.'}
          >
            <button
              type="button"
              className={active ? 'active' : undefined}
              aria-pressed={active}
              disabled={!canConstrain}
              onClick={() =>
                active ? onEditTool(null) : onEditTool(kind, hint)
              }
            >
              <Icon size={14} aria-hidden="true" />
              {label}
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
                    {constraints.map(
                      ({ constraintId, label, editable, conflicted }) => (
                        <li
                          key={constraintId}
                          data-conflicted={conflicted ? 'true' : undefined}
                          aria-label={
                            conflicted
                              ? `${label} · solver residual; edit or delete this constraint`
                              : label
                          }
                        >
                          {editable ? (
                            <Tooltip
                              label={
                                conflicted
                                  ? `Edit conflicting constraint: ${label}`
                                  : `Edit constraint: ${label}`
                              }
                            >
                              <button
                                type="button"
                                className="sketch-constraint-edit"
                                data-conflicted={
                                  conflicted ? 'true' : undefined
                                }
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
                      )
                    )}
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

  // The tools come first and never move; what changes with the pick (the
  // entity editor) follows them, then the sketch's own state and settings.
  // The relations live on their own rail on the right (SketchRelationsRail).
  return (
    <>
      <div className="sketch-rail" role="toolbar" aria-label="Sketch tools">
        <span className="sketch-rail-group-label">Draw</span>
        <div className="sketch-rail-group draw">{drawTools}</div>
        <span className="sketch-rail-group-label">Modify</span>
        <div className="sketch-rail-group modify">{modifyTools}</div>
        <div className="sketch-rail-group solve">
          {solveButton}
          {solvePill}
        </div>
        <div className="sketch-rail-group utility">{utilityTools}</div>
      </div>
      {entityEditor}
      {workflow}
      {palette}
    </>
  );
}

/** Relations dividers: before the positional group and the dimensions. */
const RELATION_GROUP_STARTS = new Set<SketchConstraintToolKind>([
  'concentric',
  'radius'
]);

interface SketchRelationsRailProps {
  /** Null until the first entity commit creates the sketch node. */
  canConstrain: boolean;
  pendingConstraint: PendingSketchConstraint | null;
  /**
   * The selected entity, if any: its kind, and the relations that take it as
   * their first pick. Null while nothing is selected, when every relation
   * arms and waits for its picks on the canvas.
   */
  selection: {
    kind: string;
    fitting: readonly SketchConstraintToolKind[];
  } | null;
  /** Arms (or, with null, disarms) a relation that collects its picks. */
  onConstraintTool(kind: SketchConstraintToolKind | null): void;
  /** Starts a relation from the selection: the selected entity is pick 1. */
  onSelectionConstraintTool(kind: SketchConstraintToolKind): void;
}

/**
 * The sketch relations as a fixed icon rail on the right. The icons never
 * move — they keep the order of CONSTRAINT_TOOL_SPECS — and a name appears
 * beside a relation only when it fits the selection (or is armed), so the
 * rail reads as "what you can do with this" without rearranging itself.
 * A relation that does not fit is greyed and says why.
 */
export function SketchRelationsRail({
  canConstrain,
  pendingConstraint,
  selection,
  onConstraintTool,
  onSelectionConstraintTool
}: SketchRelationsRailProps) {
  const reasonId = useId();
  return (
    <div
      className="sketch-relations"
      role="toolbar"
      aria-label="Relations"
      aria-orientation="vertical"
    >
      {CONSTRAINT_TOOL_SPECS.map(({ kind, label, hint }) => {
        const Icon = CONSTRAINT_ICONS[kind];
        const armed = pendingConstraint?.kind === kind;
        const fits = !selection || selection.fitting.includes(kind);
        const reason = !canConstrain
          ? 'Draw an entity first.'
          : fits
            ? null
            : `Does not apply to a ${selection.kind}.`;
        const named = armed || Boolean(selection && fits && canConstrain);
        return (
          <span key={kind} className="sketch-relation-slot">
            {RELATION_GROUP_STARTS.has(kind) && (
              <span className="sketch-relations-divider" aria-hidden="true" />
            )}
            <Tooltip label={label} description={reason ?? hint}>
              <button
                type="button"
                className={`sketch-relation${armed ? ' active' : ''}`}
                aria-pressed={armed}
                aria-label={label}
                aria-describedby={reason ? `${reasonId}-${kind}` : undefined}
                // An armed relation can always be put down again.
                disabled={reason !== null && !armed}
                onClick={() =>
                  selection && !armed
                    ? onSelectionConstraintTool(kind)
                    : onConstraintTool(armed ? null : kind)
                }
              >
                <Icon size={15} aria-hidden="true" />
                {named && (
                  <span className="sketch-relation-name" aria-hidden="true">
                    {label}
                  </span>
                )}
                {reason && (
                  <span id={`${reasonId}-${kind}`} className="visually-hidden">
                    {reason}
                  </span>
                )}
              </button>
            </Tooltip>
          </span>
        );
      })}
    </div>
  );
}
