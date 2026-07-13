import { ArrowUpDown, Check, Layers3, MousePointer2, X } from 'lucide-react';

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
