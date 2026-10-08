import { Check, Layers3, MousePointer2, X } from 'lucide-react';
import { displayLengthName, type UnitSystem } from '@openzcad/shared';
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

interface MoveInstructionProps {
  units: string;
  /** Current gizmo snap increments; null until the first drag. */
  snap: { move: number; rotate: number } | null;
  /** Sketch moves translate only, so the copy names arrows alone. */
  hideRotation?: boolean;
  /** Filled by the banner; the Move panel forwards live drag snaps into it. */
  liveSnapRef?: MutableRefObject<
    ((snap: { move: number; rotate: number }) => void) | null
  >;
}

/**
 * The Move instruction banner. It rides the viewport, over the model it
 * describes, while the Move panel itself (`MoveOverlay`) anchors in the right
 * lane with every other command card.
 */
export function MoveInstruction({
  units,
  snap: committedSnap,
  hideRotation,
  liveSnapRef
}: MoveInstructionProps) {
  const unitText = displayLengthName(units as UnitSystem);
  const [snap, setSnap] = useState(committedSnap);
  useEffect(() => {
    setSnap(committedSnap);
  }, [committedSnap]);
  useEffect(() => {
    if (!liveSnapRef) {
      return;
    }
    liveSnapRef.current = setSnap;
    return () => {
      liveSnapRef.current = null;
    };
  }, [liveSnapRef]);
  return (
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
          {snap
            ? hideRotation
              ? `${snap.move} ${unitText}`
              : `${snap.move} ${unitText} · ${snap.rotate}°`
            : 'whole steps'}{' '}
          — zoom in for finer steps, hold Shift for free movement.
        </small>
      </span>
    </div>
  );
}
