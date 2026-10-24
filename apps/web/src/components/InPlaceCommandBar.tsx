import type { ReactNode } from 'react';
import { Check, MoreHorizontal, X } from 'lucide-react';

/**
 * The only chrome an in-place command has: its name, the one-line step it
 * is waiting on, and Cancel / Done. It takes the guidance row above the
 * command bar, so the next step is read in the same place every hint is.
 *
 * There is no field here on purpose. Inputs are picked in the model and
 * numbers live on handle chips; anything rare enough to need a control of
 * its own goes behind `options`.
 */
export interface InPlaceCommandBarProps {
  title: string;
  hint: string;
  /** False until every required slot is filled and the preview is valid. */
  canFinish: boolean;
  /** Shown instead of the hint while a refusal stands, in the warning tone. */
  refusal?: string | null;
  /** Rarely used options, behind a disclosure. */
  options?: ReactNode;
  onDone(): void;
  onCancel(): void;
}

export function InPlaceCommandBar({
  title,
  hint,
  canFinish,
  refusal = null,
  options,
  onDone,
  onCancel
}: InPlaceCommandBarProps) {
  return (
    <div
      className={`in-place-command${refusal ? ' refused' : ''}`}
      role="group"
      aria-label={`${title} command`}
    >
      <span className="in-place-command-title">{title}</span>
      <span className="in-place-command-hint" role="status" aria-live="polite">
        {refusal ?? hint}
      </span>
      {options ? (
        <details className="in-place-command-options">
          <summary aria-label={`${title} options`}>
            <MoreHorizontal size={14} aria-hidden="true" />
          </summary>
          <div className="in-place-command-options-panel">{options}</div>
        </details>
      ) : null}
      <button
        type="button"
        className="in-place-command-cancel"
        onClick={onCancel}
        aria-keyshortcuts="Escape"
      >
        <X size={14} aria-hidden="true" />
        Cancel
        <kbd>Esc</kbd>
      </button>
      <button
        type="button"
        className="in-place-command-done"
        onClick={onDone}
        disabled={!canFinish}
        aria-keyshortcuts="Enter"
      >
        <Check size={14} aria-hidden="true" />
        Done
        <kbd>↵</kbd>
      </button>
    </div>
  );
}
