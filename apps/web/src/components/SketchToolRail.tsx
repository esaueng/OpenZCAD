import { useId, useState, type KeyboardEvent, type ReactNode } from 'react';
import {
  CircleDot,
  Construction,
  Diameter,
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
import {
  nextSketchCircleMode,
  type PendingSketchConstraint,
  type PendingSketchEdit,
  type SketchCircleMode,
  type SketchConstraintToolKind,
  type SketchEditToolKind,
  type SketchToolId
} from '../lib/interaction/machine';
import { CONSTRAINT_TOOL_SPECS } from '../lib/sketch/constraints';
import type { SketchDefinedState } from '../lib/sketch/constraints';
import { SKETCH_EDIT_TOOL_SPECS } from '../lib/sketch/edits';
import { CONSTRAINT_ICONS } from './constraintIcons';
import { Tooltip } from './Tooltip';

/** One row of the palette's constraint list, pre-rendered by App. */
export interface SketchConstraintListItem {
  constraintId: string;
  label: string;
  editable: boolean;
  conflicted?: boolean;
  /**
   * True while the last solve proved the whole sketch fully defined. Rows
   * never claim an under-defined state per entity — the kernel reports no
   * per-entity freedom — so this is sketch-wide agreement with the pill and
   * the viewport, not a second signal on its own.
   */
  defined?: boolean;
}

/** What the solve-status pill shows; null until a solve has run. */
export interface SketchSolveStatus {
  label: string;
  tone: 'ok' | 'info' | 'warn';
  /** Sketch-wide defined state behind the pill text, if a solve ran. */
  definedState?: SketchDefinedState;
  /** Entities named by constraints with measurable residuals, if any. */
  diagnosticObjectIds?: string[];
  /** Entities proved fully defined by a zero-DOF solve, if any. */
  definedObjectIds?: string[];
  /** Constraints with measurable residuals, if the solver named any. */
  conflictingConstraintIds?: string[];
}

interface SketchToolRailProps {
  workflow?: ReactNode;
  /** The sketch being edited, named at the head of the palette flyout. */
  sketchName?: string;
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
  /**
   * The palette flyout's open state, when the caller remembers it (App
   * keeps it in the panel state so it survives leaving and re-entering a
   * sketch). Absent, the rail holds it itself.
   */
  paletteOpen?: boolean;
  onTogglePalette?(): void;
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

/** A circle through three points on its circumference, drawn like lucide. */
function ThreePointCircle({ size }: { size: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="9" />
      <circle cx="12" cy="3" r="1" fill="currentColor" />
      <circle cx="4.2" cy="16.5" r="1" fill="currentColor" />
      <circle cx="19.8" cy="16.5" r="1" fill="currentColor" />
    </svg>
  );
}

/**
 * The circle's three types. `label` names the type on the tool and in its
 * tooltip; `tile` is the short word on the strip beside the rail.
 */
const CIRCLE_MODES: {
  mode: SketchCircleMode;
  label: string;
  tile: string;
  detail: string;
  icon: typeof CircleDot | typeof ThreePointCircle;
}[] = [
  {
    mode: 'center-radius',
    label: 'Center Circle',
    tile: 'Center',
    detail: 'Center and radius',
    icon: CircleDot
  },
  {
    mode: 'two-point-diameter',
    label: 'Diameter Circle',
    tile: 'Diameter',
    detail: 'Opposite diameter endpoints',
    icon: Diameter
  },
  {
    mode: 'three-point',
    label: 'Three-Point Circle',
    tile: '3 points',
    detail: 'Three circumference points',
    icon: ThreePointCircle
  }
];

const EDIT_TOOL_ICONS: Record<SketchEditToolKind, typeof Minus> = {
  fillet: Radius,
  chamfer: Slice,
  offset: SquareDashed
};

function circleModeSpec(mode: SketchCircleMode) {
  return CIRCLE_MODES.find((spec) => spec.mode === mode) ?? CIRCLE_MODES[0]!;
}

/**
 * The live draw tool as the rail names it: the circle by its type, every
 * other tool by its tooltip's name.
 */
export function sketchDrawToolLabel(
  tool: SketchToolId,
  circleMode: SketchCircleMode
): string {
  return tool === 'circle'
    ? circleModeSpec(circleMode).label
    : (TOOLS.find((entry) => entry.id === tool)?.label ?? tool);
}

/**
 * Arrow keys step the strip's type and move focus with it, wrapping round;
 * Home and End go to the ends. Only the checked tile is in the tab order
 * (a roving tabIndex), so Tab leaves the group in one press.
 */
function radioGroupKeyStep(
  event: KeyboardEvent<HTMLElement>,
  count: number,
  index: number
): number | null {
  const step =
    event.key === 'ArrowRight' || event.key === 'ArrowDown'
      ? 1
      : event.key === 'ArrowLeft' || event.key === 'ArrowUp'
        ? -1
        : 0;
  const next =
    event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? count - 1
        : step === 0
          ? null
          : (index + step + count) % count;
  if (next === null) {
    return null;
  }
  event.preventDefault();
  const radios = event.currentTarget
    .closest('[role="radiogroup"]')
    ?.querySelectorAll<HTMLElement>('[role="radio"]');
  radios?.[next]?.focus();
  return next;
}

/**
 * The snap spacing as typed. While the field has focus it shows the draft,
 * so a value on its way to valid ("", "0.", "0.0") stays in the field: the
 * committed value written back over each refused keystroke turned "0.5"
 * typed over 1 into 1.5. Only a value in range is committed, and leaving
 * the field shows the committed value again.
 */
function SnapSpacingField({
  value,
  onCommit
}: {
  value: number;
  onCommit(value: number): void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <input
      type="number"
      min="0.001"
      max="10000"
      step="0.1"
      value={draft ?? String(value)}
      aria-label="Sketch snap spacing"
      onChange={(event) => {
        const text = event.currentTarget.value;
        setDraft(text);
        const next = Number(text);
        if (
          text.trim() !== '' &&
          Number.isFinite(next) &&
          next >= 0.001 &&
          next <= 10_000
        ) {
          onCommit(next);
        }
      }}
      onBlur={() => setDraft(null)}
    />
  );
}

/** The sketch rail: the sketch's tools as one icon column, plus its flyouts. */
export function SketchToolRail({
  workflow,
  entityEditor,
  sketchName,
  canExtrude = true,
  tool,
  circleMode,
  construction,
  settings,
  units,
  paletteVisible,
  paletteOpen: paletteOpenProp,
  onTogglePalette,
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
  // The sketch's overview and settings open beside the rail; closed until asked.
  const [paletteOpenState, setPaletteOpenState] = useState(false);
  const paletteOpen = paletteOpenProp ?? paletteOpenState;
  const togglePalette = () =>
    onTogglePalette ? onTogglePalette() : setPaletteOpenState((open) => !open);
  const patchSettings = (patch: Partial<AppSettings['sketching']>) =>
    onSettings({ ...settings, ...patch });

  // Icon-only, like the verb rail: the name and key ride the tooltip, and
  // the accessible name is the tool's name alone.
  const drawTool = ({
    id,
    label,
    keyHint,
    icon: Icon
  }: (typeof TOOLS)[number]) => {
    // An armed modify tool picks through Select's hit-testing, so the
    // machine parks the tool there; the rail lights the modify tool alone
    // rather than Select beside it as a second live tool.
    const on = tool === id && !(id === 'select' && pendingEdit);
    return (
      <Tooltip key={id} label={label} shortcut={keyHint}>
        <button
          type="button"
          className={on ? 'active' : undefined}
          aria-pressed={on}
          aria-label={label}
          onClick={() => onTool(id)}
        >
          <Icon size={16} aria-hidden="true" />
        </button>
      </Tooltip>
    );
  };
  const circleSpec = circleModeSpec(circleMode);
  const CircleIcon = circleSpec.icon;
  const drawTools = (
    <>
      {TOOLS.slice(0, 3).map(drawTool)}
      <span className="sketch-circle-tool">
        <Tooltip
          label={circleSpec.label}
          shortcut="C"
          description="C again steps through the circle types"
        >
          <button
            type="button"
            className={tool === 'circle' ? 'active' : undefined}
            aria-pressed={tool === 'circle'}
            aria-label={`Circle: ${circleSpec.label}`}
            onClick={() => onTool('circle')}
          >
            <CircleIcon size={16} aria-hidden="true" />
          </button>
        </Tooltip>
        {tool === 'circle' ? (
          // The type rides beside the rail while the circle tool is live:
          // one click to any type, and the strip leaves with the tool.
          <span
            className="sketch-type-strip"
            role="radiogroup"
            aria-label="Circle type"
            data-rail-flyout=""
          >
            {CIRCLE_MODES.map(
              ({ mode, label, tile, detail, icon: Icon }, index) => (
                <Tooltip key={mode} label={label} description={detail}>
                  <button
                    type="button"
                    role="radio"
                    aria-checked={circleMode === mode}
                    tabIndex={circleMode === mode ? 0 : -1}
                    className={`sketch-type-tile${
                      circleMode === mode ? ' active' : ''
                    }`}
                    onClick={() => onCircleMode(mode)}
                    onKeyDown={(event) => {
                      const next = radioGroupKeyStep(
                        event,
                        CIRCLE_MODES.length,
                        index
                      );
                      if (next !== null) {
                        onCircleMode(CIRCLE_MODES[next]!.mode);
                      }
                    }}
                  >
                    <Icon size={16} aria-hidden="true" />
                    <span>{tile}</span>
                  </button>
                </Tooltip>
              )
            )}
            <Tooltip label="Next circle type" shortcut="C">
              <button
                type="button"
                className="sketch-type-cycle"
                aria-label="Next circle type"
                onClick={() => onCircleMode(nextSketchCircleMode(circleMode))}
              >
                <kbd>C</kbd>
              </button>
            </Tooltip>
          </span>
        ) : null}
      </span>
      {TOOLS.slice(3).map(drawTool)}
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
              aria-label={label}
              disabled={!canConstrain}
              onClick={() =>
                active ? onEditTool(null) : onEditTool(kind, hint)
              }
            >
              <Icon size={16} aria-hidden="true" />
            </button>
          </Tooltip>
        );
      })}
    </>
  );
  // The solve status is the button's tone dot and its tooltip; the text
  // itself stays in the tree for assistive tech, off screen.
  const solveTools = (
    <>
      <Tooltip
        label={solving ? 'Solving…' : 'Solve'}
        description={
          solveStatus?.label ??
          (constraints.length === 0
            ? 'Add a constraint first.'
            : 'Solve the sketch constraints and apply the result.')
        }
      >
        <button
          type="button"
          aria-label="Solve"
          data-tone={solveStatus?.tone}
          disabled={!canConstrain || constraints.length === 0 || solving}
          onClick={onSolve}
        >
          <Play size={16} aria-hidden="true" />
        </button>
      </Tooltip>
      <span
        className="sketch-solve-pill visually-hidden"
        data-tone={solveStatus?.tone}
        role="status"
      >
        {solveStatus?.label ?? ''}
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
          aria-label="Construction"
          onClick={() => onConstruction(!construction)}
        >
          <Construction size={16} aria-hidden="true" />
        </button>
      </Tooltip>
      <Tooltip
        label="Diagnostics"
        description="Find open endpoints and invalid profile geometry"
      >
        <button type="button" aria-label="Diagnostics" onClick={onDiagnostics}>
          <ScanSearch size={16} aria-hidden="true" />
        </button>
      </Tooltip>
      <Tooltip
        label="Extrude"
        shortcut="E"
        description={
          canExtrude
            ? 'Extrude valid profiles'
            : 'Close a profile before extruding.'
        }
      >
        <button
          type="button"
          aria-label="Extrude"
          disabled={!canExtrude || solving}
          onClick={onExtrude}
        >
          <Layers3 size={16} aria-hidden="true" />
        </button>
      </Tooltip>
    </>
  );
  const paletteButton = paletteVisible ? (
    <Tooltip
      label="Sketch palette"
      description="The sketch's plane, snapping, grid and constraints"
    >
      <button
        type="button"
        className={paletteOpen ? 'active' : undefined}
        aria-label="Sketch palette"
        aria-expanded={paletteOpen}
        onClick={togglePalette}
      >
        <Grid3x3 size={16} aria-hidden="true" />
      </button>
    </Tooltip>
  ) : null;
  const palette =
    paletteVisible && paletteOpen ? (
      <aside className="sketch-palette" aria-label="Sketch palette">
        <header className="sketch-palette-header">
          <span>
            <Grid3x3 size={14} aria-hidden="true" />
            {sketchName ?? 'Sketch'}
          </span>
        </header>
        {workflow}
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
                <SnapSpacingField
                  value={settings.linearSnap}
                  onCommit={(linearSnap) => patchSettings({ linearSnap })}
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
                  ({ constraintId, label, editable, conflicted, defined }) => (
                    <li
                      key={constraintId}
                      data-conflicted={conflicted ? 'true' : undefined}
                      data-defined={defined ? 'true' : undefined}
                      aria-label={
                        conflicted
                          ? `${label} · solver residual; edit or delete this constraint`
                          : defined
                            ? `${label} · fully defined`
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
                            data-conflicted={conflicted ? 'true' : undefined}
                            data-defined={defined ? 'true' : undefined}
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
      </aside>
    ) : null;

  // The rail is one icon column, the verb rail's twin: draw, modify, then
  // solve and the utilities, then the palette. What changes with the pick
  // (the entity editor) and the palette open beside it as flyouts, so the
  // rail never grows. The relations live on their own rail on the right
  // (SketchRelationsRail); Finish is the column's foot, under the rail.
  return (
    <>
      <div
        className="sketch-rail"
        role="toolbar"
        aria-label="Sketch tools"
        aria-orientation="vertical"
      >
        <div className="sketch-rail-group draw">{drawTools}</div>
        <span className="sketch-rail-divider" aria-hidden="true" />
        <div className="sketch-rail-group modify">{modifyTools}</div>
        <span className="sketch-rail-divider" aria-hidden="true" />
        <div className="sketch-rail-group utility">
          {utilityTools}
          {solveTools}
        </div>
        {paletteButton && (
          <>
            <span className="sketch-rail-divider" aria-hidden="true" />
            <div className="sketch-rail-group palette">{paletteButton}</div>
          </>
        )}
      </div>
      <div className="sketch-flyouts" data-rail-flyouts="">
        {entityEditor}
        {palette}
      </div>
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
            : `Does not apply to ${/^[aeiou]/i.test(selection.kind) ? 'an' : 'a'} ${selection.kind}.`;
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
