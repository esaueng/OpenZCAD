import { useEffect, useRef, useState } from 'react';
import {
  Check,
  ChevronRight,
  Eye,
  EyeOff,
  LoaderCircle,
  Ruler,
  X
} from 'lucide-react';
import type { AssistantProposalEntry } from '../../lib/assistant/conversation';
import {
  describeOperation,
  summarizeOperations
} from '../../lib/assistant/describe';
import { RichText } from './RichText';
import { StableLabel } from '../StableLabel';

interface ProposalCardProps {
  entry: AssistantProposalEntry;
  previewing: boolean;
  busy: boolean;
  /** This card's own patch is going through the kernel right now. */
  applying?: boolean;
  /**
   * The prompt line's keys act on this card: Enter applies, `p` previews,
   * Escape rejects. Only the newest open proposal is keyed, and its actions
   * say so.
   */
  keyed?: boolean;
  onPreview(): void;
  onApply(): void;
  onReject(): void;
}

const CONFIDENCE_LABEL = {
  read: 'read',
  inferred: 'inferred',
  unreadable: 'unreadable'
} as const;

function count(value: number, noun: string): string {
  return `${value} ${noun}${value === 1 ? '' : 's'}`;
}

/**
 * A proposal as a block in the stream: its state as a label, the summary,
 * what was read from a drawing, the operations behind a disclosure, and
 * three text actions. The same preview, apply and reject path as before;
 * only the chrome is gone.
 */
export function ProposalCard({
  entry,
  previewing,
  busy,
  applying = false,
  keyed = false,
  onPreview,
  onApply,
  onReject
}: ProposalCardProps) {
  const [showOperations, setShowOperations] = useState(false);
  const [showReadings, setShowReadings] = useState(true);
  const totals = summarizeOperations(entry.proposal.operations);
  const totalParts = [
    totals.parameters > 0 ? count(totals.parameters, 'param') : null,
    totals.bodies > 0 ? count(totals.bodies, 'solid') : null,
    totals.edits > 0 ? count(totals.edits, 'edit') : null
  ].filter((part) => part !== null);
  const resolved = entry.status !== 'open';

  // Apply and Reject leave with the decision they made. Focus stays on the
  // card that now records it instead of falling to the page — unless it has
  // already gone somewhere else, as it has when the prompt's keys decided.
  const cardRef = useRef<HTMLDivElement | null>(null);
  const previousStatus = useRef(entry.status);
  useEffect(() => {
    const was = previousStatus.current;
    previousStatus.current = entry.status;
    const card = cardRef.current;
    if (was !== 'open' || entry.status === 'open' || !card) {
      return;
    }
    const active = card.ownerDocument.activeElement;
    if (
      !active ||
      active === card.ownerDocument.body ||
      card.contains(active)
    ) {
      card.focus({ preventScroll: true });
    }
  }, [entry.status]);

  return (
    <div
      ref={cardRef}
      tabIndex={-1}
      className={`assistant-card proposal ${entry.status}${
        previewing ? ' previewing' : ''
      }`}
    >
      <span className="assistant-card-label">
        {entry.status === 'applied' ? (
          <Check size={12} aria-hidden="true" />
        ) : entry.status === 'rejected' ? (
          <X size={12} aria-hidden="true" />
        ) : null}
        {entry.status === 'applied'
          ? 'Applied'
          : entry.status === 'rejected'
            ? 'Rejected'
            : 'Proposal'}
        {previewing && (
          <span className="assistant-live-pill">
            <Eye size={10} aria-hidden="true" />
            in the viewport
          </span>
        )}
      </span>
      <RichText text={entry.proposal.summary} className="assistant-card-copy" />
      {resolved && (
        // Once a proposal is decided, its detail is reference material rather
        // than a decision to make — the reading table stays reachable, but the
        // card stops competing with the live turn below it.
        <span className="assistant-card-note">
          {entry.status === 'applied'
            ? 'In the document history — undo reverses it.'
            : 'Nothing was changed.'}
        </span>
      )}
      {!resolved && entry.proposal.preserveGeometry && (
        <span className="assistant-card-note">
          Exact preflight must prove the current geometry is unchanged.
        </span>
      )}

      {entry.readings.length > 0 && (
        <div className="assistant-readings">
          <button
            type="button"
            className="assistant-disclosure"
            aria-expanded={showReadings}
            onClick={() => setShowReadings((open) => !open)}
          >
            <ChevronRight
              size={12}
              className="disclosure-chevron"
              aria-hidden="true"
            />
            <Ruler size={12} aria-hidden="true" />
            {entry.readings.length} dimension
            {entry.readings.length === 1 ? '' : 's'} read from the drawing
          </button>
          {/*
            The point of this table is that someone can check a misread decimal
            before the part is cut, so the source view and how sure the model was
            matter as much as the value.
          */}
          {showReadings && (
            <table>
              <thead>
                <tr>
                  <th scope="col">Dimension</th>
                  <th scope="col">Value</th>
                  <th scope="col">From</th>
                </tr>
              </thead>
              <tbody>
                {entry.readings.map((reading, index) => (
                  <tr
                    key={`${reading.label}-${index}`}
                    className={reading.confidence}
                  >
                    <th scope="row">{reading.label}</th>
                    <td>
                      {reading.value}{' '}
                      <span className="assistant-confidence">
                        {CONFIDENCE_LABEL[reading.confidence]}
                      </span>
                    </td>
                    <td>{reading.source}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {entry.proposal.assumptions.length > 0 && (
        <ul className="assistant-assumptions">
          {entry.proposal.assumptions.map((assumption, index) => (
            <li key={`${assumption}-${index}`}>{assumption}</li>
          ))}
        </ul>
      )}

      <button
        type="button"
        className="assistant-disclosure"
        aria-expanded={showOperations}
        onClick={() => setShowOperations((open) => !open)}
      >
        <ChevronRight
          size={12}
          className="disclosure-chevron"
          aria-hidden="true"
        />
        {count(entry.proposal.operations.length, 'operation')}
        {totalParts.length > 0 && (
          // The leading space reads in the accessible name; the flex gap
          // draws the visible one.
          <span className="assistant-op-totals">
            {` · ${totalParts.join(' · ')}`}
          </span>
        )}
      </button>
      {showOperations && (
        <ol className="assistant-operations">
          {entry.proposal.operations.map((operation, index) => (
            <li key={`${operation.kind}-${index}`}>
              {describeOperation(operation)}
            </li>
          ))}
        </ol>
      )}

      {!resolved && (
        <div className="assistant-card-actions">
          <button
            type="button"
            className="assistant-primary"
            disabled={busy}
            onClick={onApply}
          >
            {keyed && <kbd aria-hidden="true">⏎</kbd>}
            {applying ? (
              <LoaderCircle size={13} aria-hidden="true" className="spin" />
            ) : (
              <Check size={13} aria-hidden="true" />
            )}
            <StableLabel reserve={['Applying…', 'Apply']}>
              {applying ? 'Applying…' : 'Apply'}
            </StableLabel>
          </button>
          <button
            type="button"
            className={previewing ? 'active' : ''}
            disabled={busy}
            onClick={onPreview}
          >
            {keyed && <kbd aria-hidden="true">p</kbd>}
            {previewing ? (
              <EyeOff size={13} aria-hidden="true" />
            ) : (
              <Eye size={13} aria-hidden="true" />
            )}
            <StableLabel reserve={['Hide preview', 'Preview']}>
              {previewing ? 'Hide preview' : 'Preview'}
            </StableLabel>
          </button>
          <button type="button" disabled={busy} onClick={onReject}>
            {keyed && <kbd aria-hidden="true">esc</kbd>}
            <X size={13} aria-hidden="true" />
            Reject
          </button>
        </div>
      )}
    </div>
  );
}
