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
  evaluateKeypadInput,
  keypadClampPosition,
  type KeypadUnit
} from '../lib/keypad';

export interface KeypadRequest {
  /** Which commit path the value feeds (routing is the opener's concern). */
  kind: 'offset' | 'edge';
  /** Short label over the value field ('Offset', 'Radius', '⌀', 'Height'). */
  label: string;
  /** Prefill; may be a typed digit captured mid-gesture. */
  initial: string;
  unitKind: 'length' | 'angle';
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
  anchorRef: MutableRefObject<((point: { x: number; y: number } | null) => void) | null>;
  /** Live preview as the value changes; only called with valid values. */
  onPreview(value: number): void;
  /** Commit: evaluated value in document units, plus the raw text. */
  onCommit(value: number, raw: string): void;
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
  onCancel
}: NumericKeypadProps) {
  const [value, setValue] = useState(request.initial);
  const [entryUnit, setEntryUnit] = useState<KeypadUnit>(
    request.unitKind === 'angle' ? 'deg' : units === 'inch' ? 'mm' : units
  );
  const rootRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const evaluation = evaluateKeypadInput(value, entryUnit, units, scope);

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

  const previewIfValid = (next: string) => {
    setValue(next);
    const result = evaluateKeypadInput(next, entryUnit, units, scope);
    if (result.ok && result.value !== undefined) {
      onPreview(result.value);
    }
    // Keep the value field focused so Enter/Escape always land on the pad.
    inputRef.current?.focus();
  };

  const commit = () => {
    if (evaluation.ok && evaluation.value !== undefined) {
      onCommit(evaluation.value, value.trim());
    }
  };

  return (
    <div
      ref={rootRef}
      className="numeric-keypad"
      role="dialog"
      aria-label={`${request.label} value`}
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
        <span className="keypad-label">{request.label}</span>
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
            ? `= ${Math.round(evaluation.value * 1000) / 1000} ${units}`
            : (evaluation.error ?? 'invalid')}
        </div>
      )}
      <div className="keypad-units" role="radiogroup" aria-label="Entry unit">
        {(request.unitKind === 'angle' ? (['deg'] as KeypadUnit[]) : LENGTH_UNITS).map(
          (unit) => (
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
                const result = evaluateKeypadInput(value, unit, units, scope);
                if (result.ok && result.value !== undefined) {
                  onPreview(result.value);
                }
              }}
            >
              {unit}
            </button>
          )
        )}
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
          aria-label={`Apply ${request.label.toLowerCase()}`}
          disabled={!evaluation.ok}
          onClick={commit}
        >
          <Check size={16} aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}
