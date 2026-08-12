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
  type KeypadUnit
} from '../lib/keypad';

export interface KeypadRequest {
  /** Which commit path the value feeds (routing is the opener's concern). */
  kind: 'offset' | 'edge' | 'radius';
  /** Short label over the value field ('Offset', 'Radius', 'Height'). */
  label: string;
  /** Prefill; may be a typed digit captured mid-gesture. */
  initial: string;
  unitKind: 'length' | 'angle';
  /** Radial display/entry notation; committed values are always radii. */
  dimensionMode?: DimensionMode;
  /** Total extent whose entered value normalizes to a signed offset. */
  totalBaseline?: number;
  /**
   * Original absolute measurement, used to restore exact-entry cancellation.
   */
  baseline?: number;
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
 * Floating exact-value entry anchored at the point of action — the keyboard
 * companion of every drag handle. One instance serves offsets, radii,
 * extrude heights, and sketch dimensions.
 */
export function NumericKeypad({
  request,
  units,
  scope,
  anchorRef,
  onPreview,
  onCommit,
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
      : evaluation.value - (request.totalBaseline ?? 0);
  const normalizedRaw =
    evaluation.normalizedRaw === undefined
      ? undefined
      : request.totalBaseline === undefined
        ? evaluation.normalizedRaw
        : evaluation.isExpression
          ? `(${evaluation.normalizedRaw}) - ${request.totalBaseline}`
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
    anchorRef.current = (point) => {
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
        { width: host.clientWidth, height: host.clientHeight }
      );
      root.style.visibility = 'visible';
      root.style.left = `${placement.x}px`;
      root.style.top = `${placement.y}px`;
      positioned = true;
    };
    return () => {
      anchorRef.current = null;
    };
  }, [anchorRef]);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

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
      onPreview(result.value - (request.totalBaseline ?? 0));
    }
    // Keep the value field focused so Enter/Escape always land on the pad.
    inputRef.current?.focus();
  };

  const commit = () => {
    if (
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
          spellCheck={false}
          onChange={(event) => previewIfValid(event.target.value)}
        />
      </div>
      {evaluation.isExpression && (
        <div className="keypad-expr-preview">
          {evaluation.ok && evaluation.value !== undefined
            ? `= ${Math.round((evaluation.displayValue ?? evaluation.value) * 1000) / 1000} ${units}`
            : (evaluation.error ?? 'invalid')}
        </div>
      )}
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
                onPreview(result.value - (request.totalBaseline ?? 0));
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
        <button
          type="button"
          className="keypad-commit"
          aria-label={`Apply ${label.toLowerCase()}`}
          disabled={!evaluation.ok}
          onClick={commit}
        >
          <Check size={16} aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}
