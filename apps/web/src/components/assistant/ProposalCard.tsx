import { useState } from 'react';
import {
  Check,
  ChevronDown,
  ChevronRight,
  Eye,
  Ruler,
  X
} from 'lucide-react';
import type { AssistantProposalEntry } from '../../lib/assistant/conversation';
import {
  describeOperation,
  summarizeOperations
} from '../../lib/assistant/describe';

interface ProposalCardProps {
  entry: AssistantProposalEntry;
  previewing: boolean;
  busy: boolean;
  onPreview(): void;
  onApply(): void;
  onReject(): void;
}

const CONFIDENCE_LABEL = {
  read: 'read',
  inferred: 'inferred',
  unreadable: 'unreadable'
} as const;

export function ProposalCard({
  entry,
  previewing,
  busy,
  onPreview,
  onApply,
  onReject
}: ProposalCardProps) {
  const [showOperations, setShowOperations] = useState(false);
  const [showReadings, setShowReadings] = useState(true);
  const totals = summarizeOperations(entry.proposal.operations);
  const resolved = entry.status !== 'open';

  return (
    <div className={`assistant-card proposal ${entry.status}`}>
      <span className="assistant-card-label">
        {entry.status === 'applied'
          ? 'Applied'
          : entry.status === 'rejected'
            ? 'Rejected'
            : 'Proposed change'}
      </span>
      <p className="assistant-card-copy">{entry.proposal.summary}</p>

      {entry.readings.length > 0 && (
        <div className="assistant-readings">
          <button
            type="button"
            className="assistant-disclosure"
            aria-expanded={showReadings}
            onClick={() => setShowReadings((open) => !open)}
          >
            {showReadings ? (
              <ChevronDown size={12} aria-hidden="true" />
            ) : (
              <ChevronRight size={12} aria-hidden="true" />
            )}
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
                      {reading.value}
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
        {showOperations ? (
          <ChevronDown size={12} aria-hidden="true" />
        ) : (
          <ChevronRight size={12} aria-hidden="true" />
        )}
        {entry.proposal.operations.length} operation
        {entry.proposal.operations.length === 1 ? '' : 's'}
        <span className="assistant-op-totals">
          {totals.parameters > 0 && `${totals.parameters} param`}
          {totals.bodies > 0 && ` · ${totals.bodies} solid`}
          {totals.edits > 0 && ` · ${totals.edits} edit`}
        </span>
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
            className={previewing ? 'active' : ''}
            disabled={busy}
            onClick={onPreview}
          >
            <Eye size={13} aria-hidden="true" />
            {previewing ? 'Hide preview' : 'Preview'}
          </button>
          <button
            type="button"
            className="assistant-primary"
            disabled={busy}
            onClick={onApply}
          >
            <Check size={13} aria-hidden="true" />
            Apply
          </button>
          <button type="button" disabled={busy} onClick={onReject}>
            <X size={13} aria-hidden="true" />
            Reject
          </button>
        </div>
      )}
    </div>
  );
}
