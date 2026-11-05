import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type MutableRefObject
} from 'react';
import { Check, Delete, Ellipsis, LoaderCircle } from 'lucide-react';
import type { UnitSystem } from '@openzcad/shared';
import {
  appendKeypadKey,
  convertDimensionInput,
  dimensionModeForInput,
  editControlState,
  evaluateKeypadInput,
  keypadClampPosition,
  keypadDockedPosition,
  keypadInPlacePosition,
  type DimensionMode,
  type EditControlState,
  type KeypadExclusion,
  type KeypadPlacement,
  type KeypadUnit,
  type PreviewVerdict
} from '../lib/keypad';
import { unitLabel } from '../lib/measurements';
import { MODEL_PANEL_OBSTACLES } from '../lib/selectionCalloutView';
import { formatNumber } from '../lib/model';
import {
  keypadReturnTarget,
  returnKeypadFocus
} from '../lib/keypadReturnFocus';
import { spokenValueName } from '../lib/inPlace/chipNames';
import type { SelectionCalloutOperation } from '../lib/selectionCallout';
import { EditRefusal } from './EditRefusal';

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
  /**
   * The value is being checked by the exact kernel: the control reads
   * "Checking…" in words and Apply waits, so only a checked value commits.
   */
  checking?: boolean;
  /**
   * The refused operation, when the refusal is one the control can explain:
   * its line, remedies and "Why?" sit under the value. Without it a refusal
   * shows `commitDisabledReason` as plain text.
   */
  refusal?: {
    operation: SelectionCalloutOperation;
    onPickAnother?(): void;
    pickAnotherLabel?: string;
  } | null;
  /**
   * The exact kernel's latest verdict on a previewed value, for a host that
   * checks values as they are typed (an edge, a face offset, a radius).
   * With it the control is Ready only once the value it shows has built.
   * Undefined for a host that does not check (a sketch dimension).
   */
  verdict?: PreviewVerdict | null;
  onDimensionModeChange?(mode: DimensionMode): void;
  /**
   * What the control says, for the key hints read in the guidance row; null
   * once it closes.
   */
  onUiStateChange?(ui: KeypadUiState | null): void;
  onCancel(): void;
}

/** The control's state, as the guidance row's key hints read it. */
export interface KeypadUiState {
  state: EditControlState;
  /** An explanation (Why?, the unit help) is open: Esc closes it first. */
  explaining: boolean;
  /** Enter was pressed while checking: it applies once the value builds. */
  pending: boolean;
}

/** Phone widths: the control is a sheet above the on-screen keyboard. */
const PHONE_QUERY = '(max-width: 560px)';

const METRIC_UNITS: KeypadUnit[] = ['mm', 'cm', 'm'];

/**
 * The kind of pointer that last pressed anything on the page. A hybrid
 * device (a touch laptop, a tablet with a trackpad) reports a fine primary
 * pointer either way, so the press that opened the control is the better
 * witness of whether a keyboard is at hand.
 */
let lastPointerType: string | null = null;
if (typeof window !== 'undefined') {
  window.addEventListener(
    'pointerdown',
    (event) => {
      lastPointerType = event.pointerType || null;
    },
    { capture: true, passive: true }
  );
}

/**
 * Whether the digit grid opens expanded. A mouse-and-keyboard user types
 * into the field, so with a fine pointer the grid (most of the control, over
 * the model being edited) waits behind its overflow action; a touch opening
 * has no keyboard to type with and opens it. Without `matchMedia` (a test
 * DOM) it opens, as it always did.
 */
function keypadGridOpensExpanded(): boolean {
  if (lastPointerType === 'touch' || lastPointerType === 'pen') return true;
  if (lastPointerType === 'mouse') return false;
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function')
    return true;
  return !window.matchMedia('(pointer: fine)').matches;
}

/** Forgets the last pointer, for tests that switch devices. */
export function resetKeypadPointerForTests(): void {
  lastPointerType = null;
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
 * The painted box of the value chip the entry was opened from, host-relative,
 * or null when it is not drawn (off screen, not yet laid out).
 *
 * The control takes the chip's place: the value it shows becomes the field
 * that edits it, beside the operation tag, rather than a second card
 * repeating it nearby.
 */
function valueChipBox(
  host: HTMLElement,
  commandValueId: string | undefined
): { left: number; top: number; right: number; bottom: number } | null {
  const chip =
    (commandValueId
      ? host.querySelector<HTMLElement>(
          `[data-testid="command-handle-${commandValueId}"]`
        )
      : null) ??
    host.querySelector<HTMLElement>(
      '[data-testid="direct-manipulation-value"]'
    ) ??
    host.querySelector<HTMLElement>('.handle-value-chip');
  const rect = chip?.getBoundingClientRect();
  if (!chip || !rect || rect.width <= 0 || rect.height <= 0) return null;
  if (getComputedStyle(chip).visibility === 'hidden') return null;
  const hostRect = host.getBoundingClientRect();
  return {
    left: rect.left - hostRect.left,
    top: rect.top - hostRect.top,
    right: rect.right - hostRect.left,
    bottom: rect.bottom - hostRect.top
  };
}

/**
 * How far down the host the keypad may reach: to the top of the bottom lane
 * (the guidance row and the search bar, where a command's Done stands),
 * which is drawn over the stage and would take the keypad's own clicks.
 */
function keypadFloor(host: HTMLElement): number {
  const lane = host
    .closest('.viewer-area')
    ?.querySelector<HTMLElement>('.command-bar-lane');
  if (!lane) return host.clientHeight;
  const top =
    lane.getBoundingClientRect().top - host.getBoundingClientRect().top;
  return top > 0 ? Math.min(host.clientHeight, top) : host.clientHeight;
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
  checking = false,
  verdict,
  refusal = null,
  onDimensionModeChange,
  onUiStateChange,
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
  // The unit's help: pinned open by a press, shown while it has focus or
  // the pointer, so a keyboard user reads it by tabbing to the unit.
  const [helpPinned, setHelpPinned] = useState(false);
  const [helpHover, setHelpHover] = useState(false);
  const [explaining, setExplaining] = useState(false);
  // The value last handed to the live preview: only its verdict counts.
  const [previewed, setPreviewed] = useState<number | null>(null);
  // Enter pressed while the value was still being checked: it applies once
  // that value builds, and is dropped by a refusal or by more typing.
  const [commitPending, setCommitPending] = useState(false);
  const reasonId = useId();
  const gridId = useId();
  const helpId = useId();
  const stateId = useId();
  const rootRef = useRef<HTMLDivElement | null>(null);
  const rowRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
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

  /** Hands a value to the live preview and waits for its verdict. */
  const preview = (next: number, raw?: string) => {
    setPreviewed(next);
    if (raw !== undefined) onPreview(next, raw);
    else onPreview(next);
  };

  // Imperative anchoring: the viewport's render loop pushes screen points.
  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) {
      return;
    }
    // Placed once at the first anchor push, then frozen: a control that
    // chases the live preview moves out from under the pointer mid-entry.
    // Losing the anchor (orbited off screen) docks it once, and it stays.
    let positioned = false;
    let docked = false;
    let lastAnchor: { x: number; y: number } | null = null;
    const phone = () =>
      typeof window.matchMedia === 'function' &&
      window.matchMedia(PHONE_QUERY).matches;
    const place = (placement: KeypadPlacement) => {
      root.style.visibility = 'visible';
      root.style.left = `${placement.x}px`;
      root.style.top = `${placement.y}px`;
      root.dataset.placement = placement.side;
    };
    const measure = (host: HTMLElement) => {
      root.style.maxHeight = `${Math.max(0, keypadFloor(host) - 16)}px`;
      return {
        size: {
          width: root.offsetWidth || 232,
          height: root.offsetHeight || 40
        },
        viewport: { width: host.clientWidth, height: keypadFloor(host) },
        row: rowRef.current?.offsetHeight || root.offsetHeight || 40
      };
    };
    const positionAt = (point: { x: number; y: number } | null) => {
      const host = root.parentElement;
      if (!host) return;
      if (phone()) {
        // A sheet above the on-screen keyboard; CSS lays it out.
        root.style.visibility = 'visible';
        root.style.removeProperty('left');
        root.style.removeProperty('top');
        root.style.removeProperty('max-height');
        root.dataset.placement = 'sheet';
        positioned = true;
        return;
      }
      if (!point) {
        // The pick left the screen while the value was being edited.
        if (positioned && !docked && !request.fixedClientAnchor) {
          const { size, viewport } = measure(host);
          place(keypadDockedPosition(size, viewport, dockedPanelBands(host)));
          docked = true;
        }
        return;
      }
      if (positioned) return;
      lastAnchor = point;
      const { size, viewport, row } = measure(host);
      const bands = dockedPanelBands(host);
      const chip = request.fixedClientAnchor
        ? null
        : valueChipBox(host, request.commandValueId);
      // A handle's value chip is stood in for (or docked from, when it is
      // off screen or under a panel); an editor with no chip to replace,
      // click-placed or not yet drawn, stands by its anchor point.
      place(
        docked
          ? keypadDockedPosition(size, viewport, bands)
          : chip
            ? keypadInPlacePosition(chip, size, viewport, bands, row)
            : keypadClampPosition(point, size, viewport, bands)
      );
      positioned = true;
    };
    anchorRef.current = positionAt;
    const host = root.parentElement;
    if (host && request.fixedClientAnchor) {
      const rect = host.getBoundingClientRect();
      positionAt({
        x: request.fixedClientAnchor.x - rect.left,
        y: request.fixedClientAnchor.y - rect.top
      });
    } else if (host) {
      const chip = valueChipBox(host, request.commandValueId);
      if (chip) {
        positionAt({ x: chip.left, y: chip.top });
      } else {
        // Focus cannot land in a hidden input while the rig's first frame is
        // pending: placed provisionally until the rig pushes its anchor.
        positionAt({ x: host.clientWidth / 2, y: host.clientHeight / 2 });
        positioned = false;
      }
    }
    // Preserve a stable position during typing, but re-clamp when the host
    // or the control changes size (rotation, a dock opening, a refusal line).
    const reposition = () => {
      if (!lastAnchor && !phone()) return;
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
    // The phone sheet rides above the on-screen keyboard, which shrinks the
    // visual viewport rather than the layout one.
    const viewport = window.visualViewport;
    const keyboardInset = () => {
      if (!viewport) return;
      const inset = Math.max(
        0,
        window.innerHeight - viewport.height - viewport.offsetTop
      );
      root.style.setProperty('--keyboard-inset', `${Math.round(inset)}px`);
    };
    keyboardInset();
    viewport?.addEventListener('resize', keyboardInset);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', reposition);
      viewport?.removeEventListener('resize', keyboardInset);
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
        preview(normalizedValue, normalizedRaw);
      } else {
        preview(normalizedValue);
      }
    }
    // Once, for a captured first key; `preview` is recreated every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [evaluation.ok, evaluation.isExpression, normalizedValue, normalizedRaw]);

  const entryError = evaluation.ok ? null : (evaluation.error ?? 'invalid');
  useEffect(() => {
    onEntryError?.(entryError);
  }, [entryError, onEntryError]);
  // Closed, it leaves nothing pending.
  useEffect(() => () => onEntryError?.(null), [onEntryError]);

  const previewIfValid = (next: string, requestedMode = dimensionMode) => {
    if (next !== value) {
      untouchedPrefill.current = false;
      setCommitPending(false);
    }
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
        preview(previewed, result.normalizedRaw);
      } else {
        preview(previewed);
      }
    }
    // Keep the value field focused so Enter/Escape always land on the pad.
    inputRef.current?.focus();
  };

  // The state in words, beside the colour. Only the verdict for the value
  // on screen makes it Ready: Enter never commits an earlier value's
  // preview against newer input.
  const state = editControlState({
    entryOk: evaluation.ok,
    previewed,
    verdict,
    hostChecking: checking,
    hostRefused: commitRefused,
    hostDisabled: commitDisabled
  });

  const commitNow = () => {
    if (
      evaluation.ok &&
      normalizedValue !== undefined &&
      normalizedRaw !== undefined
    ) {
      if (unchangedTotal(value, entryUnit) && normalizedValue === 0) onCancel();
      else onCommit(normalizedValue, normalizedRaw);
    }
  };
  const commit = () => {
    if (state === 'ready') commitNow();
    else if (state === 'checking' && !checking) setCommitPending(true);
  };
  // A pending Enter lands on the verdict for the value it was pressed on.
  useEffect(() => {
    if (!commitPending) return;
    if (state === 'ready') {
      setCommitPending(false);
      commitNow();
    } else if (state !== 'checking') {
      setCommitPending(false);
    }
    // commitNow reads the same render's value; only the state moves it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [commitPending, state]);

  const switchDimensionMode = (nextMode: DimensionMode) => {
    if (!dimensionMode || nextMode === dimensionMode) {
      return;
    }
    const next = convertDimensionInput(value, dimensionMode, nextMode, scope);
    setDimensionMode(nextMode);
    onDimensionModeChange?.(nextMode);
    previewIfValid(next, nextMode);
  };

  const explained =
    state === 'refused' && refusal?.operation.error ? refusal : null;
  // A refusal the control cannot explain on its own (no operation to name
  // it) is shown as the host's sentence.
  const reasonShown =
    state === 'refused' && !explained && Boolean(commitDisabledReason);
  const helpOpen = helpPinned || helpHover;
  const onUiStateChangeRef = useRef(onUiStateChange);
  onUiStateChangeRef.current = onUiStateChange;
  useEffect(() => {
    onUiStateChangeRef.current?.({
      state,
      explaining: explaining || helpOpen,
      pending: commitPending
    });
  }, [state, explaining, helpOpen, commitPending]);
  useEffect(() => () => onUiStateChangeRef.current?.(null), []);

  const unitText =
    request.unitKind === 'angle'
      ? '°'
      : request.unitKind === 'count'
        ? ''
        : unitLabel('length', units);
  // A converted or computed value is shown in the document's own units, so
  // a value typed in some other unit is never committed unseen — a plain
  // number under another unit's chip included.
  const evaluated =
    evaluation.isExpression ||
    evaluation.typedUnit ||
    (request.unitKind === 'length' && entryUnit !== units && evaluation.ok)
      ? evaluation.ok && evaluation.value !== undefined
        ? `= ${formatNumber(evaluation.displayValue ?? evaluation.value)}${unitText ? ` ${unitText}` : ''}`
        : (evaluation.error ?? 'invalid')
      : '';
  const describedBy =
    [
      explained || reasonShown || state === 'invalid' ? reasonId : null,
      state === 'checking' ? stateId : null
    ]
      .filter(Boolean)
      .join(' ') || undefined;
  const applyName = `Apply ${label.toLowerCase()}`;
  const helpText =
    request.unitKind === 'length'
      ? 'Type units or expressions: 2cm, 1in'
      : 'Type a value or an expression, like 90/4';

  return (
    <div
      ref={rootRef}
      className="numeric-keypad"
      data-state={state}
      data-grid={gridOpen ? 'open' : 'closed'}
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
          // The Escape ladder: an explanation closes first (the refusal's
          // own card closes itself before this hears it), then the edit is
          // cancelled back to its baseline; the next Escape, with the
          // control gone, clears the selection.
          if (helpOpen) {
            setHelpPinned(false);
            setHelpHover(false);
            inputRef.current?.focus();
            return;
          }
          onCancel();
        }
      }}
    >
      {/* The control: what is edited, its value, its unit, and Apply. It
          stands where the value chip stood, beside the operation tag, so the
          two read as one control. */}
      <div className="keypad-value-row" ref={rowRef}>
        <span className="keypad-label">{label}</span>
        <input
          ref={inputRef}
          className="keypad-value"
          aria-label={spokenValueName(label)}
          value={value}
          aria-invalid={state === 'invalid' || state === 'refused'}
          aria-describedby={describedBy}
          spellCheck={false}
          inputMode="decimal"
          enterKeyHint="done"
          onChange={(event) => previewIfValid(event.target.value)}
        />
        <span className="keypad-expr-preview" aria-live="polite">
          {state === 'invalid' ? '' : evaluated}
        </span>
        {unitText && (
          // The unit is where other units are explained: they are typed,
          // not picked, so the unit itself is the way to learn how.
          <button
            type="button"
            className="keypad-unit-help"
            aria-expanded={helpOpen}
            aria-describedby={helpOpen ? helpId : undefined}
            onClick={() => setHelpPinned((open) => !open)}
            onFocus={() => setHelpHover(true)}
            onBlur={() => setHelpHover(false)}
            onPointerEnter={() => setHelpHover(true)}
            onPointerLeave={() => setHelpHover(false)}
          >
            {unitText}
          </button>
        )}
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
          <Ellipsis size={15} aria-hidden="true" />
        </button>
        {/* Named, not just ticked: a bare checkmark makes the user guess what
            it applies, and the name is the same one assistive tech reads. */}
        <button
          type="button"
          className="keypad-commit"
          aria-label={applyName}
          disabled={state !== 'ready'}
          title={
            state === 'ready'
              ? `${applyName} (Enter)`
              : state === 'checking'
                ? 'Checking the value…'
                : undefined
          }
          aria-describedby={describedBy}
          onClick={commit}
        >
          <Check size={16} aria-hidden="true" />
        </button>
      </div>
      {helpOpen && unitText && (
        <p className="keypad-help" id={helpId} role="note">
          {helpText}
        </p>
      )}
      {state === 'invalid' ? (
        <p className="keypad-warning" id={reasonId}>
          {entryError === 'invalid' ? 'Not a number or expression' : entryError}
        </p>
      ) : state === 'checking' ? (
        <p className="keypad-state" id={stateId}>
          <LoaderCircle size={12} className="spin" aria-hidden="true" />
          {commitPending ? 'Checking… applies once it builds' : 'Checking…'}
        </p>
      ) : explained ? (
        <EditRefusal
          operation={explained.operation}
          variant="control"
          unitLabel={unitText}
          lineId={reasonId}
          onTrySize={(size) => previewIfValid(formatNumber(size))}
          onOpenChange={setExplaining}
          {...(explained.onPickAnother
            ? { onPickAnother: explained.onPickAnother }
            : {})}
          {...(explained.pickAnotherLabel
            ? { pickAnotherLabel: explained.pickAnotherLabel }
            : {})}
        />
      ) : reasonShown ? (
        <p className="keypad-warning" role="alert" id={reasonId}>
          {commitDisabledReason}
        </p>
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
      {gridOpen && (
        <div className="keypad-pad" id={gridId}>
          {request.unitKind !== 'count' && (
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
                    if (unit !== entryUnit) {
                      untouchedPrefill.current = false;
                      setCommitPending(false);
                    }
                    setEntryUnit(unit);
                    const result = evaluateKeypadInput(
                      value,
                      unit,
                      units,
                      scope,
                      dimensionMode
                    );
                    if (result.ok && result.value !== undefined) {
                      preview(normalize(result.value, value, unit));
                    }
                  }}
                >
                  {UNIT_LABELS[unit] ?? unit}
                </button>
              ))}
            </div>
          )}
          <div className="keypad-grid">
            {PAD_KEYS.flat().map((key) => (
              <button
                key={key}
                type="button"
                className="keypad-key"
                onClick={() => previewIfValid(appendKeypadKey(value, key))}
              >
                {key === '*' ? '×' : key === '/' ? '÷' : key}
              </button>
            ))}
            <button
              type="button"
              className="keypad-key"
              aria-label="Backspace"
              onClick={() => previewIfValid(appendKeypadKey(value, '⌫'))}
            >
              <Delete size={14} aria-hidden="true" />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
