import { ArrowUpDown, Check, Layers3, MousePointer2, Move3d, X } from 'lucide-react';

interface ProfileQuickActionProps {
  profileName: string;
  onExtrude(): void;
  onDismiss(): void;
}

export function ProfileQuickAction({
  profileName,
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
        <strong>Closed profile selected</strong>
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

interface ExtrudeOverlayProps {
  profileName: string;
  distance: number;
  units: string;
  onDistanceChange(value: number): void;
  onConfirm(): void;
  onCancel(): void;
}

export function ExtrudeOverlay({
  profileName,
  distance,
  units,
  onDistanceChange,
  onConfirm,
  onCancel
}: ExtrudeOverlayProps) {
  const direction =
    distance > 0
      ? 'Positive side'
      : distance < 0
        ? 'Opposite side'
        : 'Choose either side';
  return (
    <>
      <div className="extrude-instruction" role="status">
        <span className="extrude-instruction-icon">
          <MousePointer2 size={17} aria-hidden="true" />
        </span>
        <span>
          <strong>Drag the arrow through the sketch plane</strong>
          <small>
            Move either direction, then press Enter to create the solid.
          </small>
        </span>
      </div>

      <form
        className="extrude-controller"
        aria-label="Extrude controls"
        onSubmit={(event) => {
          event.preventDefault();
          if (Math.abs(distance) >= 0.1) {
            onConfirm();
          }
        }}
      >
        <div className="extrude-controller-header">
          <span>
            <Layers3 size={16} aria-hidden="true" />
            Extrude
          </span>
          <button type="button" aria-label="Cancel extrude" onClick={onCancel}>
            <X size={15} aria-hidden="true" />
          </button>
        </div>
        <p>{profileName}</p>
        <label>
          <span>Distance</span>
          <span className="extrude-distance-input">
            <input
              type="number"
              step="0.5"
              value={Number.isFinite(distance) ? distance : 0}
              onChange={(event) => onDistanceChange(Number(event.target.value))}
            />
            <b>{units}</b>
          </span>
        </label>
        <div className="extrude-direction">
          <ArrowUpDown size={14} aria-hidden="true" />
          <span>{direction}</span>
        </div>
        <div className="extrude-actions">
          <button type="button" className="secondary" onClick={onCancel}>
            Cancel
          </button>
          <button
            type="submit"
            className="primary"
            disabled={!Number.isFinite(distance) || Math.abs(distance) < 0.1}
          >
            <Check size={15} aria-hidden="true" />
            Create solid
          </button>
        </div>
      </form>
    </>
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
}

const MOVE_AXES = ['x', 'y', 'z'] as const;

export function MoveOverlay({
  bodyName,
  values,
  units,
  snap,
  onChange,
  onConfirm,
  onCancel
}: MoveOverlayProps) {
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
          <strong>Drag an arrow to move, a ring to rotate</strong>
          <small>
            Snaps to {snap ? `${snap.move} ${units} · ${snap.rotate}°` : 'whole steps'} — zoom in
            for finer steps, hold Shift for free movement.
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
        <p>{bodyName}</p>
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
        <div className="move-grid" role="group" aria-label="Rotation">
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
