import {
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode
} from 'react';
import {
  Crosshair,
  CircleDot,
  Construction,
  Columns3,
  Diameter,
  Ellipse,
  Ellipsis,
  FlipHorizontal2,
  Grid3x3,
  Hexagon,
  Layers3,
  Link2,
  Link2Off,
  Magnet,
  MousePointer2,
  Minus,
  Play,
  Projector,
  Radius,
  RotateCw,
  ScanSearch,
  Scissors,
  Slice,
  Spline,
  Square,
  SquareDashed,
  SquareDot,
  SquareRoundCorner,
  Trash2,
  Type,
  Waypoints
} from 'lucide-react';
import {
  MAX_SKETCH_POLYGON_SIDES,
  type AppSettings,
  type SketchProjectionMode
} from '@openzcad/shared';
import {
  nextSketchCircleMode,
  nextSketchCurveMode,
  nextSketchRectangleMode,
  sketchCurveModeFor,
  sketchCurveModeTool,
  type PendingSketchConstraint,
  type PendingSketchEdit,
  type SketchCircleMode,
  type SketchCurveMode,
  type SketchRectangleMode,
  type SketchConstraintToolKind,
  type SketchEditToolKind,
  type SketchOffsetOptions,
  type SketchToolId
} from '../lib/interaction/machine';
import { CONSTRAINT_TOOL_SPECS } from '../lib/sketch/constraints';
import type { SketchDefinedState } from '../lib/sketch/constraints';
import type { ConstraintInspectionTarget } from '../lib/sketch/constraintInspection';
import { SKETCH_EDIT_TOOL_SPECS } from '../lib/sketch/edits';
import { DEFAULT_SKETCH_OFFSET_OPTIONS } from '../lib/sketch/offset';
import { CONSTRAINT_ICONS } from './constraintIcons';
import { Tooltip } from './Tooltip';
import { SketchModifyFlyout } from './SketchModifyFlyout';
import { RelationGlyphFilter } from './RelationGlyphFilter';
import { useKeymap } from '../lib/keymap';
import { platformShortcutLabel } from '../lib/platformShortcut';

/** One row of the palette's constraint list, pre-rendered by App. */
export interface SketchConstraintListItem {
  constraintId: string;
  label: string;
  editable: boolean;
  targets?: ConstraintInspectionTarget[];
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
  referenceDimensions?: ReactNode;
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
  /** The Rectangle tool's type; absent is `corner`. */
  rectangleMode?: SketchRectangleMode;
  /** The Polygon tool's side count; absent is 6. */
  polygonSides?: number;
  /** The curve slot's type (I01); absent is each tool's first type. */
  curveMode?: SketchCurveMode;
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
  /** The Offset tool's corner join and chain setting; absent is the default. */
  offsetOptions?: SketchOffsetOptions;
  onOffsetOptions?(options: SketchOffsetOptions): void;
  constraints: SketchConstraintListItem[];
  selectedObjectId?: string | null;
  solveStatus: SketchSolveStatus | null;
  solving: boolean;
  onTool(tool: SketchToolId): void;
  onCircleMode(mode: SketchCircleMode): void;
  onRectangleMode?(mode: SketchRectangleMode): void;
  onPolygonSides?(sides: number): void;
  onCurveMode?(mode: SketchCurveMode): void;
  /** I01: the Project tool's linked/unlinked choice; absent is linked. */
  projectMode?: SketchProjectionMode;
  /** Arms the Project tool with that choice. */
  onProjectMode?(mode: SketchProjectionMode): void;
  onConstruction(value: boolean): void;
  onSettings(settings: AppSettings['sketching']): void;
  /** The hint travels with the tool: the rail already holds the specs. */
  onEditTool(kind: SketchEditToolKind | null, hint?: string): void;
  onEditConstraint(
    constraintId: string,
    anchor: { x: number; y: number }
  ): void;
  onDeleteConstraint(constraintId: string): void;
  onSelectConstraintObject(constraintId: string, objectId: string): void;
  onSolve(): void;
  onDiagnostics(): void;
  onExtrude(): void;
}

const TOOLS: {
  id: Exclude<
    SketchToolId,
    'circle' | 'rectangle' | 'polygon' | 'ellipse' | 'spline' | 'project'
  >;
  label: string;
  /** The keymap command whose live key the tooltip names. */
  command: string;
  icon: typeof Minus;
}[] = [
  {
    id: 'select',
    label: 'Select',
    command: 'sketch-select',
    icon: MousePointer2
  },
  { id: 'line', label: 'Line', command: 'sketch-line', icon: Minus },
  { id: 'arc', label: 'Arc', command: 'sketch-arc', icon: Waypoints },
  { id: 'text', label: 'Text', command: 'sketch-text', icon: Type }
];

/** The Project tool's two modes, in the order its strip shows them. */
const PROJECT_MODES: {
  mode: SketchProjectionMode;
  label: string;
  tile: string;
  detail: string;
  icon: typeof Minus;
}[] = [
  {
    mode: 'linked',
    label: 'Linked projection',
    tile: 'Linked',
    detail:
      'Follows its model edge through later edits; shows broken if the edge goes away.',
    icon: Link2
  },
  {
    mode: 'unlinked',
    label: 'Unlinked projection',
    tile: 'Unlinked',
    detail: 'Copies the edge once as ordinary, editable sketch geometry.',
    icon: Link2Off
  }
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
    label: 'Center circle',
    tile: 'Center',
    detail: 'Center and radius',
    icon: CircleDot
  },
  {
    mode: 'two-point-diameter',
    label: 'Diameter circle',
    tile: 'Diameter',
    detail: 'Opposite diameter endpoints',
    icon: Diameter
  },
  {
    mode: 'three-point',
    label: 'Three-point circle',
    tile: '3 points',
    detail: 'Three circumference points',
    icon: ThreePointCircle
  }
];

/** A rectangle placed by one side's two ends and a third point. */
function ThreePointRectangle({ size }: { size: number }) {
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
      <path d="M4 15 13 4l7 6-9 11Z" />
      <circle cx="4" cy="15" r="1" fill="currentColor" />
      <circle cx="13" cy="4" r="1" fill="currentColor" />
      <circle cx="20" cy="10" r="1" fill="currentColor" />
    </svg>
  );
}

/**
 * The shape slot's types: the rectangle's three, then the polygon, which is
 * its own tool sharing the slot. Every one draws real lines held by
 * relations and named as one object.
 */
const SHAPE_MODES: {
  mode: SketchRectangleMode | 'polygon';
  label: string;
  tile: string;
  detail: string;
  icon: typeof Square | typeof ThreePointRectangle;
}[] = [
  {
    mode: 'corner',
    label: 'Rectangle',
    tile: 'Corner',
    detail: 'Two opposite corners',
    icon: Square
  },
  {
    mode: 'center',
    label: 'Center rectangle',
    tile: 'Center',
    detail: 'Center, then a corner',
    icon: SquareDot
  },
  {
    mode: 'three-point',
    label: 'Three-point rectangle',
    tile: '3 points',
    detail: 'One side, then the height',
    icon: ThreePointRectangle
  },
  {
    mode: 'polygon',
    label: 'Polygon',
    tile: 'Polygon',
    detail: 'Center, then a vertex on the circumcircle',
    icon: Hexagon
  }
];

/** An elliptical arc between its two ends, drawn like lucide. */
function EllipticalArc({ size }: { size: number }) {
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
      <path d="M2 12a10 6 0 0 1 20 0" />
      <circle cx="2" cy="12" r="1" fill="currentColor" />
      <circle cx="22" cy="12" r="1" fill="currentColor" />
    </svg>
  );
}

/** A curve under its control polygon. */
function ControlSpline({ size }: { size: number }) {
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
      <path d="M3 20 8 5l8 14 5-15" strokeDasharray="2 3" strokeWidth={1.5} />
      <path d="M3 20C6 9 10 9 12 13s5 4 9-9" />
    </svg>
  );
}

/**
 * The curve slot's types (I01): the Ellipse tool's two and the Spline
 * tool's two, sharing one rail slot the way the rectangle and polygon do.
 */
const CURVE_MODES: {
  mode: SketchCurveMode;
  label: string;
  tile: string;
  detail: string;
  icon: typeof Ellipse | typeof EllipticalArc;
}[] = [
  {
    mode: 'ellipse',
    label: 'Ellipse',
    tile: 'Ellipse',
    detail: 'Center, an axis end, then the other radius',
    icon: Ellipse
  },
  {
    mode: 'elliptical-arc',
    label: 'Elliptical arc',
    tile: 'Arc',
    detail: 'An ellipse, then the arc’s start and end',
    icon: EllipticalArc
  },
  {
    mode: 'fit-spline',
    label: 'Fit spline',
    tile: 'Fit',
    detail: 'A smooth curve through every point',
    icon: Spline
  },
  {
    mode: 'control-spline',
    label: 'Control-point spline',
    tile: 'Control',
    detail: 'A cubic B-spline pulled by its control points',
    icon: ControlSpline
  }
];

function curveModeSpec(mode: SketchCurveMode) {
  return CURVE_MODES.find((spec) => spec.mode === mode) ?? CURVE_MODES[0]!;
}

const MIN_POLYGON_SIDES = 3;

function shapeModeSpec(mode: SketchRectangleMode | 'polygon') {
  return SHAPE_MODES.find((spec) => spec.mode === mode) ?? SHAPE_MODES[0]!;
}

/**
 * The polygon's side count as typed: the draft stays in the field while it
 * is on its way to valid ("", "1" on the way to "12"), and only a whole
 * number the document accepts is committed.
 */
function PolygonSidesField({
  value,
  onCommit
}: {
  value: number;
  onCommit(value: number): void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <label className="sketch-type-sides">
      <span>Sides</span>
      <input
        type="number"
        min={MIN_POLYGON_SIDES}
        max={MAX_SKETCH_POLYGON_SIDES}
        step="1"
        inputMode="numeric"
        value={draft ?? String(value)}
        aria-label="Polygon sides"
        onChange={(event) => {
          const text = event.currentTarget.value;
          setDraft(text);
          const next = Number(text);
          if (
            Number.isInteger(next) &&
            next >= MIN_POLYGON_SIDES &&
            next <= MAX_SKETCH_POLYGON_SIDES
          ) {
            onCommit(next);
          }
        }}
        onBlur={() => setDraft(null)}
      />
    </label>
  );
}

const EDIT_TOOL_ICONS: Record<SketchEditToolKind, typeof Minus> = {
  fillet: Radius,
  chamfer: Slice,
  offset: SquareDashed,
  trim: Scissors,
  mirror: FlipHorizontal2,
  'linear-pattern': Columns3,
  'circular-pattern': RotateCw
};

/**
 * Fillet and Chamfer keep their own rail slots; the rest of the modify tools
 * share one, opening beside the rail. The rail is a fixed column with no
 * room left, so a new modify tool joins this fold rather than the column.
 */
const FOLDED_EDIT_TOOLS = new Set<SketchEditToolKind>([
  'offset',
  'trim',
  'mirror',
  'linear-pattern',
  'circular-pattern'
]);

/** Offset's corner joins, as its strip offers them. */
const OFFSET_JOINS = [
  {
    join: 'miter',
    label: 'Miter',
    detail: 'Straight neighbours extend to a sharp corner',
    icon: Square
  },
  {
    join: 'round',
    label: 'Round',
    detail: 'An arc about the source corner joins the neighbours',
    icon: SquareRoundCorner
  }
] as const;

function circleModeSpec(mode: SketchCircleMode) {
  return CIRCLE_MODES.find((spec) => spec.mode === mode) ?? CIRCLE_MODES[0]!;
}

/**
 * The live draw tool as the rail names it: the circle by its type, every
 * other tool by its tooltip's name.
 */
export function sketchDrawToolLabel(
  tool: SketchToolId,
  circleMode: SketchCircleMode,
  rectangleMode: SketchRectangleMode = 'corner',
  curveMode?: SketchCurveMode
): string {
  return tool === 'circle'
    ? circleModeSpec(circleMode).label
    : tool === 'rectangle'
      ? shapeModeSpec(rectangleMode).label
      : tool === 'polygon'
        ? shapeModeSpec('polygon').label
        : tool === 'ellipse' || tool === 'spline'
          ? curveModeSpec(sketchCurveModeFor(tool, curveMode)).label
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
  referenceDimensions,
  entityEditor,
  sketchName,
  canExtrude = true,
  tool,
  circleMode,
  rectangleMode = 'corner',
  polygonSides = 6,
  curveMode,
  projectMode = 'linked',
  onProjectMode,
  construction,
  settings,
  units,
  paletteVisible,
  paletteOpen: paletteOpenProp,
  onTogglePalette,
  canConstrain,
  pendingEdit,
  offsetOptions = DEFAULT_SKETCH_OFFSET_OPTIONS,
  onOffsetOptions,
  constraints,
  selectedObjectId,
  solveStatus,
  solving,
  onTool,
  onCircleMode,
  onRectangleMode,
  onPolygonSides,
  onCurveMode,
  onConstruction,
  onSettings,
  onEditTool,
  onEditConstraint,
  onDeleteConstraint,
  onSelectConstraintObject,
  onSolve,
  onDiagnostics,
  onExtrude
}: SketchToolRailProps) {
  const keymap = useKeymap();
  const circleKey = keymap.label('sketch-circle');
  const rectangleKey = keymap.label('sketch-rectangle');
  const polygonKey = keymap.label('sketch-polygon');
  const ellipseKey = keymap.label('sketch-ellipse');
  const splineKey = keymap.label('sketch-spline');
  const projectKey = keymap.label('sketch-project');
  // The sketch's overview and settings open beside the rail; closed until asked.
  const [paletteOpenState, setPaletteOpenState] = useState(false);
  const paletteOpen = paletteOpenProp ?? paletteOpenState;
  const togglePalette = () =>
    onTogglePalette ? onTogglePalette() : setPaletteOpenState((open) => !open);
  const constraintGroupRef = useRef<HTMLFieldSetElement>(null);
  const [modifyOpen, setModifyOpen] = useState(false);
  const modifyTriggerRef = useRef<HTMLButtonElement>(null);
  const modifyGroupId = useId();
  const reviewRequested = useRef(false);
  const [inspectedConstraintId, setInspectedConstraintId] = useState<
    string | null
  >(null);
  const focusConstraints = () => {
    constraintGroupRef.current?.focus();
    constraintGroupRef.current?.scrollIntoView?.({ block: 'nearest' });
  };
  useEffect(() => {
    if (paletteOpen && reviewRequested.current) {
      reviewRequested.current = false;
      constraintGroupRef.current?.focus();
      constraintGroupRef.current?.scrollIntoView?.({ block: 'nearest' });
    }
  }, [paletteOpen]);
  const reviewConstraints = () => {
    if (paletteOpen) {
      focusConstraints();
    } else {
      reviewRequested.current = true;
      togglePalette();
    }
  };
  const warning = solveStatus?.tone === 'warn';
  // Only rows still present in the live sketch can be recovery targets. A
  // refused prospective dimension may have residuals for its uncommitted ID.
  const hasAttributedConflict = constraints.some((item) => item.conflicted);
  const solveExplanation = warning
    ? hasAttributedConflict
      ? 'Marked constraints have measured residuals. Show their geometry, then edit a value or delete a relation.'
      : 'The solver did not identify a conflicting constraint. Review the relations below.'
    : solveStatus?.definedState === 'fully-defined'
      ? 'All sketch geometry is fully constrained.'
      : solveStatus?.definedState === 'under-defined'
        ? 'Remaining freedom is reported for the whole sketch, not individual entities.'
        : null;
  const patchSettings = (patch: Partial<AppSettings['sketching']>) =>
    onSettings({ ...settings, ...patch });

  // Icon-only, like the verb rail: the name and key ride the tooltip, and
  // the accessible name is the tool's name alone.
  const drawTool = ({
    id,
    label,
    command,
    icon: Icon
  }: (typeof TOOLS)[number]) => {
    // An armed modify tool picks through Select's hit-testing, so the
    // machine parks the tool there; the rail lights the modify tool alone
    // rather than Select beside it as a second live tool.
    const on = tool === id && !(id === 'select' && pendingEdit);
    return (
      <Tooltip key={id} label={label} shortcut={keymap.label(command)}>
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
  const shapeOn = tool === 'rectangle' || tool === 'polygon';
  const shapeSpec = shapeModeSpec(
    tool === 'polygon' ? 'polygon' : rectangleMode
  );
  const ShapeIcon = shapeSpec.icon;
  const curveOn = tool === 'ellipse' || tool === 'spline';
  const curveSpec = curveModeSpec(
    curveOn ? sketchCurveModeFor(tool, curveMode) : (curveMode ?? 'ellipse')
  );
  const CurveIcon = curveSpec.icon;
  const curveKey =
    sketchCurveModeTool(curveSpec.mode) === 'ellipse' ? ellipseKey : splineKey;
  const chooseCurve = (mode: SketchCurveMode) => onCurveMode?.(mode);
  const drawTools = (
    <>
      {TOOLS.slice(0, 3).map(drawTool)}
      <span className="sketch-circle-tool">
        <Tooltip
          label={circleSpec.label}
          shortcut={circleKey}
          description={
            circleKey
              ? `${platformShortcutLabel(circleKey)} again steps through the circle types`
              : 'The type strip picks the circle type'
          }
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
            <Tooltip label="Next circle type" shortcut={circleKey}>
              <button
                type="button"
                className="sketch-type-cycle"
                aria-label="Next circle type"
                onClick={() => onCircleMode(nextSketchCircleMode(circleMode))}
              >
                {circleKey ? (
                  <kbd>{platformShortcutLabel(circleKey)}</kbd>
                ) : (
                  <RotateCw size={12} aria-hidden="true" />
                )}
              </button>
            </Tooltip>
          </span>
        ) : null}
      </span>
      <span className="sketch-circle-tool">
        <Tooltip
          label={shapeSpec.label}
          shortcut={tool === 'polygon' ? polygonKey : rectangleKey}
          description={
            rectangleKey
              ? `${platformShortcutLabel(rectangleKey)} again steps through the rectangle types`
              : 'The type strip picks the rectangle type or the polygon'
          }
        >
          <button
            type="button"
            className={shapeOn ? 'active' : undefined}
            aria-pressed={shapeOn}
            aria-label={shapeSpec.mode === 'polygon' ? 'Polygon' : 'Rectangle'}
            onClick={() =>
              onTool(shapeSpec.mode === 'polygon' ? 'polygon' : 'rectangle')
            }
          >
            <ShapeIcon size={16} aria-hidden="true" />
          </button>
        </Tooltip>
        {shapeOn ? (
          // Like the circle's strip: the types ride beside the rail while a
          // shape tool is live, and leave with it.
          <span
            className="sketch-type-strip"
            role="radiogroup"
            aria-label="Shape type"
            data-rail-flyout=""
          >
            {SHAPE_MODES.map(
              ({ mode, label, tile, detail, icon: Icon }, index) => {
                const checked = shapeSpec.mode === mode;
                const choose = (
                  choice: (typeof SHAPE_MODES)[number]['mode']
                ) =>
                  choice === 'polygon'
                    ? onTool('polygon')
                    : onRectangleMode?.(choice);
                return (
                  <Tooltip key={mode} label={label} description={detail}>
                    <button
                      type="button"
                      role="radio"
                      aria-checked={checked}
                      tabIndex={checked ? 0 : -1}
                      className={`sketch-type-tile${checked ? ' active' : ''}`}
                      onClick={() => choose(mode)}
                      onKeyDown={(event) => {
                        const next = radioGroupKeyStep(
                          event,
                          SHAPE_MODES.length,
                          index
                        );
                        if (next !== null) {
                          choose(SHAPE_MODES[next]!.mode);
                        }
                      }}
                    >
                      <Icon size={16} aria-hidden="true" />
                      <span>{tile}</span>
                    </button>
                  </Tooltip>
                );
              }
            )}
            {tool === 'polygon' ? (
              <PolygonSidesField
                value={polygonSides}
                onCommit={(sides) => onPolygonSides?.(sides)}
              />
            ) : (
              <Tooltip label="Next rectangle type" shortcut={rectangleKey}>
                <button
                  type="button"
                  className="sketch-type-cycle"
                  aria-label="Next rectangle type"
                  onClick={() =>
                    onRectangleMode?.(nextSketchRectangleMode(rectangleMode))
                  }
                >
                  {rectangleKey ? (
                    <kbd>{platformShortcutLabel(rectangleKey)}</kbd>
                  ) : (
                    <RotateCw size={12} aria-hidden="true" />
                  )}
                </button>
              </Tooltip>
            )}
          </span>
        ) : null}
      </span>
      <span className="sketch-circle-tool">
        <Tooltip
          label={curveSpec.label}
          shortcut={curveKey}
          description={
            curveKey
              ? `${platformShortcutLabel(curveKey)} again steps to the tool’s other type`
              : 'The type strip picks an ellipse or a spline'
          }
        >
          <button
            type="button"
            className={curveOn ? 'active' : undefined}
            aria-pressed={curveOn}
            aria-label={`Curve: ${curveSpec.label}`}
            onClick={() => chooseCurve(curveSpec.mode)}
          >
            <CurveIcon size={16} aria-hidden="true" />
          </button>
        </Tooltip>
        {curveOn ? (
          // Like the shape slot: the types ride beside the rail while the
          // ellipse or spline tool is live, and leave with it.
          <span
            className="sketch-type-strip"
            role="radiogroup"
            aria-label="Curve type"
            data-rail-flyout=""
          >
            {CURVE_MODES.map(
              ({ mode, label, tile, detail, icon: Icon }, index) => {
                const checked = curveSpec.mode === mode;
                return (
                  <Tooltip key={mode} label={label} description={detail}>
                    <button
                      type="button"
                      role="radio"
                      aria-checked={checked}
                      tabIndex={checked ? 0 : -1}
                      className={`sketch-type-tile${checked ? ' active' : ''}`}
                      onClick={() => chooseCurve(mode)}
                      onKeyDown={(event) => {
                        const next = radioGroupKeyStep(
                          event,
                          CURVE_MODES.length,
                          index
                        );
                        if (next !== null) {
                          chooseCurve(CURVE_MODES[next]!.mode);
                        }
                      }}
                    >
                      <Icon size={16} aria-hidden="true" />
                      <span>{tile}</span>
                    </button>
                  </Tooltip>
                );
              }
            )}
            <Tooltip label="Next curve type" shortcut={curveKey}>
              <button
                type="button"
                className="sketch-type-cycle"
                aria-label="Next curve type"
                onClick={() => chooseCurve(nextSketchCurveMode(curveSpec.mode))}
              >
                {curveKey ? (
                  <kbd>{platformShortcutLabel(curveKey)}</kbd>
                ) : (
                  <RotateCw size={12} aria-hidden="true" />
                )}
              </button>
            </Tooltip>
          </span>
        ) : null}
      </span>
      {TOOLS.slice(3).map(drawTool)}
      <span className="sketch-circle-tool">
        <Tooltip
          label="Project edges"
          shortcut={projectKey}
          description={
            projectKey
              ? `Click a model edge, or a face for its boundary. ${platformShortcutLabel(projectKey)} again steps between linked and unlinked`
              : 'Click a model edge, or a face for its boundary'
          }
        >
          <button
            type="button"
            className={tool === 'project' ? 'active' : undefined}
            aria-pressed={tool === 'project'}
            aria-label="Project edges"
            onClick={() => onProjectMode?.(projectMode)}
          >
            <Projector size={16} aria-hidden="true" />
          </button>
        </Tooltip>
        {tool === 'project' ? (
          <span
            className="sketch-type-strip"
            role="radiogroup"
            aria-label="Projection link"
            data-rail-flyout=""
          >
            {PROJECT_MODES.map(
              ({ mode, label, tile, detail, icon: Icon }, index) => {
                const checked = projectMode === mode;
                return (
                  <Tooltip key={mode} label={label} description={detail}>
                    <button
                      type="button"
                      role="radio"
                      aria-checked={checked}
                      tabIndex={checked ? 0 : -1}
                      className={`sketch-type-tile${checked ? ' active' : ''}`}
                      onClick={() => onProjectMode?.(mode)}
                      onKeyDown={(event) => {
                        const next = radioGroupKeyStep(
                          event,
                          PROJECT_MODES.length,
                          index
                        );
                        if (next !== null) {
                          onProjectMode?.(PROJECT_MODES[next]!.mode);
                        }
                      }}
                    >
                      <Icon size={16} aria-hidden="true" />
                      <span>{tile}</span>
                    </button>
                  </Tooltip>
                );
              }
            )}
          </span>
        ) : null}
      </span>
    </>
  );
  const editTool = (
    { kind, label, hint }: (typeof SKETCH_EDIT_TOOL_SPECS)[number],
    inFold: boolean
  ) => {
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
          className={
            inFold
              ? `sketch-modify-item${active ? ' active' : ''}`
              : active
                ? 'active'
                : undefined
          }
          aria-pressed={active}
          aria-label={label}
          disabled={!canConstrain}
          onClick={() => {
            if (inFold) setModifyOpen(false);
            if (active) onEditTool(null);
            else onEditTool(kind, hint);
          }}
        >
          <Icon size={16} aria-hidden="true" />
          {inFold && <span aria-hidden="true">{label}</span>}
        </button>
      </Tooltip>
    );
  };
  const foldArmed =
    pendingEdit !== null && FOLDED_EDIT_TOOLS.has(pendingEdit.kind);
  const modifyTools = (
    <>
      {SKETCH_EDIT_TOOL_SPECS.filter(
        ({ kind }) => !FOLDED_EDIT_TOOLS.has(kind)
      ).map((spec) => editTool(spec, false))}
      <span
        className="sketch-modify-tool"
        // Escape closes the fold from the toggle as well as from inside.
        onKeyDown={(event) => {
          if (event.key === 'Escape' && modifyOpen) {
            event.stopPropagation();
            setModifyOpen(false);
          }
        }}
      >
        <Tooltip
          label="More modify tools"
          description="Offset, trim, mirror and patterns"
        >
          <button
            type="button"
            className={foldArmed ? 'active' : undefined}
            aria-label="More modify tools"
            ref={modifyTriggerRef}
            aria-expanded={modifyOpen}
            aria-controls={modifyOpen ? modifyGroupId : undefined}
            onClick={() => setModifyOpen((open) => !open)}
          >
            <Ellipsis size={16} aria-hidden="true" />
          </button>
        </Tooltip>
        {modifyOpen && (
          <SketchModifyFlyout
            anchorRef={modifyTriggerRef}
            id={modifyGroupId}
            onClose={() => setModifyOpen(false)}
          >
            {SKETCH_EDIT_TOOL_SPECS.filter(({ kind }) =>
              FOLDED_EDIT_TOOLS.has(kind)
            ).map((spec) => editTool(spec, true))}
          </SketchModifyFlyout>
        )}
        {pendingEdit?.kind === 'offset' && !modifyOpen ? (
          // Like the circle's types: Offset's settings ride beside its slot
          // while it is armed, and leave with it. They apply to the next pick.
          <span
            className="sketch-type-strip"
            role="group"
            aria-label="Offset options"
            data-rail-flyout=""
          >
            <span
              className="sketch-offset-joins"
              role="radiogroup"
              aria-label="Offset corners"
            >
              {OFFSET_JOINS.map(
                ({ join, label, detail, icon: Icon }, index) => {
                  const checked = offsetOptions.join === join;
                  return (
                    <Tooltip key={join} label={label} description={detail}>
                      <button
                        type="button"
                        role="radio"
                        aria-checked={checked}
                        tabIndex={checked ? 0 : -1}
                        className={`sketch-type-tile${checked ? ' active' : ''}`}
                        onClick={() =>
                          onOffsetOptions?.({ ...offsetOptions, join })
                        }
                        onKeyDown={(event) => {
                          const next = radioGroupKeyStep(
                            event,
                            OFFSET_JOINS.length,
                            index
                          );
                          if (next !== null) {
                            onOffsetOptions?.({
                              ...offsetOptions,
                              join: OFFSET_JOINS[next]!.join
                            });
                          }
                        }}
                      >
                        <Icon size={16} aria-hidden="true" />
                        <span>{label}</span>
                      </button>
                    </Tooltip>
                  );
                }
              )}
            </span>
            <Tooltip
              label="Chain"
              description="On, a pick offsets every curve joined end to end with it. Off, only the picked curve."
            >
              <button
                type="button"
                aria-pressed={offsetOptions.chain}
                className={`sketch-type-tile${offsetOptions.chain ? ' active' : ''}`}
                onClick={() =>
                  onOffsetOptions?.({
                    ...offsetOptions,
                    chain: !offsetOptions.chain
                  })
                }
              >
                <Link2 size={16} aria-hidden="true" />
                <span>Chain</span>
              </button>
            </Tooltip>
          </span>
        ) : null}
      </span>
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
      {!warning && (
        <span
          className="sketch-solve-pill visually-hidden"
          data-tone={solveStatus?.tone}
          role="status"
        >
          {solveStatus?.label ?? ''}
        </span>
      )}
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
        shortcut={keymap.label('sketch-extrude')}
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
            <label className="sketch-palette-number sketch-palette-select">
              <span>Relation glyphs</span>
              <select
                value={settings.relationGlyphs}
                onChange={(event) =>
                  patchSettings({
                    relationGlyphs: event.currentTarget
                      .value as AppSettings['sketching']['relationGlyphs']
                  })
                }
              >
                <option value="always">Always</option>
                <option value="selected">Selected</option>
                <option value="hidden">Hidden</option>
              </select>
            </label>
            <RelationGlyphFilter
              hidden={settings.hiddenRelationGlyphs}
              disabled={settings.relationGlyphs === 'hidden'}
              onChange={(hiddenRelationGlyphs) =>
                patchSettings({ hiddenRelationGlyphs })
              }
            />
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
          {constraints.length > 0 || solveStatus ? (
            <fieldset ref={constraintGroupRef} tabIndex={-1}>
              <legend>Constraints</legend>
              {solveStatus && (
                <div
                  className="sketch-constraint-explanation"
                  data-tone={solveStatus.tone}
                >
                  <strong>{solveStatus.label}</strong>
                  {solveExplanation && <p>{solveExplanation}</p>}
                </div>
              )}
              <ul className="sketch-constraint-list">
                {constraints.map(
                  ({
                    constraintId,
                    label,
                    editable,
                    conflicted,
                    defined,
                    targets = []
                  }) => (
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
                      <Tooltip label={`Show geometry for constraint: ${label}`}>
                        <button
                          type="button"
                          className="sketch-constraint-show"
                          aria-label={`Show geometry for constraint: ${label}`}
                          aria-expanded={inspectedConstraintId === constraintId}
                          disabled={solving}
                          onClick={() =>
                            setInspectedConstraintId((current) =>
                              current === constraintId ? null : constraintId
                            )
                          }
                        >
                          <ScanSearch size={14} aria-hidden="true" />
                        </button>
                      </Tooltip>
                      <Tooltip label={`Delete constraint: ${label}`}>
                        <button
                          type="button"
                          className="row-delete"
                          aria-label={`Delete constraint: ${label}`}
                          disabled={solving}
                          onClick={() => onDeleteConstraint(constraintId)}
                        >
                          <Trash2 size={12} aria-hidden="true" />
                        </button>
                      </Tooltip>
                      {inspectedConstraintId === constraintId && (
                        <div
                          className="sketch-constraint-targets"
                          role="group"
                          aria-label={`Geometry for constraint: ${label}`}
                        >
                          <span>Referenced geometry</span>
                          {targets.length === 0 ? (
                            <p>
                              The referenced geometry is no longer available.
                            </p>
                          ) : (
                            targets.map(({ objectId, label: targetLabel }) => (
                              <button
                                key={objectId}
                                type="button"
                                aria-label={`Select geometry: ${targetLabel}`}
                                aria-pressed={selectedObjectId === objectId}
                                disabled={solving}
                                onClick={() =>
                                  onSelectConstraintObject(
                                    constraintId,
                                    objectId
                                  )
                                }
                              >
                                {targetLabel}
                              </button>
                            ))
                          )}
                        </div>
                      )}
                    </li>
                  )
                )}
              </ul>
            </fieldset>
          ) : null}
          {referenceDimensions}
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
        {warning && (
          <section
            className="sketch-solve-feedback"
            aria-label="Constraint feedback"
          >
            <p role="status">{solveStatus.label}</p>
            <button type="button" onClick={reviewConstraints}>
              Review constraints
            </button>
          </section>
        )}
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
/**
 * The point relations share one rail slot: four more icons ran the relations
 * column onto the view cube and over the canvas. They are point-first picks,
 * so a selected entity never fits them and nothing is lost by folding them.
 */
const POINT_RELATIONS = new Set<SketchConstraintToolKind>([
  'symmetric',
  'point-on-object',
  'lock',
  'disconnect'
]);

export function SketchRelationsRail({
  canConstrain,
  pendingConstraint,
  selection,
  onConstraintTool,
  onSelectionConstraintTool
}: SketchRelationsRailProps) {
  const reasonId = useId();
  const groupId = useId();
  const [pointsOpen, setPointsOpen] = useState(false);
  const pointArmed =
    pendingConstraint !== null && POINT_RELATIONS.has(pendingConstraint.kind);

  function relation(
    { kind, label, hint }: (typeof CONSTRAINT_TOOL_SPECS)[number],
    inGroup: boolean
  ) {
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
        {!inGroup && RELATION_GROUP_STARTS.has(kind) && (
          <span className="sketch-relations-divider" aria-hidden="true" />
        )}
        <Tooltip label={label} description={reason ?? hint}>
          <button
            type="button"
            className={`${inGroup ? 'sketch-point-relation' : 'sketch-relation'}${armed ? ' active' : ''}`}
            aria-pressed={armed}
            aria-label={label}
            aria-describedby={reason ? `${reasonId}-${kind}` : undefined}
            // An armed relation can always be put down again.
            disabled={reason !== null && !armed}
            onClick={() => {
              if (inGroup) setPointsOpen(false);
              if (selection && !armed) onSelectionConstraintTool(kind);
              else onConstraintTool(armed ? null : kind);
            }}
          >
            <Icon size={16} aria-hidden="true" />
            {inGroup ? (
              <span aria-hidden="true">{label}</span>
            ) : (
              named && (
                <span className="sketch-relation-name" aria-hidden="true">
                  {label}
                </span>
              )
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
  }

  return (
    <div
      className="sketch-relations"
      role="toolbar"
      aria-label="Relations"
      aria-orientation="vertical"
    >
      {CONSTRAINT_TOOL_SPECS.filter(
        ({ kind }) => !POINT_RELATIONS.has(kind)
      ).map((spec) => relation(spec, false))}
      <span
        className="sketch-relation-slot sketch-point-relations-anchor"
        // Escape closes the flyout from the toggle as well as from inside.
        onKeyDown={(event) => {
          if (event.key === 'Escape' && pointsOpen) {
            event.stopPropagation();
            setPointsOpen(false);
          }
        }}
      >
        <span className="sketch-relations-divider" aria-hidden="true" />
        <Tooltip
          label="Point relations"
          description="Symmetric, point on curve, lock and disconnect"
        >
          <button
            type="button"
            className={`sketch-relation${pointArmed ? ' active' : ''}`}
            aria-label="Point relations"
            aria-expanded={pointsOpen}
            aria-controls={pointsOpen ? groupId : undefined}
            onClick={() => setPointsOpen((open) => !open)}
          >
            <Crosshair size={16} aria-hidden="true" />
          </button>
        </Tooltip>
        {pointsOpen && (
          <div
            id={groupId}
            className="sketch-point-relations"
            role="group"
            aria-label="Point relations"
          >
            {CONSTRAINT_TOOL_SPECS.filter(({ kind }) =>
              POINT_RELATIONS.has(kind)
            ).map((spec) => relation(spec, true))}
          </div>
        )}
      </span>
    </div>
  );
}
