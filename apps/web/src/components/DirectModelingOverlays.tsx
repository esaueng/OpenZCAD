import {
  ArrowUpDown,
  Check,
  Layers3,
  MousePointer2,
  Move3d,
  X
} from 'lucide-react';

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

interface ExtrudeOverlayProps {
  profileName: string;
  profileCount: number;
  availableProfileCount: number;
  distance: number;
  units: string;
  onDistanceChange(value: number): void;
  onClearProfiles(): void;
  onSelectAllProfiles(): void;
  onBackToSketch?: () => void;
  onConfirm(): void;
  onCancel(): void;
}

export function ExtrudeOverlay({
  profileName,
  profileCount,
  availableProfileCount,
  distance,
  units,
  onDistanceChange,
  onClearProfiles,
  onSelectAllProfiles,
  onBackToSketch,
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
        <div className="extrude-profile-field">
          <span>
            <strong>Profiles</strong>
            <small>{profileName}</small>
          </span>
          <b>{profileCount} selected</b>
          <button type="button" onClick={onClearProfiles}>
            Clear
          </button>
          {availableProfileCount > profileCount && (
            <button type="button" onClick={onSelectAllProfiles}>
              Select all valid
            </button>
          )}
        </div>
        <label>
          <span>Operation</span>
          <select aria-label="Extrude operation" value="new-body" disabled>
            <option value="new-body">New Body</option>
          </select>
        </label>
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
          <button
            type="button"
            onClick={() => onDistanceChange(distance === 0 ? -24 : -distance)}
          >
            Flip
          </button>
        </div>
        <div className="extrude-actions">
          {onBackToSketch && (
            <button
              type="button"
              className="secondary"
              onClick={onBackToSketch}
            >
              Back to Sketch
            </button>
          )}
          <button type="button" className="secondary" onClick={onCancel}>
            Cancel Extrude
          </button>
          <button
            type="submit"
            className="primary"
            disabled={!Number.isFinite(distance) || Math.abs(distance) < 0.1}
          >
            <Check size={15} aria-hidden="true" />
            Apply Extrude
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
  /** Sketch moves translate only; the rotation grid and copy are hidden. */
  hideRotation?: boolean;
}

const MOVE_AXES = ['x', 'y', 'z'] as const;

export function MoveOverlay({
  bodyName,
  values,
  units,
  snap,
  onChange,
  onConfirm,
  onCancel,
  hideRotation
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
