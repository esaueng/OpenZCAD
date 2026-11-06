import { useEffect, useId, useRef, useState } from 'react';
import { AlertTriangle, X } from 'lucide-react';
import type { SelectionCalloutOperation } from '../lib/selectionCallout';
import { formatNumber } from '../lib/model';
import { REFUSAL_STATUS_LABELS, refusalSummary } from '../lib/refusalSummary';
import {
  SAVE_REPRODUCTION_HINT,
  SAVE_REPRODUCTION_LABEL
} from '../lib/selectionCalloutView';

export interface EditRefusalProps {
  /** The refused operation: its error, title and ways out. */
  operation: SelectionCalloutOperation;
  /**
   * `control`: one line under the value being edited, at the pick. `bar`:
   * the compact "Not built · Why?" in the guidance row, for when no control
   * is open to carry it (a refused drag); its explanation opens upward.
   */
  variant: 'control' | 'bar';
  /** The unit a "Try …" size is read in ("mm"). */
  unitLabel: string;
  /** Puts a size the adapter proved buildable into the value. */
  onTrySize?(size: number): void;
  /** Leaves this pick so another edge or face can be chosen. */
  onPickAnother?(): void;
  /** "Pick another edge": names what is picked again. */
  pickAnotherLabel?: string;
  /** Id for the short line, so the value field can be described by it. */
  lineId?: string;
  /** Whether the explanation is open: the key hints say what Esc does. */
  onOpenChange?(open: boolean): void;
}

/**
 * A refused edit, on the control that made it.
 *
 * One line says what happened (the status in words, a short headline, and
 * that the solid is unchanged) with the remedies that are proved: a size the
 * adapter built, the last value that built. "Why?" opens the cause in place
 * with the rest of the ways out. Only the line is a live region, so opening
 * and closing the explanation announces nothing but itself.
 *
 * Escape closes an open explanation before anything else hears it, which is
 * the first rung of the edit's Escape ladder: explanation, then the edit,
 * then the selection.
 */
export function EditRefusal({
  operation,
  variant,
  unitLabel,
  onTrySize,
  onPickAnother,
  pickAnotherLabel = 'Pick another',
  lineId,
  onOpenChange
}: EditRefusalProps) {
  const error = operation.error;
  const ownLineId = useId();
  const cardId = useId();
  const headingId = useId();
  const whyRef = useRef<HTMLButtonElement | null>(null);
  // One refusal is one operation's one sentence: any change opens closed.
  const identity = `${operation.title}\u0000${error?.message ?? ''}`;
  const [why, setWhy] = useState({ identity, open: false });
  if (why.identity !== identity && why.open) setWhy({ identity, open: false });
  const open = why.identity === identity && why.open;
  const setOpen = (next: boolean) => setWhy({ identity, open: next });

  const onOpenChangeRef = useRef(onOpenChange);
  onOpenChangeRef.current = onOpenChange;
  useEffect(() => {
    onOpenChangeRef.current?.(open);
  }, [open]);
  useEffect(() => () => onOpenChangeRef.current?.(false), []);

  useEffect(() => {
    if (!open) return;
    // Capture, so the explanation closes before the editor (which would
    // cancel the value) or the workspace (which would clear the pick) acts.
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopImmediatePropagation();
      setWhy((current) => ({ ...current, open: false }));
      // Focus inside the card would be left on a removed node.
      const active = document.activeElement;
      if (active instanceof HTMLElement && active.closest('.edit-refusal-card'))
        whyRef.current?.focus();
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [open]);

  if (!error) return null;
  const summary = refusalSummary(error, operation.title);
  const culprit = error.culprit;
  const id = lineId ?? ownLineId;
  const compact = variant === 'bar';
  const trySize =
    summary.trySize !== undefined && onTrySize ? summary.trySize : undefined;
  return (
    <div
      className={`edit-refusal is-${variant}${open ? ' is-open' : ''}`}
      data-status={summary.status}
      // The viewport must never read a press here as a pick or an orbit.
      onPointerDown={(event) => event.stopPropagation()}
    >
      <div className="edit-refusal-row">
        {/* The live region holds the words only; the buttons beside it are
            outside, so pressing one announces nothing but itself. */}
        <span id={id} className="edit-refusal-line" role="alert">
          <AlertTriangle size={13} aria-hidden="true" />
          <strong>{REFUSAL_STATUS_LABELS[summary.status]}</strong>
          <span
            className={compact ? 'visually-hidden' : 'edit-refusal-headline'}
          >
            {summary.headline}
          </span>
          {!compact && (
            <span className="edit-refusal-unchanged">Solid unchanged</span>
          )}
        </span>
        {!compact && trySize !== undefined && (
          <button
            type="button"
            className="edit-refusal-action is-primary"
            onClick={() => onTrySize!(trySize)}
          >
            {`Try ${formatNumber(trySize)} ${unitLabel}`.trim()}
          </button>
        )}
        {operation.keepLastValidLabel && (
          <button
            type="button"
            className="edit-refusal-action"
            onClick={operation.onKeepLastValid}
          >
            {operation.keepLastValidLabel}
          </button>
        )}
        <button
          ref={whyRef}
          type="button"
          className="edit-refusal-why"
          aria-expanded={open}
          aria-controls={cardId}
          onClick={() => setOpen(!open)}
        >
          Why?
        </button>
      </div>
      {open && (
        <div
          id={cardId}
          className="edit-refusal-card"
          role="group"
          aria-labelledby={headingId}
        >
          <div className="edit-refusal-card-head">
            <strong id={headingId}>{summary.headline}</strong>
            <button
              type="button"
              className="edit-refusal-close"
              aria-label="Close explanation"
              onClick={() => {
                setOpen(false);
                whyRef.current?.focus();
              }}
            >
              <X size={13} aria-hidden="true" />
            </button>
          </div>
          <p>{summary.cause}</p>
          <p className="edit-refusal-unchanged">The solid is unchanged.</p>
          <div className="edit-refusal-card-actions">
            {compact && trySize !== undefined && (
              <button
                type="button"
                className="edit-refusal-action is-primary"
                onClick={() => onTrySize!(trySize)}
              >
                {`Try ${formatNumber(trySize)} ${unitLabel}`.trim()}
              </button>
            )}
            {culprit && (
              <button
                type="button"
                className="edit-refusal-action is-primary"
                onClick={() => operation.onEditCulprit(culprit.featureId)}
              >
                {`Edit “${culprit.featureName}”`}
              </button>
            )}

            {onPickAnother && summary.pickAnother && (
              <button
                type="button"
                className="edit-refusal-action"
                onClick={onPickAnother}
              >
                {pickAnotherLabel}
              </button>
            )}
            {error.detail && (
              <button
                type="button"
                className="edit-refusal-action is-quiet"
                onClick={operation.onViewDetails}
              >
                Technical details
              </button>
            )}
            {error.detail && operation.onSaveReproduction && (
              <button
                type="button"
                className="edit-refusal-action is-quiet"
                title={SAVE_REPRODUCTION_HINT}
                onClick={operation.onSaveReproduction}
              >
                {SAVE_REPRODUCTION_LABEL}
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
