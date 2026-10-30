import {
  Anchor,
  ArrowUpFromDot,
  BrushCleaning,
  Diameter,
  Eraser,
  Info,
  ListChecks,
  Ruler,
  SquarePen,
  SquareX
} from 'lucide-react';
import { useLayoutEffect, useRef, type ReactNode } from 'react';
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
import { OPERATION_PHASE_LABELS } from '../lib/selectionCalloutView';
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
  return (
    <span
      className={`selection-callout-phase selection-rail-phase phase-${phase}`}
      title={label}
    >
      <span className="visually-hidden">{label}</span>
    </span>
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
  if (!error) return null;
  const culprit = error.culprit;
  return (
    <div className="selection-callout-diagnostic" role="alert">
      <span className="selection-callout-error">{error.message}</span>
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
