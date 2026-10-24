import { X } from 'lucide-react';
import { useLayoutEffect, useRef } from 'react';
import { renderLabelSegments } from '../lib/liveLabels';
import type {
  SelectionCalloutContent,
  SelectionCalloutOperation
} from '../lib/selectionCallout';
import { OPERATION_PHASE_LABELS } from '../lib/selectionCalloutView';

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
  const phase = operation?.phase;
  const edgeCount = operation?.selectAllEdgesCount;
  return (
    <section
      className="selection-card selection-callout-chip"
      role={operation ? 'region' : 'group'}
      aria-label={operation ? `${operation.title} operation` : 'Selection'}
      aria-busy={validating ? 'true' : undefined}
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
          {content.verbs.map((verb) => (
            <button
              key={verb.id}
              type="button"
              className="selection-callout-verb"
              title={verb.title}
              // Named for what it acts on, so it never shares a name with
              // the rail button or tool-card action of the same verb.
              aria-label={`Selection: ${verb.label}`}
              aria-pressed={verb.pressed}
              // The exact check owns this pick until it answers: another
              // action now would leave the old operation free to commit late.
              disabled={verb.disabled || validating}
              onClick={() => content.onVerb(verb.id)}
            >
              {verb.label}
            </button>
          ))}
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
    <span className={`selection-callout-phase phase-${phase}`}>{label}</span>
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
