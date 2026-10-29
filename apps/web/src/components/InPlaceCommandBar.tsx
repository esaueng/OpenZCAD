import { Check, MoreHorizontal, X } from 'lucide-react';
import { useId, useLayoutEffect, useRef, useState } from 'react';
import { ownedTopologyName } from '../lib/topologyLabels';
import { modelingRefusalSummary } from '../lib/modelingRefusal';

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
  /**
   * Nothing but Cancel takes input (a Done being validated): what the bar
   * shows must stay what is being committed.
   */
  locked?: boolean;
  /** Shown instead of the hint while a refusal stands, in the warning tone. */
  refusal?: string | null;
  /**
   * Rarely used choices (a hole's style, a draft's pull direction), behind
   * a disclosure: each a short row of mutually exclusive buttons.
   */
  options?: readonly InPlaceOption[];
  onOption?(optionId: string, value: string): void;
  /** Opens exact numeric entry on the current draft before committing. */
  onPreciseValues?(): void;
  /**
   * One-off actions beside the choices (a fillet's Select all edges, a
   * chamfer's Swap the two faces), under the same disclosure.
   */
  actions?: readonly { id: string; label: string }[];
  onAction?(actionId: string): void;
  /**
   * The picks a command holds, by name, in pick order (a fillet's edges),
   * each with a remove button, as the card's list had them. The list keeps
   * `minimum` picks: their buttons are off.
   */
  picks?: {
    label: string;
    minimum: number;
    items: readonly { id: string; name: string; owner?: string }[];
  } | null;
  onRemovePick?(id: string): void;
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
  locked = false,
  refusal = null,
  options = [],
  onOption,
  onPreciseValues,
  actions = [],
  onAction,
  picks = null,
  onRemovePick,
  values = [],
  onValue,
  onDone,
  onCancel
}: InPlaceCommandBarProps) {
  const refusalSummary = refusal ? modelingRefusalSummary(refusal) : null;
  const shown = refusalSummary ?? refusal;
  const hintRef = useRef<HTMLSpanElement>(null);
  const hintId = useId();
  // A refusal wraps to three lines; one longer than that offers the rest
  // rather than leaving its recovery to a tooltip (F014).
  const [clamped, setClamped] = useState(false);
  const [expanded, setExpanded] = useState(false);
  useLayoutEffect(() => {
    setExpanded(false);
    const element = hintRef.current;
    if (!element || !shown) {
      setClamped(false);
      return;
    }
    const measure = () =>
      setClamped(element.scrollHeight > element.clientHeight + 1);
    measure();
    const observer =
      typeof ResizeObserver === 'undefined'
        ? null
        : new ResizeObserver(measure);
    observer?.observe(element);
    return () => observer?.disconnect();
  }, [shown]);
  return (
    <div
      className={`in-place-command${refusal ? ' refused' : ''}`}
      role="group"
      aria-label={`${title} command`}
    >
      <span className="in-place-command-title">{title}</span>
      <span
        ref={hintRef}
        id={hintId}
        className={`in-place-command-hint${expanded ? ' is-expanded' : ''}`}
        role="status"
        aria-live="polite"
        title={shown ?? undefined}
      >
        {shown ?? hint}
      </span>
      {shown && (clamped || expanded) ? (
        <button
          type="button"
          className="in-place-command-more"
          aria-expanded={expanded}
          aria-controls={hintId}
          onClick={() => setExpanded((open) => !open)}
        >
          {expanded ? 'Less' : 'More'}
        </button>
      ) : null}
      {refusalSummary && (
        <details className="in-place-command-options">
          <summary>Technical details</summary>
          <div className="in-place-command-options-panel">
            <p>{refusalSummary}</p>
            <p>{refusal}</p>
          </div>
        </details>
      )}
      {onPreciseValues && (
        <button
          type="button"
          className="in-place-command-cancel"
          onClick={onPreciseValues}
          disabled={locked}
        >
          Precise values…
        </button>
      )}
      {options.length > 0 ||
      values.length > 0 ||
      actions.length > 0 ||
      picks ? (
        <details className="in-place-command-options">
          <summary aria-label={`${title} options`}>
            <MoreHorizontal size={14} aria-hidden="true" />
          </summary>
          <div className="in-place-command-options-panel">
            {picks && picks.items.length > 0 ? (
              <ol className="edge-pick-list" aria-label={picks.label}>
                {picks.items.map((item, index) => {
                  const fullName = item.owner
                    ? ownedTopologyName(item.owner, item.name)
                    : item.name;
                  return (
                    <li key={item.id} className="edge-pick-row">
                      <span className="pick-order mono">{index + 1}</span>
                      <span className="edge-pick-name" title={fullName}>
                        {item.owner ? (
                          <span className="edge-pick-owner">
                            {ownedTopologyName(item.owner, '')}
                          </span>
                        ) : null}
                        <span className="edge-pick-entity">{item.name}</span>
                      </span>
                      <button
                        type="button"
                        className="edge-pick-remove"
                        aria-label={`Remove ${index + 1} ${fullName}`}
                        title={
                          picks.items.length <= picks.minimum
                            ? `${title} needs at least ${picks.minimum}`
                            : 'Remove'
                        }
                        disabled={locked || picks.items.length <= picks.minimum}
                        onClick={() => onRemovePick?.(item.id)}
                      >
                        <X size={12} aria-hidden="true" />
                      </button>
                    </li>
                  );
                })}
              </ol>
            ) : null}
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
                      disabled={locked}
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
                  disabled={locked}
                  aria-labelledby={`in-place-value-${value.id}`}
                  onClick={(event) => {
                    const box = event.currentTarget.getBoundingClientRect();
                    // Exact entry takes over from Options. Leaving its flyout
                    // open covers the keypad in the command lane's context.
                    event.currentTarget
                      .closest('details')
                      ?.removeAttribute('open');
                    onValue?.(value.id, { x: box.left, y: box.bottom });
                  }}
                >
                  {value.text}
                </button>
              </div>
            ))}
            {actions.length > 0 ? (
              <div className="in-place-option">
                {actions.map((action) => (
                  <button
                    key={action.id}
                    type="button"
                    className="in-place-option-choice"
                    disabled={locked}
                    onClick={() => onAction?.(action.id)}
                  >
                    {action.label}
                  </button>
                ))}
              </div>
            ) : null}
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
        disabled={locked || !canFinish}
        aria-keyshortcuts="Enter"
      >
        <Check size={14} aria-hidden="true" />
        Done
        <kbd aria-hidden="true">Enter</kbd>
      </button>
    </div>
  );
}
