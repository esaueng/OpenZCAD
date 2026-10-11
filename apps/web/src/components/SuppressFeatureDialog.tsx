import { useRef } from 'react';
import { CirclePause } from 'lucide-react';
import { useModalFocus } from '../lib/useModalFocus';

export interface SuppressFeatureDialogProps {
  /** The feature the user asked to suppress. */
  name: string;
  /** Names of the later features that cannot rebuild without it. */
  dependents: readonly string[];
  onCancel(): void;
  /** Suppress the feature and every listed dependent in one undoable step. */
  onSuppressAll(): void;
}

/** How many dependents are named before the rest are counted. */
const NAMED_DEPENDENTS = 6;

/**
 * Answers a refused suppression the way a load-bearing delete is answered:
 * name what rests on the feature and offer to pause the whole branch.
 *
 * The refusal used to be one long lane sentence carrying every dependent's
 * kernel reason, internal body ids included, cut off after a few words and
 * gone in five seconds. The choice it implied — suppress the dependents too —
 * had to be made by hand, one row at a time.
 */
export function SuppressFeatureDialog({
  name,
  dependents,
  onCancel,
  onSuppressAll
}: SuppressFeatureDialogProps) {
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
        aria-labelledby="suppress-feature-dialog-title"
        aria-describedby="suppress-feature-dialog-body"
        tabIndex={-1}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.stopPropagation();
            onCancel();
          }
        }}
      >
        <h2 id="suppress-feature-dialog-title">
          <CirclePause size={16} aria-hidden="true" />
          Suppress “{name}”?
        </h2>
        <div id="suppress-feature-dialog-body" className="delete-feature-body">
          <p>
            {name} is used by{' '}
            {dependents.length === 1
              ? '1 later feature that cannot rebuild without it:'
              : `${dependents.length} later features that cannot rebuild without it:`}
          </p>
          <ul className="delete-feature-dependents">
            {named.map((dependent, index) => (
              <li key={`${index}-${dependent}`}>{dependent}</li>
            ))}
            {unnamed > 0 && <li>and {unnamed} more</li>}
          </ul>
          <p>
            Suppress {dependents.length === 1 ? 'it' : 'them'} too to pause the
            whole branch. Undo brings everything back.
          </p>
        </div>
        <div className="delete-feature-actions">
          <button type="button" className="secondary" onClick={onCancel}>
            Cancel
          </button>
          <button
            ref={confirmRef}
            type="button"
            className="primary"
            onClick={onSuppressAll}
          >
            {dependents.length === 1 ? 'Suppress it too' : 'Suppress them too'}
          </button>
        </div>
      </div>
    </div>
  );
}
