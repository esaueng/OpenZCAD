import { useEffect, useRef, useState, type MutableRefObject } from 'react';
import { coerceParamValue } from '@openzcad/document-core';
import type {
  BodyId,
  ExtrudeEndCondition,
  ParamValue,
  SketchId,
  ThroughAllSide,
  UnitSystem
} from '@openzcad/shared';
import type { ExtrudeChoice } from '../../lib/extrudeInference';
import { paramValueText, previewExpression } from '../../lib/model';
import { ExprInput } from '../ExprInput';
import { ExtrudeControls } from '../ExtrudeControls';
import ExtrudeExtentControls from './ExtrudeExtentControls';

export interface ExtrudeFormValue {
  name: string;
  sketchId: SketchId;
  distance: ParamValue;
  symmetric: boolean;
  backDistance: ParamValue;
  choice: ExtrudeChoice;
  /**
   * F01: `through-all` is offered for an existing explicit cut only. Absent
   * reads as blind, which is all the create path ever sends.
   */
  endCondition?: ExtrudeEndCondition;
  throughAllSide?: ThroughAllSide;
}

interface ExtrudeFormProps {
  scope: Record<string, number>;
  units?: UnitSystem;
  sketches: { sketchId: SketchId; name: string }[];
  bodies: { bodyId: BodyId; name: string }[];
  initial: {
    name: string;
    sketchId: SketchId;
    distance: ParamValue;
    symmetric?: boolean;
    backDistance?: ParamValue;
    operation?: ExtrudeChoice['operation'];
    targetBodyId?: BodyId;
    endCondition?: ExtrudeEndCondition;
    throughAllSide?: ThroughAllSide;
  };
  creating?: boolean;
  profileCount?: number;
  disabled?: boolean;
  submitLabel: string;
  distanceSetterRef?: MutableRefObject<((value: ParamValue) => void) | null>;
  onDraft?(value: ExtrudeFormValue): void;
  onPreview?(value: ExtrudeFormValue | null): void;
  onSubmit(value: ExtrudeFormValue): void;
  onCancel(): void;
}

/**
 * The distance with its direction flipped. A negated expression is unwrapped
 * rather than wrapped again, so Reverse twice reads as it started instead of
 * `-(-(10/2))`.
 */
export function reversedDistance(distance: string): string {
  const text = distance.trim();
  if (Number.isFinite(Number(text))) {
    return String(-Number(text));
  }
  if (text.startsWith('-(') && text.endsWith(')')) {
    // Only when that first parenthesis closes at the very end: `-(a)*(b)`
    // is not a negation of everything after the minus.
    let depth = 0;
    for (let index = 1; index < text.length; index += 1) {
      const char = text[index];
      if (char === '(') depth += 1;
      if (char === ')') depth -= 1;
      if (depth === 0) {
        if (index === text.length - 1) return text.slice(2, -1).trim();
        break;
      }
    }
  }
  return `-(${text})`;
}

/** The same draft editor for a selected profile and an existing feature. */
export function ExtrudeForm({
  scope,
  units = 'mm',
  sketches,
  bodies,
  initial,
  creating = false,
  profileCount,
  disabled = false,
  submitLabel,
  distanceSetterRef,
  onDraft,
  onPreview,
  onSubmit,
  onCancel
}: ExtrudeFormProps) {
  const [draft, setDraft] = useState(() => ({
    name: initial.name,
    distance: paramValueText(initial.distance),
    symmetric: initial.symmetric === true,
    backDistance: paramValueText(initial.backDistance ?? 0),
    choice: {
      operation: initial.operation ?? (creating ? 'automatic' : 'new-body'),
      ...(initial.targetBodyId ? { targetBodyId: initial.targetBodyId } : {})
    },
    endCondition: initial.endCondition ?? 'blind',
    throughAllSide: initial.throughAllSide ?? 'forward'
  }));
  // Through all needs one explicit cut target, so it is offered when editing
  // a cut, not while the operation is still being inferred.
  const offersThroughAll = !creating && draft.choice.operation === 'cut';
  const throughAll = offersThroughAll && draft.endCondition === 'through-all';
  // A new extrude opens at zero until the user drags or types a distance, so
  // the zero-distance error waits for that edit (or an attempt to submit)
  // rather than greeting the card in red. Create stays disabled either way.
  const [distanceEdited, setDistanceEdited] = useState(false);
  const quantity = { documentUnits: units, dimension: 'length' } as const;
  const distance = previewExpression(draft.distance, scope, quantity);
  const back = previewExpression(draft.backDistance, scope, quantity);
  const valid = valueFor(draft) !== null;

  function valueFor(next: typeof draft): ExtrudeFormValue | null {
    const d = previewExpression(next.distance, scope, quantity);
    const b = previewExpression(next.backDistance, scope, quantity);
    const targetRequired =
      next.choice.operation === 'add' || next.choice.operation === 'cut';
    const targetBodyId = targetRequired ? next.choice.targetBodyId : undefined;
    const nextThroughAll =
      !creating &&
      next.choice.operation === 'cut' &&
      next.endCondition === 'through-all';
    if (
      !next.name.trim() ||
      // Through all ignores the distance; it is kept only for switching
      // back to blind, so it cannot block Apply.
      (!nextThroughAll &&
        (!d.ok ||
          d.value === undefined ||
          d.value === 0 ||
          (!next.symmetric &&
            (!b.ok || b.value === undefined || b.value < 0)))) ||
      (targetRequired && !bodies.some((body) => body.bodyId === targetBodyId))
    )
      return null;
    return formValue(next);
  }

  function formValue(next: typeof draft): ExtrudeFormValue {
    const nextThroughAll =
      !creating &&
      next.choice.operation === 'cut' &&
      next.endCondition === 'through-all';
    return {
      name: next.name.trim(),
      sketchId: initial.sketchId,
      distance: coerceParamValue(next.distance),
      symmetric: nextThroughAll ? false : next.symmetric,
      backDistance:
        nextThroughAll || next.symmetric
          ? 0
          : coerceParamValue(next.backDistance),
      choice: next.choice,
      endCondition: nextThroughAll ? 'through-all' : 'blind',
      throughAllSide: next.throughAllSide
    };
  }

  function change(patch: Partial<typeof draft>) {
    const next = { ...draft, ...patch };
    if (patch.distance !== undefined) setDistanceEdited(true);
    setDraft(next);
    onDraft?.(formValue(next));
    onPreview?.(valueFor(next));
  }
  const updateDistance = useRef((value: ParamValue) =>
    change({ distance: paramValueText(value) })
  );
  updateDistance.current = (value) =>
    change({ distance: paramValueText(value) });
  useEffect(() => {
    if (!distanceSetterRef) return;
    distanceSetterRef.current = (value) => updateDistance.current(value);
    return () => {
      distanceSetterRef.current = null;
    };
  }, [distanceSetterRef]);

  function submit() {
    setDistanceEdited(true);
    const value = valueFor(draft);
    if (value && !disabled) onSubmit(value);
  }

  return (
    <form
      className="feature-form extrude-form"
      aria-label="Extrude settings"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.stopPropagation();
          onCancel();
        }
        if (
          event.key === 'Enter' &&
          !(event.target instanceof HTMLButtonElement)
        ) {
          event.preventDefault();
          event.stopPropagation();
          submit();
        }
      }}
    >
      <fieldset disabled={disabled}>
        <label className="field">
          <span>Name</span>
          <input
            value={draft.name}
            onChange={(event) => change({ name: event.target.value })}
          />
        </label>
        <p className="muted">
          {sketches.find((sketch) => sketch.sketchId === initial.sketchId)
            ?.name ?? 'Selected sketch'}
          {profileCount
            ? ` · ${profileCount} selected ${profileCount === 1 ? 'profile' : 'profiles'}`
            : ''}
        </p>
        <ExtrudeControls
          choice={draft.choice}
          bodies={bodies}
          disabled={disabled}
          allowAutomatic={creating}
          onChange={(choice) => change({ choice })}
        />
        {offersThroughAll ? (
          <ExtrudeExtentControls
            endCondition={draft.endCondition}
            throughAllSide={draft.throughAllSide}
            onChange={change}
          />
        ) : null}
        {throughAll ? null : (
          <>
            <ExprInput
              label="Distance"
              value={draft.distance}
              scope={scope}
              quantity={quantity}
              onChange={(distance) => change({ distance })}
              error={
                distanceEdited && distance.ok && distance.value === 0
                  ? 'Distance cannot be zero — a zero-distance extrude builds no solid.'
                  : undefined
              }
            />
            {!distanceEdited && distance.ok && distance.value === 0 ? (
              // Before the first edit the zero is the starting value, not a
              // mistake, so it is not shown in red; but a dim Create with no
              // reason anywhere read as a broken button.
              <p className="muted">
                Enter a distance other than 0, or drag the arrow, to enable{' '}
                {submitLabel}.
              </p>
            ) : null}
            <button
              type="button"
              className="secondary"
              onClick={() =>
                change({ distance: reversedDistance(draft.distance) })
              }
            >
              Reverse direction
            </button>
            <label className="field extrude-symmetry">
              <input
                type="checkbox"
                checked={draft.symmetric}
                onChange={(event) =>
                  change({ symmetric: event.target.checked })
                }
              />
              <span>Symmetric about the sketch plane</span>
            </label>
            {!draft.symmetric && (
              <ExprInput
                label="Back distance"
                value={draft.backDistance}
                scope={scope}
                quantity={quantity}
                onChange={(backDistance) => change({ backDistance })}
                error={
                  back.ok && back.value !== undefined && back.value < 0
                    ? 'Back distance cannot be negative.'
                    : undefined
                }
              />
            )}
            {/* Direction is the distance's sign, and Reverse is the one control
            that flips it. A third way, "Distance…", opened the viewport's
            exact-entry keypad for the same number this field already holds
            (the value chip and typing a digit still open that keypad). */}
            <p className="muted">
              Negative distance reverses the extrusion. Drag or type to preview;{' '}
              {submitLabel} saves the result.
            </p>
          </>
        )}
      </fieldset>
      <div className="form-actions">
        <button
          type="submit"
          className="primary"
          disabled={disabled || !valid}
          aria-keyshortcuts="Enter"
        >
          {submitLabel}
          <kbd className="kbd-inline" aria-hidden="true">
            ↵
          </kbd>
        </button>
        <button type="button" className="secondary" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}
