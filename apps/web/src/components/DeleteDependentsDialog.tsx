import { useRef } from 'react';
import { Trash2 } from 'lucide-react';
import { useModalFocus } from '../lib/useModalFocus';

export interface DeleteDependentsDialogProps {
  /** The detail the user asked to delete, or "N features" for a batch. */
  name: string;
  /** Later steps built on its geometry that cannot rebuild without it. */
  dependents: readonly string[];
  onCancel(): void;
  /** Delete the detail and every listed step in one undoable step. */
  onDeleteAll(): void;
}

/** How many dependents are named before the rest are counted. */
const NAMED_DEPENDENTS = 6;

/**
 * Answers a refused detail delete as a refused suppression is answered.
 *
 * A fillet rolled along a chamfer's edge, or a blend edit of that fillet,
 * rests on the chamfer's own faces: deleting the chamfer alone leaves them
 * nothing to build on, so the delete is refused. Each is itself a detail or
 * an in-place edit, so it can go with the chamfer without taking anything
 * else along. This names them and offers exactly that.
 */
export function DeleteDependentsDialog({
  name,
  dependents,
  onCancel,
  onDeleteAll
}: DeleteDependentsDialogProps) {
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const confirmRef = useRef<HTMLButtonElement | null>(null);
  useModalFocus(dialogRef, { autoFocus: true, initialFocusRef: confirmRef });

  const named = dependents.slice(0, NAMED_DEPENDENTS);
  const unnamed = dependents.length - named.length;

  return (
    <div className="modal-backdrop">
      <div
        ref={dialogRef}
        className="delete-feature-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="delete-dependents-dialog-title"
        aria-describedby="delete-dependents-dialog-body"
        tabIndex={-1}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.stopPropagation();
            onCancel();
          }
        }}
      >
        <h2 id="delete-dependents-dialog-title">
          <Trash2 size={16} aria-hidden="true" />
          Delete “{name}”?
        </h2>
        <div id="delete-dependents-dialog-body" className="delete-feature-body">
          <p>
            {dependents.length === 1
              ? `1 later feature was built on ${name} and cannot rebuild without it:`
              : `${dependents.length} later features were built on ${name} and cannot rebuild without it:`}
          </p>
          <ul className="delete-feature-dependents">
            {named.map((dependent, index) => (
              <li key={`${index}-${dependent}`}>{dependent}</li>
            ))}
            {unnamed > 0 && <li>and {unnamed} more</li>}
          </ul>
          <p>
            Delete {dependents.length === 1 ? 'it' : 'them'} too, and the rest
            of the part rebuilds without {name}. Undo brings everything back.
          </p>
        </div>
        <div className="delete-feature-actions">
          <button type="button" className="secondary" onClick={onCancel}>
            Cancel
          </button>
          <button
            ref={confirmRef}
            type="button"
            className="delete-feature-confirm"
            onClick={onDeleteAll}
          >
            {dependents.length === 1 ? 'Delete it too' : 'Delete them too'}
          </button>
        </div>
      </div>
    </div>
  );
}
