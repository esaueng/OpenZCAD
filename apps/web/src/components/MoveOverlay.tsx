import { X } from 'lucide-react';
import { CARD_EYEBROWS } from '../lib/cardEyebrows';
import { useEffect, useState, type MutableRefObject } from 'react';

/*
 * The Move panel. Its own module, loaded only once a Move starts, so its
 * fields stay off the entry chunk (App.tsx lazy-loads it); the banner and the
 * closed-profile action stay in DirectModelingOverlays.
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
      value={draft ?? value}
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
  useEffect(() => {
    setLive({ values: committedValues, snap: committedSnap });
  }, [committedValues, committedSnap]);
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
  const dirty =
    MOVE_AXES.some((axis) => values.translation[axis] !== 0) ||
    MOVE_AXES.some((axis) => values.rotationDeg[axis] !== 0);
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
  return (
    <form
      className="extrude-controller move-controller"
      aria-label="Move controls"
      onSubmit={(event) => {
        event.preventDefault();
        if (dirty) {
          onConfirm();
        }
      }}
    >
      <div className="panel-header">
        <div className="panel-title-row">
          <h2>Move / Rotate</h2>
          <span className="panel-eyebrow">{CARD_EYEBROWS.direct}</span>
          <button
            type="button"
            className="icon-button panel-close"
            aria-label="Cancel move"
            onClick={onCancel}
          >
            <X size={14} aria-hidden="true" />
          </button>
        </div>
      </div>
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
      ) : (
        <p>{bodyName}</p>
      )}
      <div className="move-grid" role="group" aria-label="Translation">
        {MOVE_AXES.map((axis) => (
          <label key={`t-${axis}`}>
            <span className={`move-axis move-axis-${axis}`}>
              d{axis.toUpperCase()}
            </span>
            <span className="extrude-distance-input">
              <MoveNumberInput
                step={snap?.move ?? 1}
                value={values.translation[axis]}
                label={`Move ${axis.toUpperCase()} in ${units}`}
                onValue={(next) => setValue('translation', axis, next)}
              />
              <b>{units}</b>
            </span>
          </label>
        ))}
      </div>
      <div
        className="move-grid"
        role="group"
        aria-label="Rotation"
        hidden={hideRotation}
      >
        {MOVE_AXES.map((axis) => (
          <label key={`r-${axis}`}>
            <span className={`move-axis move-axis-${axis}`}>
              r{axis.toUpperCase()}
            </span>
            <span className="extrude-distance-input">
              <MoveNumberInput
                step={snap?.rotate ?? 1}
                value={values.rotationDeg[axis]}
                label={`Rotate ${axis.toUpperCase()} in degrees`}
                onValue={(next) => setValue('rotationDeg', axis, next)}
              />
              <b>°</b>
            </span>
          </label>
        ))}
      </div>
      <div className="form-actions">
        <button type="submit" className="primary" disabled={!dirty}>
          Apply move
        </button>
        <button type="button" className="secondary" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}
