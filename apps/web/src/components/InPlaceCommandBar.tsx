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
export interface InPlaceOption {
  id: string;
  label: string;
  value: string;
  choices: readonly { value: string; label: string; note?: string }[];
}

export interface InPlaceCommandBarProps {
  title: string;
  hint: string;
  /** False until every required slot is filled and the preview is valid. */
  canFinish: boolean;
  /** Shown instead of the hint while a refusal stands, in the warning tone. */
  refusal?: string | null;
  /**
   * Rarely used choices (a hole's style, a draft's pull direction), behind
   * a disclosure: each a short row of mutually exclusive buttons.
   */
  options?: readonly InPlaceOption[];
  onOption?(optionId: string, value: string): void;
  onDone(): void;
  onCancel(): void;
}

export function InPlaceCommandBar({
  title,
  hint,
  canFinish,
  refusal = null,
  options = [],
  onOption,
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
      {options.length > 0 ? (
        <details className="in-place-command-options">
          <summary aria-label={`${title} options`}>
            <MoreHorizontal size={14} aria-hidden="true" />
          </summary>
          <div className="in-place-command-options-panel">
            {options.map((option) => {
              const note = option.choices.find(
                (choice) => choice.value === option.value
              )?.note;
              return (
                <div
                  key={option.id}
                  className="in-place-option"
                  role="radiogroup"
                  aria-label={option.label}
                >
                  <span className="in-place-option-label">{option.label}</span>
                  {option.choices.map((choice) => (
                    <button
                      key={choice.value}
                      type="button"
                      role="radio"
                      aria-checked={choice.value === option.value}
                      className="in-place-option-choice"
                      onClick={() => onOption?.(option.id, choice.value)}
                    >
                      {choice.label}
                    </button>
                  ))}
                  {note ? <p className="in-place-option-note">{note}</p> : null}
                </div>
              );
            })}
          </div>
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
