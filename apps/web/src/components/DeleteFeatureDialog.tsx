import { useRef } from 'react';
import { Trash2 } from 'lucide-react';
import { useModalFocus } from '../lib/useModalFocus';

export interface DeleteFeatureDialogProps {
  /** The feature about to be deleted. */
  name: string;
  /** How many features a History batch deletes; one names `name` instead. */
  count?: number;
  /** Names of the later features that build on it, in history order. */
  dependents: readonly string[];
  onCancel(): void;
  onDelete(): void;
}

/** How many dependents are named before the rest are counted. */
const NAMED_DEPENDENTS = 6;

/**
 * Confirms a load-bearing delete, naming what rests on the feature.
 *
 * This used to be a native `confirm()`. Embedded and automated browsers
 * answer that with Cancel without ever showing it, as does a browser where
 * the user once ticked "prevent additional dialogs", so the Del key, the
 * card's menu and the history row's menu all did nothing and said nothing.
 * An in-page dialog is always seen, and it can list the dependents the
 * feature card already counts.
 */
export function DeleteFeatureDialog({
  name,
  count = 1,
  dependents,
  onCancel,
  onDelete
}: DeleteFeatureDialogProps) {
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const deleteRef = useRef<HTMLButtonElement | null>(null);
  useModalFocus(dialogRef, { autoFocus: true, initialFocusRef: deleteRef });

  const source = count > 1 ? 'them' : 'it';
  const named = dependents.slice(0, NAMED_DEPENDENTS);
  const unnamed = dependents.length - named.length;

  return (
    <div className="modal-backdrop">
      <div
        ref={dialogRef}
        className="delete-feature-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="delete-feature-dialog-title"
        aria-describedby="delete-feature-dialog-body"
        tabIndex={-1}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.stopPropagation();
            onCancel();
          }
        }}
      >
        <h2 id="delete-feature-dialog-title">
          <Trash2 size={16} aria-hidden="true" />
          {count > 1 ? `Delete ${count} features?` : `Delete “${name}”?`}
        </h2>
        <div id="delete-feature-dialog-body" className="delete-feature-body">
          <p>
            {`${dependents.length === 1 ? '1 later feature builds' : `${dependents.length} later features build`} on ${source}:`}
          </p>
          <ul className="delete-feature-dependents">
            {named.map((dependent, index) => (
              <li key={`${index}-${dependent}`}>{dependent}</li>
            ))}
            {unnamed > 0 && <li>and {unnamed} more</li>}
          </ul>
          <p>
            {/* What deleting does to them, in Suppress's own terms: they
                stay and rebuild, and one that needed it fails. This said
                they "will rebuild without it" while Suppress, of the same
                features, said they "cannot rebuild without it". */}
            {dependents.length === 1
              ? `It stays in History, and shows an error if it cannot rebuild without ${source}.`
              : `They stay in History, and any that cannot rebuild without ${source} shows an error.`}{' '}
            Undo brings everything back.
          </p>
        </div>
        <div className="delete-feature-actions">
          <button type="button" className="secondary" onClick={onCancel}>
            Cancel
          </button>
          <button
            ref={deleteRef}
            type="button"
            className="delete-feature-confirm"
            onClick={onDelete}
          >
            Delete
          </button>
        </div>
      </div>
    </div>
  );
}
