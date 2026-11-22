import {
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
  type RefObject
} from 'react';
import {
  Info,
  Layers2,
  LoaderCircle,
  Rows3,
  Spline,
  Triangle,
  X
} from 'lucide-react';
import type {
  CurvatureAnalysisRequest,
  CurvatureMeasure,
  DraftAnalysisRequest,
  SurfaceAnalysisKind,
  SurfaceAnalysisReport,
  SurfaceAnalysisRequest,
  ThicknessAnalysisRequest,
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
  CURVATURE_LEGEND_LABELS,
  CURVATURE_MEASURE_LABELS,
  DRAFT_COLORS,
  DRAFT_VERDICT_LABELS,
  analysisNotes,
  curvatureScale,
  curvatureUnit,
  describeCurvatureSummary,
  describeDraftSummary,
  describeUnsupported,
  describeZebraSummary,
  formatCurvature,
  formatDegrees,
  summarizeCurvature,
  summarizeDraft,
  THICKNESS_COLORS,
  describeThicknessSummary,
  formatLength,
  summarizeThickness
} from '../lib/analysis/surfaceAnalysisUi';

const KIND_ICONS: Record<SurfaceAnalysisKind, typeof Triangle> = {
  draft: Triangle,
  curvature: Spline,
  zebra: Rows3,
  thickness: Layers2
};

const PULL_LABELS: Record<DraftPullId, string> = {
  '+z': '+Z',
  '-z': '−Z',
  '+y': '+Y',
  '-y': '−Y',
  '+x': '+X',
  '-x': '−X'
};

/** One word under each end of the curvature ramp; the full name is its title. */
const CURVATURE_SHORT_LABELS: Record<
  CurvatureMeasure,
  { negative: string; zero: string; positive: string }
> = {
  gaussian: { negative: 'Saddle', zero: 'Flat', positive: 'Dome' },
  mean: { negative: 'Concave', zero: 'Flat', positive: 'Convex' },
  maximum: { negative: 'Concave', zero: 'Flat', positive: 'Tightest' }
};

function pullIdOf(request: DraftAnalysisRequest): DraftPullId {
  const { x, y, z } = request.pull;
  for (const [id, axis] of Object.entries(DRAFT_PULL_DIRECTIONS)) {
    if (axis.x === x && axis.y === y && axis.z === z) return id as DraftPullId;
  }
  return '+z';
}

/** A row of mutually exclusive choices, read as one radio group. */
function Segmented<T extends string>({
  label,
  value,
  options,
  onChange
}: {
  label: string;
  value: T;
  options: readonly { id: T; label: string }[];
  onChange(id: T): void;
}) {
  const groupRef = useRef<HTMLDivElement | null>(null);
  const current = Math.max(
    0,
    options.findIndex((option) => option.id === value)
  );
  // A radio group is one tab stop; the arrows (and Home/End) move and
  // choose within it.
  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const step =
      event.key === 'ArrowRight' || event.key === 'ArrowDown'
        ? 1
        : event.key === 'ArrowLeft' || event.key === 'ArrowUp'
          ? -1
          : 0;
    let next = -1;
    if (step) next = (current + step + options.length) % options.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = options.length - 1;
    if (next < 0) return;
    event.preventDefault();
    onChange(options[next]!.id);
    groupRef.current
      ?.querySelectorAll<HTMLButtonElement>('[role="radio"]')
      [next]?.focus();
  }
  return (
    <div
      ref={groupRef}
      className="analysis-segmented"
      role="radiogroup"
      aria-label={label}
      onKeyDown={onKeyDown}
    >
      {options.map((option, index) => (
        <button
          key={option.id}
          type="button"
          role="radio"
          aria-checked={index === current}
          tabIndex={index === current ? 0 : -1}
          className="analysis-segment"
          onClick={() => onChange(option.id)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

/** A labelled number with its unit inside the field. */
function NumberField({
  id,
  label,
  unit,
  value,
  min,
  max,
  step,
  accept
}: {
  id: string;
  label: string;
  unit: string;
  value: number;
  min: number;
  max?: number;
  step: number | 'any';
  accept(value: number): void;
}) {
  return (
    <div className="analysis-field">
      <label htmlFor={id}>{label}</label>
      <span className="analysis-number">
        <input
          id={id}
          aria-label={`${label} (${unit})`}
          type="number"
          min={min}
          max={max}
          step={step}
          value={value}
          onChange={(event) => accept(Number(event.target.value))}
        />
        <span className="analysis-unit" aria-hidden="true">
          {unit}
        </span>
      </span>
    </div>
  );
}

/** One legend entry: its colour, a short name and, once measured, a count. */
function Chip({
  color,
  label,
  count
}: {
  color: string;
  label: string;
  count?: number | null;
}) {
  return (
    <li className="analysis-chip">
      <span
        className="analysis-swatch"
        style={{ background: color }}
        aria-hidden="true"
      />
      <span>{label}</span>
      {count !== undefined && count !== null ? (
        <span className="analysis-chip-count"> · {count}</span>
      ) : null}
    </li>
  );
}

interface KindView {
  /** The settings, kept to a row or two of compact controls. */
  fields: ReactNode;
  /** The colour key, or null when the overlay explains itself. */
  legend: ReactNode;
  /** The one-line result, once there is a report. */
  summary: string;
  /** A further word on the result, kept under the disclosure. */
  detail?: string;
  /** Appended to the provenance note, once there is a report. */
  exactness: string;
}

type OnChange = (request: SurfaceAnalysisRequest) => void;

function draftView(
  request: DraftAnalysisRequest,
  report: SurfaceAnalysisReport | null,
  onChange: OnChange,
  id: string
): KindView {
  const summary = report
    ? summarizeDraft(report, request.minimumDegrees)
    : null;
  const minimum = formatDegrees(request.minimumDegrees);
  return {
    fields: (
      <>
        <div className="analysis-field">
          <span className="analysis-field-label" aria-hidden="true">
            Pull
          </span>
          <Segmented
            label="Pull"
            value={pullIdOf(request)}
            options={(Object.keys(DRAFT_PULL_DIRECTIONS) as DraftPullId[]).map(
              (pull) => ({ id: pull, label: PULL_LABELS[pull] })
            )}
            onChange={(pull) =>
              onChange({ ...request, pull: DRAFT_PULL_DIRECTIONS[pull] })
            }
          />
        </div>
        <NumberField
          id={id}
          label="Min draft"
          unit="°"
          value={request.minimumDegrees}
          min={0}
          max={89}
          step={0.5}
          accept={(value) => {
            if (!Number.isFinite(value) || value < 0 || value >= 90) return;
            onChange({ ...request, minimumDegrees: value });
          }}
        />
      </>
    ),
    legend: (
      <>
        <Chip
          color={DRAFT_COLORS.positive}
          label={`≥ ${minimum}`}
          count={summary?.faces.positive}
        />
        <Chip
          color={DRAFT_COLORS.insufficient}
          label={request.minimumDegrees > 0 ? `< ${minimum}` : minimum}
          count={summary?.faces.insufficient}
        />
        <Chip
          color={DRAFT_COLORS.negative}
          label="Undercut"
          count={summary?.faces.negative}
        />
      </>
    ),
    summary: summary ? describeDraftSummary(summary) : '',
    detail:
      summary && summary.faces.mixed > 0
        ? `${DRAFT_VERDICT_LABELS.mixed}: needs a split at a parting line.`
        : undefined,
    exactness: summary
      ? `${summary.exactFaces} of ${summary.totalFaces} faces exact.`
      : ''
  };
}

function curvatureView(
  request: CurvatureAnalysisRequest,
  report: SurfaceAnalysisReport | null,
  onChange: OnChange,
  lengthUnit: string,
  nameOf: (bodyId: string) => string
): KindView {
  const summary = report ? summarizeCurvature(report) : null;
  const scale = report ? curvatureScale(report) : 0;
  const unit = curvatureUnit(request.measure, lengthUnit);
  const signed = request.measure !== 'maximum';
  const end = (value: number) => `${formatCurvature(value)} ${unit}`;
  const labels = CURVATURE_LEGEND_LABELS[request.measure];
  const ramp = signed
    ? `linear-gradient(90deg, ${CURVATURE_COLORS.concave}, ${CURVATURE_COLORS.flat}, ${CURVATURE_COLORS.convex})`
    : `linear-gradient(90deg, ${CURVATURE_COLORS.flat}, ${CURVATURE_COLORS.tight}, ${CURVATURE_COLORS.convex})`;
  const short = CURVATURE_SHORT_LABELS[request.measure];
  const ends = [
    ...(signed
      ? [{ short: short.negative, full: labels.negative, value: end(-scale) }]
      : []),
    { short: short.zero, full: labels.zero, value: '0' },
    { short: short.positive, full: labels.positive, value: end(scale) }
  ];
  return {
    fields: (
      <Segmented
        label="Measure"
        value={request.measure}
        options={(
          Object.entries(CURVATURE_MEASURE_LABELS) as [
            CurvatureMeasure,
            string
          ][]
        ).map(([id, label]) => ({ id, label }))}
        onChange={(measure) => onChange({ ...request, measure })}
      />
    ),
    legend: (
      <li className="analysis-ramp">
        <span
          className="analysis-ramp-bar"
          style={{ background: ramp }}
          aria-hidden="true"
        />
        <span className="analysis-ramp-ends">
          {ends.map((item) => (
            <span
              key={item.short}
              className="analysis-ramp-end"
              title={item.full}
            >
              <span className="analysis-ramp-name">{item.short}</span>
              {report ? (
                <span className="analysis-ramp-value"> {item.value}</span>
              ) : null}
            </span>
          ))}
        </span>
      </li>
    ),
    summary: summary
      ? `${describeCurvatureSummary(summary, lengthUnit, nameOf)}${
          summary.totalFaces > 0 && Number.isFinite(summary.min)
            ? ` ${CURVATURE_MEASURE_LABELS[request.measure]} curvature ${end(summary.min)} to ${end(summary.max)}.`
            : ''
        }`
      : '',
    exactness: summary
      ? `${summary.exactFaces} of ${summary.totalFaces} faces exact.`
      : ''
  };
}

function zebraView(
  request: ZebraAnalysisRequest,
  report: SurfaceAnalysisReport | null,
  onChange: OnChange,
  id: string
): KindView {
  return {
    fields: (
      <div className="analysis-field analysis-field-wide">
        <label htmlFor={id}>Stripes</label>
        <input
          id={id}
          className="analysis-slider"
          type="range"
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
        {/* The slider states its own value; this is its echo on screen. */}
        <span className="analysis-slider-value" aria-hidden="true">
          {request.stripes}
        </span>
      </div>
    ),
    legend: null,
    summary: report ? describeZebraSummary(report) : '',
    exactness: ''
  };
}

function thicknessView(
  request: ThicknessAnalysisRequest,
  report: SurfaceAnalysisReport | null,
  onChange: OnChange,
  id: string,
  lengthUnit: string,
  nameOf: (bodyId: string) => string
): KindView {
  const summary = report ? summarizeThickness(report, request.minimum) : null;
  const minimum = formatLength(request.minimum, lengthUnit);
  const twice = formatLength(request.minimum * 2, lengthUnit);
  return {
    fields: (
      <NumberField
        id={id}
        label="Min wall"
        unit={lengthUnit}
        value={request.minimum}
        min={0}
        step="any"
        accept={(value) => {
          if (!Number.isFinite(value) || value <= 0) return;
          onChange({ ...request, minimum: value });
        }}
      />
    ),
    legend: (
      <>
        <Chip
          color={THICKNESS_COLORS.thin}
          label={`< ${minimum}`}
          count={summary?.faces.thin}
        />
        <Chip
          color={THICKNESS_COLORS.marginal}
          label={`< ${twice}`}
          count={summary?.faces.marginal}
        />
        <Chip
          color={THICKNESS_COLORS.ample}
          label={`≥ ${twice}`}
          count={summary?.faces.ample}
        />
      </>
    ),
    summary: summary
      ? describeThicknessSummary(summary, request.minimum, lengthUnit, nameOf)
      : '',
    exactness: summary
      ? `${
          summary.resolution !== null
            ? `Resolution ${formatLength(summary.resolution, lengthUnit)} · `
            : ''
        }${summary.exactFaces} of ${summary.totalFaces} faces exact.`
      : ''
  };
}

const EDGE = 8;
const GAP = 8;

/**
 * Stands the panel beside the Display button that switched it on: left of
 * a rail on the right edge, or above a bar along the foot. The button moves
 * with the layout (Build's rail, View's bar, a docked inspector), so the
 * panel follows it rather than a fixed corner. Without a button on screen
 * the stylesheet's own placement stands.
 */
function useBesideDisplayButton(
  panelRef: RefObject<HTMLElement | null>
): CSSProperties | undefined {
  const [style, setStyle] = useState<CSSProperties | undefined>(undefined);
  useLayoutEffect(() => {
    const panel = panelRef.current;
    const stage = panel?.offsetParent;
    if (!panel || !(stage instanceof HTMLElement)) return;
    // View's and Tweak's bar sits in the app shell beside the viewer, not
    // inside it: look across the whole workspace.
    const scope: ParentNode = stage.closest('.workspace') ?? document;
    let last = '';
    const apply = (next: CSSProperties | undefined) => {
      const key = JSON.stringify(next ?? null);
      if (key === last) return;
      last = key;
      setStyle(next);
    };
    let observedHost: Element | null = null;
    const place = () => {
      const trigger = Array.from(
        scope.querySelectorAll<HTMLElement>('[data-display-mode-trigger]')
      ).find((element) => element.getClientRects().length > 0);
      if (!trigger) {
        apply(undefined);
        return;
      }
      const host =
        trigger.closest<HTMLElement>('.viewer-rail, .view-mode-bar') ?? trigger;
      if (host !== observedHost) {
        if (observedHost) resize?.unobserve(observedHost);
        observedHost = host;
        resize?.observe(host);
      }
      const s = stage.getBoundingClientRect();
      const h = host.getBoundingClientRect();
      const t = trigger.getBoundingClientRect();
      const width = panel.offsetWidth;
      const height = panel.offsetHeight;
      const clamp = (value: number, low: number, high: number) =>
        Math.max(low, Math.min(value, Math.max(low, high)));
      const vertical = h.height > h.width;
      // A vertical rail with no room beside it (a phone): the stylesheet's
      // own placement.
      if (vertical && h.left - s.left < width + GAP + EDGE) {
        apply(undefined);
        return;
      }
      // A vertical rail: beside it, the panel's top level with the button.
      if (vertical) {
        apply({
          left: 'auto',
          right: `${Math.round(s.right - h.left + GAP)}px`,
          top: `${Math.round(clamp(t.top - s.top - 6, EDGE, s.height - height - EDGE))}px`,
          bottom: 'auto',
          transform: 'none'
        });
        return;
      }
      // A horizontal bar: above it (or below, without room), centred on
      // the button.
      const centre = t.left + t.width / 2 - s.left;
      const above = h.top - s.top >= height + GAP + EDGE;
      apply({
        left: `${Math.round(clamp(centre - width / 2, EDGE, s.width - width - EDGE))}px`,
        right: 'auto',
        top: above ? 'auto' : `${Math.round(h.bottom - s.top + GAP)}px`,
        bottom: above ? `${Math.round(s.bottom - h.top + GAP)}px` : 'auto',
        transform: 'none'
      });
    };
    // A dock that opens or widens moves the rail through a custom property
    // on the workspace, which resizes nothing observed: re-place on those
    // changes too, once per frame.
    let frame = 0;
    const schedule = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        place();
      });
    };
    const resize =
      typeof ResizeObserver === 'undefined'
        ? null
        : new ResizeObserver(schedule);
    resize?.observe(stage);
    resize?.observe(panel);
    const mutation =
      typeof MutationObserver === 'undefined'
        ? null
        : new MutationObserver(schedule);
    const root = stage.closest('.workspace');
    for (const target of [root, stage]) {
      if (target)
        mutation?.observe(target, {
          attributes: true,
          attributeFilter: ['class', 'style']
        });
    }
    if (root) mutation?.observe(root, { childList: true, subtree: true });
    // Tweak's View bar slides in on a keyframe animation rather than a
    // transition: a placement taken mid-slide stays off by the remaining
    // offset unless it is taken again once the animation settles.
    const settled = ['transitionend', 'animationend', 'animationcancel'];
    for (const type of settled) root?.addEventListener(type, schedule);
    window.addEventListener('resize', schedule);
    place();
    return () => {
      if (frame) cancelAnimationFrame(frame);
      resize?.disconnect();
      mutation?.disconnect();
      for (const type of settled) root?.removeEventListener(type, schedule);
      window.removeEventListener('resize', schedule);
    };
  }, [panelRef]);
  return style;
}

/**
 * M09: the analysis that is on, its few settings, a compact colour key and
 * the one-line result. What the colours do and do not prove sits one click
 * away under the info disclosure. Stands beside the Display button that
 * switched it on; the close button ends it.
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
  const id = useId();
  const panelRef = useRef<HTMLElement | null>(null);
  const placement = useBesideDisplayButton(panelRef);
  const report = run.kind === 'done' ? run.report : null;
  const view =
    request.kind === 'draft'
      ? draftView(request, report, onChange, id)
      : request.kind === 'curvature'
        ? curvatureView(request, report, onChange, lengthUnit, nameOf)
        : request.kind === 'zebra'
          ? zebraView(request, report, onChange, id)
          : thicknessView(request, report, onChange, id, lengthUnit, nameOf);
  const unsupported = report
    ? [
        ...report.missing.map(
          (bodyId) => `${nameOf(bodyId)}: no exact geometry to analyse.`
        ),
        ...describeUnsupported(report.unsupported, nameOf)
      ]
    : [];
  const Icon = KIND_ICONS[request.kind];
  const running = !previewing && run.kind === 'running';
  return (
    <section
      ref={panelRef}
      className="analysis-panel"
      role="region"
      aria-label={`${ANALYSIS_LABELS[request.kind]} analysis`}
      style={placement}
    >
      <div className="analysis-panel-head">
        <Icon size={14} className="analysis-panel-icon" aria-hidden="true" />
        <h2 className="analysis-panel-title">
          {ANALYSIS_LABELS[request.kind]}
        </h2>
        <button
          type="button"
          className="analysis-panel-off"
          aria-label="Turn off"
          title="Turn off"
          onClick={onOff}
        >
          <X size={14} aria-hidden="true" />
        </button>
      </div>
      <div className="analysis-panel-fields">{view.fields}</div>
      {view.legend || unsupported.length > 0 ? (
        <ul className="analysis-legend" aria-label="Legend">
          {view.legend}
          {unsupported.length > 0 ? (
            <Chip
              color={CURVATURE_COLORS.unevaluated}
              label={
                request.kind === 'thickness' ? 'Not measured' : 'Not evaluated'
              }
            />
          ) : null}
        </ul>
      ) : null}
      <p
        className={`analysis-panel-status${
          run.kind === 'failed' && !previewing ? ' is-failed' : ''
        }`}
        role="status"
      >
        {running ? (
          <LoaderCircle
            size={12}
            className="analysis-spinner spin"
            aria-hidden="true"
          />
        ) : null}
        {previewing
          ? 'Paused during preview.'
          : running
            ? 'Analysing…'
            : run.kind === 'failed'
              ? `Failed: ${run.message}`
              : view.summary}
      </p>
      {/* Closed by default and again for each analysis: the card shows
          the result, the notes wait behind one click. */}
      <details className="analysis-about" key={request.kind}>
        <summary>
          <Info size={12} aria-hidden="true" />
          Details
        </summary>
        <ul className="analysis-notes" role="note">
          {view.detail ? <li>{view.detail}</li> : null}
          {analysisNotes(request.kind).map((note) => (
            <li key={note}>{note}</li>
          ))}
          {view.exactness ? <li>{view.exactness}</li> : null}
        </ul>
        {unsupported.length > 0 ? (
          <ul className="analysis-unsupported" aria-label="Not analysed">
            {unsupported.map((line, index) => (
              <li key={index}>{line}</li>
            ))}
          </ul>
        ) : null}
      </details>
    </section>
  );
}
