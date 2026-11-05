import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type MutableRefObject
} from 'react';
import { Check, Delete, Grid3x3 } from 'lucide-react';
import type { UnitSystem } from '@openzcad/shared';
import {
  appendKeypadKey,
  convertDimensionInput,
  dimensionModeForInput,
  evaluateKeypadInput,
  keypadBesidePosition,
  keypadClampPosition,
  type DimensionMode,
  type KeypadExclusion,
  type KeypadUnit
} from '../lib/keypad';
import { unitLabel } from '../lib/measurements';
import { MODEL_PANEL_OBSTACLES } from '../lib/selectionCalloutView';
import { formatNumber } from '../lib/model';
import {
  keypadReturnTarget,
  returnKeypadFocus
} from '../lib/keypadReturnFocus';
import { spokenValueName } from '../lib/inPlace/chipNames';
import { useMediaQuery } from '../hooks/useMediaQuery';

export interface KeypadRequest {
  /** U09: which in-place command value a `command` entry edits. */
  commandValueId?: string;
  /** Which commit path the value feeds (routing is the opener's concern). */
  kind:
    | 'offset'
    | 'edge'
    | 'radius'
    | 'sketch-dimension'
    | 'sketch-edit'
    /** U09: an in-place command's handle value. */
    | 'command'
    /** U09: a value of the in-place Extrude (`commandValueId` names it). */
    | 'extrude';
  /** Short label over the value field ('Offset', 'Radius', 'Height'). */
  label: string;
  /** Prefill; may be a typed digit captured mid-gesture. */
  initial: string;
  /** Captured first keys continue at the caret; measured prefills select all. */
  selectInitial?: boolean;
  /** A count is a plain whole number: no unit chips, no conversion. */
  unitKind: 'length' | 'angle' | 'count';
  /** Radial display/entry notation; committed values are always radii. */
  dimensionMode?: DimensionMode;
  /** Total extent whose entered value normalizes to a signed offset. */
  totalBaseline?: number;
  /** Signed offset before a measured Total was rounded for its prefill. */
  initialOffset?: number;
  /** -1 when the handle's drag subtracts from that total; default +1. */
  totalSense?: 1 | -1;
  /**
   * Original absolute measurement, used to restore exact-entry cancellation.
   */
  baseline?: number;
  /** The expression the value held when entry opened, restored on cancel. */
  baselineRaw?: string;
  /** Client-space anchor for a click-placed editor without a live 3D rig. */
  fixedClientAnchor?: { x: number; y: number };
}

interface NumericKeypadProps {
  request: KeypadRequest;
  units: UnitSystem;
  scope: Record<string, number>;
  /**
   * Imperative anchor sink: the viewport pushes the anchor's screen position
   * (host-relative CSS pixels) every frame; null hides while off-screen. The
   * keypad positions itself without React re-renders.
   */
  anchorRef: MutableRefObject<
    ((point: { x: number; y: number } | null) => void) | null
  >;
  /**
   * Live preview as the value changes; only called with valid values.
   * `raw` is the entry as it would be stored, when it is an expression.
   */
  onPreview(value: number, raw?: string): void;
  /**
   * Why the entry as it stands does not evaluate, or null once it does:
   * a host whose own Done stands beside the keypad holds it meanwhile.
   */
  onEntryError?(error: string | null): void;
  /** Commit: evaluated value in document units, plus the raw text. */
  onCommit(value: number, raw: string): void;
  /** Exact preview refused the current value; entry stays editable. */
  commitDisabled?: boolean;
  commitDisabledReason?: string | null;
  /**
   * The value was refused, not merely being checked: the keypad takes the
   * error colour the notice lane uses. A check in flight stays neutral —
   * it used to wear the same warning amber as a refusal.
   */
  commitRefused?: boolean;
  onDimensionModeChange?(mode: DimensionMode): void;
  onCancel(): void;
}

const METRIC_UNITS: KeypadUnit[] = ['mm', 'cm', 'm'];

/**
 * Whether the digit grid opens expanded. A mouse-and-keyboard user types
 * into the field, so on a fine pointer the grid (two thirds of the keypad,
 * over the model being edited) waits behind its toggle; a touch screen has
 * no keyboard to type with and opens it. Without `matchMedia` (a test DOM)
 * it opens, as it always did.
 */
function keypadGridOpensExpanded(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function')
    return true;
  return !window.matchMedia('(pointer: fine)').matches;
}

/**
 * The chips a length entry offers: the metric three, plus the document's own
 * unit when it is not already one of them.
 *
 * An inch document used to get the metric three and open on `mm`, while the
 * field beside them was prefilled in inches — so committing the prefilled
 * value without editing divided it by 25.4.
 */
function lengthUnitsFor(units: UnitSystem): KeypadUnit[] {
  return METRIC_UNITS.includes(units) ? METRIC_UNITS : [...METRIC_UNITS, units];
}

/** Chips read as a drawing would label them, not as the enum spells them. */
const UNIT_LABELS: Partial<Record<KeypadUnit, string>> = { inch: 'in' };
const PAD_KEYS = [
  ['7', '8', '9', '/'],
  ['4', '5', '6', '*'],
  ['1', '2', '3', '-'],
  ['±', '0', '.', '+']
];

/**
 * Arrow keys move through a radio group's chips and pick the one they land
 * on, as a native radio group does. Only the checked chip is a Tab stop, so
 * Tab crosses each group once instead of stopping on every unit.
 */
function onRadioGroupKeyDown(event: KeyboardEvent<HTMLElement>) {
  const step =
    event.key === 'ArrowRight' || event.key === 'ArrowDown'
      ? 1
      : event.key === 'ArrowLeft' || event.key === 'ArrowUp'
        ? -1
        : 0;
  if (step === 0) {
    return;
  }
  const radios = [
    ...event.currentTarget.querySelectorAll<HTMLButtonElement>(
      '[role="radio"]:not(:disabled)'
    )
  ];
  const index = radios.findIndex((radio) => radio === event.target);
  if (index < 0) {
    return;
  }
  event.preventDefault();
  const next = radios[(index + step + radios.length) % radios.length]!;
  next.click();
  // After the click: a mode switch hands focus to the value field.
  next.focus();
}

/**
 * Panels floating over the viewport, in host-relative pixels.
 *
 * Read from the DOM rather than passed down: these are siblings laid out by
 * CSS, so their live width — resized, collapsed, or absent — is the only
 * honest source, and it is one measurement taken once per opening.
 */
function dockedPanelBands(host: HTMLElement): KeypadExclusion[] {
  const area = host.closest('.viewer-area');
  if (!area) {
    return [];
  }
  const hostRect = host.getBoundingClientRect();
  // The column on the left, the command card, the inspector and every model
  // panel drawn on the right (each docked column, the unpinned panel, the
  // phone lane), and any direct-mode strip; the keypad keeps clear of all
  // of them.
  return [
    ...area.querySelectorAll(
      `.command-float, .inspector-float, ${MODEL_PANEL_OBSTACLES}, .palette-float, .workspace-column-float`
    )
  ].flatMap((panel) => {
    const rect = panel.getBoundingClientRect();
    return rect.width > 0
      ? [{ x: rect.left - hostRect.left, width: rect.width }]
      : [];
  });
}

/**
 * The box the value chip and its operation label paint, host-relative, or a
 * point box at the rig's anchor when neither is drawn yet.
 *
 * Their painted boxes, unlike the anchor: the chip pair is laid out away
 * from the rig's point by CSS, so the point alone put the keypad on top of
 * the very chip it was opened from.
 */
function chipBoxAround(
  host: HTMLElement,
  point: { x: number; y: number }
): { left: number; top: number; right: number; bottom: number } {
  const hostRect = host.getBoundingClientRect();
  const boxes = [
    host.querySelector<HTMLElement>(
      '[data-testid="direct-manipulation-value"]'
    ) ?? host.querySelector<HTMLElement>('.handle-value-chip'),
    host.querySelector<HTMLElement>('.handle-label-chip')
  ]
    .map((chip) => chip?.getBoundingClientRect())
    .filter((rect): rect is DOMRect =>
      Boolean(rect && rect.width > 0 && rect.height > 0)
    );
  if (boxes.length === 0) {
    return { left: point.x, top: point.y, right: point.x, bottom: point.y };
  }
  return {
    left: Math.min(...boxes.map((rect) => rect.left)) - hostRect.left,
    top: Math.min(...boxes.map((rect) => rect.top)) - hostRect.top,
    right: Math.max(...boxes.map((rect) => rect.right)) - hostRect.left,
    bottom: Math.max(...boxes.map((rect) => rect.bottom)) - hostRect.top
  };
}

/**
 * How far down the host the keypad may reach: to the top of the bottom lane
 * (the guidance row and the search bar, where a command's Done stands),
 * which is drawn over the stage and would take the keypad's own clicks.
 */
export function keypadFloor(host: HTMLElement): number {
  const hostTop = host.getBoundingClientRect().top;
  let floor = host.clientHeight;
  const lane = host
    .closest('.viewer-area')
    ?.querySelector<HTMLElement>('.command-bar-lane');
  if (lane) {
    const top = lane.getBoundingClientRect().top - hostTop;
    if (top > 0) floor = Math.min(floor, top);
  }
  // A software keyboard shrinks the visual viewport and leaves the layout
  // viewport (and so the host) as it was. A pinch-zoomed view is the
  // reader's own framing, not an obstruction, so only an unscaled one counts.
  const visual = host.ownerDocument.defaultView?.visualViewport;
  if (visual && Math.abs(visual.scale - 1) < 0.01) {
    const visibleBottom = visual.offsetTop + visual.height - hostTop;
    if (visibleBottom > 0) floor = Math.min(floor, visibleBottom);
  }
  return floor;
}

/**
 * Floating exact-value entry anchored at the point of action — the keyboard
 * companion of every drag handle. One instance serves offsets, radii,
 * extrude heights, and sketch dimensions.
 */
/** The signed drag value a typed total stands for. */
function offsetFromTotal(
  total: number,
  request: Pick<KeypadRequest, 'totalBaseline' | 'totalSense'>
): number {
  return (total - (request.totalBaseline ?? 0)) * (request.totalSense ?? 1);
}

export function NumericKeypad({
  request,
  units,
  scope,
  anchorRef,
  onPreview,
  onEntryError,
  onCommit,
  commitDisabled = false,
  commitDisabledReason,
  commitRefused = false,
  onDimensionModeChange,
  onCancel
}: NumericKeypadProps) {
  const [value, setValue] = useState(request.initial);
  const [dimensionMode, setDimensionMode] = useState(request.dimensionMode);
  // The document's own unit, always: every prefill in App.tsx is a value in
  // document units, so any other starting chip rescales it behind the user.
  const [entryUnit, setEntryUnit] = useState<KeypadUnit>(
    request.unitKind === 'length'
      ? units
      : request.unitKind === 'count'
        ? 'count'
        : 'deg'
  );
  const label = dimensionMode
    ? dimensionMode === 'diameter'
      ? 'Diameter'
      : 'Radius'
    : request.label;
  const [gridOpen, setGridOpen] = useState(keypadGridOpensExpanded);
  const reasonId = useId();
  const gridId = useId();
  const rootRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  // The pad is the touch keyboard: the field keeps focus (Enter, Escape and
  // a hardware keyboard still land on it) without raising the system
  // keyboard over the keys. A deliberate touch on the field itself asks for
  // the system keyboard, which parameter names need.
  const coarsePointer = useMediaQuery('(pointer: coarse)');
  const [systemKeyboard, setSystemKeyboard] = useState(false);
  const raiseSystemKeyboard = useRef(false);
  // Read on the first render, before the field takes focus below.
  const [returnTarget] = useState(keypadReturnTarget);
  useEffect(() => () => returnKeypadFocus(returnTarget), [returnTarget]);
  const selectInitial = useRef(request.selectInitial ?? true);
  const initialPreviewed = useRef(false);
  const untouchedPrefill = useRef(request.selectInitial !== false);
  const evaluation = evaluateKeypadInput(
    value,
    entryUnit,
    units,
    scope,
    dimensionMode
  );
  const unchangedTotal = (raw: string, unit: KeypadUnit) =>
    request.kind === 'offset' &&
    request.totalBaseline !== undefined &&
    request.initialOffset !== undefined &&
    untouchedPrefill.current &&
    raw === request.initial &&
    unit === units;
  const normalize = (evaluated: number, raw: string, unit: KeypadUnit) =>
    unchangedTotal(raw, unit)
      ? request.initialOffset!
      : offsetFromTotal(evaluated, request);
  const normalizedValue =
    evaluation.value === undefined
      ? undefined
      : normalize(evaluation.value, value, entryUnit);
  const normalizedRaw =
    evaluation.normalizedRaw === undefined
      ? undefined
      : request.totalBaseline === undefined
        ? evaluation.normalizedRaw
        : evaluation.isExpression
          ? (request.totalSense ?? 1) === 1
            ? `(${evaluation.normalizedRaw}) - ${request.totalBaseline}`
            : `${request.totalBaseline} - (${evaluation.normalizedRaw})`
          : String(normalizedValue);

  // Imperative anchoring: the viewport's render loop pushes screen points.
  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) {
      return;
    }
    // Position once at the first anchor push, then stay put: a keypad that
    // chases the live preview moves out from under the pointer mid-entry.
    let positioned = false;
    let lastAnchor: { x: number; y: number } | null = null;
    const positionAt = (point: { x: number; y: number } | null) => {
      if (positioned || !point) {
        return;
      }
      const host = root.parentElement;
      if (!host) {
        return;
      }
      lastAnchor = point;
      root.style.maxHeight = `${Math.max(0, keypadFloor(host) - 16)}px`;
      const size = {
        width: root.offsetWidth || 232,
        height: root.offsetHeight || 280
      };
      const viewport = { width: host.clientWidth, height: keypadFloor(host) };
      // A click-placed editor has no chips to stand beside; one opened from
      // a handle's value chip stands beside the chips, clear of the handle.
      const placement = request.fixedClientAnchor
        ? keypadClampPosition(point, size, viewport, dockedPanelBands(host))
        : keypadBesidePosition(
            chipBoxAround(host, point),
            size,
            viewport,
            dockedPanelBands(host)
          );
      root.style.visibility = 'visible';
      root.style.left = `${placement.x}px`;
      root.style.top = `${placement.y}px`;
      positioned = true;
    };
    anchorRef.current = positionAt;
    if (request.fixedClientAnchor) {
      const host = root.parentElement;
      if (host) {
        const rect = host.getBoundingClientRect();
        positionAt({
          x: request.fixedClientAnchor.x - rect.left,
          y: request.fixedClientAnchor.y - rect.top
        });
      }
    } else {
      const host = root.parentElement;
      if (host) {
        // The chip the entry was opened from: a command value's own, else
        // the drag handle's; any value chip when neither is drawn.
        const chip =
          (request.commandValueId
            ? host.querySelector<HTMLElement>(
                `[data-testid="command-handle-${request.commandValueId}"]`
              )
            : null) ??
          host.querySelector<HTMLElement>(
            '[data-testid="direct-manipulation-value"]'
          ) ??
          host.querySelector<HTMLElement>('.handle-value-chip');
        const chipRect = chip?.getBoundingClientRect();
        const chipAnchor = {
          x: Number.parseFloat(chip?.style.left ?? ''),
          y: Number.parseFloat(chip?.style.top ?? '')
        };
        const visibleChip =
          chip &&
          chipRect &&
          chipRect.width > 0 &&
          chipRect.height > 0 &&
          getComputedStyle(chip).visibility !== 'hidden' &&
          Number.isFinite(chipAnchor.x) &&
          Number.isFinite(chipAnchor.y);
        if (visibleChip) {
          // CSS moves the chip away from this anchor; its painted box is not the rig's point.
          positionAt(chipAnchor);
        } else {
          // Focus cannot land in a hidden input while the rig's first frame is pending.
          positionAt({ x: host.clientWidth / 2, y: host.clientHeight / 2 });
          positioned = false;
        }
      }
    }
    // Preserve a stable position during typing, but re-clamp when the host
    // or keypad changes size (rotation, a dock opening, or a warning row).
    const reposition = () => {
      if (!lastAnchor) return;
      const wasPositioned = positioned;
      positioned = false;
      positionAt(lastAnchor);
      // A centered fallback remains provisional until the rig's first push.
      positioned = wasPositioned;
    };
    const observer =
      typeof ResizeObserver === 'undefined'
        ? null
        : new ResizeObserver(reposition);
    if (root.parentElement) observer?.observe(root.parentElement);
    observer?.observe(root);
    window.addEventListener('resize', reposition);
    const visual = window.visualViewport;
    visual?.addEventListener('resize', reposition);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', reposition);
      visual?.removeEventListener('resize', reposition);
      anchorRef.current = null;
    };
  }, [anchorRef, request.fixedClientAnchor, request.commandValueId]);

  useLayoutEffect(() => {
    inputRef.current?.focus();
    if (selectInitial.current) inputRef.current?.select();
    else {
      const input = inputRef.current;
      input?.setSelectionRange(input.value.length, input.value.length);
    }
  }, []);

  useEffect(() => {
    if (selectInitial.current || initialPreviewed.current) return;
    initialPreviewed.current = true;
    if (evaluation.ok && normalizedValue !== undefined) {
      if (evaluation.isExpression && normalizedRaw !== undefined) {
        onPreview(normalizedValue, normalizedRaw);
      } else {
        onPreview(normalizedValue);
      }
    }
  }, [
    evaluation.ok,
    evaluation.isExpression,
    normalizedValue,
    normalizedRaw,
    onPreview
  ]);

  const entryError = evaluation.ok ? null : (evaluation.error ?? 'invalid');
  useEffect(() => {
    onEntryError?.(entryError);
  }, [entryError, onEntryError]);
  // Closed, it leaves nothing pending.
  useEffect(() => () => onEntryError?.(null), [onEntryError]);

  const previewIfValid = (next: string, requestedMode = dimensionMode) => {
    if (next !== value) untouchedPrefill.current = false;
    const typedMode = dimensionModeForInput(next, scope);
    const nextMode = typedMode ?? requestedMode;
    if (typedMode && typedMode !== dimensionMode) {
      setDimensionMode(typedMode);
      onDimensionModeChange?.(typedMode);
    }
    setValue(next);
    const result = evaluateKeypadInput(next, entryUnit, units, scope, nextMode);
    if (result.ok && result.value !== undefined) {
      const previewed = normalize(result.value, next, entryUnit);
      if (
        result.isExpression &&
        request.totalBaseline === undefined &&
        result.normalizedRaw !== undefined
      ) {
        onPreview(previewed, result.normalizedRaw);
      } else {
        onPreview(previewed);
      }
    }
    // Keep the value field focused so Enter/Escape always land on the pad.
    inputRef.current?.focus();
  };

  const commit = () => {
    if (
      !commitDisabled &&
      evaluation.ok &&
      normalizedValue !== undefined &&
      normalizedRaw !== undefined
    ) {
      if (unchangedTotal(value, entryUnit) && normalizedValue === 0) onCancel();
      else onCommit(normalizedValue, normalizedRaw);
    }
  };

  const switchDimensionMode = (nextMode: DimensionMode) => {
    if (!dimensionMode || nextMode === dimensionMode) {
      return;
    }
    const next = convertDimensionInput(value, dimensionMode, nextMode, scope);
    setDimensionMode(nextMode);
    onDimensionModeChange?.(nextMode);
    previewIfValid(next, nextMode);
  };

  return (
    <div
      ref={rootRef}
      className="numeric-keypad"
      data-state={
        commitRefused ? 'refused' : commitDisabled ? 'checking' : 'ready'
      }
      role="dialog"
      // The visible label may be a glyph ("⌀", "R"); the names are in words.
      aria-label={`${spokenValueName(label)} value`}
      // The viewport must never see keypad gestures as picks or orbits.
      onPointerDown={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        event.stopPropagation();
        // Enter on a focused chip or key presses that button (a unit, the
        // diameter mode), as Enter does on any button; it used to commit
        // the value instead.
        if (
          event.key === 'Enter' &&
          !(event.target instanceof HTMLButtonElement)
        ) {
          event.preventDefault();
          commit();
        }
        if (event.key === 'Escape') {
          event.preventDefault();
          onCancel();
        }
      }}
    >
      <div className="keypad-value-row">
        <span className="keypad-label">{label}</span>
        <input
          ref={inputRef}
          className="keypad-value"
          aria-label={spokenValueName(label)}
          inputMode={coarsePointer && !systemKeyboard ? 'none' : undefined}
          onPointerDown={(event) => {
            if (
              coarsePointer &&
              !systemKeyboard &&
              event.pointerType !== 'mouse'
            ) {
              raiseSystemKeyboard.current = true;
              setSystemKeyboard(true);
            }
          }}
          onClick={(event) => {
            // WebKit raises the keyboard only for a focus made inside the
            // gesture, and this field was focused before the tap.
            if (!raiseSystemKeyboard.current) return;
            raiseSystemKeyboard.current = false;
            event.currentTarget.blur();
            event.currentTarget.focus();
          }}
          value={value}
          aria-invalid={commitRefused || !evaluation.ok}
          spellCheck={false}
          onChange={(event) => previewIfValid(event.target.value)}
        />
        <button
          type="button"
          className="keypad-grid-toggle"
          aria-label="Keypad"
          title={gridOpen ? 'Hide keypad' : 'Show keypad'}
          aria-expanded={gridOpen}
          aria-controls={gridId}
          onClick={() => {
            setGridOpen((open) => !open);
            inputRef.current?.focus();
          }}
        >
          <Grid3x3 size={14} aria-hidden="true" />
        </button>
      </div>
      {/* A converted or computed value is shown in the document's own units,
          so a value typed in some other unit is never committed unseen — a
          plain number under another unit's chip included. */}
      {/* Always present so typing an operator does not push the number grid
          and the Commit button down under the pointer. */}
      <div className="keypad-expr-preview">
        {evaluation.isExpression ||
        evaluation.typedUnit ||
        (request.unitKind === 'length' && entryUnit !== units && evaluation.ok)
          ? evaluation.ok && evaluation.value !== undefined
            ? `= ${formatNumber(evaluation.displayValue ?? evaluation.value)}${request.unitKind === 'angle' ? '°' : request.unitKind === 'count' ? '' : ` ${unitLabel('length', units)}`}`
            : (evaluation.error ?? 'invalid')
          : request.unitKind === 'length'
            ? // Typing a unit is how another one is entered; the hint says
              // so where the chips used to suggest a document setting.
              `Other units: 2cm, 1in`
            : ''}
      </div>
      {commitDisabled && commitDisabledReason ? (
        <div className="keypad-warning" role="alert" id={reasonId}>
          {commitDisabledReason}
        </div>
      ) : null}
      {dimensionMode && (
        <div
          className="keypad-units"
          role="radiogroup"
          aria-label="Radial entry mode"
          onKeyDown={onRadioGroupKeyDown}
        >
          {(['diameter', 'radius'] as DimensionMode[]).map((mode) => (
            <button
              key={mode}
              type="button"
              role="radio"
              aria-checked={dimensionMode === mode}
              tabIndex={dimensionMode === mode ? 0 : -1}
              className={dimensionMode === mode ? 'active' : undefined}
              onClick={() => switchDimensionMode(mode)}
            >
              {mode === 'diameter' ? 'Ø Diameter' : 'R Radius'}
            </button>
          ))}
        </div>
      )}
      {gridOpen && request.unitKind !== 'count' && (
        <div
          className="keypad-units keypad-entry-units"
          role="radiogroup"
          aria-label="Entry unit"
          onKeyDown={onRadioGroupKeyDown}
        >
          {/* Named as the unit typed in, not the document's: the bare
              mm/cm/m row read as a switch for the whole model. */}
          <span className="keypad-units-label" aria-hidden="true">
            Enter in
          </span>
          {(request.unitKind === 'angle'
            ? (['deg'] as KeypadUnit[])
            : lengthUnitsFor(units)
          ).map((unit) => (
            <button
              key={unit}
              type="button"
              role="radio"
              aria-checked={entryUnit === unit}
              tabIndex={entryUnit === unit ? 0 : -1}
              className={entryUnit === unit ? 'active' : undefined}
              // Unit chips only rescale plain numbers, not expressions.
              disabled={evaluation.isExpression}
              onClick={() => {
                if (unit !== entryUnit) untouchedPrefill.current = false;
                setEntryUnit(unit);
                const result = evaluateKeypadInput(
                  value,
                  unit,
                  units,
                  scope,
                  dimensionMode
                );
                if (result.ok && result.value !== undefined) {
                  onPreview(normalize(result.value, value, unit));
                }
              }}
            >
              {UNIT_LABELS[unit] ?? unit}
            </button>
          ))}
        </div>
      )}
      <div className="keypad-grid" id={gridId}>
        {(gridOpen ? PAD_KEYS.flat() : []).map((key) => (
          <button
            key={key}
            type="button"
            className="keypad-key"
            onClick={() => previewIfValid(appendKeypadKey(value, key))}
          >
            {key === '*' ? '×' : key === '/' ? '÷' : key}
          </button>
        ))}
        {gridOpen && (
          <button
            type="button"
            className="keypad-key"
            aria-label="Backspace"
            onClick={() => previewIfValid(appendKeypadKey(value, '⌫'))}
          >
            <Delete size={14} aria-hidden="true" />
          </button>
        )}
        {/* Named, not just ticked: a bare checkmark makes the user guess what
            it applies, and the name is the same one assistive tech reads. */}
        <button
          type="button"
          className="keypad-commit"
          disabled={!evaluation.ok || commitDisabled}
          // The reason the button is off, read with it and shown on hover.
          {...(commitDisabled && commitDisabledReason
            ? { 'aria-describedby': reasonId, title: commitDisabledReason }
            : {})}
          onClick={commit}
        >
          <Check size={16} aria-hidden="true" />
          {`Apply ${label.toLowerCase()}`}
        </button>
      </div>
    </div>
  );
}
