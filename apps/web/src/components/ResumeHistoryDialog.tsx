import { useRef } from 'react';
import { CirclePlay } from 'lucide-react';
import { useModalFocus } from '../lib/useModalFocus';
import { plainRefusal } from '../lib/refusalLanguage';

export interface ResumeHistoryDialogProps {
  /** The marker move asked for: "Resume full history", "Roll back after …". */
  action: string;
  /** The resumed features that would not rebuild, each with its reason. */
  failures: readonly { name: string; reason: string }[];
  /** Keep the rollback where it is. Nothing changes. */
  onKeep(): void;
  /** Commit the move as one undoable step, failures and all. */
  onResume(): void;
}

/** How many failures are named before the rest are counted. */
const NAMED_FAILURES = 6;

/**
 * Asks before a resume that the exact rebuild says would break later
 * features. An edit made while rolled back is checked only against the
 * features that were building; resuming used to bring the paused ones back
 * with no check at all, so twenty of them could turn red at once.
 *
 * Unlike a refused suppression this offers to go ahead: resuming is how the
 * full model comes back, and repairing the failures in place may be exactly
 * what the user means to do next.
 */
export function ResumeHistoryDialog({
  action,
  failures,
  onKeep,
  onResume
}: ResumeHistoryDialogProps) {
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const confirmRef = useRef<HTMLButtonElement | null>(null);
  useModalFocus(dialogRef, { autoFocus: true, initialFocusRef: confirmRef });

  const named = failures.slice(0, NAMED_FAILURES);
  const unnamed = failures.length - named.length;

  return (
    <div className="modal-backdrop">
      <div
        ref={dialogRef}
        className="delete-feature-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="resume-history-dialog-title"
        aria-describedby="resume-history-dialog-body"
        tabIndex={-1}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.stopPropagation();
            onKeep();
          }
        }}
      >
        <h2 id="resume-history-dialog-title">
          <CirclePlay size={16} aria-hidden="true" />
          {action}?
        </h2>
        <div id="resume-history-dialog-body" className="delete-feature-body">
          <p>
            {failures.length === 1
              ? '1 paused feature would not rebuild:'
              : `${failures.length} paused features would not rebuild:`}
          </p>
          <ul className="delete-feature-dependents">
            {named.map((failure, index) => (
              <li key={`${index}-${failure.name}`}>
                <strong>{failure.name}</strong>:{' '}
                {plainRefusal(failure.reason).message}
              </li>
            ))}
            {unnamed > 0 && <li>and {unnamed} more</li>}
          </ul>
          <p>
            Keep rolled back to change the edit first, or resume anyway and
            repair {failures.length === 1 ? 'it' : 'them'} in place. Undo brings
            the rollback back.
          </p>
        </div>
        <div className="delete-feature-actions">
          <button type="button" className="secondary" onClick={onKeep}>
            Keep rolled back
          </button>
          <button
            ref={confirmRef}
            type="button"
            className="primary"
            onClick={onResume}
          >
            Resume anyway
          </button>
        </div>
      </div>
    </div>
  );
}
