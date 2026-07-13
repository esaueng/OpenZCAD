import { useEffect, useRef } from 'react';
import { Check, X } from 'lucide-react';
import type {
  BooleanOperation,
  PlaneId,
  RevolveAxis,
  SketchObjectKind
} from '@openzcad/shared';
import {
  sessionFields,
  sessionInstruction,
  sessionTitle,
  validateSession,
  type ToolSession
} from '../lib/session';
import { PLANE_LABELS, REVOLVE_AXIS_LABELS, previewExpression } from '../lib/model';

interface CommandHUDProps {
  session: ToolSession;
  scope: Record<string, number>;
  units: string;
  /** Names of the bodies picked so far (boolean sessions). */
  pickedBodyNames: string[];
  onSetValue(key: string, value: string): void;
  onSetPlane(plane: PlaneId): void;
  onSetShape(shape: SketchObjectKind): void;
  onSetAxis(axis: RevolveAxis): void;
  onSetOperation(operation: BooleanOperation): void;
  onConfirm(): void;
  onCancel(): void;
}

const SHAPES: SketchObjectKind[] = ['rectangle', 'circle', 'polygon'];
const SHAPE_LABELS: Record<SketchObjectKind, string> = {
  rectangle: 'Rectangle',
  circle: 'Circle',
  polygon: 'Polygon'
};
const OPERATIONS: BooleanOperation[] = ['union', 'subtract', 'intersect'];
const OPERATION_LABELS: Record<BooleanOperation, string> = {
  union: 'Union',
  subtract: 'Subtract',
  intersect: 'Intersect'
};

function ChipRow<T extends string>({
  label,
  options,
  labels,
  value,
  onSelect
}: {
  label: string;
  options: T[];
  labels: Record<T, string>;
  value: T;
  onSelect(option: T): void;
}) {
  return (
    <div className="hud-chip-row" role="radiogroup" aria-label={label}>
      <span className="hud-chip-label">{label}</span>
      {options.map((option) => (
        <button
          key={option}
          type="button"
          role="radio"
          aria-checked={option === value}
          className={`hud-chip ${option === value ? 'active' : ''}`}
          onClick={() => onSelect(option)}
        >
          {labels[option]}
        </button>
      ))}
    </div>
  );
}

/**
 * Floating command HUD: title, one-line instruction, compact expression
 * inputs (Tab/Shift+Tab cycle, Enter confirms, Esc cancels — handled by the
 * global keymap), and explicit confirm/cancel actions. Values preview live;
 * nothing is committed until confirm.
 */
export function CommandHUD({
  session,
  scope,
  units,
  pickedBodyNames,
  onSetValue,
  onSetPlane,
  onSetShape,
  onSetAxis,
  onSetOperation,
  onConfirm,
  onCancel
}: CommandHUDProps) {
  const fields = sessionFields(session);
  const validation = validateSession(session, scope);
  const firstInputRef = useRef<HTMLInputElement | null>(null);
  const sessionKindRef = useRef<string>('');

  // Focus the first parameter when a session starts (not on every keystroke),
  // so drag-first workflows and type-first workflows both work.
  useEffect(() => {
    const identity = `${session.kind}:${'primitiveKind' in session ? session.primitiveKind : ''}`;
    if (identity !== sessionKindRef.current) {
      sessionKindRef.current = identity;
      firstInputRef.current?.select();
    }
  }, [session]);

  return (
    <div className="command-hud" role="dialog" aria-label={`${sessionTitle(session)} command`}>
      <div className="hud-header">
        <strong className="hud-title">{sessionTitle(session)}</strong>
        <span className="hud-instruction">{sessionInstruction(session)}</span>
      </div>

      {session.kind === 'sketch' && (
        <>
          <ChipRow
            label="Plane"
            options={Object.keys(PLANE_LABELS) as PlaneId[]}
            labels={PLANE_LABELS}
            value={session.plane}
            onSelect={onSetPlane}
          />
          <ChipRow
            label="Shape"
            options={SHAPES}
            labels={SHAPE_LABELS}
            value={session.shape}
            onSelect={onSetShape}
          />
        </>
      )}
      {session.kind === 'revolve' && (
        <ChipRow
          label="Axis"
          options={Object.keys(REVOLVE_AXIS_LABELS) as RevolveAxis[]}
          labels={REVOLVE_AXIS_LABELS}
          value={session.axis}
          onSelect={onSetAxis}
        />
      )}
      {session.kind === 'boolean' && (
        <>
          <ChipRow
            label="Operation"
            options={OPERATIONS}
            labels={OPERATION_LABELS}
            value={session.operation}
            onSelect={onSetOperation}
          />
          <div className="hud-picks" aria-live="polite">
            {pickedBodyNames.length === 0 ? (
              <span className="muted">No bodies picked yet.</span>
            ) : (
              pickedBodyNames.map((name, index) => (
                <span key={`${name}-${index}`} className="hud-pick">
                  <i>{index + 1}</i>
                  {name}
                </span>
              ))
            )}
          </div>
        </>
      )}

      {fields.length > 0 && (
        <div className="hud-fields">
          {fields.map((field, index) => {
            const raw = session.values[field.key] ?? '';
            const error = validation.fieldErrors[field.key];
            const preview = previewExpression(raw, scope);
            const isPlainNumber = /^\s*-?(?:\d+\.?\d*|\.\d+)\s*$/.test(raw);
            return (
              <label key={field.key} className={`hud-field ${error ? 'invalid' : ''}`}>
                <span className="hud-field-label">{field.label}</span>
                <input
                  ref={index === 0 ? firstInputRef : undefined}
                  className="mono"
                  value={raw}
                  spellCheck={false}
                  autoComplete="off"
                  aria-label={field.label}
                  aria-invalid={Boolean(error)}
                  onChange={(event) => onSetValue(field.key, event.target.value)}
                  onFocus={(event) => event.currentTarget.select()}
                  onKeyDown={(event) => {
                    // Arrow increments for plain numbers; expressions untouched.
                    if (
                      (event.key === 'ArrowUp' || event.key === 'ArrowDown') &&
                      isPlainNumber
                    ) {
                      event.preventDefault();
                      const step = event.shiftKey ? 10 : 1;
                      const current = Number(raw) || 0;
                      const next = current + (event.key === 'ArrowUp' ? step : -step);
                      onSetValue(field.key, String(Math.round(next * 1000) / 1000));
                    }
                  }}
                />
                <span className="hud-field-unit">{field.unit ?? units}</span>
                {error ? (
                  <small className="hud-field-error">{error}</small>
                ) : (
                  !isPlainNumber &&
                  raw.trim().length > 0 && (
                    <small className={`hud-field-preview ${preview.ok ? '' : 'error'}`}>
                      {preview.text}
                    </small>
                  )
                )}
              </label>
            );
          })}
        </div>
      )}

      {validation.message && <p className="hud-message">{validation.message}</p>}

      <div className="hud-actions">
        <button
          type="button"
          className="primary hud-confirm"
          disabled={!validation.ok}
          onClick={onConfirm}
          title="Confirm (Enter)"
        >
          <Check size={13} aria-hidden="true" />
          Confirm
          <kbd>↵</kbd>
        </button>
        <button type="button" className="secondary" onClick={onCancel} title="Cancel (Esc)">
          <X size={13} aria-hidden="true" />
          Cancel
          <kbd>Esc</kbd>
        </button>
      </div>
    </div>
  );
}
