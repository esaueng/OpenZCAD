import { useId, type ReactNode } from 'react';
import type {
  CurvatureAnalysisRequest,
  CurvatureMeasure,
  DraftAnalysisRequest,
  SurfaceAnalysisReport,
  SurfaceAnalysisRequest,
  ZebraAnalysisRequest
} from '@openzcad/shared';
import type { AnalysisRunState } from '../lib/analysis/useSurfaceAnalysis';
import {
  DRAFT_PULL_DIRECTIONS,
  ZEBRA_STRIPE_LIMITS,
  type DraftPullId
} from '../lib/analysis/analysisRuntime';
import {
  ANALYSIS_LABELS,
  CURVATURE_COLORS,
  CURVATURE_MEASURE_LABELS,
  DRAFT_COLORS,
  DRAFT_VERDICT_LABELS,
  analysisLimits,
  analysisProvenance,
  curvatureScale,
  curvatureUnit,
  describeCurvatureSummary,
  describeDraftSummary,
  describeUnsupported,
  describeZebraSummary,
  formatCurvature,
  formatDegrees,
  summarizeCurvature,
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

function pullIdOf(request: DraftAnalysisRequest): DraftPullId {
  const { x, y, z } = request.pull;
  for (const [id, axis] of Object.entries(DRAFT_PULL_DIRECTIONS)) {
    if (axis.x === x && axis.y === y && axis.z === z) return id as DraftPullId;
  }
  return '+z';
}

function Swatch({ color }: { color: string }) {
  return (
    <span
      className="analysis-swatch"
      style={{ background: color }}
      aria-hidden="true"
    />
  );
}

interface KindView {
  fields: ReactNode;
  legend: ReactNode;
  /** The one-line result, once there is a report. */
  summary: string;
  /** Appended to the provenance note, once there is a report. */
  exactness: string;
}

type OnChange = (request: SurfaceAnalysisRequest) => void;

function draftView(
  request: DraftAnalysisRequest,
  report: SurfaceAnalysisReport | null,
  onChange: OnChange,
  ids: { first: string; second: string }
): KindView {
  const summary = report
    ? summarizeDraft(report, request.minimumDegrees)
    : null;
  const minimum = formatDegrees(request.minimumDegrees);
  return {
    fields: (
      <>
        <label className="analysis-panel-field" htmlFor={ids.first}>
          Pull
          <select
            id={ids.first}
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
        <label className="analysis-panel-field" htmlFor={ids.second}>
          Minimum draft (°)
          <input
            id={ids.second}
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
      </>
    ),
    legend: (
      <>
        <li>
          <Swatch color={DRAFT_COLORS.positive} />≥ {minimum} toward the pull
          {summary ? ` · ${summary.faces.positive}` : ''}
        </li>
        <li>
          <Swatch color={DRAFT_COLORS.insufficient} />
          Within ±{minimum}
          {summary ? ` · ${summary.faces.insufficient}` : ''}
        </li>
        <li>
          <Swatch color={DRAFT_COLORS.negative} />≥ {minimum} away (undercut)
          {summary ? ` · ${summary.faces.negative}` : ''}
        </li>
        <li>
          <Swatch color={DRAFT_COLORS.unevaluated} />
          Not evaluated
        </li>
      </>
    ),
    summary: summary
      ? `${describeDraftSummary(summary)}${
          summary.faces.mixed > 0
            ? ` ${DRAFT_VERDICT_LABELS.mixed}: the face changes band and needs splitting at a parting line.`
            : ''
        }`
      : '',
    exactness: summary
      ? ` ${summary.exactFaces} of ${summary.totalFaces} face ranges exact.`
      : ''
  };
}

function curvatureView(
  request: CurvatureAnalysisRequest,
  report: SurfaceAnalysisReport | null,
  onChange: OnChange,
  ids: { first: string },
  lengthUnit: string,
  nameOf: (bodyId: string) => string
): KindView {
  const summary = report ? summarizeCurvature(report) : null;
  const scale = report ? curvatureScale(report) : 0;
  const unit = curvatureUnit(request.measure, lengthUnit);
  const signed = request.measure !== 'maximum';
  const end = (value: number) => `${formatCurvature(value)} ${unit}`;
  return {
    fields: (
      <label className="analysis-panel-field" htmlFor={ids.first}>
        Measure
        <select
          id={ids.first}
          value={request.measure}
          onChange={(event) =>
            onChange({
              ...request,
              measure: event.target.value as CurvatureMeasure
            })
          }
        >
          {Object.entries(CURVATURE_MEASURE_LABELS).map(([id, label]) => (
            <option key={id} value={id}>
              {label}
            </option>
          ))}
        </select>
      </label>
    ),
    legend: (
      <>
        {signed ? (
          <li>
            <Swatch color={CURVATURE_COLORS.concave} />
            Concave{report ? ` · ${end(-scale)}` : ''}
          </li>
        ) : null}
        <li>
          <Swatch color={CURVATURE_COLORS.flat} />
          Flat · 0
        </li>
        <li>
          <Swatch color={CURVATURE_COLORS.convex} />
          {signed ? 'Convex' : 'Tightest'}
          {report ? ` · ${end(scale)}` : ''}
        </li>
        <li>
          <Swatch color={CURVATURE_COLORS.unevaluated} />
          Not evaluated
        </li>
      </>
    ),
    summary: summary
      ? `${describeCurvatureSummary(summary, lengthUnit, nameOf)}${
          summary.totalFaces > 0 && Number.isFinite(summary.min)
            ? ` ${CURVATURE_MEASURE_LABELS[request.measure]} curvature ${end(summary.min)} to ${end(summary.max)}.`
            : ''
        }`
      : '',
    exactness: summary
      ? ` ${summary.exactFaces} of ${summary.totalFaces} face ranges exact.`
      : ''
  };
}

function zebraView(
  request: ZebraAnalysisRequest,
  report: SurfaceAnalysisReport | null,
  onChange: OnChange,
  ids: { first: string }
): KindView {
  return {
    fields: (
      <label className="analysis-panel-field" htmlFor={ids.first}>
        Stripes
        <input
          id={ids.first}
          type="number"
          min={ZEBRA_STRIPE_LIMITS.min}
          max={ZEBRA_STRIPE_LIMITS.max}
          step={1}
          value={request.stripes}
          onChange={(event) => {
            const value = Number(event.target.value);
            if (
              !Number.isInteger(value) ||
              value < ZEBRA_STRIPE_LIMITS.min ||
              value > ZEBRA_STRIPE_LIMITS.max
            )
              return;
            onChange({ ...request, stripes: value });
          }}
        />
      </label>
    ),
    legend: (
      <>
        <li>
          <span
            className="analysis-swatch analysis-swatch-zebra"
            aria-hidden="true"
          />
          Reflected stripes; they move as the view turns
        </li>
        <li>
          <Swatch color={CURVATURE_COLORS.unevaluated} />
          Not evaluated
        </li>
      </>
    ),
    summary: report ? describeZebraSummary(report) : '',
    exactness: ''
  };
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
  lengthUnit = 'mm',
  nameOf,
  onChange,
  onOff
}: {
  request: SurfaceAnalysisRequest;
  run: AnalysisRunState;
  /** A preview stands in for the build: the overlay is withheld. */
  previewing?: boolean;
  /** The document's length unit label, for curvature figures. */
  lengthUnit?: string;
  nameOf(bodyId: string): string;
  onChange: OnChange;
  onOff(): void;
}) {
  const first = useId();
  const second = useId();
  const report = run.kind === 'done' ? run.report : null;
  const view =
    request.kind === 'draft'
      ? draftView(request, report, onChange, { first, second })
      : request.kind === 'curvature'
        ? curvatureView(
            request,
            report,
            onChange,
            { first },
            lengthUnit,
            nameOf
          )
        : zebraView(request, report, onChange, { first });
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
      <div className="analysis-panel-fields">{view.fields}</div>
      <ul className="analysis-legend" aria-label="Legend">
        {view.legend}
      </ul>
      <p className="analysis-panel-status" role="status">
        {previewing
          ? 'Paused while a preview is on screen; the colours return with the built model.'
          : run.kind === 'running'
            ? 'Analysing with the exact kernel…'
            : run.kind === 'failed'
              ? `The analysis failed: ${run.message}`
              : view.summary}
      </p>
      <p className="analysis-panel-note" role="note">
        {analysisProvenance(request.kind)}
        {view.exactness}
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
