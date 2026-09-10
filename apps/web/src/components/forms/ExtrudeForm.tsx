import { useEffect, useRef, useState, type MutableRefObject } from 'react';
import { coerceParamValue } from '@openzcad/document-core';
import type { BodyId, ParamValue, SketchId } from '@openzcad/shared';
import type { ExtrudeChoice } from '../../lib/extrudeInference';
import { paramValueText, previewExpression } from '../../lib/model';
import { ExprInput } from '../ExprInput';
import { ExtrudeControls } from '../ExtrudeControls';

export interface ExtrudeFormValue {
  name: string;
  sketchId: SketchId;
  distance: ParamValue;
  symmetric: boolean;
  backDistance: ParamValue;
  choice: ExtrudeChoice;
}

interface ExtrudeFormProps {
  scope: Record<string, number>;
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
  onDistance?(value: ParamValue): void;
}

/** The same draft editor for a selected profile and an existing feature. */
export function ExtrudeForm({
  scope,
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
  onCancel,
  onDistance
}: ExtrudeFormProps) {
  const [draft, setDraft] = useState(() => ({
    name: initial.name,
    distance: paramValueText(initial.distance),
    symmetric: initial.symmetric === true,
    backDistance: paramValueText(initial.backDistance ?? 0),
    choice: {
      operation: initial.operation ?? (creating ? 'automatic' : 'new-body'),
      ...(initial.targetBodyId ? { targetBodyId: initial.targetBodyId } : {})
    }
  }));
  const distance = previewExpression(draft.distance, scope);
  const back = previewExpression(draft.backDistance, scope);
  const valid = valueFor(draft) !== null;

  function valueFor(next: typeof draft): ExtrudeFormValue | null {
    const d = previewExpression(next.distance, scope);
    const b = previewExpression(next.backDistance, scope);
    const targetRequired =
      next.choice.operation === 'add' || next.choice.operation === 'cut';
    const targetBodyId = targetRequired ? next.choice.targetBodyId : undefined;
    if (
      !next.name.trim() ||
      !d.ok ||
      d.value === undefined ||
      d.value === 0 ||
      (!next.symmetric && (!b.ok || b.value === undefined || b.value < 0)) ||
      (targetRequired && !bodies.some((body) => body.bodyId === targetBodyId))
    )
      return null;
    return {
      name: next.name.trim(),
      sketchId: initial.sketchId,
      distance: coerceParamValue(next.distance),
      symmetric: next.symmetric,
      backDistance: next.symmetric ? 0 : coerceParamValue(next.backDistance),
      choice: next.choice
    };
  }

  function change(patch: Partial<typeof draft>) {
    const next = { ...draft, ...patch };
    setDraft(next);
    onDraft?.({
      name: next.name.trim(),
      sketchId: initial.sketchId,
      distance: coerceParamValue(next.distance),
      symmetric: next.symmetric,
      backDistance: next.symmetric ? 0 : coerceParamValue(next.backDistance),
      choice: next.choice
    });
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
        <ExprInput
          label="Distance"
          value={draft.distance}
          scope={scope}
          onChange={(distance) => change({ distance })}
          error={
            distance.ok && distance.value === 0
              ? 'Distance cannot be zero — a zero-distance extrude builds no solid.'
              : undefined
          }
        />
        <button
          type="button"
          onClick={() =>
            change({
              distance: Number.isFinite(Number(draft.distance))
                ? String(-Number(draft.distance))
                : `-(${draft.distance})`
            })
          }
        >
          Reverse direction
        </button>
        <label className="field extrude-symmetry">
          <input
            type="checkbox"
            checked={draft.symmetric}
            onChange={(event) => change({ symmetric: event.target.checked })}
          />
          <span>Symmetric about the sketch plane</span>
        </label>
        {!draft.symmetric && (
          <ExprInput
            label="Back distance"
            value={draft.backDistance}
            scope={scope}
            onChange={(backDistance) => change({ backDistance })}
            error={
              back.ok && back.value !== undefined && back.value < 0
                ? 'Back distance cannot be negative.'
                : undefined
            }
          />
        )}
        <p className="muted">
          Negative distance reverses the extrusion. Drag or type to preview;{' '}
          {submitLabel} saves the result.
        </p>
        {onDistance && (
          <button
            type="button"
            disabled={!distance.ok}
            onClick={() => onDistance(coerceParamValue(draft.distance))}
          >
            Distance…
          </button>
        )}
      </fieldset>
      <div className="form-actions">
        <button type="submit" className="primary" disabled={disabled || !valid}>
          {submitLabel}
        </button>
        <button type="button" className="secondary" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}
