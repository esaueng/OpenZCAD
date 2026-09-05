import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type MutableRefObject
} from 'react';
import { Check, Delete } from 'lucide-react';
import type { UnitSystem } from '@openzcad/shared';
import {
  appendKeypadKey,
  convertDimensionInput,
  dimensionModeForInput,
  evaluateKeypadInput,
  keypadClampPosition,
  type DimensionMode,
  type KeypadExclusion,
  type KeypadUnit
} from '../lib/keypad';

export interface KeypadRequest {
  /** Which commit path the value feeds (routing is the opener's concern). */
  kind: 'offset' | 'edge' | 'radius' | 'sketch-dimension';
  /** Short label over the value field ('Offset', 'Radius', 'Height'). */
  label: string;
  /** Prefill; may be a typed digit captured mid-gesture. */
  initial: string;
  /** Captured first keys continue at the caret; measured prefills select all. */
  selectInitial?: boolean;
  unitKind: 'length' | 'angle';
  /** Radial display/entry notation; committed values are always radii. */
  dimensionMode?: DimensionMode;
  /** Total extent whose entered value normalizes to a signed offset. */
  totalBaseline?: number;
  /** -1 when the handle's drag subtracts from that total; default +1. */
  totalSense?: 1 | -1;
  /**
   * Original absolute measurement, used to restore exact-entry cancellation.
   */
  baseline?: number;
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
  /** Live preview as the value changes; only called with valid values. */
  onPreview(value: number): void;
  /** Commit: evaluated value in document units, plus the raw text. */
  onCommit(value: number, raw: string): void;
  /** Exact preview refused the current value; entry stays editable. */
  commitDisabled?: boolean;
  commitDisabledReason?: string | null;
  onDimensionModeChange?(mode: DimensionMode): void;
  onCancel(): void;
}

const LENGTH_UNITS: KeypadUnit[] = ['mm', 'cm', 'm'];
const PAD_KEYS = [
  ['7', '8', '9', '/'],
  ['4', '5', '6', '*'],
  ['1', '2', '3', '-'],
  ['±', '0', '.', '+']
];

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
  return ['.inspector-float', '.palette-float'].flatMap((selector) => {
    const panel = area.querySelector(selector);
    if (!panel) {
      return [];
    }
    const rect = panel.getBoundingClientRect();
    return rect.width > 0
      ? [{ x: rect.left - hostRect.left, width: rect.width }]
      : [];
  });
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
  onCommit,
  commitDisabled = false,
  commitDisabledReason,
  onDimensionModeChange,
  onCancel
}: NumericKeypadProps) {
  const [value, setValue] = useState(request.initial);
  const [dimensionMode, setDimensionMode] = useState(request.dimensionMode);
  const [entryUnit, setEntryUnit] = useState<KeypadUnit>(
    request.unitKind === 'angle' ? 'deg' : units === 'inch' ? 'mm' : units
  );
  const label = dimensionMode
    ? dimensionMode === 'diameter'
      ? 'Diameter'
      : 'Radius'
    : request.label;
  const rootRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const selectInitial = useRef(request.selectInitial ?? true);
  const initialPreviewed = useRef(false);
  const evaluation = evaluateKeypadInput(
    value,
    entryUnit,
    units,
    scope,
    dimensionMode
  );
  const normalizedValue =
    evaluation.value === undefined
      ? undefined
      : offsetFromTotal(evaluation.value, request);
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
    const positionAt = (point: { x: number; y: number } | null) => {
      if (positioned || !point) {
        return;
      }
      const host = root.parentElement;
      if (!host) {
        return;
      }
      const placement = keypadClampPosition(
        point,
        {
          width: root.offsetWidth || 232,
          height: root.offsetHeight || 280
        },
        { width: host.clientWidth, height: host.clientHeight },
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
        const chip = host.querySelector<HTMLElement>('.handle-value-chip');
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
    return () => {
      anchorRef.current = null;
    };
  }, [anchorRef, request.fixedClientAnchor]);

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
    if (evaluation.ok && normalizedValue !== undefined)
      onPreview(normalizedValue);
  }, [evaluation.ok, normalizedValue, onPreview]);

  const previewIfValid = (next: string, requestedMode = dimensionMode) => {
    const typedMode = dimensionModeForInput(next);
    const nextMode = typedMode ?? requestedMode;
    if (typedMode && typedMode !== dimensionMode) {
      setDimensionMode(typedMode);
      onDimensionModeChange?.(typedMode);
    }
    setValue(next);
    const result = evaluateKeypadInput(next, entryUnit, units, scope, nextMode);
    if (result.ok && result.value !== undefined) {
      onPreview(offsetFromTotal(result.value, request));
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
      onCommit(normalizedValue, normalizedRaw);
    }
  };

  const switchDimensionMode = (nextMode: DimensionMode) => {
    if (!dimensionMode || nextMode === dimensionMode) {
      return;
    }
    const next = convertDimensionInput(value, dimensionMode, nextMode);
    setDimensionMode(nextMode);
    onDimensionModeChange?.(nextMode);
    previewIfValid(next, nextMode);
  };

  return (
    <div
      ref={rootRef}
      className="numeric-keypad"
      data-state={commitDisabled ? 'warning' : 'ready'}
      role="dialog"
      aria-label={`${label} value`}
      // The viewport must never see keypad gestures as picks or orbits.
      onPointerDown={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === 'Enter') {
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
          value={value}
          aria-invalid={commitDisabled || !evaluation.ok}
          spellCheck={false}
          onChange={(event) => previewIfValid(event.target.value)}
        />
      </div>
      {/* A converted or computed value is shown in the document's own units,
          so a value typed in some other unit is never committed unseen. */}
      {/* Always present so typing an operator does not push the number grid
          and the Commit button down under the pointer. */}
      <div className="keypad-expr-preview">
        {evaluation.isExpression || evaluation.typedUnit
          ? evaluation.ok && evaluation.value !== undefined
            ? `= ${Math.round((evaluation.displayValue ?? evaluation.value) * 1000) / 1000} ${units}`
            : (evaluation.error ?? 'invalid')
          : ''}
      </div>
      {commitDisabled && commitDisabledReason ? (
        <div className="keypad-warning" role="alert">
          {commitDisabledReason}
        </div>
      ) : null}
      {dimensionMode && (
        <div
          className="keypad-units"
          role="radiogroup"
          aria-label="Radial entry mode"
        >
          {(['diameter', 'radius'] as DimensionMode[]).map((mode) => (
            <button
              key={mode}
              type="button"
              role="radio"
              aria-checked={dimensionMode === mode}
              className={dimensionMode === mode ? 'active' : undefined}
              onClick={() => switchDimensionMode(mode)}
            >
              {mode === 'diameter' ? 'Ø Diameter' : 'R Radius'}
            </button>
          ))}
        </div>
      )}
      <div className="keypad-units" role="radiogroup" aria-label="Entry unit">
        {(request.unitKind === 'angle'
          ? (['deg'] as KeypadUnit[])
          : LENGTH_UNITS
        ).map((unit) => (
          <button
            key={unit}
            type="button"
            role="radio"
            aria-checked={entryUnit === unit}
            className={entryUnit === unit ? 'active' : undefined}
            // Unit chips only rescale plain numbers, not expressions.
            disabled={evaluation.isExpression}
            onClick={() => {
              setEntryUnit(unit);
              const result = evaluateKeypadInput(
                value,
                unit,
                units,
                scope,
                dimensionMode
              );
              if (result.ok && result.value !== undefined) {
                onPreview(offsetFromTotal(result.value, request));
              }
            }}
          >
            {unit}
          </button>
        ))}
      </div>
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
        {/* Named, not just ticked: a bare checkmark makes the user guess what
            it applies, and the name is the same one assistive tech reads. */}
        <button
          type="button"
          className="keypad-commit"
          disabled={!evaluation.ok || commitDisabled}
          onClick={commit}
        >
          <Check size={16} aria-hidden="true" />
          {`Apply ${label.toLowerCase()}`}
        </button>
      </div>
    </div>
  );
}
