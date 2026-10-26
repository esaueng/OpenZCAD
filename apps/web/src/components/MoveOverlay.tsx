import { Check, MoreHorizontal, X } from 'lucide-react';
import { displayLengthName, type UnitSystem } from '@openzcad/shared';
import { moveHasFiniteValues } from '../lib/moveCard';
import { useEffect, useRef, useState, type MutableRefObject } from 'react';

/*
 * The Move bar (U09): the gizmo is the command, so this is the in-place
 * Cancel / Done pill every command finishes on, with the exact numbers, the
 * name, the body and Copy behind its Options. Its own module, loaded only
 * once a Move starts, so its fields stay off the entry chunk (App.tsx
 * lazy-loads it); the banner and the closed-profile action stay in
 * DirectModelingOverlays.
 */

export interface MoveOverlayValues {
  translation: { x: number; y: number; z: number };
  rotationDeg: { x: number; y: number; z: number };
}

interface MoveOverlayProps {
  bodyName: string;
  values: MoveOverlayValues;
  units: string;
  /** Current gizmo snap increments; null until the first drag. */
  snap: { move: number; rotate: number } | null;
  onChange(values: MoveOverlayValues): void;
  onConfirm(): void;
  onCancel(): void;
  /** Sketch moves translate only; the rotation grid and copy are hidden. */
  hideRotation?: boolean;
  /**
   * The Move feature's name. Omitted for a sketch move, which commits as a
   * sketch translation rather than a named feature, so there is nothing to
   * call. Present for a body move: this overlay is now the only way to make
   * one, so naming at creation has to live here (WF-07).
   */
  name?: string;
  onName?(value: string): void;
  /**
   * Every body the move could target, so choosing one no longer means backing
   * out to a second UI. Omitted when there is nothing to choose between.
   */
  targets?: readonly { bodyId: string; name: string }[];
  targetBodyId?: string;
  onTargetBody?(bodyId: string): void;
  /**
   * M10: add the moved body as a copy and leave the source in place.
   * Omitted for a sketch move, which has no body to copy.
   */
  copy?: boolean;
  onCopy?(value: boolean): void;
  /**
   * Where this panel publishes a sink for live drag values. The viewport
   * writes the numbers a gesture is producing straight into it, so dragging
   * the gizmo updates these fields without a workspace render. `values` stays
   * authoritative for everything else — typing, switching body, committing.
   */
  liveValuesRef?: MutableRefObject<
    | ((
        translation: MoveOverlayValues['translation'],
        rotationDeg: MoveOverlayValues['rotationDeg'],
        snap: { move: number; rotate: number }
      ) => void)
    | null
  >;
  /**
   * Where the viewport's instruction banner (`MoveInstruction`) listens for
   * the snap a live drag is using. The panel owns the one drag sink above and
   * forwards the snap, so the banner and the panel never disagree mid-drag.
   */
  liveSnapRef?: MutableRefObject<
    ((snap: { move: number; rotate: number }) => void) | null
  >;
}

const MOVE_AXES = ['x', 'y', 'z'] as const;

function sameMoveValues(left: MoveOverlayValues, right: MoveOverlayValues) {
  return MOVE_AXES.every(
    (axis) =>
      Object.is(left.translation[axis], right.translation[axis]) &&
      Object.is(left.rotationDeg[axis], right.rotationDeg[axis])
  );
}

/**
 * A number as a field shows it. A geometry snap lands on `point - pivot`, and
 * that subtraction leaves binary noise (0.19999999999999998) the gizmo's own
 * grid snap no longer does; nine places is far below any modelling tolerance.
 * Negative zero folds to 0, but — as in the gizmo's `snapTo` — an invalid
 * coordinate stays invalid instead of reading as a plausible 0.
 */
function fieldValue(value: number): number {
  const cleaned = Number(value.toFixed(9));
  return cleaned === 0 ? 0 : cleaned;
}

/**
 * A Move/Rotate field that holds what is being typed until it is a number.
 * Bound straight to the value, a lone "-" (an empty number input) read as
 * Number("") === 0 and rewrote the field to 0, so typing -5 produced 05: a
 * move of +5 where the user asked for -5.
 */
function MoveNumberInput({
  value,
  step,
  label,
  onValue
}: {
  value: number;
  step: number;
  label: string;
  onValue(next: number): void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <input
      type="number"
      step={step}
      // A number input cannot hold NaN or Infinity (React warns on NaN; the
      // browser blanks both), so a non-finite value shows as an empty field.
      value={draft ?? (Number.isFinite(value) ? value : '')}
      aria-label={label}
      onChange={(event) => {
        const raw = event.target.value;
        setDraft(raw);
        const next = Number(raw);
        if (raw.trim() !== '' && Number.isFinite(next)) {
          onValue(next);
        }
      }}
      onKeyDown={(event) => {
        // An emptied or half-typed field holds no value of its own; Enter
        // would apply the previous one, which the field no longer shows.
        if (
          event.key === 'Enter' &&
          draft !== null &&
          (draft.trim() === '' || !Number.isFinite(Number(draft)))
        ) {
          event.preventDefault();
        }
      }}
      onBlur={() => setDraft(null)}
    />
  );
}

export function MoveOverlay({
  bodyName,
  values: committedValues,
  units,
  snap: committedSnap,
  onChange,
  onConfirm,
  onCancel,
  hideRotation,
  name,
  onName,
  targets,
  targetBodyId,
  onTargetBody,
  copy,
  onCopy,
  liveValuesRef,
  liveSnapRef
}: MoveOverlayProps) {
  // Mirrors `values` except while a drag is streaming, when it runs ahead of
  // workspace state. Keyed off the props so a typed value, a body switch, or a
  // settled drag all re-seed it.
  const [live, setLive] = useState<{
    values: MoveOverlayValues;
    snap: { move: number; rotate: number } | null;
  }>({ values: committedValues, snap: committedSnap });
  const target = targetBodyId ?? bodyName;
  const translationOnly = hideRotation === true;
  const committed = useRef({
    values: committedValues,
    snap: committedSnap,
    target,
    units,
    translationOnly
  });
  useEffect(() => {
    const previous = committed.current;
    // App recreates the values wrapper on unrelated renders (a resize or a
    // save finishing). Only a changed transform, snap or target reseeds the
    // panel; otherwise it would erase the gesture's newer live values.
    if (
      sameMoveValues(previous.values, committedValues) &&
      Object.is(previous.snap?.move, committedSnap?.move) &&
      Object.is(previous.snap?.rotate, committedSnap?.rotate) &&
      previous.target === target &&
      previous.units === units &&
      previous.translationOnly === translationOnly
    )
      return;
    committed.current = {
      values: committedValues,
      snap: committedSnap,
      target,
      units,
      translationOnly
    };
    setLive({ values: committedValues, snap: committedSnap });
  }, [committedValues, committedSnap, target, units, translationOnly]);
  useEffect(() => {
    if (!liveValuesRef) {
      return;
    }
    liveValuesRef.current = (translation, rotationDeg, nextSnap) => {
      setLive({ values: { translation, rotationDeg }, snap: nextSnap });
      liveSnapRef?.current?.(nextSnap);
    };
    return () => {
      liveValuesRef.current = null;
    };
  }, [liveValuesRef, liveSnapRef]);
  const values = live.values;
  const snap = live.snap;
  const unitText = displayLengthName(units as UnitSystem);
  const dirty =
    MOVE_AXES.some((axis) => values.translation[axis] !== 0) ||
    MOVE_AXES.some((axis) => values.rotationDeg[axis] !== 0);
  // Match the shared confirmation guard, including translation-only sketches.
  // A copy in place is a real result (a coincident duplicate to move later),
  // so a copy applies at zero where a plain Move has nothing to do.
  const canApply =
    (dirty || copy === true) &&
    moveHasFiniteValues({
      ...values,
      ...(hideRotation ? { target: 'sketch' as const } : {})
    });
  const setValue = (
    group: 'translation' | 'rotationDeg',
    axis: (typeof MOVE_AXES)[number],
    next: number
  ) => {
    onChange({
      ...values,
      [group]: { ...values[group], [axis]: next }
    });
  };
  const title = hideRotation ? 'Move' : 'Move / Rotate';
  return (
    <form
      className="in-place-command move-command"
      aria-label="Move controls"
      onSubmit={(event) => {
        event.preventDefault();
        if (canApply) {
          onConfirm();
        }
      }}
    >
      <span className="in-place-command-title">{title}</span>
      <span className="in-place-command-hint" title={bodyName}>
        {copy ? 'A copy of ' : ''}
        <span className="move-target-name">{bodyName}</span> · drag the gizmo,
        or type exact values under Options
      </span>
      {/* The gizmo is the Move: its exact numbers, name, body and copy are
          rare enough to sit behind Options, as every in-place command's. */}
      <details className="in-place-command-options">
        <summary aria-label={`${title} options`}>
          <MoreHorizontal size={14} aria-hidden="true" />
        </summary>
        <div className="in-place-command-options-panel move-options">
          {name !== undefined && onName ? (
            <label className="field move-name">
              <span>Name</span>
              <input
                value={name}
                onChange={(event) => onName(event.target.value)}
              />
            </label>
          ) : null}
          {targets && targets.length > 1 && onTargetBody ? (
            <label className="field move-target">
              <span>Body</span>
              <select
                value={targetBodyId ?? ''}
                onChange={(event) => onTargetBody(event.target.value)}
              >
                {targets.map((target) => (
                  <option key={target.bodyId} value={target.bodyId}>
                    {target.name}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          <div className="move-grid" role="group" aria-label="Translation">
            {MOVE_AXES.map((axis) => (
              <label key={`t-${axis}`}>
                <span className={`move-axis move-axis-${axis}`}>
                  d{axis.toUpperCase()}
                </span>
                <span className="extrude-distance-input">
                  <MoveNumberInput
                    step={snap?.move ?? 1}
                    value={fieldValue(values.translation[axis])}
                    label={`Move ${axis.toUpperCase()} in ${units}`}
                    onValue={(next) => setValue('translation', axis, next)}
                  />
                  <b>{unitText}</b>
                </span>
              </label>
            ))}
          </div>
          {/* Not rendered rather than `hidden`: `.move-grid { display: grid }`
          beat the attribute, so a sketch move showed rotation fields whose
          values its commit silently dropped. */}
          {hideRotation ? null : (
            <div className="move-grid" role="group" aria-label="Rotation">
              {MOVE_AXES.map((axis) => (
                <label key={`r-${axis}`}>
                  <span className={`move-axis move-axis-${axis}`}>
                    r{axis.toUpperCase()}
                  </span>
                  <span className="extrude-distance-input">
                    <MoveNumberInput
                      step={snap?.rotate ?? 1}
                      value={fieldValue(values.rotationDeg[axis])}
                      label={`Rotate ${axis.toUpperCase()} in degrees`}
                      onValue={(next) => setValue('rotationDeg', axis, next)}
                    />
                    <b>°</b>
                  </span>
                </label>
              ))}
            </div>
          )}
          {copy !== undefined && onCopy ? (
            <label className="field transform-copy">
              <input
                type="checkbox"
                checked={copy}
                onChange={(event) => onCopy(event.target.checked)}
              />
              <span>Copy (keep the original)</span>
            </label>
          ) : null}
        </div>
      </details>
      <button
        type="button"
        className="in-place-command-cancel"
        onClick={onCancel}
        aria-keyshortcuts="Escape"
      >
        <X size={14} aria-hidden="true" />
        Cancel
        <kbd aria-hidden="true">Esc</kbd>
      </button>
      <button
        type="submit"
        className="in-place-command-done"
        disabled={!canApply}
        aria-keyshortcuts="Enter"
      >
        <Check size={14} aria-hidden="true" />
        Done
        <kbd aria-hidden="true">↵</kbd>
      </button>
    </form>
  );
}
