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

/** An exact number too rare for a handle (a primitive's position). */
export interface InPlaceOptionValue {
  id: string;
  label: string;
  /** As shown: the typed expression, or the number with its unit. */
  text: string;
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
  /** Exact numbers behind the same disclosure, each opening the keypad. */
  values?: readonly InPlaceOptionValue[];
  /** A value's button was pressed, at this client point (for the keypad). */
  onValue?(valueId: string, at: { x: number; y: number }): void;
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
  values = [],
  onValue,
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
      {options.length > 0 || values.length > 0 ? (
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
            {values.map((value) => (
              <div key={value.id} className="in-place-option">
                <span
                  className="in-place-option-label"
                  id={`in-place-value-${value.id}`}
                >
                  {value.label}
                </span>
                <button
                  type="button"
                  className="in-place-option-choice in-place-option-value"
                  aria-labelledby={`in-place-value-${value.id}`}
                  onClick={(event) => {
                    const box = event.currentTarget.getBoundingClientRect();
                    onValue?.(value.id, { x: box.left, y: box.bottom });
                  }}
                >
                  {value.text}
                </button>
              </div>
            ))}
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
        <kbd aria-hidden="true">Esc</kbd>
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
        <kbd aria-hidden="true">↵</kbd>
      </button>
    </div>
  );
}
