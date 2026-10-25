import { MoreHorizontal, X } from 'lucide-react';
import { useLayoutEffect, useRef, useState } from 'react';
import { useSettledFlag } from '../hooks/useSettledFlag';
import { renderLabelSegments } from '../lib/liveLabels';
import {
  MAX_SELECTION_VERBS,
  type SelectionCalloutContent,
  type SelectionCalloutOperation,
  type SelectionCalloutVerb
} from '../lib/selectionCallout';
import { OPERATION_PHASE_LABELS } from '../lib/selectionCalloutView';
import { StableLabel } from './StableLabel';

/**
 * How long the exact check must run before the card says so. Most releases
 * validate within a frame or two: announcing each one blinked a pill in and
 * out, squeezed the name and dimmed every verb.
 */
export const VALIDATING_ANNOUNCE_MS = 250;

/** The pill reserves its widest label, so a phase change never reflows it. */
const PHASE_PILL_RESERVE = (
  ['exact-entry', 'validating', 'failed'] as const
).map((phase) => OPERATION_PHASE_LABELS[phase]);

/**
 * What the pick is and what can be done with it, in a card above the verb
 * rail. It used to be a chip hung on the pick in the viewport; the model now
 * carries only the handle and its value, so nothing but the part sits under
 * the cursor. The card keeps the chip's names, classes and accessible names
 * ("Selection: Fillet", "Deselect all"), so every way of reaching a verb
 * still reaches it.
 *
 * The operation's refusal is not here: it joins the notice lane
 * ({@link SelectionRefusal}), where every other message the workspace has
 * for the user already stands.
 */
export function SelectionCard({
  content
}: {
  content: SelectionCalloutContent;
}) {
  const nameRef = useRef<HTMLSpanElement>(null);
  const label = content.label;
  // Segmented like every other spelling of a pick, so a cylinder-radius drag
  // can rewrite the diameter node in place (setLiveDiameter).
  useLayoutEffect(() => {
    if (nameRef.current) renderLabelSegments(nameRef.current, label ?? []);
  }, [label]);
  const operation = content.operation;
  const validating = operation?.phase === 'validating';
  // The verbs are held from the first frame (the check owns the pick until it
  // answers); only saying so waits until the check has visibly taken time.
  const announced = useSettledFlag(validating, VALIDATING_ANNOUNCE_MS);
  // A quick check keeps the marker the release came from (the drag's dot,
  // the typed value's pill) rather than blinking a new one.
  const before = useRef(operation?.phase);
  const phase = validating && !announced ? before.current : operation?.phase;
  useLayoutEffect(() => {
    if (!validating) before.current = operation?.phase;
  });
  const edgeCount = operation?.selectAllEdgesCount;
  // The first verbs are buttons; the rest wait behind More, which opens for
  // this pick only (a new pick starts folded). A lit verb is always
  // a button, wherever it falls in the order.
  // Keyed by what is picked as well as its verbs: two flat faces have the
  // same verbs (and often the same name), and the second still opens folded.
  const verbsKey = JSON.stringify([
    content.pickKey ?? label,
    content.verbs.map((verb) => verb.id)
  ]);
  const [moreOpenFor, setMoreOpenFor] = useState<string | null>(null);
  const moreOpen = moreOpenFor === verbsKey;
  const shown: SelectionCalloutVerb[] = [];
  const folded: SelectionCalloutVerb[] = [];
  for (const verb of content.verbs) {
    (shown.length < MAX_SELECTION_VERBS || verb.pressed ? shown : folded).push(
      verb
    );
  }
  const verbButton = (verb: SelectionCalloutVerb) => (
    <button
      key={verb.id}
      type="button"
      className="selection-callout-verb"
      title={verb.title}
      // Named for what it acts on, so it never shares a name with the rail
      // button or tool-card action of the same verb.
      aria-label={`Selection: ${verb.label}`}
      aria-pressed={verb.pressed}
      // The exact check owns this pick until it answers: another action now
      // would leave the old operation free to commit late.
      disabled={verb.disabled || validating}
      onClick={() => content.onVerb(verb.id)}
    >
      {verb.label}
    </button>
  );
  return (
    <section
      className="selection-card selection-callout-chip"
      role={operation ? 'region' : 'group'}
      aria-label={operation ? `${operation.title} operation` : 'Selection'}
      aria-busy={validating ? 'true' : undefined}
      data-busy={validating && !announced ? 'quiet' : undefined}
    >
      <div className="selection-card-header">
        <span className="selection-card-heading">
          <span className="selection-callout-name" ref={nameRef} />
          {content.detail && (
            <span className="selection-callout-detail">{content.detail}</span>
          )}
        </span>
        {/* Armed is the resting state, and the lit verb already says which
            operation the pick carries; every other phase is news. */}
        {phase && phase !== 'armed' && <PhaseMarker phase={phase} />}
        {/* In the header, so a folded card is no taller than it was. */}
        {folded.length > 0 && (
          <button
            type="button"
            className="selection-callout-more"
            title={
              moreOpen
                ? 'Fewer verbs'
                : `${folded.length} more: ${folded.map((verb) => verb.label).join(', ')}`
            }
            aria-expanded={moreOpen}
            aria-label={
              moreOpen ? 'Fewer selection verbs' : 'More selection verbs'
            }
            onClick={() => setMoreOpenFor(moreOpen ? null : verbsKey)}
          >
            <MoreHorizontal size={14} aria-hidden="true" />
          </button>
        )}
        {content.onClear && (
          <button
            type="button"
            className="selection-callout-clear"
            title="Deselect all (Esc)"
            aria-label="Deselect all"
            disabled={validating}
            onClick={content.onClear}
          >
            <X size={14} aria-hidden="true" />
          </button>
        )}
      </div>
      {operation?.badge && (
        <span
          className="selection-callout-badge"
          tabIndex={0}
          aria-label={operation.badge.label}
          title={operation.badge.detail}
        >
          Anchored
        </span>
      )}
      {(content.verbs.length > 0 || (operation && edgeCount)) && (
        <div className="selection-callout-verbs">
          {shown.map(verbButton)}
          {moreOpen && folded.map(verbButton)}
          {operation && edgeCount ? (
            <button
              type="button"
              className="selection-callout-verb"
              aria-label={`Select all ${edgeCount} edges`}
              disabled={validating}
              onClick={operation.onSelectAllEdges}
            >
              All {edgeCount} edges
            </button>
          ) : null}
        </div>
      )}
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
  return (
    <span className={`selection-callout-phase phase-${phase}`}>
      <StableLabel reserve={PHASE_PILL_RESERVE} align="center">
        {label}
      </StableLabel>
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
