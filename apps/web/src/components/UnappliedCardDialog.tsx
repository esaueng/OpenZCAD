import { useRef } from 'react';
import { CircleAlert } from 'lucide-react';
import { useModalFocus } from '../lib/useModalFocus';

export interface UnappliedCardDialogProps {
  /** The open command card holding the unapplied change, e.g. "Move". */
  card: string;
  /** What happens once it is settled, e.g. "Union opens". */
  outcome: string;
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
  outcome,
  onApply,
  onDiscard,
  onCancel
}: UnappliedCardDialogProps) {
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const applyRef = useRef<HTMLButtonElement | null>(null);
  useModalFocus(dialogRef, {
    autoFocus: true,
    initialFocusRef: applyRef,
    onEscape: onCancel
  });

  return (
    <div className="modal-backdrop">
      <div
        ref={dialogRef}
        className="unapplied-card-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="unapplied-card-dialog-title"
        aria-describedby="unapplied-card-dialog-body"
        tabIndex={-1}
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
          discard them before {outcome}.
        </p>
        <div className="unapplied-card-actions">
          <button type="button" className="secondary" onClick={onCancel}>
            Cancel
          </button>
          <button type="button" className="secondary" onClick={onDiscard}>
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
