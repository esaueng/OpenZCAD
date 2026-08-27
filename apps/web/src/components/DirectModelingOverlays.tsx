import {
  Check,
  Layers3,
  MousePointer2,
  Move3d,
  X
} from 'lucide-react';
import { useEffect, useState, type MutableRefObject } from 'react';

interface ProfileQuickActionProps {
  profileName: string;
  profileCount?: number;
  onExtrude(): void;
  onDismiss(): void;
}

export function ProfileQuickAction({
  profileName,
  profileCount = 1,
  onExtrude,
  onDismiss
}: ProfileQuickActionProps) {
  return (
    <div
      className="profile-quick-action"
      role="region"
      aria-label="Selected closed profile"
    >
      <span className="profile-ready-icon">
        <Check size={14} aria-hidden="true" />
      </span>
      <span className="profile-quick-copy">
        <strong>
          {profileCount} closed profile{profileCount === 1 ? '' : 's'} selected
        </strong>
        <small>{profileName}</small>
      </span>
      <button type="button" className="profile-extrude" onClick={onExtrude}>
        <Layers3 size={15} aria-hidden="true" />
        Extrude
        <kbd>E</kbd>
      </button>
      <button
        type="button"
        className="profile-dismiss"
        aria-label="Deselect profile"
        onClick={onDismiss}
      >
        <X size={14} aria-hidden="true" />
      </button>
    </div>
  );
}


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
}

const MOVE_AXES = ['x', 'y', 'z'] as const;

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
  liveValuesRef
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
    };
    return () => {
      liveValuesRef.current = null;
    };
  }, [liveValuesRef]);
  const values = live.values;
  const snap = live.snap;
  const dirty =
    MOVE_AXES.some((axis) => values.translation[axis] !== 0) ||
    MOVE_AXES.some((axis) => values.rotationDeg[axis] !== 0);
  const setValue = (
    group: 'translation' | 'rotationDeg',
    axis: (typeof MOVE_AXES)[number],
    raw: string
  ) => {
    const next = Number(raw);
    if (!Number.isFinite(next)) {
      return;
    }
    onChange({
      ...values,
      [group]: { ...values[group], [axis]: next }
    });
  };
  return (
    <>
      <div className="extrude-instruction" role="status">
        <span className="extrude-instruction-icon">
          <MousePointer2 size={17} aria-hidden="true" />
        </span>
        <span>
          <strong>
            {hideRotation
              ? 'Drag an arrow to move the sketch'
              : 'Drag an arrow to move, a ring to rotate'}
          </strong>
          <small>
            Snaps to{' '}
            {snap ? `${snap.move} ${units} · ${snap.rotate}°` : 'whole steps'} —
            zoom in for finer steps, hold Shift for free movement.
          </small>
        </span>
      </div>

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
        <div className="extrude-controller-header">
          <span>
            <Move3d size={16} aria-hidden="true" />
            Move / Rotate
          </span>
          <button type="button" aria-label="Cancel move" onClick={onCancel}>
            <X size={15} aria-hidden="true" />
          </button>
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
                <input
                  type="number"
                  step={snap?.move ?? 1}
                  value={values.translation[axis]}
                  aria-label={`Move ${axis.toUpperCase()} in ${units}`}
                  onChange={(event) =>
                    setValue('translation', axis, event.target.value)
                  }
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
                <input
                  type="number"
                  step={snap?.rotate ?? 1}
                  value={values.rotationDeg[axis]}
                  aria-label={`Rotate ${axis.toUpperCase()} in degrees`}
                  onChange={(event) =>
                    setValue('rotationDeg', axis, event.target.value)
                  }
                />
                <b>°</b>
              </span>
            </label>
          ))}
        </div>
        <div className="extrude-actions">
          <button type="button" className="secondary" onClick={onCancel}>
            Cancel
          </button>
          <button type="submit" className="primary" disabled={!dirty}>
            <Check size={15} aria-hidden="true" />
            Apply move
          </button>
        </div>
      </form>
    </>
  );
}
