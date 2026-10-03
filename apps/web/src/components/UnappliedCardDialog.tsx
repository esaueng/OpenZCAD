import { useRef } from 'react';
import { CircleAlert } from 'lucide-react';
import { useModalFocus } from '../lib/useModalFocus';

export interface UnappliedCardDialogProps {
  /** The open command card holding the unapplied change, e.g. "Move". */
  card: string;
  /** The tool the user asked for, e.g. "Union". */
  next: string;
  onApply(): void;
  onDiscard(): void;
  onCancel(): void;
}

/**
 * Asked once when a tool is opened over a command card that still holds a
 * change nobody applied. Opening Union over a Move with dX 60 used to leave
 * both cards open and the move uncommitted; one card owns the lane, so the
 * pending one is applied or discarded first, or the switch is called off.
 *
 * In-page, never `window.confirm()`: embedded and automated browsers answer
 * that with Cancel without showing it.
 */
export function UnappliedCardDialog({
  card,
  next,
  onApply,
  onDiscard,
  onCancel
}: UnappliedCardDialogProps) {
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const applyRef = useRef<HTMLButtonElement | null>(null);
  useModalFocus(dialogRef, { autoFocus: true, initialFocusRef: applyRef });

  return (
    <div className="modal-backdrop">
      <div
        ref={dialogRef}
        className="unapplied-card-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="unapplied-card-dialog-title"
        aria-describedby="unapplied-card-dialog-body"
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.stopPropagation();
            onCancel();
          }
        }}
      >
        <h2 id="unapplied-card-dialog-title">
          <CircleAlert size={16} aria-hidden="true" />
          Apply the {card} first?
        </h2>
        <p id="unapplied-card-dialog-body">
          The {card} card has changes that are not applied yet. Apply them or
          discard them before {next} opens.
        </p>
        <div className="unapplied-card-actions">
          <button type="button" onClick={onCancel}>
            Cancel
          </button>
          <button type="button" onClick={onDiscard}>
            Discard
          </button>
          <button
            ref={applyRef}
            type="button"
            className="primary"
            onClick={onApply}
          >
            Apply
          </button>
        </div>
      </div>
    </div>
  );
}
