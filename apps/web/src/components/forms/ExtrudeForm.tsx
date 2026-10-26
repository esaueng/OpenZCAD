import { useEffect, useRef, useState, type MutableRefObject } from 'react';
import type {
  BodyId,
  ExtrudeToFaceTarget,
  ParamValue,
  SketchId,
  UnitSystem
} from '@openzcad/shared';
import {
  extrudeDraftAngleError,
  extrudeDraftValue,
  extrudeFormValue,
  extrudeIsThroughAll,
  extrudeIsToFace,
  extrudeOffersThroughAll,
  extrudeShownExtent,
  extrudeToFaceProblem,
  extrudeToFaceUnresolved,
  initialExtrudeDraft,
  reversedDistance,
  toFaceReachText,
  type ExtrudeDraft,
  type ExtrudeDraftContext,
  type ExtrudeDraftInitial,
  type ExtrudeFormValue,
  type ExtrudeToFacePicking
} from '../../lib/extrudeDraft';
import { paramValueText, previewExpression } from '../../lib/model';
import { ExprInput } from '../ExprInput';
import { ExtrudeControls } from '../ExtrudeControls';
import ExtrudeExtentControls from './ExtrudeExtentControls';

export {
  reversedDistance,
  type ExtrudeFormValue,
  type ExtrudeToFaceInfo,
  type ExtrudeToFacePicking
} from '../../lib/extrudeDraft';

interface ExtrudeFormProps {
  scope: Record<string, number>;
  units?: UnitSystem;
  sketches: { sketchId: SketchId; name: string }[];
  bodies: { bodyId: BodyId; name: string }[];
  initial: ExtrudeDraftInitial;
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
  const [draft, setDraft] = useState<ExtrudeDraft>(() =>
    initialExtrudeDraft(initial, creating)
  );
  const ctx: ExtrudeDraftContext = {
    scope,
    units,
    initial,
    bodies,
    ...(toFacePicking ? { toFacePicking } : {})
  };
  // Through all needs one explicit cut target, so it is offered once Cut is
  // chosen, never while the operation is still being inferred.
  const offersThroughAll = extrudeOffersThroughAll(draft);
  const throughAll = extrudeIsThroughAll(draft);
  // F01 (v29): to-face replaces the distance with a picked face; any
  // operation may reach one. A host with no face pick never offers it.
  const toFace = extrudeIsToFace(draft, ctx);
  const toFaceInfo =
    toFace && draft.toFace ? toFacePicking!.describe(draft.toFace) : null;
  const toFaceProblem = extrudeToFaceProblem(draft, ctx);
  // A new extrude opens at zero until the user drags or types a distance, so
  // the zero-distance error waits for that edit (or an attempt to submit)
  // rather than greeting the card in red. Create stays disabled either way.
  const [distanceEdited, setDistanceEdited] = useState(false);
  const quantity = { documentUnits: units, dimension: 'length' } as const;
  const angleQuantity = { documentUnits: units, dimension: 'angle' } as const;
  const distance = previewExpression(draft.distance, scope, quantity);
  const back = previewExpression(draft.backDistance, scope, quantity);
  const valid = extrudeDraftValue(draft, ctx) !== null;
  const draftError = extrudeDraftAngleError(draft, ctx);
  const valueFor = (next: ExtrudeDraft) => extrudeDraftValue(next, ctx);
  const formValue = (next: ExtrudeDraft) => extrudeFormValue(next, ctx);

  function change(patch: Partial<ExtrudeDraft>) {
    if (
      toFacePicking?.armed &&
      patch.endCondition !== undefined &&
      patch.endCondition !== 'to-face'
    ) {
      toFacePicking.cancel();
    }
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
  const pendingFace = useRef<ExtrudeToFaceTarget | null>(null);
  const updateFace = useRef((_target: ExtrudeToFaceTarget) => {});
  updateFace.current = (target) => {
    const reach = toFacePicking?.describe(target).distance ?? null;
    pendingFace.current = reach === null ? target : null;
    change({
      toFace: target,
      endCondition: 'to-face',
      // Rounded for the field, but never through zero: a reach shorter than
      // the rounding keeps its exact value, so its sign (which side of the
      // sketch the face is on) still reaches the commit.
      ...(reach !== null ? { distance: toFaceReachText(reach) } : {})
    });
  };
  const faceReach = toFaceInfo?.distance;
  useEffect(() => {
    const target = pendingFace.current;
    if (!target) return;
    if (!toFace || draft.toFace !== target) {
      pendingFace.current = null;
      return;
    }
    // An edit pick can arrive before history-position replay finishes.
    // Publish its preview and dormant distance once that reach is known.
    if (faceReach !== null && faceReach !== undefined) {
      updateFace.current(target);
    }
  }, [toFace, draft.toFace, faceReach]);
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
            endCondition={extrudeShownExtent(draft, ctx)}
            throughAllSide={draft.throughAllSide}
            offersThroughAll={offersThroughAll}
            toFace={{
              label: toFaceInfo?.label ?? null,
              unresolved: extrudeToFaceUnresolved(draft, ctx),
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
