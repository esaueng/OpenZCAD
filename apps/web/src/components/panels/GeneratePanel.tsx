import { Sparkles } from 'lucide-react';
import type { GenerativeRunSummary } from '../../lib/generative';
import type { ReadinessItem } from '../../lib/workflow';
import { formatN, formatPercent } from '../../lib/format';
import { ValidationChecklist } from '../ValidationChecklist';

export interface GenerateProgress {
  running: boolean;
  phase: string;
  percent: number;
}

interface GeneratePanelProps {
  readiness: ReadinessItem[];
  progress: GenerateProgress;
  lastRun: GenerativeRunSummary | null;
  onGenerate(): void;
}

export function GeneratePanel({ readiness, progress, lastRun, onGenerate }: GeneratePanelProps) {
  const ready = readiness.every((item) => item.done);

  return (
    <>
      <h3>Setup checklist</h3>
      <ValidationChecklist items={readiness} />

      <button
        type="button"
        className="primary wide"
        disabled={!ready || progress.running}
        title={ready ? 'Run the generative study' : 'Complete the checklist first'}
        onClick={onGenerate}
      >
        <Sparkles size={15} aria-hidden="true" />
        {progress.running ? 'Generating…' : 'Generate outcomes'}
      </button>

      {progress.running && (
        <div className="progress" role="progressbar" aria-valuenow={progress.percent}>
          <span style={{ width: `${progress.percent}%` }} />
          <div className="progress-label">{progress.phase}</div>
        </div>
      )}

      {lastRun && !progress.running && (
        <>
          <h3>Last run</h3>
          <div className="kv-grid">
            <b>outcomes</b>
            <span>{lastRun.outcomes.length}</span>
            <b>design vol</b>
            <span>{(lastRun.designVolumeMm3 / 1000).toFixed(1)} cm³</span>
            <b>total load</b>
            <span>{formatN(lastRun.totalLoadN)}</span>
            <b>target</b>
            <span>{formatPercent(lastRun.settings.volumeFraction)}</span>
            <b>objective</b>
            <span>{lastRun.settings.objective}</span>
          </div>
        </>
      )}

      <div className="callout">
        Outcomes come from the mock topology solver: deterministic estimates derived from
        your setup, so the full workflow is exercisable before the native OpenCascade kernel
        lands. Metrics are estimates, not FEA results.
      </div>
    </>
  );
}
