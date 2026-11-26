import {
  Check,
  ChevronLeft,
  ClipboardPaste,
  Construction,
  Copy,
  Layers3,
  LayoutGrid,
  Link2,
  Play,
  Projector,
  Ruler,
  ScanSearch,
  SquareMousePointer
} from 'lucide-react';
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode
} from 'react';
import { createPortal } from 'react-dom';
import type { SketchProjectionMode } from '@openzcad/shared';
import type {
  PendingSketchConstraint,
  PendingSketchEdit,
  SketchCircleMode,
  SketchConstraintToolKind,
  SketchCurveMode,
  SketchEditToolKind,
  SketchModifyOptions,
  SketchPatternOrientation,
  SketchPatternSpacing,
  SketchRectangleMode,
  SketchToolId
} from '../../lib/interaction/machine';
import { sketchCurveModeFor } from '../../lib/interaction/machine';
import { CONSTRAINT_TOOL_SPECS } from '../../lib/sketch/constraints';
import {
  SKETCH_EDIT_TOOL_SPECS,
  sketchMirrorSetHint,
  sketchPatternSetHint
} from '../../lib/sketch/edits';
import { DEFAULT_SKETCH_OFFSET_OPTIONS } from '../../lib/sketch/offset';
import { CONSTRAINT_ICONS } from '../constraintIcons';
import {
  CIRCLE_MODES,
  CURVE_MODES,
  EDIT_TOOL_ICONS,
  OFFSET_JOINS,
  PATTERN_ORIENTATIONS,
  PATTERN_SPACINGS,
  PolygonSidesField,
  PROJECT_MODES,
  radioGroupKeyStep,
  SHAPE_MODES,
  SKETCH_RAIL_TOOLS,
  SketchPaletteContent,
  type SketchPaletteContentProps
} from '../SketchToolRail';
import { SKETCH_SELECTION_PAGE, useCompactTray } from './compactSlots';
import { TrayPage, useTrayPagesLeaveWithTray } from './CompactTray';

/** The sketch tray's pages, by key. */
const TOOLS_PAGE = 'sketch-tools';
const TEXT_PAGE = 'sketch-text';

/** How long a press on a tool with types is held to open its chooser. */
export const SKETCH_LONG_PRESS_MS = 450;

/** The tray slots that carry types, each with a chooser in the tray. */
type VariantSlot = 'circle' | 'shape' | 'curve' | 'project';

type ShapeMode = (typeof SHAPE_MODES)[number]['mode'];

export interface CompactSketchTrayProps {
  tool: SketchToolId;
  circleMode: SketchCircleMode;
  rectangleMode: SketchRectangleMode;
  polygonSides: number;
  curveMode?: SketchCurveMode;
  projectMode: SketchProjectionMode;
  construction: boolean;
  /** Null until the first entity commit creates the sketch node. */
  canConstrain: boolean;
  canExtrude: boolean;
  solving: boolean;
  pendingEdit: PendingSketchEdit | null;
  pendingConstraint: PendingSketchConstraint | null;
  /** Offset's and the patterns' settings; absent is the default. */
  modifyOptions?: SketchModifyOptions;
  /** How many entities are picked: Copy needs one, Mirror reads them. */
  selectedObjectCount: number;
  /**
   * The picked entity as the relations read it: its kind and the relations
   * that take it as their first pick. Null with nothing picked.
   */
  relationSelection: {
    kind: string;
    fitting: readonly SketchConstraintToolKind[];
  } | null;
  /** A spline is being placed: the tray offers ✓ to finish it. */
  splineInProgress: boolean;
  /** The sketch's plane and overview, at the head of the palette. */
  workflow: ReactNode;
  /** The palette's body: display, snapping, constraints and DOF. */
  palette: Omit<SketchPaletteContentProps, 'keyboardHelp'>;
  /** The picked entity's editor, on the selection page. */
  entityEditor: ReactNode;
  /** The Text tool's card while text is composed. */
  textCard: ReactNode;
  onTool(tool: SketchToolId): void;
  onCircleMode(mode: SketchCircleMode): void;
  onRectangleMode(mode: SketchRectangleMode): void;
  onPolygonSides(sides: number): void;
  onCurveMode(mode: SketchCurveMode): void;
  onProjectMode(mode: SketchProjectionMode): void;
  onFinishSpline(): void;
  onEditTool(kind: SketchEditToolKind | null, hint?: string): void;
  onModifyOptions(options: SketchModifyOptions): void;
  onConstruction(next: boolean): void;
  onDimension(): void;
  onSolve(): void;
  onDiagnostics(): void;
  onExtrude(): void;
  /** Arms (or, with null, disarms) a relation that collects its picks. */
  onConstraintTool(kind: SketchConstraintToolKind | null): void;
  /** Starts a relation from the pick: the picked entity is pick 1. */
  onSelectionConstraintTool(kind: SketchConstraintToolKind): void;
  onSelectAll(): void;
  onCopy(): void;
  onPaste(): void;
  /** A page opened: keep the model in view above the sheet. */
  onStageCovered?(): void;
}

/**
 * Opens on a long press as well as on a tap (`onLongPress`); the tap that
 * ends a long press is swallowed, so it does not also run `onPress`.
 */
function usePressAndHold(onLongPress: (() => void) | undefined) {
  const timer = useRef<number | null>(null);
  const held = useRef(false);
  const clear = () => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
  };
  useEffect(() => clear, []);
  if (!onLongPress) return { handlers: {}, consumeHold: () => false };
  return {
    handlers: {
      onPointerDown(event: ReactPointerEvent<HTMLButtonElement>) {
        if (event.button !== 0) return;
        held.current = false;
        clear();
        timer.current = window.setTimeout(() => {
          timer.current = null;
          held.current = true;
          onLongPress();
        }, SKETCH_LONG_PRESS_MS);
      },
      onPointerUp: clear,
      onPointerCancel: clear,
      onPointerLeave: clear,
      // A finger held down asks the browser for its menu too: not here.
      onContextMenu(event: { preventDefault(): void }) {
        event.preventDefault();
      }
    },
    consumeHold() {
      const was = held.current;
      held.current = false;
      return was;
    }
  };
}

function ToolButton({
  label,
  icon,
  active,
  hasTypes = false,
  onPress,
  onTypes
}: {
  label: string;
  icon: ReactNode;
  active: boolean;
  /** Its types open on a long press, or on a tap while it is live. */
  hasTypes?: boolean;
  onPress(): void;
  onTypes?(): void;
}) {
  const { handlers, consumeHold } = usePressAndHold(
    hasTypes ? onTypes : undefined
  );
  return (
    <button
      type="button"
      className={`compact-tray-button${hasTypes ? ' has-types' : ''}`}
      aria-label={label}
      aria-pressed={active}
      title={hasTypes ? `${label} · hold for types` : label}
      {...handlers}
      onClick={() => {
        if (consumeHold()) return;
        if (active && hasTypes && onTypes) onTypes();
        else onPress();
      }}
    >
      {icon}
    </button>
  );
}

/** One choice in a type chooser: an icon tile with the type's name. */
interface TypeChoice<T extends string> {
  value: T;
  label: string;
  icon: ReactNode;
}

/**
 * A slot's types in the tray's own row, in place of the tools: never over
 * the canvas, where a drawing tap would land on it. A choice arms the tool
 * with that type and gives the row back to the tools.
 */
function TypeChooser<T extends string>({
  label,
  choices,
  checked,
  onChoose,
  onClose,
  extra
}: {
  label: string;
  choices: readonly TypeChoice<T>[];
  checked: T;
  onChoose(value: T, viaKeys: boolean): void;
  onClose(): void;
  extra?: ReactNode;
}) {
  const groupRef = useRef<HTMLDivElement | null>(null);
  // Focus follows the chooser in, on the checked type.
  useLayoutEffect(() => {
    groupRef.current
      ?.querySelector<HTMLElement>('[aria-checked="true"]')
      ?.focus({ preventScroll: true });
  }, []);
  return (
    <>
      <button
        type="button"
        className="compact-tray-button"
        aria-label="Back to the sketch tools"
        onClick={onClose}
      >
        <ChevronLeft aria-hidden="true" />
      </button>
      <div
        ref={groupRef}
        className="compact-sketch-tools compact-sketch-types"
        role="radiogroup"
        aria-label={label}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.stopPropagation();
            onClose();
          }
        }}
      >
        {choices.map((choice, index) => {
          const on = choice.value === checked;
          return (
            <button
              key={choice.value}
              type="button"
              role="radio"
              className="compact-tray-button"
              aria-checked={on}
              aria-label={choice.label}
              title={choice.label}
              tabIndex={on ? 0 : -1}
              onClick={() => onChoose(choice.value, false)}
              onKeyDown={(event: KeyboardEvent<HTMLElement>) => {
                const next = radioGroupKeyStep(event, choices.length, index);
                if (next !== null) onChoose(choices[next]!.value, true);
              }}
            >
              {choice.icon}
            </button>
          );
        })}
        {extra}
      </div>
    </>
  );
}

function isShapeTool(tool: SketchToolId): tool is 'polygon' | 'slot' | 'point' {
  return tool === 'polygon' || tool === 'slot' || tool === 'point';
}

/** One action row in a sketch page. */
function ActionRow({
  label,
  icon,
  pressed,
  disabledReason,
  onPress
}: {
  label: string;
  icon: ReactNode;
  pressed?: boolean;
  disabledReason?: string | null;
  onPress(): void;
}) {
  return (
    <li>
      <button
        type="button"
        className="compact-menu-row"
        aria-label={label}
        disabled={Boolean(disabledReason)}
        title={disabledReason ?? undefined}
        {...(pressed === undefined ? {} : { 'aria-pressed': pressed })}
        onClick={onPress}
      >
        <span className="compact-menu-icon" aria-hidden="true">
          {icon}
        </span>
        <span className="compact-menu-label" aria-hidden="true">
          {label}
        </span>
        {pressed ? (
          <Check className="compact-menu-check" size={18} aria-hidden="true" />
        ) : null}
      </button>
    </li>
  );
}

/** The relations that fit the pick, plus the one armed. */
export function contextualRelations(
  selection: CompactSketchTrayProps['relationSelection'],
  pending: PendingSketchConstraint | null,
  canConstrain: boolean
): SketchConstraintToolKind[] {
  const fitting =
    selection && canConstrain
      ? CONSTRAINT_TOOL_SPECS.filter(({ kind }) =>
          selection.fitting.includes(kind)
        ).map(({ kind }) => kind)
      : [];
  if (pending && !fitting.includes(pending.kind)) fitting.push(pending.kind);
  return fitting;
}

/**
 * The sketch in the compact workspace (U12 slice 6). The tray at peek is
 * the draw tools as one scrolling row of 44 px icons, each type chosen in
 * the row itself (a long press, or a tap on the live tool); All sketch
 * tools opens the sheet's page with the modify tools, construction,
 * dimension, solve, diagnostics, extrude, the selection's actions, every
 * relation and the palette. The relations that fit the pick stand as chips
 * on the stage above the sheet, and nothing else: one that does not apply
 * is left out, not greyed. Each control runs the handler the regular
 * sketch rail runs.
 */
export function CompactSketchTray(props: CompactSketchTrayProps) {
  const {
    tool,
    circleMode,
    rectangleMode,
    polygonSides,
    curveMode,
    projectMode,
    pendingEdit,
    pendingConstraint,
    canConstrain,
    relationSelection,
    splineInProgress,
    textCard,
    onStageCovered
  } = props;
  const tray = useCompactTray();
  const page = tray?.page ?? null;
  useTrayPagesLeaveWithTray();
  const [chooser, setChooser] = useState<VariantSlot | null>(null);

  // A canvas press puts the tools back, as the rail's type strips fold.
  useEffect(() => {
    if (!chooser) return;
    const fold = (event: PointerEvent) => {
      const target = event.target;
      if (
        target instanceof HTMLCanvasElement &&
        target.closest('.viewer-host')
      ) {
        setChooser(null);
      }
    };
    document.addEventListener('pointerdown', fold, true);
    return () => document.removeEventListener('pointerdown', fold, true);
  }, [chooser]);

  // The Text tool's card is the sheet's page while text is composed, and
  // leaves with it.
  const textShown = Boolean(textCard);
  const textShownBefore = useRef(false);
  useEffect(() => {
    const was = textShownBefore.current;
    textShownBefore.current = textShown;
    if (textShown && !was) tray?.openPage(TEXT_PAGE, 'Text');
    else if (!textShown && was && tray?.page === TEXT_PAGE) tray.closePage();
  }, [textShown, tray]);

  const openTools = () =>
    page === TOOLS_PAGE
      ? tray?.closePage()
      : tray?.openPage(TOOLS_PAGE, 'Sketch');
  const backToCanvas = () => {
    if (page) tray?.closePage();
  };

  const shapeMode: ShapeMode = isShapeTool(tool) ? tool : rectangleMode;
  const shapeSpec =
    SHAPE_MODES.find((spec) => spec.mode === shapeMode) ?? SHAPE_MODES[0]!;
  const circleSpec =
    CIRCLE_MODES.find((spec) => spec.mode === circleMode) ?? CIRCLE_MODES[0]!;
  const curveOn = tool === 'ellipse' || tool === 'spline';
  const shownCurve = curveOn
    ? sketchCurveModeFor(tool, curveMode)
    : (curveMode ?? 'ellipse');
  const curveSpec =
    CURVE_MODES.find((spec) => spec.mode === shownCurve) ?? CURVE_MODES[0]!;
  const shapeOn = tool === 'rectangle' || isShapeTool(tool);
  // The polygon, slot and point are tools of their own in the shape slot;
  // the rectangle's types are one tool.
  const shapeTool: SketchToolId =
    shapeSpec.mode === 'polygon' ||
    shapeSpec.mode === 'slot' ||
    shapeSpec.mode === 'point'
      ? shapeSpec.mode
      : 'rectangle';
  const chooseShape = (mode: ShapeMode) =>
    mode === 'polygon' || mode === 'slot' || mode === 'point'
      ? props.onTool(mode)
      : props.onRectangleMode(mode);

  const drawTool = ({
    id,
    label,
    icon: Icon
  }: (typeof SKETCH_RAIL_TOOLS)[number]) => (
    <ToolButton
      key={id}
      label={label}
      icon={<Icon aria-hidden="true" />}
      // An armed modify tool picks through Select, which the rail does not
      // light as a second live tool.
      active={tool === id && !(id === 'select' && pendingEdit)}
      onPress={() => props.onTool(id)}
    />
  );

  const CircleIcon = circleSpec.icon;
  const ShapeIcon = shapeSpec.icon;
  const CurveIcon = curveSpec.icon;
  const tools = (
    <div className="compact-sketch-tools">
      {SKETCH_RAIL_TOOLS.slice(0, 3).map(drawTool)}
      <ToolButton
        label={`Circle: ${circleSpec.label}`}
        icon={<CircleIcon size={22} />}
        active={tool === 'circle'}
        hasTypes
        onPress={() => props.onTool('circle')}
        onTypes={() => setChooser('circle')}
      />
      <ToolButton
        label={shapeTool === 'rectangle' ? 'Rectangle' : shapeSpec.label}
        icon={<ShapeIcon size={22} />}
        active={shapeOn}
        hasTypes
        onPress={() => props.onTool(shapeTool)}
        onTypes={() => setChooser('shape')}
      />
      <ToolButton
        label={`Curve: ${curveSpec.label}`}
        icon={<CurveIcon size={22} />}
        active={curveOn}
        hasTypes
        onPress={() => props.onCurveMode(curveSpec.mode)}
        onTypes={() => setChooser('curve')}
      />
      {SKETCH_RAIL_TOOLS.slice(3).map(drawTool)}
      <ToolButton
        label="Project edges"
        icon={<Projector aria-hidden="true" />}
        active={tool === 'project'}
        hasTypes
        onPress={() => props.onProjectMode(projectMode)}
        onTypes={() => setChooser('project')}
      />
    </div>
  );

  const typeRow = (() => {
    const close = () => setChooser(null);
    switch (chooser) {
      case 'circle':
        return (
          <TypeChooser
            label="Circle type"
            choices={CIRCLE_MODES.map(({ mode, label, icon: Icon }) => ({
              value: mode,
              label,
              icon: <Icon size={22} />
            }))}
            checked={circleMode}
            onChoose={(mode, viaKeys) => {
              props.onCircleMode(mode);
              if (!viaKeys) close();
            }}
            onClose={close}
          />
        );
      case 'shape':
        return (
          <TypeChooser
            label="Shape type"
            choices={SHAPE_MODES.map(({ mode, label, icon: Icon }) => ({
              value: mode,
              label,
              icon: <Icon size={22} />
            }))}
            checked={shapeMode}
            onChoose={(mode, viaKeys) => {
              chooseShape(mode);
              // The polygon keeps the row: its side count is set here.
              if (!viaKeys && mode !== 'polygon') close();
            }}
            onClose={close}
            extra={
              tool === 'polygon' ? (
                <PolygonSidesField
                  value={polygonSides}
                  onCommit={props.onPolygonSides}
                />
              ) : null
            }
          />
        );
      case 'curve':
        return (
          <TypeChooser
            label="Curve type"
            choices={CURVE_MODES.map(({ mode, label, icon: Icon }) => ({
              value: mode,
              label,
              icon: <Icon size={22} />
            }))}
            checked={shownCurve}
            onChoose={(mode, viaKeys) => {
              props.onCurveMode(mode);
              if (!viaKeys) close();
            }}
            onClose={close}
          />
        );
      case 'project':
        return (
          <TypeChooser
            label="Projection link"
            choices={PROJECT_MODES.map(({ mode, label, icon: Icon }) => ({
              value: mode,
              label,
              icon: <Icon size={22} />
            }))}
            checked={projectMode}
            onChoose={(mode, viaKeys) => {
              props.onProjectMode(mode);
              if (!viaKeys) close();
            }}
            onClose={close}
          />
        );
      default:
        return null;
    }
  })();

  const relations = contextualRelations(
    relationSelection,
    pendingConstraint,
    canConstrain
  );
  const relationRow =
    tray?.stageHost && relations.length > 0
      ? createPortal(
          <div
            className="compact-relations"
            role="toolbar"
            aria-label="Relations"
          >
            {relations.map((kind) => {
              const spec = CONSTRAINT_TOOL_SPECS.find(
                (entry) => entry.kind === kind
              )!;
              const Icon = CONSTRAINT_ICONS[kind];
              const armed = pendingConstraint?.kind === kind;
              return (
                <button
                  key={kind}
                  type="button"
                  className="compact-relation-chip"
                  aria-label={spec.label}
                  aria-pressed={armed}
                  title={spec.hint}
                  onClick={() =>
                    relationSelection && !armed
                      ? props.onSelectionConstraintTool(kind)
                      : props.onConstraintTool(armed ? null : kind)
                  }
                >
                  <Icon size={18} aria-hidden="true" />
                  <span aria-hidden="true">{spec.label}</span>
                </button>
              );
            })}
          </div>,
          tray.stageHost
        )
      : null;

  return (
    <>
      <div
        className="compact-tray is-mode is-sketch"
        role="toolbar"
        aria-label="Sketch tools"
      >
        {splineInProgress ? (
          <button
            type="button"
            className="compact-tray-button is-confirm"
            aria-label="Finish spline"
            title="Finish the spline through the points placed"
            onClick={props.onFinishSpline}
          >
            <Check aria-hidden="true" />
          </button>
        ) : null}
        {typeRow ?? tools}
        <button
          type="button"
          className={`compact-tray-button${
            pendingEdit !== null ? ' is-on' : ''
          }`}
          aria-label="All sketch tools"
          aria-expanded={page === TOOLS_PAGE}
          data-tray-item={TOOLS_PAGE}
          onClick={openTools}
        >
          <LayoutGrid aria-hidden="true" />
        </button>
      </div>
      {relationRow}
      <TrayPage page={TOOLS_PAGE} onStageCovered={onStageCovered}>
        <div className="compact-sketch-page">
          <SketchToolsPage {...props} onDone={backToCanvas} />
        </div>
      </TrayPage>
      <TrayPage page={SKETCH_SELECTION_PAGE} onStageCovered={onStageCovered}>
        <div className="compact-sketch-page">
          <ul className="compact-menu" aria-label="Selection actions">
            <ClipboardRows {...props} />
          </ul>
          {props.entityEditor ? (
            <div className="compact-sheet-card">{props.entityEditor}</div>
          ) : null}
        </div>
      </TrayPage>
      <TrayPage page={TEXT_PAGE} onStageCovered={onStageCovered}>
        {textCard ? (
          <div className="compact-sketch-page">
            <div className="compact-sheet-card">{textCard}</div>
          </div>
        ) : null}
      </TrayPage>
    </>
  );
}

/** Select all, Copy and Paste: the keyboard's Ctrl+A, C and V by touch. */
function ClipboardRows({
  selectedObjectCount,
  canConstrain,
  onSelectAll,
  onCopy,
  onPaste
}: CompactSketchTrayProps) {
  return (
    <>
      <ActionRow
        label="Select all"
        icon={<SquareMousePointer size={18} />}
        disabledReason={canConstrain ? null : 'Draw an entity first.'}
        onPress={onSelectAll}
      />
      <ActionRow
        label="Copy"
        icon={<Copy size={18} />}
        disabledReason={
          selectedObjectCount > 0 ? null : 'Pick what to copy first.'
        }
        onPress={onCopy}
      />
      <ActionRow
        label="Paste"
        icon={<ClipboardPaste size={18} />}
        onPress={onPaste}
      />
    </>
  );
}

/**
 * All sketch tools: the modify tools (with an armed tool's options), the
 * sketch's own actions, the selection's actions, every relation and the
 * palette, in one page.
 */
function SketchToolsPage(props: CompactSketchTrayProps & { onDone(): void }) {
  const {
    canConstrain,
    canExtrude,
    solving,
    construction,
    pendingEdit,
    pendingConstraint,
    modifyOptions,
    selectedObjectCount,
    relationSelection,
    palette,
    workflow,
    onDone
  } = props;
  const constraintCount = palette.constraints.length;
  const editReason = canConstrain ? null : 'Draw an entity first.';
  const pickEdit = (kind: SketchEditToolKind, hint: string) => {
    if (pendingEdit?.kind === kind) {
      props.onEditTool(null);
      return;
    }
    props.onEditTool(
      kind,
      kind === 'mirror' && selectedObjectCount > 0
        ? sketchMirrorSetHint(selectedObjectCount)
        : (kind === 'linear-pattern' || kind === 'circular-pattern') &&
            selectedObjectCount > 0
          ? sketchPatternSetHint(kind, selectedObjectCount)
          : hint
    );
    // A tool with options keeps the page up to set them; the others go
    // straight to the canvas to pick on.
    if (
      kind !== 'offset' &&
      kind !== 'linear-pattern' &&
      kind !== 'circular-pattern'
    ) {
      onDone();
    }
  };
  return (
    <>
      <section className="compact-sketch-section" aria-label="Modify">
        <h3 className="compact-sketch-heading">Modify</h3>
        <div className="compact-choice-grid">
          {SKETCH_EDIT_TOOL_SPECS.map(({ kind, label, hint }) => {
            const Icon = EDIT_TOOL_ICONS[kind];
            return (
              <button
                key={kind}
                type="button"
                className="compact-choice"
                aria-label={label}
                aria-pressed={pendingEdit?.kind === kind}
                disabled={!canConstrain}
                title={editReason ?? hint}
                onClick={() => pickEdit(kind, hint)}
              >
                <Icon size={22} aria-hidden="true" />
                <span aria-hidden="true">{label}</span>
              </button>
            );
          })}
        </div>
        <ModifyOptions
          pendingEdit={pendingEdit}
          modifyOptions={modifyOptions}
          onModifyOptions={props.onModifyOptions}
        />
      </section>
      <ul className="compact-menu" aria-label="Sketch actions">
        <ActionRow
          label="Construction"
          icon={<Construction size={18} />}
          pressed={construction}
          onPress={() => props.onConstruction(!construction)}
        />
        <ActionRow
          label="Dimension"
          icon={<Ruler size={18} />}
          disabledReason={editReason}
          onPress={() => {
            props.onDimension();
            onDone();
          }}
        />
        <ActionRow
          label="Solve"
          icon={<Play size={18} />}
          disabledReason={
            !canConstrain || constraintCount === 0
              ? 'Add a constraint first.'
              : solving
                ? 'Solving…'
                : null
          }
          onPress={props.onSolve}
        />
        <ActionRow
          label="Diagnostics"
          icon={<ScanSearch size={18} />}
          onPress={() => {
            onDone();
            props.onDiagnostics();
          }}
        />
        <ActionRow
          label="Extrude"
          icon={<Layers3 size={18} />}
          disabledReason={
            !canExtrude
              ? 'Close a profile before extruding.'
              : solving
                ? 'Solving…'
                : null
          }
          onPress={() => {
            onDone();
            props.onExtrude();
          }}
        />
      </ul>
      <ul className="compact-menu" aria-label="Selection actions">
        <ClipboardRows {...props} />
      </ul>
      <section className="compact-sketch-section" aria-label="All relations">
        <h3 className="compact-sketch-heading">Relations</h3>
        <div className="compact-choice-grid">
          {CONSTRAINT_TOOL_SPECS.map(({ kind, label, hint }) => {
            const Icon = CONSTRAINT_ICONS[kind];
            const armed = pendingConstraint?.kind === kind;
            const fits =
              !relationSelection || relationSelection.fitting.includes(kind);
            return (
              <button
                key={kind}
                type="button"
                className="compact-choice"
                aria-label={label}
                aria-pressed={armed}
                disabled={!canConstrain && !armed}
                title={editReason ?? hint}
                onClick={() => {
                  if (relationSelection && fits && !armed) {
                    props.onSelectionConstraintTool(kind);
                  } else {
                    props.onConstraintTool(armed ? null : kind);
                  }
                  onDone();
                }}
              >
                <Icon size={22} aria-hidden="true" />
                <span aria-hidden="true">{label}</span>
              </button>
            );
          })}
        </div>
      </section>
      <section
        className="sketch-palette compact-sketch-palette"
        aria-label="Sketch palette"
      >
        {workflow}
        <SketchPaletteContent {...palette} keyboardHelp={false} />
      </section>
    </>
  );
}

/** Offset's and the patterns' settings while one is armed. */
function ModifyOptions({
  pendingEdit,
  modifyOptions = DEFAULT_SKETCH_OFFSET_OPTIONS,
  onModifyOptions
}: Pick<
  CompactSketchTrayProps,
  'pendingEdit' | 'modifyOptions' | 'onModifyOptions'
>) {
  if (pendingEdit?.kind === 'offset') {
    return (
      <div
        className="compact-sketch-options"
        role="group"
        aria-label="Offset options"
      >
        <div
          className="compact-choice-grid"
          role="radiogroup"
          aria-label="Offset corners"
        >
          {OFFSET_JOINS.map(({ join, label, icon: Icon }) => (
            <button
              key={join}
              type="button"
              role="radio"
              className="compact-choice"
              aria-checked={modifyOptions.join === join}
              aria-label={label}
              onClick={() => onModifyOptions({ ...modifyOptions, join })}
            >
              <Icon size={22} aria-hidden="true" />
              <span aria-hidden="true">{label}</span>
            </button>
          ))}
          <button
            type="button"
            className="compact-choice"
            aria-pressed={modifyOptions.chain}
            aria-label="Chain"
            onClick={() =>
              onModifyOptions({ ...modifyOptions, chain: !modifyOptions.chain })
            }
          >
            <Link2 size={22} aria-hidden="true" />
            <span aria-hidden="true">Chain</span>
          </button>
        </div>
      </div>
    );
  }
  if (
    pendingEdit?.kind === 'linear-pattern' ||
    pendingEdit?.kind === 'circular-pattern'
  ) {
    const linear = pendingEdit.kind === 'linear-pattern';
    const choices = linear ? PATTERN_SPACINGS : PATTERN_ORIENTATIONS;
    const current = linear
      ? (modifyOptions.patternSpacing ?? 'spacing')
      : (modifyOptions.patternOrientation ?? 'rotate');
    return (
      <div
        className="compact-choice-grid compact-sketch-options"
        role="radiogroup"
        aria-label={linear ? 'Pattern spacing' : 'Pattern orientation'}
      >
        {choices.map(({ value, label, icon: Icon }) => (
          <button
            key={value}
            type="button"
            role="radio"
            className="compact-choice"
            aria-checked={current === value}
            aria-label={label}
            onClick={() =>
              onModifyOptions(
                linear
                  ? {
                      ...modifyOptions,
                      patternSpacing: value as SketchPatternSpacing
                    }
                  : {
                      ...modifyOptions,
                      patternOrientation: value as SketchPatternOrientation
                    }
              )
            }
          >
            <Icon size={22} aria-hidden="true" />
            <span aria-hidden="true">{label}</span>
          </button>
        ))}
      </div>
    );
  }
  return null;
}
