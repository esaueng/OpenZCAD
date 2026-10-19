import { useEffect, useRef, useState, type MutableRefObject } from 'react';
import {
  MAX_EXTRUDE_DRAFT_DEG,
  coerceParamValue
} from '@openzcad/document-core';
import type {
  BodyId,
  ExtrudeEndCondition,
  ExtrudeToFaceTarget,
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
  /** F01 (v29): present exactly with `to-face`. */
  toFace?: ExtrudeToFaceTarget;
  /** F01 (v29): absent for straight walls (a typed 0 is sent as absent). */
  draftAngleDeg?: ParamValue;
}

/**
 * What the host tells the form about a to-face target: how it reads, and
 * where the build will put it (the signed distance from the sketch plane),
 * or why it cannot reach it from this sketch.
 */
export interface ExtrudeToFaceInfo {
  label: string;
  distance: number | null;
}

/** The host's side of the to-face pick (see `ExtrudeExtentControls`). */
export interface ExtrudeToFacePicking {
  /** True while the viewport is waiting for this form's face. */
  armed: boolean;
  /** Arms (or, when armed, cancels) the viewport face pick. */
  onPick(): void;
  /**
   * Withdraws this card's armed pick, if any: called when the card unmounts,
   * so a closed card never leaves the viewport waiting for its face.
   */
  cancel(): void;
  /** How a target reads and where it sits, from the current projection. */
  describe(target: ExtrudeToFaceTarget): ExtrudeToFaceInfo;
  /** The stored face no longer resolves (edit only). */
  unresolved?: boolean;
  /** Receives the face the viewport pick produced. */
  setterRef: MutableRefObject<((target: ExtrudeToFaceTarget) => void) | null>;
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
    toFace?: ExtrudeToFaceTarget;
    draftAngleDeg?: ParamValue;
  };
  /** Absent: To face is not offered (no host to pick the face with). */
  toFacePicking?: ExtrudeToFacePicking;
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
/** The steepest draft the form takes; the schema's own bound. */
const MAX_DRAFT_DEG = MAX_EXTRUDE_DRAFT_DEG;

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
  toFacePicking,
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
    throughAllSide: initial.throughAllSide ?? 'forward',
    toFace: initial.toFace,
    draftAngle: paramValueText(initial.draftAngleDeg ?? 0)
  }));
  // Through all needs one explicit cut target, so it is offered once Cut is
  // chosen, never while the operation is still being inferred.
  const offersThroughAll = draft.choice.operation === 'cut';
  const isThroughAll = (next: typeof draft) =>
    next.choice.operation === 'cut' && next.endCondition === 'through-all';
  const throughAll = isThroughAll(draft);
  // F01 (v29): to-face replaces the distance with a picked face; any
  // operation may reach one. A host with no face pick never offers it.
  const isToFace = (next: typeof draft) =>
    toFacePicking !== undefined && next.endCondition === 'to-face';
  const toFace = isToFace(draft);
  const toFaceInfo =
    toFace && draft.toFace ? toFacePicking!.describe(draft.toFace) : null;
  // A face picked here that the build would refuse (not parallel to the
  // sketch, or lying on it) is said before Apply rather than after.
  const toFaceProblem =
    toFaceInfo && toFaceInfo.distance === null
      ? 'This face is not parallel to the sketch plane, or lies on it; pick a face parallel to the sketch.'
      : null;
  // A new extrude opens at zero until the user drags or types a distance, so
  // the zero-distance error waits for that edit (or an attempt to submit)
  // rather than greeting the card in red. Create stays disabled either way.
  const [distanceEdited, setDistanceEdited] = useState(false);
  const quantity = { documentUnits: units, dimension: 'length' } as const;
  const angleQuantity = { documentUnits: units, dimension: 'angle' } as const;
  const distance = previewExpression(draft.distance, scope, quantity);
  const back = previewExpression(draft.backDistance, scope, quantity);
  const valid = valueFor(draft) !== null;
  const draftError = draftAngleError(draft);

  /**
   * Why the draft cannot apply as typed, or null. It tapers a one-sided
   * extrusion only, and an angle at a right angle has no finite taper.
   */
  function draftAngleError(next: typeof draft): string | null {
    const a = previewExpression(next.draftAngle, scope, angleQuantity);
    if (!a.ok || a.value === undefined) return null;
    if (Math.abs(a.value) >= MAX_DRAFT_DEG) {
      return `Draft must be between -${MAX_DRAFT_DEG}° and ${MAX_DRAFT_DEG}°.`;
    }
    if (a.value === 0) return null;
    if (!isToFace(next) && next.symmetric) {
      return 'Draft tapers a one-sided extrusion; turn off Symmetric to draft it.';
    }
    const b = previewExpression(next.backDistance, scope, quantity);
    if (!isToFace(next) && b.ok && b.value !== undefined && b.value !== 0) {
      return 'Draft tapers a one-sided extrusion; clear Back distance to draft it.';
    }
    return null;
  }

  function valueFor(next: typeof draft): ExtrudeFormValue | null {
    const d = previewExpression(next.distance, scope, quantity);
    const b = previewExpression(next.backDistance, scope, quantity);
    const targetRequired =
      next.choice.operation === 'add' ||
      next.choice.operation === 'cut' ||
      next.choice.operation === 'intersect';
    const targetBodyId = targetRequired ? next.choice.targetBodyId : undefined;
    const nextThroughAll = isThroughAll(next);
    const nextToFace = isToFace(next);
    const a = previewExpression(next.draftAngle, scope, angleQuantity);
    if (
      !next.name.trim() ||
      (nextToFace &&
        // No face yet, or one the build would refuse from this sketch (not
        // parallel to it, or lying on it): nothing to Create or Apply.
        (!next.toFace ||
          toFacePicking!.describe(next.toFace).distance === null)) ||
      (!nextThroughAll &&
        (!a.ok || a.value === undefined || draftAngleError(next) !== null)) ||
      // Through all and to-face ignore the distance; it is kept only for
      // switching back to blind, so it cannot block Apply.
      (!nextThroughAll &&
        !nextToFace &&
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
    const nextThroughAll = isThroughAll(next);
    const nextToFace = isToFace(next);
    const derived = nextThroughAll || nextToFace;
    // A through-all cut and a to-face extrude derive their span in the
    // build, so the distance is dormant; a create still needs it non-zero,
    // so an untouched 0 sends 1.
    const typed = coerceParamValue(next.distance);
    const draftAngleDeg = coerceParamValue(next.draftAngle);
    return {
      name: next.name.trim(),
      sketchId: initial.sketchId,
      distance: derived && !typed ? 1 : typed,
      symmetric: derived ? false : next.symmetric,
      backDistance:
        derived || next.symmetric ? 0 : coerceParamValue(next.backDistance),
      choice: next.choice,
      endCondition: nextThroughAll
        ? 'through-all'
        : nextToFace
          ? 'to-face'
          : 'blind',
      ...(nextThroughAll ? { throughAllSide: next.throughAllSide } : {}),
      ...(nextToFace && next.toFace ? { toFace: next.toFace } : {}),
      ...(!nextThroughAll && draftAngleDeg !== 0 && draftAngleDeg !== '0'
        ? { draftAngleDeg }
        : {})
    };
  }

  function change(patch: Partial<typeof draft>) {
    const next = { ...draft, ...patch };
    if (patch.distance !== undefined) setDistanceEdited(true);
    setDraft(next);
    onDraft?.(formValue(next));
    onPreview?.(valueFor(next));
  }
  // The viewport arrow and keypad set a distance: on a to-face extrude that
  // is a choice of Distance over the face, so the extent follows the drag.
  const updateDistance = useRef((value: ParamValue) =>
    change({ distance: paramValueText(value) })
  );
  updateDistance.current = (value) =>
    change({
      distance: paramValueText(value),
      ...(draft.endCondition === 'to-face'
        ? { endCondition: 'blind' as const }
        : {})
    });
  useEffect(() => {
    if (!distanceSetterRef) return;
    distanceSetterRef.current = (value) => updateDistance.current(value);
    return () => {
      distanceSetterRef.current = null;
    };
  }, [distanceSetterRef]);
  // A picked face becomes the target, and the depth it gives becomes the
  // dormant distance, so switching back to Distance keeps the same reach.
  const updateFace = useRef((_target: ExtrudeToFaceTarget) => {});
  updateFace.current = (target) => {
    const reach = toFacePicking?.describe(target).distance ?? null;
    change({
      toFace: target,
      endCondition: 'to-face',
      ...(reach !== null
        ? { distance: String(Math.round(reach * 1e6) / 1e6) }
        : {})
    });
  };
  const faceSetterRef = toFacePicking?.setterRef;
  const cancelPick = useRef(() => {});
  cancelPick.current = () => toFacePicking?.cancel();
  useEffect(() => {
    if (!faceSetterRef) return;
    faceSetterRef.current = (target) => updateFace.current(target);
    return () => {
      faceSetterRef.current = null;
      // Closing the card withdraws its pick, armed or not.
      cancelPick.current();
    };
  }, [faceSetterRef]);

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
          // An armed face pick is the innermost thing Escape can close.
          if (toFacePicking?.armed) toFacePicking.onPick();
          else onCancel();
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
        {offersThroughAll || toFacePicking ? (
          <ExtrudeExtentControls
            endCondition={
              throughAll || toFace
                ? draft.endCondition
                : draft.endCondition === 'through-all'
                  ? 'blind'
                  : draft.endCondition
            }
            throughAllSide={draft.throughAllSide}
            offersThroughAll={offersThroughAll}
            toFace={{
              label: toFaceInfo?.label ?? null,
              unresolved:
                toFacePicking?.unresolved === true &&
                draft.toFace === initial.toFace,
              problem: toFaceProblem,
              armed: toFacePicking?.armed === true,
              onPick: () => toFacePicking?.onPick()
            }}
            onChange={change}
          />
        ) : null}
        {throughAll || toFace ? null : (
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
        {throughAll ? null : (
          <ExprInput
            label="Draft angle"
            value={draft.draftAngle}
            scope={scope}
            quantity={angleQuantity}
            onChange={(draftAngle) => change({ draftAngle })}
            error={draftError ?? undefined}
          />
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
