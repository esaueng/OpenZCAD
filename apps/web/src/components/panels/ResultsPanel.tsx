import { Download } from 'lucide-react';
import type { GenerativeRunSummary } from '../../lib/generative';
import { formatKg, formatMm, formatPercent } from '../../lib/format';

interface ResultsPanelProps {
  run: GenerativeRunSummary | null;
  selectedOutcomeId: string | null;
  stale: boolean;
  onSelectOutcome(outcomeId: string): void;
  onExportStl(): void;
}

export function ResultsPanel({
  run,
  selectedOutcomeId,
  stale,
  onSelectOutcome,
  onExportStl
}: ResultsPanelProps) {
  if (!run) {
    return (
      <p className="panel-copy">
        No outcomes yet. Complete the setup steps and run Generate to explore candidates.
      </p>
    );
  }

  const selected =
    run.outcomes.find((outcome) => outcome.id === selectedOutcomeId) ?? run.outcomes[0];

  return (
    <>
      {stale && (
        <p className="panel-warning">
          The model changed after this run — outcomes are out of date. Re-run Generate to
          refresh them.
        </p>
      )}

      <h3>Outcomes · {run.outcomes.length}</h3>
      <div className="body-list" role="list">
        {run.outcomes.map((outcome) => (
          <button
            key={outcome.id}
            type="button"
            role="listitem"
            className={`body-row ${selected?.id === outcome.id ? 'selected' : ''}`}
            onClick={() => onSelectOutcome(outcome.id)}
          >
            <span className="body-name">{outcome.name}</span>
            <span className="mono">{formatPercent(outcome.volumeFraction)}</span>
            <span className="role-badge">score {outcome.score.toFixed(0)}</span>
          </button>
        ))}
      </div>

      {selected && (
        <>
          <h3>{selected.name} · estimates</h3>
          <div className="kv-grid">
            <b>score</b>
            <span>{selected.score.toFixed(1)} / 100</span>
            <b>volume kept</b>
            <span>{formatPercent(selected.volumeFraction)}</span>
            <b>mass (steel)</b>
            <span>{formatKg(selected.massKg)}</span>
            <b>max displ.</b>
            <span>{formatMm(selected.maxDisplacementMm)}</span>
          </div>
          <button type="button" className="secondary wide" onClick={onExportStl}>
            <Download size={14} aria-hidden="true" />
            Export current model as STL
          </button>
        </>
      )}

      <div className="callout">
        The viewport previews the selected outcome by scaling design-space bodies to the kept
        volume fraction; preserved and fixed geometry stays untouched and obstacles are
        hidden. Native B-Rep outcome geometry arrives with the OpenCascade kernel.
      </div>
    </>
  );
}
