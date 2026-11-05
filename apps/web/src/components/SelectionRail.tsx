import {
  Anchor,
  ArrowUpFromDot,
  BrushCleaning,
  CircleAlert,
  Diameter,
  Eraser,
  Info,
  ListChecks,
  Ruler,
  SquarePen,
  SquareX
} from 'lucide-react';
import {
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode
} from 'react';
import { useSettledFlag } from '../hooks/useSettledFlag';
import type { SelectionActionId } from '../lib/interaction/capabilities';
import {
  LIVE_DIAMETER_DETAIL_ATTRIBUTE,
  renderLabelSegments
} from '../lib/liveLabels';
import type {
  SelectionCalloutContent,
  SelectionCalloutOperation,
  SelectionCalloutVerb
} from '../lib/selectionCallout';
import {
  OPERATION_PHASE_LABELS,
  REFUSAL_FOLD_LABELS,
  refusalIsExpandable
} from '../lib/selectionCalloutView';
import { TOOL_META, type ToolId } from '../lib/tools';
import type { LabelSegment } from '../lib/topologyLabels';
import { Tooltip } from './Tooltip';

/**
 * How long the exact check must run before the rail says so. Most releases
 * validate within a frame or two: announcing each one blinked a marker in
 * and out and dimmed every verb.
 */
export const VALIDATING_ANNOUNCE_MS = 250;

const ACTION_ICONS: Record<SelectionActionId, ReactNode> = {
  'resize-body': <Ruler size={16} aria-hidden="true" />,
  'offset-face': <ArrowUpFromDot size={16} aria-hidden="true" />,
  'resize-radial-face': <Diameter size={16} aria-hidden="true" />,
  'edit-fillet': TOOL_META.fillet.icon,
  'remove-fillet': <Eraser size={16} aria-hidden="true" />,
  'remove-all-fillets': <BrushCleaning size={16} aria-hidden="true" />,
  'remove-face-feature': <Eraser size={16} aria-hidden="true" />,
  'sketch-on-face': TOOL_META.sketch.icon,
  fillet: TOOL_META.fillet.icon,
  chamfer: TOOL_META.chamfer.icon,
  'extrude-region': TOOL_META.extrude.icon
};

function verbIcon(verb: SelectionCalloutVerb): ReactNode {
  if (verb.id === 'edit-face') {
    // One id, two verbs: an imported face with an edit of its own, and one
    // whose card only reads out what recognition found.
    return verb.label === 'Face details' ? (
      <Info size={16} aria-hidden="true" />
    ) : (
      <SquarePen size={16} aria-hidden="true" />
    );
  }
  if (verb.id.startsWith('tool:')) {
    return TOOL_META[verb.id.slice('tool:'.length) as ToolId].icon;
  }
  return ACTION_ICONS[verb.id.slice('action:'.length) as SelectionActionId];
}

/**
 * While the hand is on the handle, and while the exact check that follows
 * the release runs, the rail keeps only the verb being made: nothing else
 * can act on the pick until the check answers.
 */
export function selectionRailCollapsed(
  content: SelectionCalloutContent
): boolean {
  const phase = content.operation?.phase;
  return phase === 'dragging' || phase === 'validating';
}

/**
 * What can be done with the pick, as the verb rail itself. A pick swaps the
 * rail's fixed tools for the pick's own verbs, under a Deselect all that
 * says what is picked; the verb the pick has armed is the lit one. The
 * pick's name and measurement read in the bar at the foot of the stage
 * ({@link SelectionReadout}), so nothing hangs over the model or beside
 * the rail.
 *
 * It keeps the Selection card's classes and accessible names ("Selection:
 * Fillet", "Deselect all", the "Offset Face operation" region), so every
 * way of reaching a verb still reaches it.
 *
 * The operation's refusal is not here: it joins the notice lane
 * ({@link SelectionRefusal}), where every other message the workspace has
 * for the user already stands.
 */
export function SelectionRail({
  content,
  summary
}: {
  content: SelectionCalloutContent;
  /** What is picked, in words: "1 face", "8 edges". */
  summary: string;
}) {
  const operation = content.operation;
  const validating = operation?.phase === 'validating';
  // The verbs are held from the first frame (the check owns the pick until it
  // answers); only saying so waits until the check has visibly taken time.
  const announced = useSettledFlag(validating, VALIDATING_ANNOUNCE_MS);
  // A quick check keeps the marker the release came from (the drag's dot,
  // the typed value's) rather than blinking a new one.
  const before = useRef(operation?.phase);
  const phase = validating && !announced ? before.current : operation?.phase;
  useLayoutEffect(() => {
    if (!validating) before.current = operation?.phase;
  });
  const collapsed = selectionRailCollapsed(content);
  const verbs = collapsed
    ? content.verbs.filter((verb) => verb.pressed)
    : content.verbs;
  const edgeCount = collapsed ? undefined : operation?.selectAllEdgesCount;
  const clear = collapsed ? undefined : content.onClear;
  return (
    <section
      className="selection-rail selection-callout-chip"
      role={operation ? 'region' : 'group'}
      aria-label={operation ? `${operation.title} operation` : 'Selection'}
      aria-busy={validating ? 'true' : undefined}
      data-busy={validating && !announced ? 'quiet' : undefined}
    >
      {clear && (
        <>
          <Tooltip label="Deselect all" shortcut="Esc" description={summary}>
            <button
              type="button"
              className="command-rail selection-rail-clear"
              aria-label="Deselect all"
              disabled={validating}
              onClick={clear}
            >
              <SquareX size={16} aria-hidden="true" />
            </button>
          </Tooltip>
          {verbs.length > 0 && (
            <span className="command-rail-divider" aria-hidden="true" />
          )}
        </>
      )}
      {verbs.map((verb) => (
        <Tooltip key={verb.id} label={verb.label} description={verb.title}>
          <button
            type="button"
            className={`command-rail selection-rail-verb${verb.pressed ? ' active' : ''}`}
            // Named for what it acts on, so it never shares a name with the
            // More tools tile or tool-card action of the same verb.
            aria-label={`Selection: ${verb.label}`}
            aria-pressed={verb.pressed}
            // The exact check owns this pick until it answers: another
            // action now would leave the old operation free to commit late.
            disabled={verb.disabled || validating}
            onClick={() => content.onVerb(verb.id)}
          >
            {verbIcon(verb)}
          </button>
        </Tooltip>
      ))}
      {edgeCount ? (
        <Tooltip
          label={`All ${edgeCount} edges`}
          description="Add every edge of this body to the operation"
        >
          <button
            type="button"
            className="command-rail selection-rail-verb"
            aria-label={`Select all ${edgeCount} edges`}
            disabled={validating}
            onClick={operation?.onSelectAllEdges}
          >
            <ListChecks size={16} aria-hidden="true" />
          </button>
        </Tooltip>
      ) : null}
      {operation?.badge && (
        <span
          className="selection-callout-badge selection-rail-badge"
          tabIndex={0}
          aria-label={operation.badge.label}
          title={operation.badge.detail}
        >
          <Anchor size={14} aria-hidden="true" />
        </span>
      )}
      {/* Armed is the resting state, and the lit verb already says which
          operation the pick carries; every other phase is news. */}
      {phase && phase !== 'armed' && <PhaseMarker phase={phase} />}
    </section>
  );
}

/** What each phase mark's tooltip says, in words a user would use. */
const PHASE_TOOLTIPS: Partial<
  Record<NonNullable<SelectionCalloutOperation['phase']>, string>
> = {
  'exact-entry': 'Typing an exact value',
  validating: 'Checking the exact result',
  failed: 'This value did not build'
};

function PhaseMarker({
  phase
}: {
  phase: NonNullable<SelectionCalloutOperation['phase']>;
}) {
  const label = OPERATION_PHASE_LABELS[phase];
  if (phase === 'dragging') {
    // Collapsed while the hand is on the handle: the value on the handle is
    // what is being read then.
    return (
      <span
        className="selection-callout-phase-dot"
        aria-label={label}
        title={label}
      />
    );
  }
  // A mark under the verb, its tone the phase's; the words are for
  // assistive tech and the tooltip, since the rail has no room for a pill.
  // A refusal is a mark worth explaining: a bare red dot under the verbs
  // read as a recording light, so it is an alert glyph with a tooltip that
  // says what failed and where the reason is.
  const failed = phase === 'failed';
  return (
    <Tooltip
      label={PHASE_TOOLTIPS[phase] ?? label}
      description={
        failed
          ? 'The reason and the ways out are in the note above the search bar.'
          : undefined
      }
    >
      <span
        className={`selection-callout-phase selection-rail-phase phase-${phase}${failed ? ' has-icon' : ''}`}
        tabIndex={failed ? 0 : undefined}
      >
        {failed && <CircleAlert size={14} aria-hidden="true" />}
        <span className="visually-hidden">{label}</span>
      </span>
    </Tooltip>
  );
}

/**
 * The pick's name and its key measurement, at the foot of the stage where
 * the bar's guidance reads: the one readout of what is picked.
 */
export function SelectionReadout({
  label,
  detail,
  detailDiameter
}: {
  label: readonly LabelSegment[] | null;
  detail?: string | undefined;
  /** When `detail` is a diameter: a radius drag rewrites it in place. */
  detailDiameter?: { diameter: number; units: string } | undefined;
}) {
  const nameRef = useRef<HTMLSpanElement>(null);
  // Segmented like every other spelling of a pick, so a cylinder-radius drag
  // can rewrite the diameter node in place (setLiveDiameter).
  useLayoutEffect(() => {
    if (nameRef.current) renderLabelSegments(nameRef.current, label ?? []);
  }, [label]);
  return (
    <span className="selection-readout" role="group" aria-label="Picked">
      <span className="selection-callout-name" ref={nameRef} />
      {detail && (
        <span
          className="selection-callout-detail"
          {...(detailDiameter
            ? {
                [LIVE_DIAMETER_DETAIL_ATTRIBUTE]: String(
                  detailDiameter.diameter
                ),
                'data-units': detailDiameter.units
              }
            : {})}
        >
          {detail}
        </span>
      )}
    </span>
  );
}

/**
 * A refused operation, in the notice lane: the plain sentence and its ways
 * out (edit the feature that refused it, keep the last value that built,
 * read the kernel's own words). The handle stays live on the model, so a
 * smaller drag or a new value is still the quickest way out.
 */
export function SelectionRefusal({
  operation
}: {
  operation: SelectionCalloutOperation;
}) {
  const error = operation.error;
  const message = error?.message ?? '';
  const rowRef = useRef<HTMLDivElement | null>(null);
  const textRef = useRef<HTMLSpanElement | null>(null);
  const messageId = useId();
  // One refusal is one operation's one sentence. Any change — another
  // operation, another sentence, or a return to an earlier one — is a new
  // refusal and opens folded, so the fold never carries over.
  const identity = `${operation.title}\u0000${message}`;
  const [fold, setFold] = useState<{
    identity: string;
    expanded: boolean;
    /**
     * Whether the folded line actually clips: null until laid out, and
     * still null where nothing is laid out (unit tests), which keeps the
     * sentence guess.
     */
    clips: boolean | null;
  }>({ identity, expanded: false, clips: null });
  if (fold.identity !== identity) {
    setFold({ identity, expanded: false, clips: null });
  }
  const expanded = fold.identity === identity && fold.expanded;
  const clips = fold.identity === identity ? fold.clips : null;
  const setExpanded = (next: boolean) =>
    setFold((current) => ({ ...current, expanded: next }));
  useLayoutEffect(() => {
    const row = rowRef.current;
    const text = textRef.current;
    if (!row || !text) return;
    const area = row.closest<HTMLElement>('.viewer-area');
    const measure = () => {
      // Folded, the clamp shows whether anything is hidden; open, the
      // answer from the folded line stands.
      if (!expanded && text.clientHeight > 0) {
        const next = text.scrollHeight > text.clientHeight + 1;
        setFold((current) =>
          current.clips === next ? current : { ...current, clips: next }
        );
      }
      // The Undo toast stands on this row, so it is lifted by the row's
      // real height (plus the lane gap), folded or open, rather than by a
      // fixed figure an open diagnosis outgrows.
      if (area && row.offsetHeight > 0) {
        area.style.setProperty(
          '--lane-refusal-measured',
          `${Math.ceil(row.offsetHeight) + 12}px`
        );
      }
    };
    measure();
    const observer =
      typeof ResizeObserver === 'undefined'
        ? null
        : new ResizeObserver(measure);
    observer?.observe(row);
    observer?.observe(text);
    return () => {
      observer?.disconnect();
      area?.style.removeProperty('--lane-refusal-measured');
    };
  }, [identity, expanded]);
  if (!error) return null;
  const culprit = error.culprit;
  const expandable = expanded || (clips ?? refusalIsExpandable(message));
  return (
    <div
      ref={rowRef}
      className={[
        'selection-callout-diagnostic',
        expandable ? 'is-expandable' : '',
        expanded ? 'is-expanded' : ''
      ]
        .filter(Boolean)
        .join(' ')}
    >
      {/* Folded to one line, the whole sentence stays in the DOM and is the
          live region on its own: only its paint is clipped, and the toggle
          sits outside the region, so pressing it announces only its own
          state rather than the whole refusal again. */}
      <span
        ref={textRef}
        id={messageId}
        className="selection-callout-error"
        role="alert"
      >
        {message}
      </span>
      {expandable && (
        <button
          type="button"
          className="selection-callout-recovery selection-callout-expand"
          aria-expanded={expanded}
          aria-controls={messageId}
          onClick={() => setExpanded(!expanded)}
        >
          {expanded ? REFUSAL_FOLD_LABELS.less : REFUSAL_FOLD_LABELS.more}
        </button>
      )}
      {culprit && (
        <button
          type="button"
          className="selection-callout-recovery"
          onClick={() => operation.onEditCulprit(culprit.featureId)}
        >
          Edit {culprit.featureName}
        </button>
      )}
      {operation.keepLastValidLabel && (
        <button
          type="button"
          className="selection-callout-recovery"
          onClick={operation.onKeepLastValid}
        >
          {operation.keepLastValidLabel}
        </button>
      )}
      {error.detail && (
        <button
          type="button"
          className="selection-callout-recovery"
          onClick={operation.onViewDetails}
        >
          View details
        </button>
      )}
    </div>
  );
}
