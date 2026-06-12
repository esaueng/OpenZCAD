import type { GenerativeOutcome, GenerativeRunSummary } from '../lib/generative';
import { formatKg, formatMm, formatPercent } from '../lib/format';

interface OutcomeCardProps {
  outcome: GenerativeOutcome;
  selected: boolean;
  onSelect(outcomeId: string): void;
}

export function OutcomeCard({ outcome, selected, onSelect }: OutcomeCardProps) {
  return (
    <button
      type="button"
      className={`outcome-card ${selected ? 'selected' : ''}`}
      onClick={() => onSelect(outcome.id)}
    >
      <span className="outcome-card-title">
        {outcome.name}
        <span className="outcome-score">score {outcome.score.toFixed(0)}</span>
      </span>
      <span className="kv-grid">
        <b>volume</b>
        <span>{formatPercent(outcome.volumeFraction)}</span>
        <b>mass</b>
        <span>{formatKg(outcome.massKg)}</span>
        <b>max displ.</b>
        <span>{formatMm(outcome.maxDisplacementMm)}</span>
      </span>
    </button>
  );
}

interface OutcomePanelProps {
  run: GenerativeRunSummary;
  selectedOutcomeId: string | null;
  onSelectOutcome(outcomeId: string): void;
}

export function OutcomePanel({ run, selectedOutcomeId, onSelectOutcome }: OutcomePanelProps) {
  return (
    <section className="outcome-panel" aria-label="Generated outcomes">
      <div className="outcome-panel-header">
        outcomes
        <small>
          mock solver · {new Date(run.generatedAt).toLocaleTimeString([], { hour12: false })}
        </small>
      </div>
      <div className="outcome-strip">
        {run.outcomes.map((outcome) => (
          <OutcomeCard
            key={outcome.id}
            outcome={outcome}
            selected={outcome.id === selectedOutcomeId}
            onSelect={onSelectOutcome}
          />
        ))}
      </div>
    </section>
  );
}
