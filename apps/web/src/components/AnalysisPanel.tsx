import { useId } from 'react';
import type { SurfaceAnalysisRequest } from '@openzcad/shared';
import type { AnalysisRunState } from '../lib/analysis/useSurfaceAnalysis';
import {
  DRAFT_PULL_DIRECTIONS,
  type DraftPullId
} from '../lib/analysis/analysisRuntime';
import {
  ANALYSIS_LABELS,
  DRAFT_COLORS,
  DRAFT_VERDICT_LABELS,
  analysisLimits,
  analysisProvenance,
  describeDraftSummary,
  describeUnsupported,
  formatDegrees,
  summarizeDraft
} from '../lib/analysis/surfaceAnalysisUi';

const PULL_LABELS: Record<DraftPullId, string> = {
  '+z': '+Z',
  '-z': '−Z',
  '+y': '+Y',
  '-y': '−Y',
  '+x': '+X',
  '-x': '−X'
};

function pullIdOf(request: SurfaceAnalysisRequest): DraftPullId {
  const { x, y, z } = request.pull;
  for (const [id, axis] of Object.entries(DRAFT_PULL_DIRECTIONS)) {
    if (axis.x === x && axis.y === y && axis.z === z) return id as DraftPullId;
  }
  return '+z';
}

/**
 * M09: the analysis that is on, its settings, its legend, and what its
 * colours do and do not prove. Shown over the viewport while an analysis
 * from the Display menu is on; Turn off ends it.
 */
export function AnalysisPanel({
  request,
  run,
  previewing = false,
  nameOf,
  onChange,
  onOff
}: {
  request: SurfaceAnalysisRequest;
  run: AnalysisRunState;
  /** A preview stands in for the build: the overlay is withheld. */
  previewing?: boolean;
  nameOf(bodyId: string): string;
  onChange(request: SurfaceAnalysisRequest): void;
  onOff(): void;
}) {
  const pullId = useId();
  const minimumId = useId();
  const report = run.kind === 'done' ? run.report : null;
  const summary = report
    ? summarizeDraft(report, request.minimumDegrees)
    : null;
  const unsupported = report
    ? [
        ...report.missing.map(
          (bodyId) => `${nameOf(bodyId)}: no exact geometry to analyse.`
        ),
        ...describeUnsupported(report.unsupported, nameOf)
      ]
    : [];
  return (
    <section
      className="analysis-panel"
      role="region"
      aria-label={`${ANALYSIS_LABELS[request.kind]} analysis`}
    >
      <div className="analysis-panel-head">
        <h2 className="analysis-panel-title">
          {ANALYSIS_LABELS[request.kind]} analysis
        </h2>
        <button type="button" className="analysis-panel-off" onClick={onOff}>
          Turn off
        </button>
      </div>
      <div className="analysis-panel-fields">
        <label className="analysis-panel-field" htmlFor={pullId}>
          Pull
          <select
            id={pullId}
            value={pullIdOf(request)}
            onChange={(event) =>
              onChange({
                ...request,
                pull: DRAFT_PULL_DIRECTIONS[event.target.value as DraftPullId]
              })
            }
          >
            {Object.keys(DRAFT_PULL_DIRECTIONS).map((id) => (
              <option key={id} value={id}>
                {PULL_LABELS[id as DraftPullId]}
              </option>
            ))}
          </select>
        </label>
        <label className="analysis-panel-field" htmlFor={minimumId}>
          Minimum draft (°)
          <input
            id={minimumId}
            type="number"
            min={0}
            max={89}
            step={0.5}
            value={request.minimumDegrees}
            onChange={(event) => {
              const value = Number(event.target.value);
              if (!Number.isFinite(value) || value < 0 || value >= 90) return;
              onChange({ ...request, minimumDegrees: value });
            }}
          />
        </label>
      </div>
      <ul className="analysis-legend" aria-label="Legend">
        <li>
          <span
            className="analysis-swatch"
            style={{ background: DRAFT_COLORS.positive }}
            aria-hidden="true"
          />
          ≥ {formatDegrees(request.minimumDegrees)} toward the pull
          {summary ? ` · ${summary.faces.positive}` : ''}
        </li>
        <li>
          <span
            className="analysis-swatch"
            style={{ background: DRAFT_COLORS.insufficient }}
            aria-hidden="true"
          />
          Within ±{formatDegrees(request.minimumDegrees)}
          {summary ? ` · ${summary.faces.insufficient}` : ''}
        </li>
        <li>
          <span
            className="analysis-swatch"
            style={{ background: DRAFT_COLORS.negative }}
            aria-hidden="true"
          />
          ≥ {formatDegrees(request.minimumDegrees)} away (undercut)
          {summary ? ` · ${summary.faces.negative}` : ''}
        </li>
        <li>
          <span
            className="analysis-swatch"
            style={{ background: DRAFT_COLORS.unevaluated }}
            aria-hidden="true"
          />
          Not evaluated
        </li>
      </ul>
      <p className="analysis-panel-status" role="status">
        {previewing
          ? 'Paused while a preview is on screen; the colours return with the built model.'
          : run.kind === 'running'
            ? 'Analysing with the exact kernel…'
            : run.kind === 'failed'
              ? `The analysis failed: ${run.message}`
              : summary
                ? `${describeDraftSummary(summary)}${
                    summary.faces.mixed > 0
                      ? ` ${DRAFT_VERDICT_LABELS.mixed}: the face changes band and needs splitting at a parting line.`
                      : ''
                  }`
                : ''}
      </p>
      <p className="analysis-panel-note" role="note">
        {analysisProvenance(request.kind)}
        {summary
          ? ` ${summary.exactFaces} of ${summary.totalFaces} face ranges exact.`
          : ''}
      </p>
      <p className="analysis-panel-note">{analysisLimits(request.kind)}</p>
      {unsupported.length > 0 ? (
        <ul className="analysis-unsupported" aria-label="Not analysed">
          {unsupported.map((line, index) => (
            <li key={index}>{line}</li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
